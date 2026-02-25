import bcrypt from 'bcrypt';
import { validateApiKey, checkServiceAccess, checkBypassAuth, createQueueEntry, markAutoApproved, updateQueueStatus, getAccountCredentials, getSidecarSecretHash } from './db.js';
import { getAccessToken, buildUrl, buildHeaders } from './queueExecutor.js';
import { emitCountUpdate } from './socketManager.js';
import { checkAuthBackoff, recordAuthFailure, clearAuthFailures } from './rateLimiter.js';

// API key auth middleware for /api routes
export async function apiKeyAuth(req, res, next) {
  // Check if IP is in backoff from previous failures
  const { blocked, retryAfter } = checkAuthBackoff(req.ip);
  if (blocked) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many failed authentication attempts', retryAfter });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    recordAuthFailure(req.ip);
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const key = authHeader.slice(7);
  const valid = await validateApiKey(key);
  if (!valid) {
    recordAuthFailure(req.ip);
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (!valid.enabled) {
    recordAuthFailure(req.ip);
    return res.status(403).json({ error: 'Agent is disabled' });
  }

  // Successful auth — clear any backoff
  clearAuthFailures(req.ip);

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

// Transparent write proxy middleware factory
// GET requests pass through to service routes; write requests are either
// executed immediately (bypass) or queued for approval (202 Accepted).
export function writeProxy(serviceName) {
  return async (req, res, next) => {
    // Only intercept explicit write methods; everything else passes through
    const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (!WRITE_METHODS.includes(req.method)) {
      return next();
    }

    // Extract account name from path (first segment)
    const pathSegments = req.path.split('/').filter(Boolean);
    const accountName = pathSegments[0];
    if (!accountName) {
      return res.status(400).json({ error: 'Missing account name in path' });
    }

    const agentName = req.apiKeyInfo?.name;
    if (!agentName) {
      return res.status(401).json({ error: 'Agent authentication required' });
    }

    // Check if account exists
    const creds = getAccountCredentials(serviceName, accountName);
    if (!creds) {
      return res.status(404).json({ error: `No ${serviceName} account named "${accountName}" is configured` });
    }

    // Build the upstream path (everything after the account name)
    const upstreamPath = '/' + pathSegments.slice(1).join('/');

    const hasBypass = checkBypassAuth(serviceName, accountName, agentName);

    if (hasBypass) {
      // Execute immediately with audit trail
      try {
        const requestEntry = {
          method: req.method,
          path: upstreamPath,
          body: req.body,
          headers: {}
        };

        // Create audit trail entry
        const entry = createQueueEntry(serviceName, accountName, [requestEntry], 'Transparent write proxy (bypass)', agentName);
        markAutoApproved(entry.id);
        updateQueueStatus(entry.id, 'approved');

        // Execute the request
        const token = await getAccessToken(serviceName, accountName);
        if (!token) {
          updateQueueStatus(entry.id, 'failed', { results: [{ error: `Failed to get access token for ${serviceName}/${accountName}` }] });
          emitCountUpdate();
          return res.status(502).json({ error: `Failed to get access token for ${serviceName}/${accountName}` });
        }

        const url = buildUrl(serviceName, accountName, upstreamPath);
        if (!url) {
          updateQueueStatus(entry.id, 'failed', { results: [{ error: `Unknown service or invalid configuration: ${serviceName}` }] });
          emitCountUpdate();
          return res.status(502).json({ error: `Unknown service or invalid configuration: ${serviceName}` });
        }

        const headers = buildHeaders(serviceName, token);
        const fetchOptions = {
          method: req.method,
          headers
        };

        if (req.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }

        const response = await fetch(url, fetchOptions);

        let responseBody;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          responseBody = await response.json();
        } else {
          responseBody = await response.text();
        }

        const status = response.ok ? 'completed' : 'failed';
        updateQueueStatus(entry.id, status, {
          results: [{ index: 0, ok: response.ok, status: response.status, body: responseBody }]
        });
        emitCountUpdate();

        return res.status(response.status).json(responseBody);
      } catch (err) {
        return res.status(502).json({ error: 'Bypass execution failed', message: err.message });
      }
    } else {
      // Queue for approval
      try {
        const requestEntry = {
          method: req.method,
          path: upstreamPath,
          body: req.body,
          headers: {}
        };

        const entry = createQueueEntry(serviceName, accountName, [requestEntry], 'Transparent write proxy', agentName);
        emitCountUpdate();

        return res.status(202).json({
          status: 'queued',
          id: entry.id,
          message: 'Awaiting approval'
        });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to queue request', message: err.message });
      }
    }
  };
}

// Sidecar secret check middleware
// If a sidecar secret is configured, requires X-Sidecar-Secret header on all API routes.
// Always strips the header after validation to prevent upstream leakage.
// Integrates with auth backoff to prevent brute-force attacks on the secret.
export async function sidecarSecretCheck(req, res, next) {
  const hash = getSidecarSecretHash();
  if (!hash) {
    // No secret configured — feature is optional, pass through
    return next();
  }

  // Check backoff BEFORE doing bcrypt — saves CPU when IP is already blocked
  const { blocked, retryAfter } = checkAuthBackoff(req.ip);
  if (blocked) {
    // Still strip the header even when blocked
    delete req.headers['x-sidecar-secret'];
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many failed authentication attempts', retryAfter });
  }

  const secret = req.headers['x-sidecar-secret'];
  // Always delete the header so it never leaks upstream
  delete req.headers['x-sidecar-secret'];

  if (!secret) {
    recordAuthFailure(req.ip);
    return res.status(401).json({ error: 'Missing or invalid sidecar secret' });
  }

  const valid = await bcrypt.compare(secret, hash);
  if (!valid) {
    recordAuthFailure(req.ip);
    return res.status(401).json({ error: 'Missing or invalid sidecar secret' });
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
