import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

// Service metadata
export const serviceInfo = {
  key: 'twilio',
  name: 'Twilio',
  shortDesc: 'SMS messaging via Twilio',
  description: 'Twilio API proxy for sending and managing SMS messages',
  authType: 'basic',
  authMethods: ['basic'],
  docs: 'https://www.twilio.com/docs/sms/api',
  examples: [
    'GET /api/twilio/{accountName}/Messages.json',
    'GET /api/twilio/{accountName}/Messages/{MessageSid}.json'
  ],
  writeGuidelines: [
    'SMS messages cost money — confirm with user before sending',
    'Always verify the recipient phone number before sending',
    'Include country code in phone numbers (e.g., +1 for US)',
    'Be mindful of SMS rate limits and carrier filtering'
  ]
};

// Core read function
export async function readService(accountName, path, { query = {} } = {}) {
  const creds = getAccountCredentials('twilio', accountName);
  if (!creds?.accountSid || !creds?.authToken) {
    return {
      status: 401,
      data: {
        error: 'Twilio credentials not configured',
        hint: `Configure accountSid and authToken for account "${accountName}" in the AgentGate UI`
      }
    };
  }

  const basicAuth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
  const queryString = new URLSearchParams(query).toString();
  const url = `${TWILIO_BASE}/Accounts/${creds.accountSid}/${path.replace(/^\//, '')}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Accept': 'application/json'
    }
  });

  const data = await response.json();
  return { status: response.status, data };
}

// GET messages list
router.get('/:accountName/Messages.json', async (req, res) => {
  try {
    const result = await readService(req.params.accountName, 'Messages.json', { query: req.query });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Twilio API request failed', message: error.message });
  }
});

// GET single message
router.get('/:accountName/Messages/:sid.json', async (req, res) => {
  try {
    const result = await readService(req.params.accountName, `Messages/${req.params.sid}.json`);
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Twilio API request failed', message: error.message });
  }
});

// Account info
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'twilio',
    account: req.params.accountName,
    description: 'Twilio SMS API proxy. List and read messages; send via write queue.',
    examples: [
      `GET /api/twilio/${req.params.accountName}/Messages.json`,
      `GET /api/twilio/${req.params.accountName}/Messages/{MessageSid}.json`
    ],
    docs: 'https://www.twilio.com/docs/sms/api'
  });
});

// Wildcard GET
router.get('/:accountName/*', async (req, res) => {
  try {
    const path = req.params[0];
    const result = await readService(req.params.accountName, path, { query: req.query });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Twilio API request failed', message: error.message });
  }
});

export default router;
