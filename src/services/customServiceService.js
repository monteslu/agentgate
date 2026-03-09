// Custom service business logic layer (#249)
import { lookup as dnsLookup } from 'dns/promises';
import https from 'https';
import http from 'http';

import {
  createCustomService as dbCreate,
  getCustomService as dbGet,
  listCustomServices as dbList,
  updateCustomService as dbUpdate,
  deleteCustomService as dbDelete,
  createCustomServiceAccount as dbCreateAccount,
  getCustomServiceAccount as dbGetAccount,
  listCustomServiceAccounts as dbListAccounts,
  updateCustomServiceAccount as dbUpdateAccount,
  deleteCustomServiceAccount as dbDeleteAccount,
  listEnabledCustomServices
} from '../lib/db.js';
import SERVICE_REGISTRY from '../lib/serviceRegistry.js';

// Validate service name: URL-safe, starts with letter
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Make an HTTP(S) request using a custom agent (for DNS-pinned HTTPS).
 * Returns { status, statusText }.
 */
function pinnedRequest(url, options, agent) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent,
      signal: options.signal
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Validate that a base URL is a valid HTTP(S) URL.
 */
function validateBaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid base URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL must use http or https protocol');
  }
}

/**
 * Check if an IP address is private/internal.
 */
function isPrivateIP(ip) {
  // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    if (mapped.includes('.')) {
      return isPrivateIP(mapped);
    }
  }

  // IPv4 private ranges
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
    if (parts[0] === 10) return true;                                          // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;     // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;                     // 192.168.0.0/16
    if (parts[0] === 127) return true;                                          // 127.0.0.0/8
    if (parts[0] === 169 && parts[1] === 254) return true;                     // 169.254.0.0/16 link-local
    if (parts[0] === 0) return true;                                            // 0.0.0.0/8
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;    // 100.64.0.0/10 CGNAT
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true; // 198.18.0.0/15 benchmarking
    if (parts[0] >= 240) return true;                                           // 240.0.0.0/4 reserved
    if (parts[0] === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true; // broadcast
  }

  // IPv6
  if (ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;   // fc00::/7 unique local
  if (ip.startsWith('fe80')) return true;                         // fe80::/10 link-local
  if (ip.startsWith('2001:db8')) return true;                     // 2001:db8::/32 documentation
  return false;
}

/**
 * Resolve a URL's hostname and verify it doesn't point to a private/internal IP (SSRF protection).
 *
 * For HTTP URLs: returns { address, hostname, pinnable: true } — callers can use the
 * resolved IP directly to prevent DNS rebinding (TOCTOU).
 *
 * For HTTPS URLs: returns { address, hostname, pinnable: false, agent } — an https.Agent
 * with a custom `lookup` function that returns the pre-resolved IP. This pins DNS for the
 * actual connection while preserving TLS hostname validation via SNI. Eliminates the
 * TOCTOU gap without breaking certificate validation. Fixes #340.
 */
export async function assertNotPrivateUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const isHttps = parsed.protocol === 'https:';

  // Check if hostname is already an IP
  if (isPrivateIP(hostname)) {
    throw new Error('Connections to private/internal addresses are not allowed');
  }
  // Resolve DNS
  try {
    const result = await dnsLookup(hostname);
    if (isPrivateIP(result.address)) {
      throw new Error('Connections to private/internal addresses are not allowed');
    }
    if (isHttps) {
      // Create a single-use agent that pins DNS to the resolved IP.
      // TLS SNI uses the original hostname (Node sets servername automatically),
      // so certificate validation works correctly against the hostname, not the IP.
      const family = result.family || 4;
      const pinnedAddress = result.address;
      const agent = new https.Agent({
        lookup: (_hostname, _opts, cb) => cb(null, pinnedAddress, family),
        maxSockets: 1,
        keepAlive: false
      });
      return { address: result.address, hostname, pinnable: false, agent };
    }
    return { address: result.address, hostname, pinnable: true, agent: null };
  } catch (err) {
    if (err.message.includes('private/internal')) throw err;
    throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
  }
}

/**
 * Build a DNS-pinned URL by replacing the hostname with the resolved IP.
 * Only use for HTTP (not HTTPS) — see assertNotPrivateUrl docs.
 */
export function buildPinnedUrl(originalUrl, resolvedIp) {
  const parsed = new URL(originalUrl);
  return `${parsed.protocol}//${resolvedIp}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}${parsed.search}`;
}

/**
 * Create a custom service definition
 */
export function createCustomService(data) {
  if (!data.name || !NAME_RE.test(data.name)) {
    throw new Error('Service name must match ^[a-z][a-z0-9_-]*$');
  }
  if (!data.baseUrl) {
    throw new Error('Base URL is required');
  }
  validateBaseUrl(data.baseUrl);
  if (!data.displayName) {
    throw new Error('Display name is required');
  }
  if (!data.authConfig || !data.authConfig.type) {
    throw new Error('Auth config with type is required');
  }
  // Check for name collision with built-in services (from registry)
  const builtinNames = Object.keys(SERVICE_REGISTRY);
  if (builtinNames.includes(data.name)) {
    throw new Error(`Service name '${data.name}' conflicts with a built-in service`);
  }
  const existing = dbGet(data.name);
  if (existing) {
    throw new Error(`Custom service '${data.name}' already exists`);
  }
  return dbCreate(data);
}

export function getCustomService(name) {
  return dbGet(name);
}

export function listCustomServices() {
  return dbList();
}

export function updateCustomService(name, updates) {
  const existing = dbGet(name);
  if (!existing) {
    throw new Error(`Custom service '${name}' not found`);
  }
  if (updates.baseUrl) {
    validateBaseUrl(updates.baseUrl);
  }
  return dbUpdate(name, updates);
}

export function deleteCustomService(name) {
  return dbDelete(name);
}

// Account CRUD
export function createAccount(serviceName, accountName, credentials) {
  if (!accountName || !accountName.trim()) {
    throw new Error('Account name is required');
  }
  return dbCreateAccount(serviceName, accountName, credentials);
}

export function getAccount(serviceName, accountName) {
  return dbGetAccount(serviceName, accountName);
}

export function listAccounts(serviceName) {
  return dbListAccounts(serviceName);
}

export function updateAccount(serviceName, accountName, updates) {
  return dbUpdateAccount(serviceName, accountName, updates);
}

export function deleteAccount(serviceName, accountName) {
  return dbDeleteAccount(serviceName, accountName);
}

/**
 * Get all enabled custom services with their accounts (for route registration)
 */
export function getEnabledServices() {
  return listEnabledCustomServices();
}

/**
 * Test connection to a custom service by making a GET request to baseUrl
 */
export async function testConnection(serviceName, accountName) {
  const service = dbGet(serviceName);
  if (!service) throw new Error('Service not found');

  let account = null;
  if (accountName) {
    account = dbGetAccount(serviceName, accountName);
    if (!account) throw new Error('Account not found');
  }

  const url = service.base_url;

  // SSRF protection: resolve DNS and check for private IPs
  const { address, hostname, pinnable, agent } = await assertNotPrivateUrl(url);

  // For HTTP, use DNS-pinned URL; for HTTPS, use original URL with pinned agent (#340)
  const fetchUrl = pinnable ? buildPinnedUrl(url, address) : url;
  const headers = {};
  if (pinnable) {
    headers['Host'] = hostname;
  }

  // Inject auth if account provided
  if (account) {
    injectAuth(headers, {}, service.auth_config, account.credentials);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    if (agent) {
      const resp = await pinnedRequest(fetchUrl, { method: 'GET', headers, signal: controller.signal }, agent);
      return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, statusText: resp.statusText };
    }
    const resp = await fetch(fetchUrl, { method: 'GET', headers, signal: controller.signal });
    return { ok: resp.ok, status: resp.status, statusText: resp.statusText };
  } catch (err) {
    return { ok: false, status: 0, statusText: err.message };
  } finally {
    clearTimeout(timeout);
    if (agent) agent.destroy();
  }
}

/**
 * Inject auth credentials into headers/query based on auth config
 */
export function injectAuth(headers, query, authConfig, credentials) {
  if (!authConfig || !credentials) return;
  const type = authConfig.type;

  if (type === 'bearer') {
    headers['Authorization'] = `Bearer ${credentials.token}`;
  } else if (type === 'basic') {
    const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  } else if (type === 'api-key') {
    const injection = authConfig.injection || 'header';
    if (injection === 'header') {
      headers[authConfig.headerName || 'X-API-Key'] = credentials.apiKey;
    } else if (injection === 'query') {
      query[authConfig.paramName || 'api_key'] = credentials.apiKey;
    }
  } else if (type === 'custom-header') {
    headers[credentials.headerName || authConfig.headerName] = credentials.headerValue;
  } else if (type === 'query-param') {
    query[credentials.paramName || authConfig.paramName] = credentials.paramValue;
  }
}
