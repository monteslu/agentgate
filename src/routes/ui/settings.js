// Settings routes - hsync, messaging mode, queue settings
import { Router } from 'express';
import {
  getSetting, setSetting, deleteSetting,
  getMessagingMode, setMessagingMode,
  getSharedQueueVisibility, setSharedQueueVisibility,
  getAgentWithdrawEnabled, setAgentWithdrawEnabled
} from '../../lib/db.js';
import { connectHsync, disconnectHsync } from '../../lib/hsyncManager.js';
import { PORT } from './shared.js';

const router = Router();

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
