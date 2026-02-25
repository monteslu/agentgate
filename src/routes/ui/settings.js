// Settings routes - hsync, messaging mode, queue settings
import { Router } from 'express';
import {
  setSetting, deleteSetting, getSetting,
  setMessagingMode, getMessagingMode,
  getSharedQueueVisibility, setSharedQueueVisibility,
  getAgentWithdrawEnabled, setAgentWithdrawEnabled,
  getPendingQueueCount, listPendingMessages,
  setSidecarSecret, getSidecarSecretHash, clearSidecarSecret
} from '../../lib/db.js';
import { connectHsync, disconnectHsync, getHsyncUrl, isHsyncConnected } from '../../lib/hsyncManager.js';
import { PORT } from './shared.js';
import { renderPage } from '../../lib/render.js';

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
  const sidecarSecretConfigured = !!getSidecarSecretHash();

  renderPage(res, 'pages/settings', {
    title: 'Settings',
    includeSocket: true,
    pendingQueueCount,
    pendingMessagesCount,
    messagingMode,
    hsyncConfig,
    hsyncUrl,
    hsyncConnected,
    sharedQueueVisibility,
    agentWithdrawEnabled,
    sidecarSecretConfigured
  });
});

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
  const wantsJson = req.headers.accept?.includes('application/json');
  if (wantsJson) {
    return res.json({ ok: true, enabled });
  }
  res.redirect('/ui');
});

router.post('/queue/settings/agent-withdraw', (req, res) => {
  const enabled = req.body.enabled === 'true' || req.body.enabled === '1';
  setAgentWithdrawEnabled(enabled);
  const wantsJson = req.headers.accept?.includes('application/json');
  if (wantsJson) {
    return res.json({ ok: true, enabled });
  }
  res.redirect('/ui');
});

// Sidecar Secret — auto-generated, never user-supplied
router.post('/sidecar-secret/generate', async (req, res) => {
  const { randomBytes } = await import('crypto');
  const secret = randomBytes(32).toString('hex'); // 64-char hex, 256 bits
  await setSidecarSecret(secret);
  // Return the plaintext once — after this it can never be retrieved
  res.json({ secret });
});

router.post('/sidecar-secret/clear', (req, res) => {
  clearSidecarSecret();
  res.redirect('/ui/settings');
});

export default router;
