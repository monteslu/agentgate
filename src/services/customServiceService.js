// Custom service business logic layer (#249)
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
 * Create a custom service definition
 */
export function createCustomService(data) {
  if (!data.name || !NAME_RE.test(data.name)) {
    throw new Error('Service name must match ^[a-z][a-z0-9_-]*$');
  }
  if (!data.baseUrl) {
    throw new Error('Base URL is required');
  }
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
  const headers = {};

  // Inject auth if account provided
  if (account) {
    injectAuth(headers, {}, service.auth_config, account.credentials);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    return { ok: resp.ok, status: resp.status, statusText: resp.statusText };
  } catch (err) {
    return { ok: false, status: 0, statusText: err.message };
  } finally {
    clearTimeout(timeout);
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
