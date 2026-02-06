import { Router } from 'express';
import {
  getServiceAccess,
  listServicesWithAccess,
  checkServiceAccess,
  checkBypassAuth
} from '../lib/db.js';

const router = Router();

// GET /api/services - List services with access info (filtered by agent access)
// Includes bypass_auth status for the calling agent
router.get('/', (req, res) => {
  const agentName = req.apiKeyInfo?.name;
  const allServices = listServicesWithAccess();
  
  // Filter to only show services the agent has access to
  // And include bypass_auth status for this agent
  const accessibleServices = allServices
    .filter(svc => {
      const access = checkServiceAccess(svc.service, svc.account_name, agentName);
      return access.allowed;
    })
    .map(svc => ({
      ...svc,
      bypass_auth: agentName ? checkBypassAuth(svc.service, svc.account_name, agentName) : false
    }));
  
  res.json({ services: accessibleServices });
});

// GET /api/services/:service/:account/access - Get access config for a service/account
// Returns the agent's own access info (read-only)
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
  
  // Return access info including this agent's bypass status
  const access = getServiceAccess(service, account);
  const agentBypass = agentName ? checkBypassAuth(service, account, agentName) : false;
  
  res.json({
    ...access,
    your_bypass_auth: agentBypass
  });
});

// NOTE: Configuration endpoints (PUT access mode, POST agents, PUT bypass) 
// have been REMOVED from the API for security.
// All access configuration must be done through the Admin UI at /ui/access
// which requires admin authentication.

// GET /api/services/:service/:account/access/agents/:agentName/bypass - Check bypass_auth (read-only)
// Agents can check their own bypass status
router.get('/:service/:account/access/agents/:agentName/bypass', (req, res) => {
  const { service, account, agentName } = req.params;
  const callingAgent = req.apiKeyInfo?.name;
  
  // Agents can only check their own bypass status
  if (callingAgent && callingAgent.toLowerCase() !== agentName.toLowerCase()) {
    return res.status(403).json({ 
      error: 'You can only check your own bypass status'
    });
  }
  
  const hasBypass = checkBypassAuth(service, account, agentName);
  res.json({ 
    service,
    account,
    agent: agentName,
    bypass_auth: hasBypass
  });
});

export default router;
