// Dynamic proxy for custom services (#249)
// Loads enabled custom services and proxies requests to upstream APIs
import { Router } from 'express';
import { readOnlyEnforce } from '../lib/middleware.js';
import { injectAuth, assertNotPrivateUrl, buildPinnedUrl } from '../services/customServiceService.js';
import { getCustomServiceAccount, getCustomService } from '../lib/db.js';

const router = Router();

/**
 * Match a request path against an endpoint definition path pattern
 * e.g. /devices/{deviceId}/status matches /devices/abc123/status
 * Returns extracted path params or null if no match
 */
function matchEndpointPath(pattern, requestPath) {
  const patternParts = pattern.split('/').filter(Boolean);
  const requestParts = requestPath.split('/').filter(Boolean);
  if (patternParts.length !== requestParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.startsWith('{') && pp.endsWith('}')) {
      params[pp.slice(1, -1)] = requestParts[i];
    } else if (pp !== requestParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Simple JSON Schema validation (top-level properties only)
 * Returns array of error strings, empty if valid
 */
function validateSchema(data, schema, prefix) {
  const errors = [];
  if (!schema || schema.type !== 'object' || !schema.properties) return errors;

  const required = schema.required || [];
  for (const field of required) {
    if (data[field] === undefined || data[field] === null) {
      errors.push({ path: `${prefix}.${field}`, message: 'is required' });
    }
  }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const val = data[key];
    if (val === undefined) continue;

    if (propSchema.type === 'string' && typeof val !== 'string') {
      errors.push({ path: `${prefix}.${key}`, message: 'must be string' });
    } else if (propSchema.type === 'integer' && !Number.isInteger(Number(val))) {
      errors.push({ path: `${prefix}.${key}`, message: 'must be integer' });
    } else if (propSchema.type === 'number' && isNaN(Number(val))) {
      errors.push({ path: `${prefix}.${key}`, message: 'must be number' });
    } else if (propSchema.type === 'boolean' && typeof val !== 'boolean') {
      errors.push({ path: `${prefix}.${key}`, message: 'must be boolean' });
    }

    if (propSchema.enum && !propSchema.enum.includes(val)) {
      errors.push({ path: `${prefix}.${key}`, message: `must be one of: ${propSchema.enum.join(', ')}` });
    }
  }
  return errors;
}

/**
 * Build the upstream URL by substituting path params into the endpoint path
 */
function buildUpstreamUrl(baseUrl, endpointPath, pathParams, queryParams) {
  let path = endpointPath;
  for (const [key, val] of Object.entries(pathParams)) {
    path = path.replace(`{${key}}`, encodeURIComponent(val));
  }
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  if (queryParams) {
    for (const [key, val] of Object.entries(queryParams)) {
      if (val !== undefined && val !== null) {
        url.searchParams.set(key, val);
      }
    }
  }
  return url.toString();
}

// Design decisions for custom proxy routes:
//
// 1. No writeProxy / approval queue: Custom services intentionally bypass the write
//    approval queue used by built-in services. POST/PUT/DELETE go directly upstream.
//    Rationale: custom services are explicitly configured by the admin, who controls
//    which endpoints are exposed and to whom. The admin takes responsibility for the
//    operations they define. readOnlyEnforce is still respected as a global safety net.
//
// 2. No serviceAccessCheck: Built-in service access checks are not applied here.
//    Custom services are user-defined, not built-in — they have their own access
//    control via account-level enabled/disabled flags and endpoint whitelisting.
//
// Main handler: /api/custom/{serviceName}/{accountName}/...
// readOnlyEnforce is applied here rather than in index.js to avoid import conflicts
router.all('/:serviceName/:accountName/*', readOnlyEnforce, async (req, res) => {
  const { serviceName, accountName } = req.params;
  const restPath = '/' + req.params[0]; // everything after accountName

  // Load service definition
  const service = getCustomService(serviceName);
  if (!service || !service.enabled) {
    return res.status(404).json({ error: `Custom service '${serviceName}' not found or disabled` });
  }

  // Load account credentials
  const account = getCustomServiceAccount(serviceName, accountName);
  if (!account || !account.enabled) {
    return res.status(404).json({ error: `Account '${accountName}' not found for service '${serviceName}'` });
  }

  // Find matching endpoint
  const method = req.method.toUpperCase();
  let matchedEndpoint = null;
  let pathParams = {};

  for (const ep of service.endpoints) {
    if (ep.method.toUpperCase() !== method) continue;
    const params = matchEndpointPath(ep.path, restPath);
    if (params) {
      matchedEndpoint = ep;
      pathParams = params;
      break;
    }
  }

  if (!matchedEndpoint) {
    return res.status(404).json({
      error: 'No matching endpoint found',
      service: serviceName,
      method,
      path: restPath,
      available: service.endpoints.map(e => `${e.method} ${e.path}`)
    });
  }

  // Validate path params
  if (matchedEndpoint.pathParams) {
    const errors = validateSchema(pathParams, matchedEndpoint.pathParams, 'path');
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', details: errors });
    }
  }

  // Validate query params
  if (matchedEndpoint.queryParams) {
    const errors = validateSchema(req.query, matchedEndpoint.queryParams, 'query');
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', details: errors });
    }
  }

  // Validate body
  if (matchedEndpoint.bodySchema && ['POST', 'PUT', 'PATCH'].includes(method)) {
    const errors = validateSchema(req.body || {}, matchedEndpoint.bodySchema, 'body');
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', details: errors });
    }
  }

  // Build upstream URL
  const query = { ...req.query };
  const headers = { 'Content-Type': 'application/json' };

  // Inject auth
  injectAuth(headers, query, service.auth_config, account.credentials);

  const upstreamUrl = buildUpstreamUrl(service.base_url, matchedEndpoint.path, pathParams, query);

  // SSRF protection: resolve DNS and check for private IPs
  // For HTTP: use DNS-pinned URL to prevent rebinding attacks
  // For HTTPS: use original URL (pinning breaks TLS cert validation)
  let fetchUrl;
  try {
    const { address, hostname, pinnable } = await assertNotPrivateUrl(upstreamUrl);
    if (pinnable) {
      fetchUrl = buildPinnedUrl(upstreamUrl, address);
      headers['Host'] = hostname;
    } else {
      fetchUrl = upstreamUrl;
    }
  } catch (err) {
    return res.status(403).json({ error: 'ssrf_blocked', message: err.message });
  }

  // Proxy request
  try {
    const fetchOptions = { method, headers };
    if (['POST', 'PUT', 'PATCH'].includes(method) && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    fetchOptions.signal = controller.signal;

    const upstream = await fetch(fetchUrl, fetchOptions);
    clearTimeout(timeout);

    const contentType = upstream.headers.get('content-type') || '';
    let body;
    if (contentType.includes('application/json')) {
      body = await upstream.json();
    } else {
      body = await upstream.text();
    }

    res.status(upstream.status).json({
      _custom_service: serviceName,
      _endpoint: matchedEndpoint.name,
      status: upstream.status,
      data: body
    });
  } catch (err) {
    // Log full error server-side for debugging; return generic message to client
    // to avoid leaking internal network details (hostnames, IPs, ports) from fetch failures
    console.error(`[custom-proxy] upstream error for ${serviceName}/${matchedEndpoint.name}:`, err);
    res.status(502).json({
      error: 'upstream_error',
      message: 'The upstream service request failed',
      service: serviceName,
      endpoint: matchedEndpoint.name
    });
  }
});

export default router;
