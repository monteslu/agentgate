import { validateApiKey, checkServiceAccess, getApiKeyByName } from './db.js';

// API key auth middleware for /api routes
export async function apiKeyAuth(req, res, next) {
  // Allow internal MCP requests (from services read action)
  if (req.headers['x-mcp-internal'] === 'true' && req.headers['x-agent-name']) {
    const agentName = req.headers['x-agent-name'];
    const agent = getApiKeyByName(agentName);
    if (agent && agent.enabled) {
      req.apiKeyInfo = { name: agent.name, enabled: true };
      return next();
    }
    return res.status(403).json({ error: 'Invalid internal MCP request' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const key = authHeader.slice(7);
  const valid = await validateApiKey(key);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (!valid.enabled) {
    return res.status(403).json({ error: 'Agent is disabled' });
  }


  req.apiKeyInfo = valid;
  next();
}

// Read-only enforcement - only allow GET requests to API
export function readOnlyEnforce(req, res, next) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Only GET requests allowed (read-only access)' });
  }
  next();
}

// Service access control middleware factory
// Checks if the agent has access to the requested service/account
export function serviceAccessCheck(serviceName) {
  return (req, res, next) => {
    const pathSegments = req.path.split('/').filter(Boolean);
    const accountName = pathSegments[0];
    if (!accountName) {
      return next();
    }

    const agentName = req.apiKeyInfo?.name;
    if (!agentName) {
      return next();
    }

    const access = checkServiceAccess(serviceName, accountName, agentName);
    if (!access.allowed) {
      return res.status(403).json({
        error: `Agent '${agentName}' does not have access to service '${serviceName}/${accountName}'`,
        reason: access.reason
      });
    }
    next();
  };
}
