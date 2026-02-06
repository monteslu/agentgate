import { Router } from 'express';
import {
  getServiceAccess,
  setServiceAccessMode,
  setServiceAgents,
  listServicesWithAccess,
  listApiKeys,
  checkServiceAccess
} from '../lib/db.js';

const router = Router();

// GET /api/services - List services with access info (filtered by agent access)
router.get('/', (req, res) => {
  const agentName = req.apiKeyInfo?.name;
  const allServices = listServicesWithAccess();
  
  // Filter to only show services the agent has access to
  const accessibleServices = allServices.filter(svc => {
    const access = checkServiceAccess(svc.service, svc.account_name, agentName);
    return access.allowed;
  });
  
  res.json({ services: accessibleServices });
});

// GET /api/services/:service/:account/access - Get access config for a service/account
router.get('/:service/:account/access', (req, res) => {
  const { service, account } = req.params;
  const agentName = req.apiKeyInfo?.name;
  
  // Check if agent has access to this service
  const accessCheck = checkServiceAccess(service, account, agentName);
  if (!accessCheck.allowed) {
    return res.status(403).json({
      error: `You do not have access to ${service}/${account}`,
      reason: accessCheck.reason
    });
  }
  
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

  // Normalize agent format
  const normalizedAgents = agents.map(a => ({
    name: a.name,
    allowed: a.allowed !== false // default to true if not specified
  }));

  setServiceAgents(service, account, normalizedAgents);
  res.json({ success: true, agents: normalizedAgents });
});

export default router;
