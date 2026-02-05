import { Router } from 'express';
import {
  listAccounts, getSetting, setSetting, deleteSetting,
  setAdminPassword, verifyAdminPassword, hasAdminPassword,
  listQueueEntries, getQueueEntry, updateQueueStatus, clearQueueByStatus, deleteQueueEntry, getPendingQueueCount, getQueueCounts,
  listApiKeys, createApiKey, deleteApiKey, updateAgentWebhook, getApiKeyById,
  getMessagingMode, setMessagingMode, listPendingMessages, listAgentMessages,
  approveAgentMessage, rejectAgentMessage, deleteAgentMessage, clearAgentMessagesByStatus, getMessageCounts, getAgentMessage,
  getSharedQueueVisibility, setSharedQueueVisibility, getAgentWithdrawEnabled, setAgentWithdrawEnabled
} from '../lib/db.js';
import { connectHsync, disconnectHsync, getHsyncUrl, isHsyncConnected } from '../lib/hsyncManager.js';
import { executeQueueEntry } from '../lib/queueExecutor.js';
import { notifyAgentMessage, notifyMessageRejected, notifyAgentQueueStatus } from '../lib/agentNotifier.js';
import { registerAllRoutes, renderAllCards } from './ui/index.js';
import { emitCountUpdate } from '../lib/socketManager.js';

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
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = listPendingMessages().length;
  const sharedQueueVisibility = getSharedQueueVisibility();
  const agentWithdrawEnabled = getAgentWithdrawEnabled();

  res.send(renderPage(accounts, { hsyncConfig, hsyncUrl, hsyncConnected, pendingQueueCount, messagingMode, pendingMessagesCount, sharedQueueVisibility, agentWithdrawEnabled }));
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

// Notification settings removed - using agent-specific webhooks



// Agent Messaging settings
router.post('/messaging/mode', (req, res) => {
  const { mode } = req.body;
  try {
    setMessagingMode(mode);
    res.redirect('/ui');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Queue Settings
router.post('/queue/settings/shared-visibility', (req, res) => {
  const enabled = req.body.enabled === 'true' || req.body.enabled === '1';
  setSharedQueueVisibility(enabled);
  res.redirect('/ui');
});

router.post('/queue/settings/agent-withdraw', (req, res) => {
  const enabled = req.body.enabled === 'true' || req.body.enabled === '1';
  setAgentWithdrawEnabled(enabled);
  res.redirect('/ui');
});

// Agent Messages Queue
router.get('/messages', (req, res) => {
  const filter = req.query.filter || 'all';
  let messages;
  if (filter === 'all') {
    messages = listAgentMessages();
  } else {
    messages = listAgentMessages(filter);
  }
  const counts = getMessageCounts();
  const mode = getMessagingMode();
  const pendingQueueCount = getPendingQueueCount();
  const pendingMessagesCount = listPendingMessages().length;
  res.send(renderMessagesPage(messages, filter, counts, mode, pendingQueueCount, pendingMessagesCount));
});

router.post('/messages/:id/approve', async (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const msg = getAgentMessage(id);
  if (!msg) {
    return wantsJson
      ? res.status(404).json({ error: 'Message not found' })
      : res.status(404).send('Message not found');
  }

  if (msg.status !== 'pending') {
    return wantsJson
      ? res.status(400).json({ error: 'Can only approve pending messages' })
      : res.status(400).send('Can only approve pending messages');
  }

  approveAgentMessage(id);
  const updated = getAgentMessage(id);
  const counts = getMessageCounts();

  // Emit real-time update
  emitCountUpdate();

  // Try to notify the recipient agent
  notifyAgentMessage(updated).catch(err => {
    console.error('[agentNotifier] Failed to notify agent:', err.message);
  });

  if (wantsJson) {
    return res.json({ success: true, message: updated, counts });
  }
  res.redirect('/ui/messages');
});

router.post('/messages/:id/reject', (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const msg = getAgentMessage(id);
  if (!msg) {
    return wantsJson
      ? res.status(404).json({ error: 'Message not found' })
      : res.status(404).send('Message not found');
  }

  if (msg.status !== 'pending') {
    return wantsJson
      ? res.status(400).json({ error: 'Can only reject pending messages' })
      : res.status(400).send('Can only reject pending messages');
  }

  rejectAgentMessage(id, reason);
  const updated = getAgentMessage(id);
  const counts = getMessageCounts();

  // Emit real-time update
  emitCountUpdate();

  // Notify sender that their message was rejected
  notifyMessageRejected(updated);

  if (wantsJson) {
    return res.json({ success: true, message: updated, counts });
  }
  res.redirect('/ui/messages');
});

router.post('/messages/:id/delete', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  deleteAgentMessage(id);
  const counts = getMessageCounts();

  // Emit real-time update
  emitCountUpdate();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/messages');
});

router.post('/messages/clear', (req, res) => {
  const { status } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  clearAgentMessagesByStatus(status || 'all');
  const counts = getMessageCounts();

  // Emit real-time update
  emitCountUpdate();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/messages');
});



// Export messages as JSON or CSV
router.get('/messages/export', (req, res) => {
  const format = req.query.format || 'json';
  const messages = listAgentMessages();
  
  if (format === 'csv') {
    const headers = ['id', 'from_agent', 'to_agent', 'message', 'status', 'rejection_reason', 'created_at', 'delivered_at'];
    const csvRows = [headers.join(',')];
    for (const msg of messages) {
      const row = headers.map(h => {
        const val = msg[h] ?? '';
        const str = String(val).replace(/"/g, '""');
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
      });
      csvRows.push(row.join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="messages-export.csv"');
    return res.send(csvRows.join('\n'));
  }
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="messages-export.json"');
  res.json(messages);
});
// Broadcast message to all agents
router.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  if (!message || !message.trim()) {
    if (wantsJson) {
      return res.status(400).json({ error: 'Message is required' });
    }
    return res.redirect('/ui/messages?broadcast_error=Message+is+required');
  }

  const mode = getMessagingMode();
  const _pendingQueueCount = getPendingQueueCount();
  const _pendingMessagesCount = listPendingMessages().length;
  if (mode === 'off') {
    if (wantsJson) {
      return res.status(403).json({ error: 'Agent messaging is disabled' });
    }
    return res.redirect('/ui/messages?broadcast_error=Messaging+disabled');
  }

  // Get all agents with webhooks
  const apiKeys = listApiKeys();
  const recipients = apiKeys.filter(k => k.webhook_url);

  if (recipients.length === 0) {
    if (wantsJson) {
      return res.json({ delivered: [], failed: [], total: 0 });
    }
    return res.redirect('/ui/messages?broadcast_result=No+agents+with+webhooks');
  }

  const delivered = [];
  const failed = [];

  await Promise.all(recipients.map(async (agent) => {
    const payload = {
      type: 'broadcast',
      from: 'admin',
      message: message,
      timestamp: new Date().toISOString(),
      text: `📢 [agentgate] Broadcast from admin:\n${message.substring(0, 500)}`,
      mode: 'now'
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (agent.webhook_token) {
        headers['Authorization'] = `Bearer ${agent.webhook_token}`;
      }

      const response = await fetch(agent.webhook_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        delivered.push(agent.name);
      } else {
        failed.push({ name: agent.name, error: `HTTP ${response.status}` });
      }
    } catch (err) {
      failed.push({ name: agent.name, error: err.message });
    }
  }));

  if (wantsJson) {
    return res.json({ delivered, failed, total: recipients.length });
  }

  const resultMsg = `Delivered: ${delivered.length}, Failed: ${failed.length}`;
  res.redirect(`/ui/messages?broadcast_result=${encodeURIComponent(resultMsg)}`);
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
  const pendingQueueCount = getPendingQueueCount();
  const pendingMessagesCount = listPendingMessages().length;
  const messagingMode = getMessagingMode();
  res.send(renderQueuePage(entries, filter, counts, pendingQueueCount, pendingMessagesCount, messagingMode));
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
  const _pendingQueueCount = getPendingQueueCount();
  const _pendingMessagesCount = listPendingMessages().length;
  const _messagingMode = getMessagingMode();

  // Emit real-time update
  emitCountUpdate();

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

  // Send notification to submitting agent and global Clawdbot webhook
  const updated = getQueueEntry(id);
  notifyAgentQueueStatus(updated).catch(err => {
    console.error('[agentNotifier] Failed to notify agent:', err.message);
  });

  const counts = getQueueCounts();
  const _pendingQueueCount = getPendingQueueCount();
  const _pendingMessagesCount = listPendingMessages().length;
  const _messagingMode = getMessagingMode();

  // Emit real-time update
  emitCountUpdate();

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
  const _pendingQueueCount = getPendingQueueCount();
  const _pendingMessagesCount = listPendingMessages().length;
  const _messagingMode = getMessagingMode();

  // Emit real-time update
  emitCountUpdate();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/queue');
});



// Export queue items as JSON or CSV  
router.get('/queue/export', (req, res) => {
  const format = req.query.format || 'json';
  const entries = listQueueEntries();
  
  if (format === 'csv') {
    const headers = ['id', 'service', 'account_name', 'status', 'comment', 'submitted_by', 'rejection_reason', 'submitted_at', 'reviewed_at', 'completed_at'];
    const csvRows = [headers.join(',')];
    for (const entry of entries) {
      const row = headers.map(h => {
        const val = entry[h] ?? '';
        const str = String(val).replace(/"/g, '""');
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
      });
      csvRows.push(row.join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="queue-export.csv"');
    return res.send(csvRows.join('\n'));
  }
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="queue-export.json"');
  res.json(entries);
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
  const _pendingQueueCount = getPendingQueueCount();
  const _pendingMessagesCount = listPendingMessages().length;
  const _messagingMode = getMessagingMode();

  // Emit real-time update
  emitCountUpdate();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/queue');
});

// Retry notification for a specific queue entry
router.post('/queue/:id/notify', async (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const updated = getQueueEntry(id);

  if (wantsJson) {
    return res.json({ success: true, entry: updated });
  }
  res.redirect('/ui/queue');
});



// API Keys Management
router.get('/keys', (req, res) => {
  const keys = listApiKeys();
  const pendingQueueCount = getPendingQueueCount();
  const pendingMessagesCount = listPendingMessages().length;
  const messagingMode = getMessagingMode();
  res.send(renderKeysPage(keys, null, null, pendingQueueCount, pendingMessagesCount, messagingMode));
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

router.post('/keys/:id/webhook', (req, res) => {
  const { id } = req.params;
  const { webhook_url, webhook_token } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const agent = getApiKeyById(id);
  if (!agent) {
    return wantsJson
      ? res.status(404).json({ error: 'Agent not found' })
      : res.status(404).send('Agent not found');
  }

  updateAgentWebhook(id, webhook_url, webhook_token);
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

function renderPage(accounts, { hsyncConfig, hsyncUrl, hsyncConnected, pendingQueueCount, messagingMode, pendingMessagesCount, sharedQueueVisibility, agentWithdrawEnabled }) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Admin</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <script src="/socket.io/socket.io.js"></script>
  <script>
    function copyText(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    // Real-time updates via Socket.io
    document.addEventListener('DOMContentLoaded', function() {
      const socket = io();

      socket.on('counts', function(data) {
        // Update queue badge
        const queueBadge = document.getElementById('queue-badge');
        if (queueBadge) {
          if (data.queue.pending > 0) {
            queueBadge.textContent = data.queue.pending;
            queueBadge.style.display = '';
          } else {
            queueBadge.style.display = 'none';
          }
        }

        // Update messages badge
        const msgBadge = document.getElementById('messages-badge');
        if (msgBadge) {
          if (data.messages.pending > 0) {
            msgBadge.textContent = data.messages.pending;
            msgBadge.style.display = '';
          } else {
            msgBadge.style.display = 'none';
          }
        }

        // Show/hide messages nav based on messaging mode
        const msgNav = document.getElementById('messages-nav');
        if (msgNav) {
          msgNav.style.display = data.messagingEnabled ? '' : 'none';
        }
      });

      socket.on('connect', function() {
        console.log('Socket.io connected for real-time updates');
      });

      // Localize UTC dates to browser timezone
      document.querySelectorAll('.utc-date').forEach(function(el) {
        const utc = el.dataset.utc;
        if (utc) {
          el.textContent = new Date(utc).toLocaleString();
        }
      });
      // Localize title attributes with UTC dates
      document.querySelectorAll('.utc-title').forEach(function(el) {
        const utc = el.dataset.utc;
        if (utc) {
          el.title = 'Notified at ' + new Date(utc).toLocaleString();
        }
      });
    });
  </script>
</head>
<body>
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <img src="/public/favicon.svg" alt="agentgate" style="height: 64px;">
      <h1 style="margin: 0;">agentgate</h1>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/keys" class="nav-btn nav-btn-default">Agents</a>
      <a href="/ui/queue" class="nav-btn nav-btn-default" style="position: relative;">
        Write Queue
        <span id="queue-badge" class="badge" ${pendingQueueCount > 0 ? '' : 'style="display:none"'}>${pendingQueueCount}</span>
      </a>
      <a href="/ui/messages" id="messages-nav" class="nav-btn nav-btn-default" style="position: relative;${messagingMode === 'off' ? ' display:none;' : ''}">
        Messages
        <span id="messages-badge" class="badge" ${pendingMessagesCount > 0 ? '' : 'style="display:none"'}>${pendingMessagesCount}</span>
      </a>
      <div class="nav-divider"></div>
      <a href="/ui#settings" class="nav-btn nav-btn-default" title="Settings" >⚙️</a>
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
    <details ${messagingMode !== 'off' ? 'open' : ''}>
      <summary>Agent Messaging ${messagingMode !== 'off' ? `<span class="status configured">${messagingMode}</span>` : ''}</summary>
      <div style="margin-top: 16px;">
        <p class="help">Allow agents to send messages to each other. Messages can require human approval (supervised) or be delivered immediately (open).</p>
        <form method="POST" action="/ui/messaging/mode" style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
          <label style="display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
            <input type="radio" name="mode" value="off" ${messagingMode === 'off' ? 'checked' : ''}>
            <span>Off</span>
          </label>
          <label style="display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
            <input type="radio" name="mode" value="supervised" ${messagingMode === 'supervised' ? 'checked' : ''}>
            <span>Supervised</span>
          </label>
          <label style="display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
            <input type="radio" name="mode" value="open" ${messagingMode === 'open' ? 'checked' : ''}>
            <span>Open</span>
          </label>
          <button type="submit" class="btn-primary btn-sm">Save</button>
        </form>
        ${messagingMode === 'supervised' && pendingMessagesCount > 0 ? `
          <p style="margin-top: 12px;"><a href="/ui/messages" style="color: #818cf8;">${pendingMessagesCount} pending message${pendingMessagesCount > 1 ? 's' : ''} awaiting approval →</a></p>
        ` : ''}
      </div>
    </details>
  </div>

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
    <details ${sharedQueueVisibility || agentWithdrawEnabled ? 'open' : ''}>
      <summary>Queue Settings ${sharedQueueVisibility || agentWithdrawEnabled ? '<span class="status configured">Configured</span>' : ''}</summary>
      <div style="margin-top: 16px;">
        <p class="help">Configure how agents interact with the write queue.</p>
        
        <div style="margin-bottom: 16px; padding: 16px; background: rgba(0,0,0,0.2); border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div>
              <strong style="color: #f3f4f6;">Shared Queue Visibility</strong>
              <p class="help" style="margin: 4px 0 0 0;">When enabled, agents can see ALL queue items, not just their own.</p>
            </div>
            <form method="POST" action="/ui/queue/settings/shared-visibility" style="margin: 0;">
              <input type="hidden" name="enabled" value="${sharedQueueVisibility ? 'false' : 'true'}">
              <button type="submit" class="btn-sm ${sharedQueueVisibility ? 'btn-danger' : 'btn-primary'}">${sharedQueueVisibility ? 'Disable' : 'Enable'}</button>
            </form>
          </div>
        </div>

        <div style="padding: 16px; background: rgba(0,0,0,0.2); border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div>
              <strong style="color: #f3f4f6;">Agent Withdraw</strong>
              <p class="help" style="margin: 4px 0 0 0;">Allow agents to withdraw their own pending queue submissions.</p>
            </div>
            <form method="POST" action="/ui/queue/settings/agent-withdraw" style="margin: 0;">
              <input type="hidden" name="enabled" value="${agentWithdrawEnabled ? 'false' : 'true'}">
              <button type="submit" class="btn-sm ${agentWithdrawEnabled ? 'btn-danger' : 'btn-primary'}">${agentWithdrawEnabled ? 'Disable' : 'Enable'}</button>
            </form>
          </div>
        </div>
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

function renderQueuePage(entries, filter, counts = 0, pendingQueueCount = 0, pendingMessagesCount = 0, messagingMode = 'off') {
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

  // Format date as span with data-utc for client-side localization
  const localDate = (dateStr) => {
    if (!dateStr) return '';
    return `<span class="utc-date" data-utc="${dateStr}">${formatDate(dateStr)}</span>`;
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
      const reasonLabel = entry.status === 'withdrawn' ? 'Withdraw reason' : 'Rejection reason';
      resultSection = `
        <div class="rejection-reason">
          <strong>${reasonLabel}:</strong> ${escapeHtml(entry.rejection_reason)}
        </div>
      `;
    }

    // Notification status (only show for completed/failed/rejected)
    let notificationSection = '';
    if (['completed', 'failed', 'rejected'].includes(entry.status)) {
      const notifyStatus = entry.notified
        ? `<span class="notify-status notify-sent utc-title" data-utc="${entry.notified_at}" title="Notified at ${formatDate(entry.notified_at)}">✓ Notified</span>`
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
            <span class="help" style="margin: 0;">${localDate(entry.submitted_at)}</span>
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
  <script src="/socket.io/socket.io.js"></script>
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
    .export-section { display: flex; gap: 10px; }
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
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <a href="/ui" style="display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit;">
        <img src="/public/favicon.svg" alt="agentgate" style="height: 48px;">
        <h1 style="margin: 0;">agentgate</h1>
      </a>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/keys" class="nav-btn nav-btn-default">Agents</a>
      <a href="/ui/queue" class="nav-btn nav-btn-default" style="position: relative;">
        Write Queue
        <span id="queue-badge" class="badge" ${pendingQueueCount > 0 ? '' : 'style="display:none"'}>${pendingQueueCount}</span>
      </a>
      <a href="/ui/messages" id="messages-nav" class="nav-btn nav-btn-default" style="position: relative;${messagingMode === 'off' ? ' display:none;' : ''}">
        Messages
        <span id="messages-badge" class="badge" ${pendingMessagesCount > 0 ? '' : 'style="display:none"'}>${pendingMessagesCount}</span>
      </a>
      <div class="nav-divider"></div>
      <a href="/ui#settings" class="nav-btn nav-btn-default" title="Settings" >⚙️</a>
      <form method="POST" action="/ui/logout" style="margin: 0;">
        <button type="submit" class="nav-btn nav-btn-default" style="color: #f87171;">Logout</button>
      </form>
    </div>
  </div>
  <h2 style="margin-top: 0;">Write Queue</h2>
  <p>Review and approve write requests from agents.</p>

  <div class="filter-bar" id="filter-bar">
    ${filterLinks}
    <div class="clear-section">
      
      ${filter === 'completed' && counts.completed > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'completed\')">Clear Completed</button>' : ''}
      ${filter === 'failed' && counts.failed > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'failed\')">Clear Failed</button>' : ''}
      ${filter === 'rejected' && counts.rejected > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'rejected\')">Clear Rejected</button>' : ''}
      ${filter === 'all' && (counts.completed > 0 || counts.failed > 0 || counts.rejected > 0) ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'all\')">Clear All Non-Pending</button>' : ''}
    </div>
    <div class="export-section">
      <a href="/ui/queue/export?format=json" class="btn-sm btn-secondary">Export JSON</a>
      <a href="/ui/queue/export?format=csv" class="btn-sm btn-secondary">Export CSV</a>
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

      // Add rejection/withdraw reason if present
      if (entry.rejection_reason && (entry.status === 'rejected' || entry.status === 'withdrawn')) {
        const existing = el.querySelector('.rejection-reason');
        if (!existing) {
          const label = entry.status === 'withdrawn' ? 'Withdraw reason' : 'Rejection reason';
          const reasonHtml = '<div class="rejection-reason"><strong>' + label + ':</strong> ' + escapeHtml(entry.rejection_reason) + '</div>';
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
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      const socket = io();
      socket.on('counts', function(data) {
        const queueBadge = document.getElementById('queue-badge');
        if (queueBadge) {
          if (data.queue.pending > 0) {
            queueBadge.textContent = data.queue.pending;
            queueBadge.style.display = '';
          } else {
            queueBadge.style.display = 'none';
          }
        }
        const msgBadge = document.getElementById('messages-badge');
        if (msgBadge) {
          if (data.messages.pending > 0) {
            msgBadge.textContent = data.messages.pending;
            msgBadge.style.display = '';
          } else {
            msgBadge.style.display = 'none';
          }
        }
        const msgNav = document.getElementById('messages-nav');
        if (msgNav) {
          msgNav.style.display = data.messagingEnabled ? '' : 'none';
        }
      });

      // Localize UTC dates to browser timezone
      document.querySelectorAll('.utc-date').forEach(function(el) {
        const utc = el.dataset.utc;
        if (utc) {
          el.textContent = new Date(utc).toLocaleString();
        }
      });
      // Localize title attributes with UTC dates
      document.querySelectorAll('.utc-title').forEach(function(el) {
        const utc = el.dataset.utc;
        if (utc) {
          el.title = 'Notified at ' + new Date(utc).toLocaleString();
        }
      });
    });
  </script>
</body>
</html>`;
}

function renderMessagesPage(messages, filter, counts, mode, pendingQueueCount = 0, pendingMessagesCount = 0) {
  const messagingMode = mode;
  const escapeHtml = (str) => {
    if (typeof str !== 'string') str = String(str);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString();
  };

  const localDate = (dateStr) => {
    if (!dateStr) return '';
    return `<span class="utc-date" data-utc="${dateStr}">${formatDate(dateStr)}</span>`;
  };

  const statusBadge = (status) => {
    const colors = {
      pending: 'background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);',
      delivered: 'background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);',
      rejected: 'background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3);'
    };
    return `<span class="status" style="${colors[status] || ''}">${status}</span>`;
  };

  const renderMessage = (msg) => {
    let actions = '';
    if (msg.status === 'pending') {
      actions = `
        <div class="message-actions">
          <button type="button" class="btn-primary btn-sm" onclick="approveMessage('${msg.id}')">Approve</button>
          <input type="text" id="reason-${msg.id}" placeholder="Rejection reason (optional)" class="reject-input" style="width: 200px;">
          <button type="button" class="btn-danger btn-sm" onclick="rejectMessage('${msg.id}')">Reject</button>
        </div>
      `;
    }

    let rejectionSection = '';
    if (msg.rejection_reason) {
      rejectionSection = `
        <div class="rejection-reason">
          <strong>Rejection reason:</strong> ${escapeHtml(msg.rejection_reason)}
        </div>
      `;
    }

    return `
      <div class="card message-entry" id="message-${msg.id}" data-status="${msg.status}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
          <div class="entry-header">
            <strong>${escapeHtml(msg.from_agent)}</strong> → <strong>${escapeHtml(msg.to_agent)}</strong>
            <span class="status-badge">${statusBadge(msg.status)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="help" style="margin: 0;">${localDate(msg.created_at)}</span>
            <button type="button" class="delete-btn" onclick="deleteMessage('${msg.id}')" title="Delete">&times;</button>
          </div>
        </div>

        <div class="message-content">
          <pre style="white-space: pre-wrap; word-wrap: break-word; margin: 0; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px;">${escapeHtml(msg.message)}</pre>
        </div>

        ${rejectionSection}
        ${actions}
      </div>
    `;
  };

  const filters = ['all', 'pending', 'delivered', 'rejected'];
  const filterLinks = filters.map(f =>
    `<a href="/ui/messages?filter=${f}" class="filter-link ${filter === f ? 'active' : ''}">${f}${counts[f] > 0 ? ` (${counts[f]})` : ''}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Agent Messages</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    .filter-bar { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; align-items: center; }
    .filter-link {
      padding: 10px 20px;
      border-radius: 25px;
      text-decoration: none;
      background: rgba(255, 255, 255, 0.05);
      color: #9ca3af;
      font-weight: 600;
      font-size: 13px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: all 0.3s ease;
    }
    .filter-link:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #e5e7eb;
      border-color: rgba(255, 255, 255, 0.2);
    }
    .filter-link.active {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      border-color: transparent;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
    }
    .message-entry { margin-bottom: 20px; }
    .message-actions {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
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
    .reject-input {
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
    .reject-input::placeholder { color: #6b7280; }
    .mode-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      border: 1px solid rgba(99, 102, 241, 0.3);
    }
  </style>
</head>
<body>
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <a href="/ui" style="display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit;">
        <img src="/public/favicon.svg" alt="agentgate" style="height: 48px;">
        <h1 style="margin: 0;">agentgate</h1>
      </a>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/keys" class="nav-btn nav-btn-default">Agents</a>
      <a href="/ui/queue" class="nav-btn nav-btn-default" style="position: relative;">
        Write Queue
        <span id="queue-badge" class="badge" ${pendingQueueCount > 0 ? '' : 'style="display:none"'}>${pendingQueueCount}</span>
      </a>
      <a href="/ui/messages" id="messages-nav" class="nav-btn nav-btn-default" style="position: relative;${messagingMode === 'off' ? ' display:none;' : ''}">
        Messages
        <span id="messages-badge" class="badge" ${pendingMessagesCount > 0 ? '' : 'style="display:none"'}>${pendingMessagesCount}</span>
      </a>
      <div class="nav-divider"></div>
      <a href="/ui#settings" class="nav-btn nav-btn-default" title="Settings" >⚙️</a>
      <form method="POST" action="/ui/logout" style="margin: 0;">
        <button type="submit" class="nav-btn nav-btn-default" style="color: #f87171;">Logout</button>
      </form>
    </div>
  </div>
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <h2 style="margin: 0;">Agent Messages</h2>
    <span class="mode-badge">Mode: ${mode}</span>
  </div>
  <p>Review and approve messages between agents${mode === 'supervised' ? ' (supervised mode)' : ''}.</p>

  <!-- Broadcast Section -->
  <div class="card" style="margin-bottom: 24px;">
    <h3 style="margin-top: 0; display: flex; align-items: center; gap: 8px;">
      <span>📢</span> Broadcast Message
    </h3>
    <p class="help" style="margin-bottom: 16px;">Send a message to all agents with webhooks configured.</p>
    <form method="POST" action="/ui/broadcast" id="broadcast-form">
      <textarea 
        name="message" 
        id="broadcast-message"
        placeholder="Enter your broadcast message..." 
        rows="3" 
        style="width: 100%; margin-bottom: 12px; padding: 12px; background: rgba(15, 15, 25, 0.6); border: 2px solid rgba(99, 102, 241, 0.2); border-radius: 8px; color: #f3f4f6; font-family: inherit; resize: vertical;"
        required
      ></textarea>
      <div style="display: flex; gap: 12px; align-items: center;">
        <button type="submit" class="btn-primary" id="broadcast-btn">Send Broadcast</button>
        <span id="broadcast-status" class="help" style="margin: 0;"></span>
      </div>
    </form>
  </div>

  <h3>Message Queue</h3>

  <div class="filter-bar" id="filter-bar">
    ${filterLinks}
    <div class="clear-section">
      ${filter === 'delivered' && counts.delivered > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'delivered\')">Clear Delivered</button>' : ''}
      ${filter === 'rejected' && counts.rejected > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'rejected\')">Clear Rejected</button>' : ''}
      ${filter === 'all' && (counts.delivered > 0 || counts.rejected > 0) ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'all\')">Clear All Non-Pending</button>' : ''}
    </div>
    <div class="export-section">
      <a href="/ui/messages/export?format=json" class="btn-sm btn-secondary">Export JSON</a>
      <a href="/ui/messages/export?format=csv" class="btn-sm btn-secondary">Export CSV</a>
    </div>
  </div>

  <div id="messages-container">
  ${messages.length === 0 ? `
    <div class="card empty-state">
      <p>No ${filter === 'all' ? '' : filter + ' '}messages</p>
    </div>
  ` : messages.map(renderMessage).join('')}
  </div>

  <script>
    function escapeHtml(str) {
      if (typeof str !== 'string') str = JSON.stringify(str, null, 2);
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Broadcast form handler
    document.getElementById('broadcast-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('broadcast-btn');
      const status = document.getElementById('broadcast-status');
      const message = document.getElementById('broadcast-message').value;

      btn.disabled = true;
      btn.textContent = 'Sending...';
      status.textContent = '';

      try {
        const res = await fetch('/ui/broadcast', {
          method: 'POST',
          headers: { 
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'message=' + encodeURIComponent(message)
        });
        const data = await res.json();

        if (data.error) {
          status.textContent = '❌ ' + data.error;
          status.style.color = '#f87171';
        } else {
          const deliveredNames = data.delivered.join(', ') || 'none';
          const failedCount = data.failed.length;
          status.textContent = '✅ Delivered to: ' + deliveredNames + (failedCount > 0 ? ' | Failed: ' + failedCount : '');
          status.style.color = '#34d399';
          document.getElementById('broadcast-message').value = '';
        }
      } catch (err) {
        status.textContent = '❌ Error: ' + err.message;
        status.style.color = '#f87171';
      }

      btn.disabled = false;
      btn.textContent = 'Send Broadcast';
    });

    async function approveMessage(id) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Approving...';

      try {
        const res = await fetch('/ui/messages/' + id + '/approve', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          const el = document.getElementById('message-' + id);
          if (el) {
            el.dataset.status = 'delivered';
            // Update status badge
            const badge = el.querySelector('.status-badge');
            if (badge) {
              badge.innerHTML = '<span class="status" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);">delivered</span>';
            }
            // Remove actions
            const actions = el.querySelector('.message-actions');
            if (actions) actions.remove();
          }
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

    async function rejectMessage(id) {
      const btn = event.target;
      const reason = document.getElementById('reason-' + id)?.value || '';
      btn.disabled = true;
      btn.textContent = 'Rejecting...';

      try {
        const res = await fetch('/ui/messages/' + id + '/reject', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ reason })
        });
        const data = await res.json();

        if (data.success) {
          const el = document.getElementById('message-' + id);
          if (el) {
            el.dataset.status = 'rejected';
            // Update status badge
            const badge = el.querySelector('.status-badge');
            if (badge) {
              badge.innerHTML = '<span class="status" style="background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3);">rejected</span>';
            }
            // Remove actions and add rejection reason
            const actions = el.querySelector('.message-actions');
            if (actions) {
              actions.outerHTML = '<div class="rejection-reason"><strong>Rejection reason:</strong> ' + escapeHtml(reason || 'No reason provided') + '</div>';
            }
          }
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

    async function deleteMessage(id) {
      if (!confirm('Delete this message?')) return;

      try {
        const res = await fetch('/ui/messages/' + id + '/delete', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          const el = document.getElementById('message-' + id);
          if (el) el.remove();

          // Show empty message if no messages left
          const container = document.getElementById('messages-container');
          if (container.querySelectorAll('.message-entry').length === 0) {
            container.innerHTML = '<div class="card empty-state"><p>No messages</p></div>';
          }
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function clearByStatus(status) {
      const btn = event.target;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Clearing...';

      try {
        const res = await fetch('/ui/messages/clear', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ status })
        });
        const data = await res.json();

        if (data.success) {
          // Remove cleared messages from DOM
          const container = document.getElementById('messages-container');
          if (status === 'all') {
            container.querySelectorAll('.message-entry').forEach(el => {
              if (el.dataset.status !== 'pending') el.remove();
            });
          } else {
            container.querySelectorAll('.message-entry[data-status="' + status + '"]').forEach(el => el.remove());
          }

          // Show empty message if no messages left
          if (container.querySelectorAll('.message-entry').length === 0) {
            container.innerHTML = '<div class="card empty-state"><p>No messages</p></div>';
          }

          // Hide the clear button
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
  </script>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      const socket = io();
      socket.on('counts', function(data) {
        const queueBadge = document.getElementById('queue-badge');
        if (queueBadge) {
          if (data.queue.pending > 0) {
            queueBadge.textContent = data.queue.pending;
            queueBadge.style.display = '';
          } else {
            queueBadge.style.display = 'none';
          }
        }
        const msgBadge = document.getElementById('messages-badge');
        if (msgBadge) {
          if (data.messages.pending > 0) {
            msgBadge.textContent = data.messages.pending;
            msgBadge.style.display = '';
          } else {
            msgBadge.style.display = 'none';
          }
        }
        const msgNav = document.getElementById('messages-nav');
        if (msgNav) {
          msgNav.style.display = data.messagingEnabled ? '' : 'none';
        }
      });

      // Localize UTC dates to browser timezone
      document.querySelectorAll('.utc-date').forEach(function(el) {
        const utc = el.dataset.utc;
        if (utc) {
          el.textContent = new Date(utc).toLocaleString();
        }
      });
    });
  </script>
</body>
</html>`;
}

function renderKeysPage(keys, error = null, newKey = null, pendingQueueCount = 0, pendingMessagesCount = 0, messagingMode = 'off') {
  const escapeHtml = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString();
  };

  const localDate = (dateStr) => {
    if (!dateStr) return '';
    return `<span class="utc-date" data-utc="${dateStr}">${formatDate(dateStr)}</span>`;
  };

  const renderKeyRow = (k) => `
    <tr id="key-${k.id}">
      <td><strong>${escapeHtml(k.name)}</strong></td>
      <td><code class="key-value">${escapeHtml(k.key_prefix)}</code></td>
      <td>
        ${k.webhook_url ? `
          <span class="webhook-status webhook-configured" title="${escapeHtml(k.webhook_url)}">✓ Configured</span>
        ` : `
          <span class="webhook-status webhook-none">Not set</span>
        `}
        <button type="button" class="btn-sm webhook-btn" data-id="${k.id}" data-name="${escapeHtml(k.name)}" data-url="${escapeHtml(k.webhook_url || '')}" data-token="${escapeHtml(k.webhook_token || '')}">Configure</button>
        ${k.webhook_url ? `<button type="button" class="btn-sm test-webhook-btn" data-name="${escapeHtml(k.name)}" style="margin-left: 4px;">Test</button>` : ''}
      </td>
      <td>${localDate(k.created_at)}</td>
      <td>
        <button type="button" class="delete-btn" onclick="deleteKey('${k.id}')" title="Delete">&times;</button>
      </td>
    </tr>
  `;

  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Agents</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <style>
  <script src="/socket.io/socket.io.js"></script>
    .keys-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .keys-table th, .keys-table td { padding: 12px; text-align: left; border-bottom: 1px solid #374151; }
    .keys-table th { font-weight: 600; color: #9ca3af; font-size: 14px; }
    .key-value { background: #1f2937; padding: 4px 8px; border-radius: 4px; font-size: 13px; color: #e5e7eb; }
    .new-key-banner { background: #065f46; border: 1px solid #10b981; padding: 16px; border-radius: 8px; margin-bottom: 20px; color: #d1fae5; }
    .new-key-banner code { background: #1f2937; color: #10b981; padding: 8px 12px; border-radius: 4px; display: block; margin-top: 8px; font-size: 14px; word-break: break-all; }
    .delete-btn { background: none; border: none; color: #f87171; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; font-weight: bold; }
    .delete-btn:hover { color: #dc2626; }
    .back-link { color: #a78bfa; text-decoration: none; font-weight: 500; }
    .back-link:hover { text-decoration: underline; }
    .error-message { background: #7f1d1d; color: #fecaca; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
    .webhook-status { font-size: 12px; padding: 4px 8px; border-radius: 4px; margin-right: 8px; }
    .webhook-configured { background: #065f46; color: #6ee7b7; }
    .webhook-none { background: #374151; color: #9ca3af; }
    .btn-sm { font-size: 12px; padding: 4px 8px; background: #4f46e5; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .btn-sm:hover { background: #4338ca; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: #1f2937; border-radius: 12px; padding: 24px; max-width: 500px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
    .modal h3 { margin: 0 0 16px 0; color: #f3f4f6; }
    .modal label { display: block; margin-bottom: 4px; color: #d1d5db; font-size: 14px; }
    .modal input { width: 100%; padding: 10px; border: 1px solid #374151; border-radius: 6px; background: #111827; color: #f3f4f6; margin-bottom: 12px; box-sizing: border-box; }
    .modal input:focus { border-color: #6366f1; outline: none; }
    .modal-buttons { display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px; }
    .modal .help-text { font-size: 12px; color: #9ca3af; margin-top: -8px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <a href="/ui" style="display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit;">
        <img src="/public/favicon.svg" alt="agentgate" style="height: 48px;">
        <h1 style="margin: 0;">agentgate</h1>
      </a>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/keys" class="nav-btn nav-btn-default">Agents</a>
      <a href="/ui/queue" class="nav-btn nav-btn-default" style="position: relative;">
        Write Queue
        <span id="queue-badge" class="badge" ${pendingQueueCount > 0 ? '' : 'style="display:none"'}>${pendingQueueCount}</span>
      </a>
      <a href="/ui/messages" id="messages-nav" class="nav-btn nav-btn-default" style="position: relative;${messagingMode === 'off' ? ' display:none;' : ''}">
        Messages
        <span id="messages-badge" class="badge" ${pendingMessagesCount > 0 ? '' : 'style="display:none"'}>${pendingMessagesCount}</span>
      </a>
      <div class="nav-divider"></div>
      <a href="/ui#settings" class="nav-btn nav-btn-default" title="Settings" >⚙️</a>
      <form method="POST" action="/ui/logout" style="margin: 0;">
        <button type="submit" class="nav-btn nav-btn-default" style="color: #f87171;">Logout</button>
      </form>
    </div>
  </div>
  <h2 style="margin-top: 0;">Agents</h2>
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
            <th>Webhook</th>
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

  <!-- Webhook Modal -->
  <div id="webhook-modal" class="modal-overlay">
    <div class="modal">
      <h3>Configure Webhook for <span id="modal-agent-name"></span></h3>
      <p style="color: #9ca3af; font-size: 14px; margin-bottom: 16px;">
        When messages or queue updates are ready, agentgate will POST to this URL.
      </p>
      <form id="webhook-form">
        <input type="hidden" id="webhook-agent-id" name="id">
        <label for="webhook-url">Webhook URL</label>
        <input type="url" id="webhook-url" name="webhook_url" placeholder="https://your-agent-gateway.com/webhook">
        <p class="help-text">The endpoint that will receive POST notifications</p>

        <label for="webhook-token">Authorization Token (optional)</label>
        <input type="text" id="webhook-token" name="webhook_token" placeholder="secret-token">
        <p class="help-text">Sent as Bearer token in Authorization header</p>

        <div class="modal-buttons">
          <button type="button" class="btn-secondary" onclick="closeWebhookModal()">Cancel</button>
          <button type="submit" class="btn-primary">Save Webhook</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function copyKey(key, btn) {
      navigator.clipboard.writeText(key).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    function showWebhookModal(btn) {
      document.getElementById('webhook-agent-id').value = btn.dataset.id;
      document.getElementById('modal-agent-name').textContent = btn.dataset.name;
      document.getElementById('webhook-url').value = btn.dataset.url;
      document.getElementById('webhook-token').value = btn.dataset.token;
      document.getElementById('webhook-modal').classList.add('active');
    }

    function closeWebhookModal() {
      document.getElementById('webhook-modal').classList.remove('active');
    }

    // Attach click handlers to webhook buttons
    document.querySelectorAll('.webhook-btn').forEach(btn => {
      btn.addEventListener('click', () => showWebhookModal(btn));
    });

    // Attach click handlers to test webhook buttons
    document.querySelectorAll('.test-webhook-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        const originalText = btn.textContent;
        btn.textContent = 'Testing...';
        btn.disabled = true;

        try {
          const res = await fetch('/api/agents/' + encodeURIComponent(name) + '/test-webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const data = await res.json();

          if (data.success) {
            btn.textContent = '✓ OK';
            btn.style.color = '#34d399';
            setTimeout(() => {
              btn.textContent = originalText;
              btn.style.color = '';
              btn.disabled = false;
            }, 2000);
          } else {
            btn.textContent = '✗ ' + (data.status || 'Error');
            btn.style.color = '#f87171';
            alert('Webhook test failed: ' + data.message);
            setTimeout(() => {
              btn.textContent = originalText;
              btn.style.color = '';
              btn.disabled = false;
            }, 2000);
          }
        } catch (err) {
          btn.textContent = '✗ Error';
          btn.style.color = '#f87171';
          alert('Error: ' + err.message);
          setTimeout(() => {
            btn.textContent = originalText;
            btn.style.color = '';
            btn.disabled = false;
          }, 2000);
        }
      });
    });

    document.getElementById('webhook-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('webhook-agent-id').value;
      const webhookUrl = document.getElementById('webhook-url').value;
      const webhookToken = document.getElementById('webhook-token').value;

      try {
        const res = await fetch('/ui/keys/' + id + '/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ webhook_url: webhookUrl, webhook_token: webhookToken })
        });
        const data = await res.json();

        if (data.success) {
          closeWebhookModal();
          // Reload to show updated status
          window.location.reload();
        } else {
          alert(data.error || 'Failed to save webhook');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });

    // Close modal on overlay click
    document.getElementById('webhook-modal').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        closeWebhookModal();
      }
    });

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
              table.outerHTML = '<p style="color: #9ca3af; text-align: center; padding: 20px;">No API keys yet. Create one above.</p>';
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
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      const socket = io();
      socket.on('counts', function(data) {
        const queueBadge = document.getElementById('queue-badge');
        if (queueBadge) {
          if (data.queue.pending > 0) {
            queueBadge.textContent = data.queue.pending;
            queueBadge.style.display = '';
          } else {
            queueBadge.style.display = 'none';
          }
        }
        const msgBadge = document.getElementById('messages-badge');
        if (msgBadge) {
          if (data.messages.pending > 0) {
            msgBadge.textContent = data.messages.pending;
            msgBadge.style.display = '';
          } else {
            msgBadge.style.display = 'none';
          }
        }
        const msgNav = document.getElementById('messages-nav');
        if (msgNav) {
          msgNav.style.display = data.messagingEnabled ? '' : 'none';
        }
      });

      // Localize UTC dates to browser timezone
      document.querySelectorAll('.utc-date').forEach(function(el) {
        const utc = el.dataset.utc;
        if (utc) {
          el.textContent = new Date(utc).toLocaleString();
        }
      });
    });
  </script>
</body>
</html>`;
}

export default router;
