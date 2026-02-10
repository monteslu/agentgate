// Settings routes - hsync, messaging mode, queue settings
import { Router } from 'express';
import {
  setSetting, deleteSetting, getSetting,
  setMessagingMode, getMessagingMode,
  getSharedQueueVisibility, setSharedQueueVisibility,
  getAgentWithdrawEnabled, setAgentWithdrawEnabled,
  getPendingQueueCount, listPendingMessages
} from '../../lib/db.js';
import { connectHsync, disconnectHsync, getHsyncUrl, isHsyncConnected } from '../../lib/hsyncManager.js';
import { PORT, htmlHead, navHeader, menuScript, socketScript, localizeScript, copyScript, escapeHtml } from './shared.js';

const router = Router();

// GET /settings - render settings page
router.get('/settings', (req, res) => {
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = listPendingMessages().length;
  const pendingQueueCount = getPendingQueueCount();
  const hsyncConfig = getSetting('hsync');
  const hsyncUrl = getHsyncUrl();
  const hsyncConnected = isHsyncConnected();
  const sharedQueueVisibility = getSharedQueueVisibility();
  const agentWithdrawEnabled = getAgentWithdrawEnabled();

  res.send(renderSettingsPage({
    messagingMode,
    pendingMessagesCount,
    pendingQueueCount,
    hsyncConfig,
    hsyncUrl,
    hsyncConnected,
    sharedQueueVisibility,
    agentWithdrawEnabled
  }));
});

function renderSettingsPage(options) {
  const {
    messagingMode, pendingMessagesCount, pendingQueueCount,
    hsyncConfig, hsyncUrl, hsyncConnected,
    sharedQueueVisibility, agentWithdrawEnabled
  } = options;

  return `
${htmlHead('Settings', { includeSocket: true })}
<body>
  ${navHeader({ pendingQueueCount, pendingMessagesCount, messagingMode })}

  <h2>Settings</h2>

  <!-- Agent Messaging -->
  <div class="card">
    <h3>Agent Messaging</h3>
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

  <!-- Queue Settings -->
  <div class="card">
    <h3>Queue Settings</h3>
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

  <!-- hsync Remote Access -->
  <div class="card">
    <h3>hsync (Remote Access) ${hsyncConnected ? '<span class="status configured">Connected</span>' : hsyncConfig?.enabled ? '<span class="status not-configured">Disconnected</span>' : ''}</h3>
    ${hsyncConfig?.enabled ? `
      <p>URL: <strong>${escapeHtml(hsyncConfig?.url || '')}</strong></p>
      ${hsyncUrl ? `<p>Public URL: <span class="copyable">${escapeHtml(hsyncUrl)} <button type="button" class="copy-btn" data-copy="${escapeHtml(hsyncUrl)}">Copy</button></span></p>` : '<p class="help">Connecting... (refresh page to see URL)</p>'}
      <form method="POST" action="/ui/hsync/delete">
        <button type="submit" class="btn-danger">Disable</button>
      </form>
    ` : `
      <p class="help">Use <a href="https://hsync.tech" target="_blank">hsync</a> to expose this gateway to remote agents without opening ports.</p>
      <form method="POST" action="/ui/hsync/setup">
        <label>URL</label>
        <input type="text" name="url" placeholder="https://yourname.hsync.tech" required>
        <label>Token (optional)</label>
        <input type="password" name="token" placeholder="Token if required">
        <button type="submit" class="btn-primary">Enable hsync</button>
      </form>
    `}
  </div>

  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
  ${copyScript()}
</body>
</html>`;
}

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

export default router;
