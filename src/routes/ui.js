import { Router } from 'express';
import {
  listAccounts, getSetting, setSetting, deleteSetting,
  setAdminPassword, verifyAdminPassword, hasAdminPassword,
  listQueueEntries, getQueueEntry, updateQueueStatus, clearQueueByStatus, deleteQueueEntry, getPendingQueueCount, getQueueCounts
} from '../lib/db.js';
import { connectHsync, disconnectHsync, getHsyncUrl, isHsyncConnected } from '../lib/hsyncManager.js';
import { executeQueueEntry } from '../lib/queueExecutor.js';
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

  res.send(renderPage(accounts, { hsyncConfig, hsyncUrl, hsyncConnected, pendingQueueCount }));
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
  res.send(renderQueuePage(entries, filter, counts));
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

router.post('/queue/:id/reject', (req, res) => {
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

  const updated = getQueueEntry(id);
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

// HTML Templates

function renderPage(accounts, { hsyncConfig, hsyncUrl, hsyncConnected, pendingQueueCount }) {
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
  <div style="display: flex; justify-content: space-between; align-items: center;">
    <h1>agentgate</h1>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/queue" class="btn-primary btn-sm" style="text-decoration: none; position: relative;">
        Write Queue
        ${pendingQueueCount > 0 ? `<span style="position: absolute; top: -8px; right: -8px; background: #ef4444; color: white; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; display: flex; align-items: center; justify-content: center;">${pendingQueueCount}</span>` : ''}
      </a>
      <form method="POST" action="/ui/logout" style="margin: 0;">
        <button type="submit" class="btn-sm btn-danger">Logout</button>
      </form>
    </div>
  </div>
  <p>API gateway for agents with human-in-the-loop write approval.</p>
  <p class="help">Manage API keys via CLI: <code>npm run keys list|create|delete</code></p>
  <p class="help">API pattern: <code>/api/{service}/{accountName}/...</code></p>

  <h2>Configuration</h2>

  <!-- hsync -->
  <div class="card">
    <h3>hsync (Remote Access) ${hsyncConnected ? '<span class="status configured">Connected</span>' : hsyncConfig?.enabled ? '<span class="status not-configured">Disconnected</span>' : '<span class="status not-configured">Disabled</span>'}</h3>
    ${hsyncConfig?.enabled ? `
      <p>URL: <strong>${hsyncConfig.url}</strong></p>
      ${hsyncUrl ? `<p>Public URL: <span class="copyable">${hsyncUrl} <button type="button" class="copy-btn" onclick="copyText('${hsyncUrl}', this)">Copy</button></span></p>` : '<p class="help">Connecting... (refresh page to see URL)</p>'}
      <form method="POST" action="/ui/hsync/delete">
        <button type="submit" class="btn-danger">Disable</button>
      </form>
    ` : `
      <p class="help">Optional reverse proxy for exposing this gateway to remote agents.</p>
      <form method="POST" action="/ui/hsync/setup">
        <label>URL</label>
        <input type="text" name="url" placeholder="https://yourname.hsync.tech" required>
        <label>Token (optional)</label>
        <input type="password" name="token" placeholder="Token if required">
        <button type="submit" class="btn-primary">Enable hsync</button>
      </form>
    `}
  </div>

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

function renderQueuePage(entries, filter, counts) {
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
      pending: 'background: #fef3c7; color: #92400e;',
      approved: 'background: #dbeafe; color: #1e40af;',
      executing: 'background: #dbeafe; color: #1e40af;',
      completed: 'background: #d1fae5; color: #065f46;',
      failed: 'background: #fee2e2; color: #991b1b;',
      rejected: 'background: #f3f4f6; color: #374151;'
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
          <input type="text" id="reason-${entry.id}" placeholder="Rejection reason (optional)" style="width: 200px; padding: 6px; margin: 0 0 0 8px;">
          <button type="button" class="btn-danger btn-sm" onclick="rejectEntry('${entry.id}')" style="margin-left: 4px;">Reject</button>
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
        <div style="margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
          <strong>Rejection reason:</strong> ${escapeHtml(entry.rejection_reason)}
        </div>
      `;
    }

    return `
      <div class="card queue-entry" id="entry-${entry.id}" data-status="${entry.status}">
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

        ${entry.comment ? `<p style="margin: 0 0 12px 0; padding: 12px; background: #f0f4ff; border-radius: 8px; border-left: 4px solid var(--primary);"><strong>Agent says:</strong> ${renderMarkdownLinks(entry.comment)}</p>` : ''}

        <div class="help" style="margin-bottom: 8px;">Submitted by: <code>${escapeHtml(entry.submitted_by || 'unknown')}</code></div>

        <div class="requests-list">
          ${requestsSummary}
        </div>

        <details style="margin-top: 12px;">
          <summary>Request Details</summary>
          <pre style="margin-top: 8px; font-size: 12px;">${escapeHtml(JSON.stringify(entry.requests, null, 2))}</pre>
        </details>

        ${resultSection}
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
    .filter-bar { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
    .filter-link { padding: 8px 16px; border-radius: 20px; text-decoration: none; background: var(--gray-100); color: var(--gray-600); font-weight: 500; font-size: 14px; }
    .filter-link:hover { background: var(--gray-200); }
    .filter-link.active { background: var(--primary); color: white; }
    .queue-entry { margin-bottom: 16px; }
    .request-item { padding: 8px; background: var(--gray-50); border-radius: 6px; margin: 4px 0; font-size: 14px; }
    .request-item code { background: var(--gray-200); padding: 2px 8px; border-radius: 4px; font-weight: 600; }
    .queue-actions { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--gray-200); }
    .back-link { color: var(--primary); text-decoration: none; font-weight: 500; }
    .back-link:hover { text-decoration: underline; }
    .delete-btn { background: none; border: none; color: #dc2626; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; font-weight: bold; }
    .delete-btn:hover { color: #991b1b; }
    .clear-section { margin-left: auto; display: flex; gap: 8px; }
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
      ${filter === 'completed' && counts.completed > 0 ? `<button type="button" class="btn-sm btn-danger" onclick="clearByStatus('completed')">Clear Completed</button>` : ''}
      ${filter === 'failed' && counts.failed > 0 ? `<button type="button" class="btn-sm btn-danger" onclick="clearByStatus('failed')">Clear Failed</button>` : ''}
      ${filter === 'rejected' && counts.rejected > 0 ? `<button type="button" class="btn-sm btn-danger" onclick="clearByStatus('rejected')">Clear Rejected</button>` : ''}
      ${filter === 'all' && (counts.completed > 0 || counts.failed > 0 || counts.rejected > 0) ? `<button type="button" class="btn-sm btn-danger" onclick="clearByStatus('all')">Clear All Non-Pending</button>` : ''}
    </div>
  </div>

  <div id="entries-container">
  ${entries.length === 0 ? `
    <div class="card" style="text-align: center; padding: 40px;">
      <p style="color: var(--gray-500); margin: 0;">No ${filter === 'all' ? '' : filter + ' '}requests in queue</p>
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
        const existing = el.querySelector('.rejection-section');
        if (!existing) {
          const reasonHtml = '<div class="rejection-section" style="margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;"><strong>Rejection reason:</strong> ' + escapeHtml(entry.rejection_reason) + '</div>';
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
  </script>
</body>
</html>`;
}

export default router;
