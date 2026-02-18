import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();

// Service metadata - exported for /api/agent_start_here and /api/skill
export const serviceInfo = {
  key: 'homeassistant',
  name: 'Home Assistant',
  shortDesc: 'Smart home control and monitoring',
  description: 'Home Assistant API proxy for smart home device states and control',
  authType: 'token',
  authMethods: ['token'],
  docs: 'https://developers.home-assistant.io/docs/api/rest/',
  examples: [
    'GET /api/homeassistant/{accountName}/states',
    'GET /api/homeassistant/{accountName}/states/{entity_id}',
    'GET /api/homeassistant/{accountName}/services',
    'GET /api/homeassistant/{accountName}/config',
    'GET /api/homeassistant/{accountName}/camera_proxy/{entity_id}'
  ],
  writeGuidelines: [
    'Security-critical actions (locks, alarms, garage doors) require extra caution',
    'Always confirm with the user before toggling locks or disabling alarms',
    'Avoid bulk state changes without explicit user approval',
    'Camera streams may contain sensitive footage — handle with care'
  ]
};

// Simplify state objects to essential fields
function simplifyState(state) {
  return {
    entity_id: state.entity_id,
    state: state.state,
    last_changed: state.last_changed,
    friendly_name: state.attributes?.friendly_name || null
  };
}

// Core read function - used by both Express routes and MCP
export async function readService(accountName, path, { query = {}, raw = false } = {}) {
  const creds = getAccountCredentials('homeassistant', accountName);
  if (!creds?.token || !creds?.host) {
    return { status: 401, data: { error: 'Home Assistant credentials not configured', hint: `Configure host and token for account "${accountName}" in the AgentGate UI` } };
  }

  const host = creds.host.replace(/\/+$/, '');
  const queryString = new URLSearchParams(query).toString();
  const url = `${host}/api/${path}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${creds.token}`,
      'Content-Type': 'application/json'
    }
  });

  // Handle binary responses (camera proxy)
  const contentType = response.headers.get('content-type') || '';
  if (contentType.startsWith('image/') || contentType.startsWith('video/')) {
    const buffer = await response.arrayBuffer();
    return { status: response.status, data: Buffer.from(buffer), contentType, binary: true };
  }

  let data = await response.json();

  // Simplify states responses unless raw
  if (!raw && response.ok && path === 'states' && Array.isArray(data)) {
    data = data.map(simplifyState);
  }
  if (!raw && response.ok && path.startsWith('states/') && data?.entity_id) {
    data = simplifyState(data);
  }

  return { status: response.status, data };
}

// GET all states
router.get('/:accountName/states', async (req, res) => {
  try {
    const rawHeader = req.headers['x-agentgate-raw'];
    const raw = rawHeader !== undefined ? rawHeader === 'true' : !!(req.apiKeyInfo?.raw_results);
    const result = await readService(req.params.accountName, 'states', { raw });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Home Assistant API request failed', message: error.message });
  }
});

// GET single entity state
router.get('/:accountName/states/:entityId', async (req, res) => {
  try {
    const rawHeader = req.headers['x-agentgate-raw'];
    const raw = rawHeader !== undefined ? rawHeader === 'true' : !!(req.apiKeyInfo?.raw_results);
    const result = await readService(req.params.accountName, `states/${req.params.entityId}`, { raw });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Home Assistant API request failed', message: error.message });
  }
});

// GET camera proxy - returns binary image
router.get('/:accountName/camera_proxy/:entityId', async (req, res) => {
  try {
    const result = await readService(req.params.accountName, `camera_proxy/${req.params.entityId}`, { raw: true });
    if (result.binary) {
      res.set('Content-Type', result.contentType);
      res.status(result.status).send(result.data);
    } else {
      res.status(result.status).json(result.data);
    }
  } catch (error) {
    res.status(500).json({ error: 'Home Assistant camera proxy request failed', message: error.message });
  }
});

// GET wildcard - proxy any other HA API path
router.get('/:accountName/*', async (req, res) => {
  try {
    const path = req.params[0];
    const rawHeader = req.headers['x-agentgate-raw'];
    const raw = rawHeader !== undefined ? rawHeader === 'true' : !!(req.apiKeyInfo?.raw_results);
    const result = await readService(req.params.accountName, path, { query: req.query, raw });
    if (result.binary) {
      res.set('Content-Type', result.contentType);
      res.status(result.status).send(result.data);
    } else {
      res.status(result.status).json(result.data);
    }
  } catch (error) {
    res.status(500).json({ error: 'Home Assistant API request failed', message: error.message });
  }
});

// Account info endpoint
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'homeassistant',
    account: req.params.accountName,
    description: 'Home Assistant API proxy. Query device states, services, and camera feeds.',
    examples: [
      `GET /api/homeassistant/${req.params.accountName}/states`,
      `GET /api/homeassistant/${req.params.accountName}/states/light.living_room`,
      `GET /api/homeassistant/${req.params.accountName}/services`,
      `GET /api/homeassistant/${req.params.accountName}/config`,
      `GET /api/homeassistant/${req.params.accountName}/camera_proxy/camera.front_door`
    ],
    docs: 'https://developers.home-assistant.io/docs/api/rest/'
  });
});

export default router;
