// Main UI router - refactored to import from sub-modules
// This replaces the old monolithic ui.js

import { Router } from 'express';
import {
  listAccounts, getSetting,
  getPendingQueueCount, getMessagingMode, listPendingMessages,
  getSharedQueueVisibility, getAgentWithdrawEnabled
} from '../lib/db.js';
import { getHsyncUrl, isHsyncConnected } from '../lib/hsyncManager.js';
import { registerAllRoutes, renderAllCards } from './ui/index.js';

// Import sub-routers from new modules
import authRouter, { requireAuth } from './ui/auth.js';
import settingsRouter from './ui/settings.js';
import queueRouter from './ui/queue.js';
import messagesRouter from './ui/messages.js';
import keysRouter from './ui/keys.js';
import { PORT, BASE_URL, navHeader, socketScript, copyScript } from './ui/shared.js';

const router = Router();

// Apply auth middleware to all routes
router.use(requireAuth);

// Mount auth routes (login, logout, setup-password)
router.use('/', authRouter);

// Main dashboard
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

  res.send(renderDashboard(accounts, {
    hsyncConfig, hsyncUrl, hsyncConnected,
    pendingQueueCount, messagingMode, pendingMessagesCount,
    sharedQueueVisibility, agentWithdrawEnabled
  }));
});

// Register all service routes (github, bluesky, reddit, etc.)
registerAllRoutes(router, BASE_URL);

// Mount settings routes (hsync, messaging mode, queue settings)
router.use('/', settingsRouter);

// Mount queue routes at /queue
router.use('/queue', queueRouter);

// Mount messages routes at /messages
router.use('/messages', messagesRouter);

// Mount keys routes at /keys
router.use('/keys', keysRouter);

// Dashboard render function
function renderDashboard(accounts, opts) {
  const {
    hsyncConfig, hsyncUrl, hsyncConnected,
    pendingQueueCount, messagingMode, pendingMessagesCount,
    sharedQueueVisibility, agentWithdrawEnabled
  } = opts;

  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Admin</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <script src="/socket.io/socket.io.js"></script>
  ${copyScript()}
  ${socketScript()}
</head>
<body>
  ${navHeader({ pendingQueueCount, pendingMessagesCount, messagingMode })}
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

export default router;
