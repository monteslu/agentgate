import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();
const PLIVO_API = 'https://api.plivo.com/v1';

// Service metadata - exported for /api/agent_start_here and /api/skill
export const serviceInfo = {
  key: 'plivo',
  name: 'Plivo',
  shortDesc: 'SMS messaging via Plivo',
  description: 'Plivo SMS API proxy for sending and reading messages',
  authType: 'basic',
  authMethods: ['basic'],
  docs: 'https://www.plivo.com/docs/sms/',
  examples: [
    'GET /api/plivo/{accountName}/messages',
    'GET /api/plivo/{accountName}/messages/{messageUuid}',
    'GET /api/plivo/{accountName}/account'
  ]
};

// Core read function - used by both Express routes and MCP
export async function readService(accountName, path, { query = {}, raw: _raw = false } = {}) {
  const creds = getAccountCredentials('plivo', accountName);
  if (!creds?.authId || !creds?.authToken) {
    return { status: 401, data: { error: 'Plivo credentials not configured', hint: `Configure Auth ID and Auth Token for account "${accountName}" in the AgentGate UI` } };
  }

  const basicAuth = Buffer.from(`${creds.authId}:${creds.authToken}`).toString('base64');
  const queryString = new URLSearchParams(query).toString();
  const url = `${PLIVO_API}/Account/${creds.authId}/${path}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();
  return { status: response.status, data };
}

// List messages
router.get('/:accountName/messages', async (req, res) => {
  try {
    const result = await readService(req.params.accountName, 'Message/', { query: req.query });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Plivo API request failed', message: error.message });
  }
});

// Get single message
router.get('/:accountName/messages/:messageUuid', async (req, res) => {
  try {
    const result = await readService(req.params.accountName, `Message/${req.params.messageUuid}/`);
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Plivo API request failed', message: error.message });
  }
});

// Account info endpoint
router.get('/:accountName/account', async (req, res) => {
  try {
    const result = await readService(req.params.accountName, '');
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Plivo API request failed', message: error.message });
  }
});

// Wildcard GET - proxy any other Plivo API path
router.get('/:accountName/*', async (req, res) => {
  try {
    const path = req.params[0];
    const result = await readService(req.params.accountName, path, { query: req.query });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Plivo API request failed', message: error.message });
  }
});

// Account info
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'plivo',
    account: req.params.accountName,
    description: 'Plivo SMS API proxy. Send and read SMS messages.',
    examples: [
      `GET /api/plivo/${req.params.accountName}/messages`,
      `GET /api/plivo/${req.params.accountName}/messages/{messageUuid}`,
      `GET /api/plivo/${req.params.accountName}/account`
    ],
    docs: 'https://www.plivo.com/docs/sms/'
  });
});

export default router;
