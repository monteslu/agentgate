import { readdir, readFile, access } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { homedir } from 'os';

const DEFAULT_PLUGINS_DIR = join(homedir(), '.agentgate', 'plugins');
const loadedPlugins = new Map();

/**
 * Validate a plugin manifest has required fields
 * @param {object} manifest - Parsed manifest.json
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be a JSON object'] };
  }
  const requiredStrings = ['name', 'displayName', 'version'];
  for (const field of requiredStrings) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      errors.push(`Missing or invalid required field: ${field}`);
    }
  }
  if (manifest.name && !/^[a-z0-9_-]+$/.test(manifest.name)) {
    errors.push('name must be lowercase alphanumeric with hyphens/underscores only');
  }
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push('version must be semver (e.g. 1.0.0)');
  }
  if (manifest.auth !== undefined) {
    if (typeof manifest.auth !== 'object' || !manifest.auth.type) {
      errors.push('auth must be an object with a type field');
    }
  }
  if (manifest.operations !== undefined) {
    if (!Array.isArray(manifest.operations)) {
      errors.push('operations must be an array');
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Build serviceInfo from a validated manifest
 * @param {object} manifest - Validated manifest
 * @returns {object} serviceInfo compatible with serviceRegistry
 */
function buildServiceInfo(manifest) {
  const authMethods = [];
  if (manifest.auth?.type) {
    authMethods.push(manifest.auth.type);
  }
  return {
    key: manifest.name,
    name: manifest.displayName,
    shortDesc: manifest.description || manifest.displayName,
    description: manifest.description || `${manifest.displayName} plugin`,
    authType: manifest.auth?.type || 'none',
    authMethods,
    authFields: manifest.auth?.fields || [],
    baseUrl: manifest.baseUrl || '',
    docs: manifest.docs || '',
    examples: manifest.examples || [],
    operations: manifest.operations || [],
    isPlugin: true
  };
}

/**
 * Load all plugins from the plugins directory
 * @returns {Promise<Map<string, object>>} Map of loaded plugins
 */
export async function loadPlugins() {
  loadedPlugins.clear();
  const pluginsDir = process.env.AGENTGATE_PLUGINS_DIR || DEFAULT_PLUGINS_DIR;

  try {
    await access(pluginsDir);
  } catch {
    console.log(`Plugins directory not found: ${pluginsDir} (skipping plugin loading)`);
    return loadedPlugins;
  }

  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    console.warn(`Cannot read plugins directory: ${pluginsDir}`);
    return loadedPlugins;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = join(pluginsDir, entry.name);
    const manifestPath = join(pluginDir, 'manifest.json');
    const handlerPathMjs = join(pluginDir, 'handler.mjs');
    const handlerPathJs = join(pluginDir, 'handler.js');

    try {
      // Read and validate manifest
      const manifestRaw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestRaw);
      const { valid, errors } = validateManifest(manifest);
      if (!valid) {
        console.warn(`Plugin "${entry.name}" has invalid manifest: ${errors.join(', ')}`);
        continue;
      }

      // Check handler exists (.mjs preferred, .js fallback)
      let handlerPath;
      try {
        await access(handlerPathMjs);
        handlerPath = handlerPathMjs;
      } catch {
        await access(handlerPathJs);
        handlerPath = handlerPathJs;
      }

      // Dynamic import handler
      const handler = await import(pathToFileURL(handlerPath).href);

      const serviceInfo = handler.serviceInfo || buildServiceInfo(manifest);
      const readService = handler.readService || null;
      const router = handler.default || null;

      loadedPlugins.set(manifest.name, {
        manifest,
        serviceInfo,
        readService,
        router,
        pluginDir
      });

      console.log(`Loaded plugin: ${manifest.displayName} v${manifest.version}`);
    } catch (err) {
      console.warn(`Failed to load plugin "${entry.name}": ${err.message}`);
    }
  }

  return loadedPlugins;
}

/**
 * Get all loaded plugins
 * @returns {Map<string, object>}
 */
export function getLoadedPlugins() {
  return loadedPlugins;
}

/**
 * Get a specific loaded plugin by name
 * @param {string} name - Plugin name
 * @returns {object|null}
 */
export function getPlugin(name) {
  return loadedPlugins.get(name) || null;
}
