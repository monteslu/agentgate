import { Router } from 'express';
import {
  listAccounts, getSetting, setSetting, deleteSetting,
  setAdminPassword, verifyAdminPassword, hasAdminPassword,
  listQueueEntries, getQueueEntry, updateQueueStatus, clearQueueByStatus, deleteQueueEntry, getPendingQueueCount, getQueueCounts,
  listApiKeys, createApiKey, deleteApiKey,
  listUnnotifiedEntries
} from '../lib/db.js';
import { connectHsync, disconnectHsync, getHsyncUrl, isHsyncConnected } from '../lib/hsyncManager.js';
import { executeQueueEntry } from '../lib/queueExecutor.js';
import { notifyClawdbot, retryNotification } from '../lib/notifier.js';
import { registerAllRoutes, renderAllCards } from './ui/index.js';

const router = Router();

const PORT = process.env.PORT || 3050;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Auth cookie settings
const AUTH_COOKIE = 'rms_auth';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 1 week

// Check if user is authenticated
function isAuthenticated(req) {
  return req.signedCookies[AUTH_COOKIE] === 'authenticated';
}

// Auth middleware for protected routes
function requireAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/setup-password') {
    return next();
  }

  if (!hasAdminPassword()) {
    return res.redirect('/ui/setup-password');
  }

  if (!isAuthenticated(req)) {
    return res.redirect('/ui/login');
  }

  next();
}

// Apply auth middleware to all routes
router.use(requireAuth);

// Login page
router.get('/login', (req, res) => {
  if (!hasAdminPassword()) {
    return res.redirect('/ui/setup-password');
  }
  if (isAuthenticated(req)) {
    return res.redirect('/ui');
  }
  res.send(renderLoginPage());
});

// Handle login
router.post('/login', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.send(renderLoginPage('Password required'));
  }

  const valid = await verifyAdminPassword(password);
  if (!valid) {
    return res.send(renderLoginPage('Invalid password'));
  }

  res.cookie(AUTH_COOKIE, 'authenticated', {
    signed: true,
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax'
  });
  res.redirect('/ui');
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.redirect('/ui/login');
});

// Password setup page (first time only)
router.get('/setup-password', (req, res) => {
  if (hasAdminPassword()) {
    return res.redirect('/ui/login');
  }
  res.send(renderSetupPasswordPage());
});

// Handle password setup
router.post('/setup-password', async (req, res) => {
  if (hasAdminPassword()) {
    return res.redirect('/ui/login');
  }

  const { password, confirmPassword } = req.body;
  if (!password || password.length < 4) {
    return res.send(renderSetupPasswordPage('Password must be at least 4 characters'));
  }
  if (password !== confirmPassword) {
    return res.send(renderSetupPasswordPage('Passwords do not match'));
  }

  await setAdminPassword(password);

  res.cookie(AUTH_COOKIE, 'authenticated', {
    signed: true,
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax'
  });
  res.redirect('/ui');
});

// Main UI page
router.get('/', (req, res) => {
  const accounts = listAccounts();
  const hsyncConfig = getSetting('hsync');
  const hsyncUrl = getHsyncUrl();
  const hsyncConnected = isHsyncConnected();
  const pendingQueueCount = getPendingQueueCount();
  const notificationsConfig = getSetting('notifications');

  res.send(renderPage(accounts, { hsyncConfig, hsyncUrl, hsyncConnected, pendingQueueCount, notificationsConfig }));
});

// Register all service routes (github, bluesky, reddit, etc.)
registerAllRoutes(router, BASE_URL);

// hsync setup
router.post('/hsync/setup', async (req, res) => {
  const { url, token } = req.body;
  if (!url) {
    return res.status(400).send('URL required');
  }
  setSetting('hsync', {
    url: url.replace(/\/$/, ''),
    token: token || '',
    enabled: true
  });
  await connectHsync(PORT);
  res.redirect('/ui');
});

router.post('/hsync/delete', async (req, res) => {
  await disconnectHsync();
  deleteSetting('hsync');
  res.redirect('/ui');
});

// Notification settings
router.post('/notifications/setup', (req, res) => {
  const { url, token, events } = req.body;
  if (!url) {
    return res.status(400).send('Webhook URL required');
  }

  // Parse events - could be comma-separated string or array
  let eventList = ['completed', 'failed'];
  if (events) {
    eventList = Array.isArray(events) ? events : events.split(',').map(e => e.trim());
  }

  setSetting('notifications', {
    clawdbot: {
      enabled: true,
      url: url.replace(/\/$/, ''),
      token: token || '',
      events: eventList,
      retryAttempts: 3,
      retryDelayMs: 5000
    }
  });
  res.redirect('/ui');
});

router.post('/notifications/delete', (req, res) => {
  deleteSetting('notifications');
  res.redirect('/ui');
});

router.post('/notifications/test', async (req, res) => {
  const wantsJson = req.headers.accept?.includes('application/json');
  const config = getSetting('notifications');

  if (!config?.clawdbot?.enabled || !config.clawdbot.url || !config.clawdbot.token) {
    const error = 'Notifications not configured';
    return wantsJson
      ? res.status(400).json({ success: false, error })
      : res.status(400).send(error);
  }

  try {
    const response = await fetch(config.clawdbot.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.clawdbot.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: '🧪 [agentgate] Test notification - webhook is working!',
        mode: 'now'
      })
    });

    if (response.ok) {
      return wantsJson
        ? res.json({ success: true })
        : res.redirect('/ui?notification_test=success');
    } else {
      const text = await response.text().catch(() => '');
      const error = `HTTP ${response.status}: ${text.substring(0, 100)}`;
      return wantsJson
        ? res.status(400).json({ success: false, error })
        : res.redirect('/ui?notification_test=failed');
    }
  } catch (err) {
    return wantsJson
      ? res.status(500).json({ success: false, error: err.message })
      : res.redirect('/ui?notification_test=failed');
  }
});

// Write Queue Management
router.get('/queue', (req, res) => {
  const filter = req.query.filter || 'all';
  let entries;
  if (filter === 'all') {
    entries = listQueueEntries();
  } else {
    entries = listQueueEntries(filter);
  }
  const counts = getQueueCounts();
  const unnotified = listUnnotifiedEntries();
  res.send(renderQueuePage(entries, filter, counts, unnotified.length));
});

router.post('/queue/:id/approve', async (req, res) => {
  const { id } = req.params;
  const entry = getQueueEntry(id);
  const wantsJson = req.headers.accept?.includes('application/json');

  if (!entry) {
    return wantsJson
      ? res.status(404).json({ error: 'Queue entry not found' })
      : res.status(404).send('Queue entry not found');
  }

  if (entry.status !== 'pending') {
    return wantsJson
      ? res.status(400).json({ error: 'Can only approve pending requests' })
      : res.status(400).send('Can only approve pending requests');
  }

  updateQueueStatus(id, 'approved');

  try {
    await executeQueueEntry(entry);
  } catch (err) {
    updateQueueStatus(id, 'failed', { results: [{ error: err.message }] });
  }

  const updated = getQueueEntry(id);
  const counts = getQueueCounts();

  if (wantsJson) {
    return res.json({ success: true, entry: updated, counts });
  }
  res.redirect('/ui/queue');
});

router.post('/queue/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const entry = getQueueEntry(id);
  if (!entry) {
    return wantsJson
      ? res.status(404).json({ error: 'Queue entry not found' })
      : res.status(404).send('Queue entry not found');
  }

  if (entry.status !== 'pending') {
    return wantsJson
      ? res.status(400).json({ error: 'Can only reject pending requests' })
      : res.status(400).send('Can only reject pending requests');
  }

  updateQueueStatus(id, 'rejected', { rejection_reason: reason || 'No reason provided' });

  // Send notification to Clawdbot
  const updated = getQueueEntry(id);
  notifyClawdbot(updated).catch(err => {
    console.error('[notifier] Failed to notify Clawdbot:', err.message);
  });

  const counts = getQueueCounts();

  if (wantsJson) {
    return res.json({ success: true, entry: updated, counts });
  }
  res.redirect('/ui/queue');
});

router.post('/queue/clear', (req, res) => {
  const wantsJson = req.headers.accept?.includes('application/json');
  const { status } = req.body;

  // Only allow clearing non-pending statuses
  const allowedStatuses = ['completed', 'failed', 'rejected', 'all'];
  if (status && !allowedStatuses.includes(status)) {
    return wantsJson
      ? res.status(400).json({ error: 'Invalid status' })
      : res.status(400).send('Invalid status');
  }

  clearQueueByStatus(status || 'all');
  const counts = getQueueCounts();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/queue');
});

router.delete('/queue/:id', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const entry = getQueueEntry(id);
  if (!entry) {
    return wantsJson
      ? res.status(404).json({ error: 'Queue entry not found' })
      : res.status(404).send('Queue entry not found');
  }

  deleteQueueEntry(id);
  const counts = getQueueCounts();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/queue');
});

// Retry notification for a specific queue entry
router.post('/queue/:id/notify', async (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const result = await retryNotification(id, getQueueEntry);
  const updated = getQueueEntry(id);

  if (wantsJson) {
    return res.json({ success: result.success, error: result.error, entry: updated });
  }
  res.redirect('/ui/queue');
});

// Retry all failed notifications
router.post('/queue/notify-all', async (req, res) => {
  const wantsJson = req.headers.accept?.includes('application/json');
  const unnotified = listUnnotifiedEntries();

  if (unnotified.length === 0) {
    return wantsJson
      ? res.json({ success: true, count: 0 })
      : res.redirect('/ui/queue');
  }

  // Batch into single notification
  const { notifyClawdbotBatch } = await import('../lib/notifier.js');
  const result = await notifyClawdbotBatch(unnotified);

  if (wantsJson) {
    return res.json({ success: result.success, error: result.error, count: unnotified.length });
  }
  res.redirect('/ui/queue');
});

// API Keys Management
router.get('/keys', (req, res) => {
  const keys = listApiKeys();
  res.send(renderKeysPage(keys));
});

router.post('/keys/create', async (req, res) => {
  const { name } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  if (!name || !name.trim()) {
    return wantsJson
      ? res.status(400).json({ error: 'Name is required' })
      : res.send(renderKeysPage(listApiKeys(), 'Name is required'));
  }

  const newKey = await createApiKey(name.trim());
  const keys = listApiKeys();

  if (wantsJson) {
    // Only return the full key in JSON response at creation time
    return res.json({ success: true, key: newKey.key, keyPrefix: newKey.keyPrefix, name: newKey.name, keys });
  }
  res.send(renderKeysPage(keys, null, newKey));
});

router.post('/keys/:id/delete', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  deleteApiKey(id);
  const keys = listApiKeys();

  if (wantsJson) {
    return res.json({ success: true, keys });
  }
  res.redirect('/ui/keys');
});

router.delete('/keys/:id', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  deleteApiKey(id);
  const keys = listApiKeys();

  if (wantsJson) {
    return res.json({ success: true, keys });
  }
  res.redirect('/ui/keys');
});

// HTML Templates

function renderPage(accounts, { hsyncConfig, hsyncUrl, hsyncConnected, pendingQueueCount, notificationsConfig }) {
  const clawdbotConfig = notificationsConfig?.clawdbot;
  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Admin</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <script>
    function copyText(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }
  </script>
</head>
<body>
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <img src="/public/favicon.svg" alt="agentgate" style="height: 64px;">
      <h1 style="margin: 0;">agentgate</h1>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/keys" class="nav-btn nav-btn-default">API Keys</a>
      <a href="/ui/queue" class="nav-btn nav-btn-default" style="position: relative;">
        Write Queue
        ${pendingQueueCount > 0 ? `<span class="badge">${pendingQueueCount}</span>` : ''}
      </a>
      <div class="nav-divider"></div>
      <form method="POST" action="/ui/logout" style="margin: 0;">
        <button type="submit" class="nav-btn nav-btn-default" style="color: #f87171;">Logout</button>
      </form>
    </div>
  </div>
  <p>API gateway for agents with human-in-the-loop write approval.</p>
  <p class="help">API pattern: <code>/api/{service}/{accountName}/...</code></p>

  <h2>Services</h2>

  ${renderAllCards(accounts, BASE_URL)}

  <h2>Usage</h2>
  <div class="card">
    <p>Make requests with your API key in the Authorization header:</p>
    <pre>
# Read requests (immediate)
curl -H "Authorization: Bearer rms_your_key_here" \\
  http://localhost:${PORT}/api/github/personal/users/octocat

# Write requests (queued for approval)
curl -X POST http://localhost:${PORT}/api/queue/github/personal/submit \\
  -H "Authorization: Bearer rms_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"requests":[{"method":"POST","path":"/repos/owner/repo/issues","body":{"title":"Bug"}}],"comment":"Creating issue"}'
    </pre>
  </div>

  <h2>Advanced</h2>
  <div class="card">
    <details ${hsyncConfig?.enabled ? 'open' : ''}>
      <summary>hsync (Remote Access) ${hsyncConnected ? '<span class="status configured">Connected</span>' : hsyncConfig?.enabled ? '<span class="status not-configured">Disconnected</span>' : ''}</summary>
      <div style="margin-top: 16px;">
        ${hsyncConfig?.enabled ? `
          <p>URL: <strong>${hsyncConfig.url}</strong></p>
          ${hsyncUrl ? `<p>Public URL: <span class="copyable">${hsyncUrl} <button type="button" class="copy-btn" onclick="copyText('${hsyncUrl}', this)">Copy</button></span></p>` : '<p class="help">Connecting... (refresh page to see URL)</p>'}
          <form method="POST" action="/ui/hsync/delete">
            <button type="submit" class="btn-danger">Disable</button>
          </form>
        ` : `
          <p class="help">Optional: Use <a href="https://hsync.tech" target="_blank">hsync</a> to expose this gateway to remote agents without opening ports.</p>
          <form method="POST" action="/ui/hsync/setup">
            <label>URL</label>
            <input type="text" name="url" placeholder="https://yourname.hsync.tech" required>
            <label>Token (optional)</label>
            <input type="password" name="token" placeholder="Token if required">
            <button type="submit" class="btn-primary">Enable hsync</button>
          </form>
        `}
      </div>
    </details>
  </div>

  <div class="card">
    <details ${clawdbotConfig?.enabled ? 'open' : ''}>
      <summary>Clawdbot Notifications ${clawdbotConfig?.enabled ? '<span class="status configured">Configured</span>' : ''}</summary>
      <div style="margin-top: 16px;">
        <div id="notification-feedback"></div>
        ${clawdbotConfig?.enabled ? `
          <p>Webhook URL: <strong>${clawdbotConfig.url}</strong></p>
          <p>Events: <code>${(clawdbotConfig.events || ['completed', 'failed']).join(', ')}</code></p>
          <div style="display: flex; gap: 8px; margin-top: 12px;">
            <button type="button" class="btn-primary btn-sm" id="test-notification-btn" onclick="testNotification()">Send Test</button>
            <form method="POST" action="/ui/notifications/delete" style="margin: 0;">
              <button type="submit" class="btn-danger btn-sm">Disable</button>
            </form>
          </div>
          <script>
            async function testNotification() {
              const btn = document.getElementById('test-notification-btn');
              const feedback = document.getElementById('notification-feedback');
              btn.disabled = true;
              btn.textContent = 'Sending...';
              feedback.innerHTML = '';
              
              try {
                const res = await fetch('/ui/notifications/test', {
                  method: 'POST',
                  headers: { 'Accept': 'application/json' }
                });
                const data = await res.json();
                
                if (data.success) {
                  feedback.innerHTML = '<div class="success-message" style="margin-bottom: 16px;">✓ Test notification sent!</div>';
                } else {
                  feedback.innerHTML = '<div class="error-message" style="margin-bottom: 16px;">✗ ' + (data.error || 'Failed to send') + '</div>';
                }
              } catch (err) {
                feedback.innerHTML = '<div class="error-message" style="margin-bottom: 16px;">✗ ' + err.message + '</div>';
              }
              
              btn.disabled = false;
              btn.textContent = 'Send Test';
            }
          </script>
        ` : `
          <p class="help">Send notifications to <a href="https://docs.clawd.bot" target="_blank">Clawdbot</a> when queue items are completed, failed, or rejected.</p>
          <form method="POST" action="/ui/notifications/setup">
            <label>Webhook URL</label>
            <input type="text" name="url" placeholder="https://your-gateway.example.com/hooks/wake" required>
            <label>Token</label>
            <input type="password" name="token" placeholder="Clawdbot hooks token" required>
            <label>Events (comma-separated)</label>
            <input type="text" name="events" placeholder="completed, failed, rejected" value="completed, failed, rejected">
            <button type="submit" class="btn-primary">Enable Notifications</button>
          </form>
        `}
      </div>
    </details>
  </div>
</body>
</html>`;
}

function renderLoginPage(error = '') {
  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Login</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <div class="card login-card">
    <h1>agentgate</h1>
    <h3>Welcome back</h3>
    ${error ? `<div class="error-message">${error}</div>` : ''}
    <form method="POST" action="/ui/login">
      <label>Admin Password</label>
      <input type="password" name="password" placeholder="Enter your password" required autofocus>
      <button type="submit" class="btn-primary">Login</button>
    </form>
  </div>
</body>
</html>`;
}

function renderSetupPasswordPage(error = '') {
  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Setup</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <div class="card login-card">
    <h1>agentgate</h1>
    <h3>First time setup</h3>
    <p class="help" style="text-align: center;">Create an admin password to protect your gateway.</p>
    ${error ? `<div class="error-message">${error}</div>` : ''}
    <form method="POST" action="/ui/setup-password">
      <label>Password</label>
      <input type="password" name="password" placeholder="Choose a password" required autofocus>
      <label>Confirm Password</label>
      <input type="password" name="confirmPassword" placeholder="Confirm your password" required>
      <button type="submit" class="btn-primary">Get Started</button>
    </form>
  </div>
</body>
</html>`;
}

function renderQueuePage(entries, filter, counts, unnotifiedCount = 0) {
  const escapeHtml = (str) => {
    if (typeof str !== 'string') str = JSON.stringify(str, null, 2);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  // Render markdown links [text](url) while escaping everything else
  const renderMarkdownLinks = (str) => {
    if (!str) return '';
    // First escape HTML
    let escaped = escapeHtml(str);
    // Then convert markdown links to anchor tags
    // Pattern: [text](url) where url must start with http:// or https://
    escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return escaped;
  };

  const statusBadge = (status) => {
    const colors = {
      pending: 'background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);',
      approved: 'background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);',
      executing: 'background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);',
      completed: 'background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);',
      failed: 'background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);',
      rejected: 'background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3);'
    };
    return `<span class="status" style="${colors[status] || ''}">${status}</span>`;
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString();
  };

  const renderEntry = (entry) => {
    const requestsSummary = entry.requests.map((r) =>
      `<div class="request-item"><code>${r.method}</code> <span>${escapeHtml(r.path)}</span></div>`
    ).join('');

    let actions = '';
    if (entry.status === 'pending') {
      actions = `
        <div class="queue-actions" id="actions-${entry.id}">
          <button type="button" class="btn-primary btn-sm" onclick="approveEntry('${entry.id}')">Approve</button>
          <input type="text" id="reason-${entry.id}" placeholder="Rejection reason (optional)" class="reject-input">
          <button type="button" class="btn-danger btn-sm" onclick="rejectEntry('${entry.id}')">Reject</button>
        </div>
      `;
    }

    let resultSection = '';
    if (entry.results) {
      resultSection = `
        <details style="margin-top: 12px;">
          <summary>Results (${entry.results.length})</summary>
          <pre style="margin-top: 8px; font-size: 12px;">${escapeHtml(JSON.stringify(entry.results, null, 2))}</pre>
        </details>
      `;
    }

    if (entry.rejection_reason) {
      resultSection = `
        <div class="rejection-reason">
          <strong>Rejection reason:</strong> ${escapeHtml(entry.rejection_reason)}
        </div>
      `;
    }

    // Notification status (only show for completed/failed/rejected)
    let notificationSection = '';
    if (['completed', 'failed', 'rejected'].includes(entry.status)) {
      const notifyStatus = entry.notified
        ? `<span class="notify-status notify-sent" title="Notified at ${formatDate(entry.notified_at)}">✓ Notified</span>`
        : entry.notify_error
          ? `<span class="notify-status notify-failed" title="${escapeHtml(entry.notify_error)}">⚠ Notify failed</span>`
          : '<span class="notify-status notify-pending">— Not notified</span>';

      const retryBtn = !entry.notified
        ? `<button type="button" class="btn-sm btn-link" onclick="retryNotify('${entry.id}')" id="retry-${entry.id}">Retry</button>`
        : '';

      notificationSection = `
        <div class="notification-status" id="notify-status-${entry.id}">
          ${notifyStatus} ${retryBtn}
        </div>
      `;
    }

    return `
      <div class="card queue-entry" id="entry-${entry.id}" data-status="${entry.status}" data-notified="${entry.notified ? '1' : '0'}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
          <div class="entry-header">
            <strong>${entry.service}</strong> / ${entry.account_name}
            <span class="status-badge">${statusBadge(entry.status)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="help" style="margin: 0;">${formatDate(entry.submitted_at)}</span>
            <button type="button" class="delete-btn" onclick="deleteEntry('${entry.id}')" title="Delete">&times;</button>
          </div>
        </div>

        ${entry.comment ? `<p class="agent-comment"><strong>Agent says:</strong> ${renderMarkdownLinks(entry.comment)}</p>` : ''}

        <div class="help" style="margin-bottom: 8px;">Submitted by: <code>${escapeHtml(entry.submitted_by || 'unknown')}</code></div>

        <div class="requests-list">
          ${requestsSummary}
        </div>

        <details style="margin-top: 12px;">
          <summary>Request Details</summary>
          <pre style="margin-top: 8px; font-size: 12px;">${escapeHtml(JSON.stringify(entry.requests, null, 2))}</pre>
        </details>

        ${resultSection}
        ${notificationSection}
        ${actions}
      </div>
    `;
  };

  const filters = ['all', 'pending', 'completed', 'failed', 'rejected'];
  const filterLinks = filters.map(f =>
    `<a href="/ui/queue?filter=${f}" class="filter-link ${filter === f ? 'active' : ''}">${f}${counts[f] > 0 ? ` (${counts[f]})` : ''}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Write Queue</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <style>
    .filter-bar { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; align-items: center; }
    .filter-link {
      padding: 10px 20px;
      border-radius: 25px;
      text-decoration: none;
      background: rgba(255, 255, 255, 0.05);
      color: var(--gray-400);
      font-weight: 600;
      font-size: 13px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: all 0.3s ease;
    }
    .filter-link:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--gray-200);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .filter-link.active {
      background: linear-gradient(135deg, var(--primary) 0%, #8b5cf6 100%);
      color: white;
      border-color: transparent;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
    }
    .queue-entry { margin-bottom: 20px; }
    .request-item {
      padding: 12px 16px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 8px;
      margin: 6px 0;
      font-size: 14px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .request-item code {
      background: rgba(99, 102, 241, 0.2);
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 700;
      color: var(--primary-light);
      border: 1px solid rgba(99, 102, 241, 0.3);
      font-size: 12px;
    }
    .request-item span { color: var(--gray-300); }
    .queue-actions {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .queue-actions input[type="text"] {
      width: 240px;
      padding: 10px 14px;
      margin: 0;
      font-size: 13px;
    }
    .back-link {
      color: #818cf8;
      text-decoration: none;
      font-weight: 600;
      transition: color 0.2s ease;
    }
    .back-link:hover { color: #ffffff; }
    .delete-btn {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: #f87171;
      font-size: 18px;
      cursor: pointer;
      padding: 4px 10px;
      line-height: 1;
      font-weight: bold;
      border-radius: 6px;
      transition: all 0.2s ease;
    }
    .delete-btn:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: rgba(239, 68, 68, 0.4);
    }
    .clear-section { margin-left: auto; display: flex; gap: 10px; }
    .entry-header {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .entry-header strong {
      color: #f3f4f6;
      font-size: 16px;
    }
    .reject-input {
      width: 240px;
      padding: 10px 14px;
      margin: 0;
      font-size: 13px;
      background: rgba(15, 15, 25, 0.6);
      border: 2px solid rgba(239, 68, 68, 0.2);
      border-radius: 8px;
      color: #f3f4f6;
    }
    .reject-input:focus {
      outline: none;
      border-color: #f87171;
      box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.15);
    }
    .reject-input::placeholder {
      color: #6b7280;
    }
    .agent-comment {
      margin: 0 0 16px 0;
      padding: 16px;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%);
      border-radius: 10px;
      border-left: 4px solid #6366f1;
      color: #e5e7eb;
    }
    .agent-comment strong { color: #818cf8; }
    .agent-comment a { color: #818cf8; }
    .rejection-reason {
      margin-top: 16px;
      padding: 16px;
      background: rgba(239, 68, 68, 0.1);
      border-radius: 10px;
      border-left: 4px solid #f87171;
      color: #e5e7eb;
    }
    .rejection-reason strong { color: #f87171; }
    .empty-state {
      text-align: center;
      padding: 60px 40px;
    }
    .empty-state p { color: #6b7280; margin: 0; font-size: 16px; }
    .notification-status {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
    }
    .notify-status {
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 500;
    }
    .notify-sent {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .notify-failed {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }
    .notify-pending {
      background: rgba(156, 163, 175, 0.15);
      color: #9ca3af;
      border: 1px solid rgba(156, 163, 175, 0.3);
    }
    .btn-link {
      background: none;
      border: none;
      color: #818cf8;
      cursor: pointer;
      text-decoration: underline;
      padding: 4px 8px;
      font-size: 13px;
    }
    .btn-link:hover { color: #a5b4fc; }
    .btn-link:disabled { color: #6b7280; cursor: not-allowed; text-decoration: none; }
  </style>
</head>
<body>
  <div style="display: flex; justify-content: space-between; align-items: center;">
    <h1>Write Queue</h1>
    <a href="/ui" class="back-link">&larr; Back to Dashboard</a>
  </div>
  <p>Review and approve write requests from agents.</p>

  <div class="filter-bar" id="filter-bar">
    ${filterLinks}
    <div class="clear-section">
      ${unnotifiedCount > 0 ? `<button type="button" class="btn-sm btn-primary" onclick="retryAllNotifications()" id="retry-all-btn">Retry ${unnotifiedCount} Notification${unnotifiedCount > 1 ? 's' : ''}</button>` : ''}
      ${filter === 'completed' && counts.completed > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'completed\')">Clear Completed</button>' : ''}
      ${filter === 'failed' && counts.failed > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'failed\')">Clear Failed</button>' : ''}
      ${filter === 'rejected' && counts.rejected > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'rejected\')">Clear Rejected</button>' : ''}
      ${filter === 'all' && (counts.completed > 0 || counts.failed > 0 || counts.rejected > 0) ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'all\')">Clear All Non-Pending</button>' : ''}
    </div>
  </div>

  <div id="entries-container">
  ${entries.length === 0 ? `
    <div class="card empty-state">
      <p>No ${filter === 'all' ? '' : filter + ' '}requests in queue</p>
    </div>
  ` : entries.map(renderEntry).join('')}
  </div>

  <script>
    const statusColors = {
      pending: 'background: #fef3c7; color: #92400e;',
      approved: 'background: #dbeafe; color: #1e40af;',
      executing: 'background: #dbeafe; color: #1e40af;',
      completed: 'background: #d1fae5; color: #065f46;',
      failed: 'background: #fee2e2; color: #991b1b;',
      rejected: 'background: #f3f4f6; color: #374151;'
    };

    function updateCounts(counts) {
      const filters = ['all', 'pending', 'completed', 'failed', 'rejected'];
      const filterBar = document.getElementById('filter-bar');
      const links = filterBar.querySelectorAll('.filter-link');
      links.forEach((link, i) => {
        const f = filters[i];
        const count = counts[f] || 0;
        link.textContent = f + (count > 0 ? ' (' + count + ')' : '');
      });
    }

    function updateEntryStatus(id, entry) {
      const el = document.getElementById('entry-' + id);
      if (!el) return;

      el.dataset.status = entry.status;

      // Update status badge
      const badgeContainer = el.querySelector('.status-badge');
      if (badgeContainer) {
        badgeContainer.innerHTML = '<span class="status" style="' + (statusColors[entry.status] || '') + '">' + entry.status + '</span>';
      }

      // Remove actions for non-pending
      const actions = document.getElementById('actions-' + id);
      if (actions && entry.status !== 'pending') {
        actions.remove();
      }

      // Add result section if completed/failed
      if (entry.results && (entry.status === 'completed' || entry.status === 'failed')) {
        const existing = el.querySelector('.result-section');
        if (!existing) {
          const resultHtml = '<details class="result-section" style="margin-top: 12px;" open><summary>Results (' + entry.results.length + ')</summary><pre style="margin-top: 8px; font-size: 12px;">' + escapeHtml(JSON.stringify(entry.results, null, 2)) + '</pre></details>';
          el.insertAdjacentHTML('beforeend', resultHtml);
        }
      }

      // Add rejection reason if rejected
      if (entry.rejection_reason && entry.status === 'rejected') {
        const existing = el.querySelector('.rejection-reason');
        if (!existing) {
          const reasonHtml = '<div class="rejection-reason"><strong>Rejection reason:</strong> ' + escapeHtml(entry.rejection_reason) + '</div>';
          el.insertAdjacentHTML('beforeend', reasonHtml);
        }
      }
    }

    function escapeHtml(str) {
      if (typeof str !== 'string') str = JSON.stringify(str, null, 2);
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function approveEntry(id) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Approving...';

      try {
        const res = await fetch('/ui/queue/' + id + '/approve', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          updateEntryStatus(id, data.entry);
          updateCounts(data.counts);
        } else {
          alert(data.error || 'Failed to approve');
          btn.disabled = false;
          btn.textContent = 'Approve';
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Approve';
      }
    }

    async function rejectEntry(id) {
      const btn = event.target;
      const reasonInput = document.getElementById('reason-' + id);
      const reason = reasonInput ? reasonInput.value : '';

      btn.disabled = true;
      btn.textContent = 'Rejecting...';

      try {
        const res = await fetch('/ui/queue/' + id + '/reject', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ reason })
        });
        const data = await res.json();

        if (data.success) {
          updateEntryStatus(id, data.entry);
          updateCounts(data.counts);
        } else {
          alert(data.error || 'Failed to reject');
          btn.disabled = false;
          btn.textContent = 'Reject';
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Reject';
      }
    }

    async function clearByStatus(status) {
      const btn = event.target;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Clearing...';

      try {
        const res = await fetch('/ui/queue/clear', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ status })
        });
        const data = await res.json();

        if (data.success) {
          // Remove cleared entries from DOM
          document.querySelectorAll('.queue-entry').forEach(el => {
            const entryStatus = el.dataset.status;
            if (status === 'all') {
              if (entryStatus === 'completed' || entryStatus === 'failed' || entryStatus === 'rejected') {
                el.remove();
              }
            } else if (entryStatus === status) {
              el.remove();
            }
          });
          updateCounts(data.counts);

          // Show empty message if no entries left
          const container = document.getElementById('entries-container');
          if (container.querySelectorAll('.queue-entry').length === 0) {
            container.innerHTML = '<div class="card" style="text-align: center; padding: 40px;"><p style="color: var(--gray-500); margin: 0;">No requests in queue</p></div>';
          }

          // Hide the clear button if nothing left to clear
          btn.style.display = 'none';

          // Update retry notifications button
          updateRetryAllButton();
        }

        btn.disabled = false;
        btn.textContent = originalText;
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    async function deleteEntry(id) {
      try {
        const res = await fetch('/ui/queue/' + id, {
          method: 'DELETE',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          const el = document.getElementById('entry-' + id);
          if (el) el.remove();
          updateCounts(data.counts);

          // Show empty message if no entries left
          const container = document.getElementById('entries-container');
          if (container.querySelectorAll('.queue-entry').length === 0) {
            container.innerHTML = '<div class="card" style="text-align: center; padding: 40px;"><p style="color: var(--gray-500); margin: 0;">No requests in queue</p></div>';
          }
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function updateRetryAllButton() {
      // Count remaining unnotified entries in DOM
      const unnotified = document.querySelectorAll('.queue-entry[data-notified="0"]').length;
      const btn = document.getElementById('retry-all-btn');
      
      if (unnotified === 0) {
        if (btn) btn.remove();
      } else if (btn) {
        btn.textContent = 'Retry ' + unnotified + ' Notification' + (unnotified > 1 ? 's' : '');
      }
    }

    async function retryAllNotifications() {
      const btn = document.getElementById('retry-all-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Sending...';
      }

      try {
        const res = await fetch('/ui/queue/notify-all', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          // Refresh the page to show updated status
          window.location.reload();
        } else {
          alert(data.error || 'Failed to send notifications');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Retry Notifications';
          }
        }
      } catch (err) {
        alert('Error: ' + err.message);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Retry Notifications';
        }
      }
    }

    async function retryNotify(id) {
      const btn = document.getElementById('retry-' + id);
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Sending...';
      }

      try {
        const res = await fetch('/ui/queue/' + id + '/notify', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        const statusEl = document.getElementById('notify-status-' + id);
        if (data.success && data.entry?.notified) {
          // Update to show success
          if (statusEl) {
            statusEl.innerHTML = '<span class="notify-status notify-sent">✓ Notified</span>';
          }
          const entryEl = document.getElementById('entry-' + id);
          if (entryEl) entryEl.dataset.notified = '1';
        } else {
          // Show error
          const error = data.error || 'Failed to send';
          if (statusEl) {
            statusEl.innerHTML = '<span class="notify-status notify-failed" title="' + escapeHtml(error) + '">⚠ Notify failed</span> <button type="button" class="btn-sm btn-link" onclick="retryNotify(\\''+id+'\\')">Retry</button>';
          }
        }
      } catch (err) {
        alert('Error: ' + err.message);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Retry';
        }
      }
    }
  </script>
</body>
</html>`;
}

function renderKeysPage(keys, error = null, newKey = null) {
  const escapeHtml = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString();
  };

  const renderKeyRow = (k) => `
    <tr id="key-${k.id}">
      <td><strong>${escapeHtml(k.name)}</strong></td>
      <td><code class="key-value">${escapeHtml(k.key_prefix)}</code></td>
      <td>${formatDate(k.created_at)}</td>
      <td>
        <button type="button" class="delete-btn" onclick="deleteKey('${k.id}')" title="Delete">&times;</button>
      </td>
    </tr>
  `;

  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - API Keys</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <style>
    .keys-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .keys-table th, .keys-table td { padding: 12px; text-align: left; border-bottom: 1px solid var(--gray-200); }
    .keys-table th { font-weight: 600; color: var(--gray-600); font-size: 14px; }
    .key-value { background: var(--gray-100); padding: 4px 8px; border-radius: 4px; font-size: 13px; }
    .new-key-banner { background: #d1fae5; border: 1px solid #10b981; padding: 16px; border-radius: 8px; margin-bottom: 20px; }
    .new-key-banner code { background: white; padding: 8px 12px; border-radius: 4px; display: block; margin-top: 8px; font-size: 14px; word-break: break-all; }
    .delete-btn { background: none; border: none; color: #dc2626; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; font-weight: bold; }
    .delete-btn:hover { color: #991b1b; }
    .back-link { color: var(--primary); text-decoration: none; font-weight: 500; }
    .back-link:hover { text-decoration: underline; }
    .error-message { background: #fee2e2; color: #991b1b; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div style="display: flex; justify-content: space-between; align-items: center;">
    <h1>API Keys</h1>
    <a href="/ui" class="back-link">&larr; Back to Dashboard</a>
  </div>
  <p>Manage API keys for your agents. Keys are hashed and can only be viewed once at creation.</p>

  ${error ? `<div class="error-message">${escapeHtml(error)}</div>` : ''}

  ${newKey ? `
    <div class="new-key-banner">
      <strong>New API key created!</strong> Copy it now - you won't be able to see it again.
      <code>${newKey.key}</code>
      <button type="button" class="btn-sm btn-primary" onclick="copyKey('${newKey.key}', this)" style="margin-top: 8px;">Copy to Clipboard</button>
    </div>
  ` : ''}

  <div class="card">
    <h3>Create New Key</h3>
    <form method="POST" action="/ui/keys/create" style="display: flex; gap: 12px; align-items: flex-end;">
      <div style="flex: 1;">
        <label>Key Name</label>
        <input type="text" name="name" placeholder="e.g., clawdbot, moltbot, dev-agent" required>
      </div>
      <button type="submit" class="btn-primary">Create Key</button>
    </form>
  </div>

  <div class="card">
    <h3>Existing Keys (${keys.length})</h3>
    ${keys.length === 0 ? `
      <p style="color: var(--gray-500); text-align: center; padding: 20px;">No API keys yet. Create one above.</p>
    ` : `
      <table class="keys-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key Prefix</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="keys-tbody">
          ${keys.map(renderKeyRow).join('')}
        </tbody>
      </table>
    `}
  </div>

  <script>
    function copyKey(key, btn) {
      navigator.clipboard.writeText(key).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    async function deleteKey(id) {
      if (!confirm('Delete this API key? Any agents using it will lose access.')) return;

      try {
        const res = await fetch('/ui/keys/' + id, {
          method: 'DELETE',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          const row = document.getElementById('key-' + id);
          if (row) row.remove();

          // Update count
          const tbody = document.getElementById('keys-tbody');
          const count = tbody ? tbody.querySelectorAll('tr').length : 0;
          document.querySelector('.card:last-of-type h3').textContent = 'Existing Keys (' + count + ')';

          // Show empty message if no keys left
          if (count === 0) {
            const table = document.querySelector('.keys-table');
            if (table) {
              table.outerHTML = '<p style="color: var(--gray-500); text-align: center; padding: 20px;">No API keys yet. Create one above.</p>';
            }
          }
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  </script>
</body>
</html>`;
}

export default router;
