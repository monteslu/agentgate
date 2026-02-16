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
    agentWithdrawEnabled
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
  res.redirect('/ui');
});

router.post('/queue/settings/agent-withdraw', (req, res) => {
  const enabled = req.body.enabled === 'true' || req.body.enabled === '1';
  setAgentWithdrawEnabled(enabled);
  res.redirect('/ui');
});

export default router;
