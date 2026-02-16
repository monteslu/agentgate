// Service Access Control routes
import { Router } from 'express';
import {
  listServicesWithAccess,
  listApiKeys,
  getServiceAccess,
  setServiceAccessMode,
  setServiceAgentAccess,
  setBypassAuth,
  checkBypassAuth
} from '../../lib/db.js';
import { escapeHtml, renderAvatar } from './shared.js';
import { renderPage } from '../../lib/render.js';

const router = Router();

// Access Control page
router.get('/', (req, res) => {
  const services = listServicesWithAccess().map(svc => ({
    ...svc,
    access: getServiceAccess(svc.service, svc.account_name)
  }));
  const agents = listApiKeys();

  renderPage(res, 'pages/access', {
    title: 'Access Control',
    includeSocket: true,
    services,
    agents,
    renderAvatar,
    escapeHtml
  });
});

// Update access mode for a service
router.post('/:service/:account/mode', (req, res) => {
  const { service, account } = req.params;
  const { mode } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  try {
    setServiceAccessMode(service, account, mode);
    if (wantsJson) {
      return res.json({ success: true, mode });
    }
    res.redirect('/ui/access');
  } catch (err) {
    if (wantsJson) {
      return res.status(400).json({ error: err.message });
    }
    res.status(400).send(err.message);
  }
});

// Toggle agent access for a service
router.post('/:service/:account/agent/:agentName', (req, res) => {
  const { service, account, agentName } = req.params;
  const { allowed, bypass_auth } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  setServiceAgentAccess(service, account, agentName, allowed !== 'false', bypass_auth === 'true');

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/access');
});

// Toggle bypass_auth for an agent
router.post('/:service/:account/agent/:agentName/bypass', (req, res) => {
  const { service, account, agentName } = req.params;
  const { enabled } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  setBypassAuth(service, account, agentName, enabled === 'true' || enabled === true);

  if (wantsJson) {
    const hasBypass = checkBypassAuth(service, account, agentName);
    return res.json({ success: true, bypass_auth: hasBypass });
  }
  res.redirect('/ui/access');
});

export default router;
