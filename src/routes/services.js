import { Router } from 'express';
import {
  listServicesWithAccess,
  checkServiceAccess,
  checkBypassAuth,
  addPathBlock,
  removePathBlock,
  getPathBlocks
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

// GET /api/services/:service/:account/access - Get YOUR access info for a service/account
// SECURITY: Only returns the calling agent's own access info, NOT other agents
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
  
  // SECURITY FIX: Only return the calling agent's own access info
  // Do NOT return the full agent list (that would leak other agents' info)
  const agentBypass = agentName ? checkBypassAuth(service, account, agentName) : false;
  
  res.json({
    service,
    account_name: account,
    your_access: {
      allowed: true,
      bypass_auth: agentBypass
    }
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

// ============================================
// Path Block Management
// ============================================

// GET /api/services/:service/:account/path-blocks?agent=X
router.get('/:service/:account/path-blocks', (req, res) => {
  const { service, account } = req.params;
  const agent = req.query.agent;
  if (!agent) {
    return res.status(400).json({ error: 'agent query parameter is required' });
  }
  const blocks = getPathBlocks(service, account, agent);
  res.json({ blocks });
});

// POST /api/services/:service/:account/path-blocks
router.post('/:service/:account/path-blocks', (req, res) => {
  const { service, account } = req.params;
  const { agent, method, pathPattern } = req.body;
  if (!agent || !method || !pathPattern) {
    return res.status(400).json({ error: 'agent, method, and pathPattern are required' });
  }
  addPathBlock(service, account, agent, method, pathPattern);
  res.json({ ok: true });
});

// DELETE /api/services/:service/:account/path-blocks
router.delete('/:service/:account/path-blocks', (req, res) => {
  const { service, account } = req.params;
  const { agent, method, pathPattern } = req.body;
  if (!agent || !method || !pathPattern) {
    return res.status(400).json({ error: 'agent, method, and pathPattern are required' });
  }
  removePathBlock(service, account, agent, method, pathPattern);
  res.json({ ok: true });
});

export const routeMeta = {
  name: 'Services',
  description: 'Service discovery and access control management',
  category: 'internal',
  endpoints: [
    {
      method: 'GET',
      path: '/api/services',
      description: 'List services accessible to the authenticated agent',
      params: {},
      auth: 'agent'
    },
    {
      method: 'GET',
      path: '/api/services/:service/:account/access',
      description: 'Get your access info for a specific service/account',
      params: {},
      auth: 'agent'
    },
    {
      method: 'GET',
      path: '/api/services/:service/:account/access/agents/:agentName/bypass',
      description: 'Check bypass_auth status (own status only)',
      params: {},
      auth: 'agent'
    },
    {
      method: 'GET',
      path: '/api/services/:service/:account/path-blocks',
      description: 'Get path blocks for an agent',
      params: {
        query: {
          agent: { type: 'string', required: true, description: 'Agent name' }
        }
      },
      auth: 'agent'
    },
    {
      method: 'POST',
      path: '/api/services/:service/:account/path-blocks',
      description: 'Add a path block rule',
      params: {
        body: {
          agent: { type: 'string', required: true, description: 'Agent name' },
          method: { type: 'string', required: true, description: 'HTTP method' },
          pathPattern: { type: 'string', required: true, description: 'Path pattern to block' }
        }
      },
      auth: 'agent'
    },
    {
      method: 'DELETE',
      path: '/api/services/:service/:account/path-blocks',
      description: 'Remove a path block rule',
      params: {
        body: {
          agent: { type: 'string', required: true, description: 'Agent name' },
          method: { type: 'string', required: true, description: 'HTTP method' },
          pathPattern: { type: 'string', required: true, description: 'Path pattern to unblock' }
        }
      },
      auth: 'agent'
    }
  ]
};

export default router;
