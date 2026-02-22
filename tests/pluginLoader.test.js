import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateManifest, loadPlugins, getPlugin } from '../src/lib/pluginLoader.js';
import { registerPlugin, checkNameCollision } from '../src/lib/serviceRegistry.js';

const TEST_DIR = join(tmpdir(), 'agentgate-plugin-test-' + Date.now());

function validManifest(overrides = {}) {
  return {
    name: 'test-service',
    displayName: 'Test Service',
    version: '1.0.0',
    description: 'A test plugin',
    auth: { type: 'api_key', fields: [{ name: 'apiKey', label: 'API Key', type: 'password' }] },
    baseUrl: 'https://api.example.com',
    operations: [
      { method: 'GET', pattern: '/*', description: 'Read' }
    ],
    ...overrides
  };
}

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const { valid, errors } = validateManifest(validManifest());
    expect(valid).toBe(true);
    expect(errors.length).toBe(0);
  });

  it('rejects null manifest', () => {
    const { valid } = validateManifest(null);
    expect(valid).toBe(false);
  });

  it('rejects missing name', () => {
    const { valid, errors } = validateManifest(validManifest({ name: '' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('name'))).toBe(true);
  });

  it('rejects missing displayName', () => {
    const { valid, errors } = validateManifest(validManifest({ displayName: '' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('displayName'))).toBe(true);
  });

  it('rejects missing version', () => {
    const { valid, errors } = validateManifest(validManifest({ version: '' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('version'))).toBe(true);
  });

  it('rejects invalid version format', () => {
    const { valid, errors } = validateManifest(validManifest({ version: 'abc' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('semver'))).toBe(true);
  });

  it('rejects invalid name characters', () => {
    const { valid, errors } = validateManifest(validManifest({ name: 'My Service!' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('lowercase'))).toBe(true);
  });

  it('rejects invalid auth shape', () => {
    const { valid, errors } = validateManifest(validManifest({ auth: 'bad' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('auth'))).toBe(true);
  });

  it('rejects non-array operations', () => {
    const { valid, errors } = validateManifest(validManifest({ operations: 'bad' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('operations'))).toBe(true);
  });
});

describe('checkNameCollision', () => {
  it('detects collision with built-in service', () => {
    const { collision, reason } = checkNameCollision('github');
    expect(collision).toBe(true);
    expect(reason).toMatch(/built-in service/);
  });

  it('detects collision with reserved path', () => {
    const { collision, reason } = checkNameCollision('queue');
    expect(collision).toBe(true);
    expect(reason).toMatch(/reserved API path/);
  });

  it('detects collision with agents path', () => {
    const { collision, reason } = checkNameCollision('agents');
    expect(collision).toBe(true);
    expect(reason).toMatch(/reserved API path/);
  });

  it('allows non-colliding name', () => {
    const { collision } = checkNameCollision('my-custom-plugin');
    expect(collision).toBe(false);
  });
});

describe('registerPlugin', () => {
  it('throws on built-in service collision', () => {
    expect(() => {
      registerPlugin('github', { key: 'github', name: 'Fake GitHub' }, null);
    }).toThrow(/cannot be registered/);
  });

  it('throws on reserved path collision', () => {
    expect(() => {
      registerPlugin('queue', { key: 'queue', name: 'Fake Queue' }, null);
    }).toThrow(/cannot be registered/);
  });
});

describe('loadPlugins', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    process.env.AGENTGATE_PLUGINS_DIR = TEST_DIR;
  });

  afterEach(async () => {
    delete process.env.AGENTGATE_PLUGINS_DIR;
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('returns empty map when plugins dir has no plugins', async () => {
    const plugins = await loadPlugins();
    expect(plugins instanceof Map).toBe(true);
  });

  it('loads a valid plugin', async () => {
    const pluginDir = join(TEST_DIR, 'my-plugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'manifest.json'),
      JSON.stringify(validManifest({ name: 'my-plugin', displayName: 'My Plugin' }))
    );
    // Minimal handler — use .mjs to ensure ESM parsing
    await writeFile(join(pluginDir, 'handler.mjs'), [
      'export const serviceInfo = { key: \'my-plugin\', name: \'My Plugin\' };',
      'export default null;'
    ].join('\n'));

    const plugins = await loadPlugins();
    expect(plugins.has('my-plugin')).toBe(true);
    expect(plugins.get('my-plugin').serviceInfo.name).toBe('My Plugin');
  });

  it('skips plugin with invalid manifest', async () => {
    const pluginDir = join(TEST_DIR, 'bad-plugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify({ name: '' }));
    await writeFile(join(pluginDir, 'handler.js'), 'export default null;');

    const plugins = await loadPlugins();
    expect(plugins.has('bad-plugin')).toBe(false);
  });

  it('skips plugin with missing handler.js', async () => {
    const pluginDir = join(TEST_DIR, 'no-handler');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'manifest.json'),
      JSON.stringify(validManifest({ name: 'no-handler' }))
    );

    const plugins = await loadPlugins();
    expect(plugins.has('no-handler')).toBe(false);
  });

  it('handles non-existent plugins directory gracefully', async () => {
    process.env.AGENTGATE_PLUGINS_DIR = '/tmp/nonexistent-agentgate-plugins-xyz';
    const plugins = await loadPlugins();
    expect(plugins instanceof Map).toBe(true);
  });
});

describe('getPlugin', () => {
  it('returns null for unknown plugin', () => {
    expect(getPlugin('nonexistent')).toBeNull();
  });
});
