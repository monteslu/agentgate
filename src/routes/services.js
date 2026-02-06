import { Router } from 'express';
import {
  getServiceAccess,
  setServiceAccessMode,
  setServiceAgents,
  listServicesWithAccess,
  listApiKeys,
  setBypassAuth,
  checkBypassAuth
} from '../lib/db.js';

const router = Router();

// GET /api/services - List all services with access info
router.get('/', (req, res) => {
  const services = listServicesWithAccess();
  res.json({ services });
});

// GET /api/services/:service/:account/access - Get access config for a service/account
router.get('/:service/:account/access', (req, res) => {
  const { service, account } = req.params;
  const access = getServiceAccess(service, account);
  res.json(access);
});

// PUT /api/services/:service/:account/access - Update access mode
router.put('/:service/:account/access', (req, res) => {
  const { service, account } = req.params;
  const { access_mode } = req.body;

  if (!access_mode) {
    return res.status(400).json({ error: 'access_mode is required' });
  }

  try {
    setServiceAccessMode(service, account, access_mode);
    res.json({ success: true, access_mode });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/services/:service/:account/access/agents - Set agent access list
router.post('/:service/:account/access/agents', (req, res) => {
  const { service, account } = req.params;
  const { agents } = req.body;

  if (!Array.isArray(agents)) {
    return res.status(400).json({ error: 'agents must be an array' });
  }

  // Validate agent names exist
  const validAgents = listApiKeys().map(k => k.name.toLowerCase());
  const invalidAgents = agents.filter(
    a => !validAgents.includes(a.name?.toLowerCase())
  );

  if (invalidAgents.length > 0) {
    return res.status(400).json({
      error: 'Invalid agent names',
      invalid: invalidAgents.map(a => a.name)
    });
  }

  // Normalize agent format (include bypass_auth)
  const normalizedAgents = agents.map(a => ({
    name: a.name,
    allowed: a.allowed !== false, // default to true if not specified
    bypass_auth: !!a.bypass_auth  // default to false
  }));

  setServiceAgents(service, account, normalizedAgents);
  res.json({ success: true, agents: normalizedAgents });
});

// PUT /api/services/:service/:account/access/agents/:agentName/bypass - Toggle bypass_auth
router.put('/:service/:account/access/agents/:agentName/bypass', (req, res) => {
  const { service, account, agentName } = req.params;
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  // Validate agent exists
  const validAgents = listApiKeys().map(k => k.name.toLowerCase());
  if (!validAgents.includes(agentName.toLowerCase())) {
    return res.status(404).json({ error: `Agent '${agentName}' not found` });
  }

  setBypassAuth(service, account, agentName, enabled);
  res.json({ 
    success: true, 
    service,
    account,
    agent: agentName,
    bypass_auth: enabled
  });
});

// GET /api/services/:service/:account/access/agents/:agentName/bypass - Check bypass_auth
router.get('/:service/:account/access/agents/:agentName/bypass', (req, res) => {
  const { service, account, agentName } = req.params;
  
  const hasBypass = checkBypassAuth(service, account, agentName);
  res.json({ 
    service,
    account,
    agent: agentName,
    bypass_auth: hasBypass
  });
});

export default router;
