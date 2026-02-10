import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_AUTH = 'https://oauth2.googleapis.com';

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'calendar',
  name: 'Google Calendar',
  shortDesc: 'Events, calendars',
  description: 'Google Calendar API proxy',
  authType: 'oauth',
  authMethods: ['oauth'],
  dbKey: 'google_calendar',
  docs: 'https://developers.google.com/calendar/api/v3/reference',
  examples: [
    'GET /api/calendar/{accountName}/users/me/calendarList',
    'GET /api/calendar/{accountName}/calendars/primary/events',
    'GET /api/calendar/{accountName}/calendars/{calendarId}/events?timeMin={ISO8601}&timeMax={ISO8601}'
  ]
};

// Get a valid access token, refreshing if needed
async function getAccessToken(accountName) {
  const creds = getAccountCredentials('google_calendar', accountName);
  if (!creds) {
    return null;
  }

  // If we have an access token and it's not expired, use it
  if (creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt) {
    return creds.accessToken;
  }

  // Need to refresh the token
  if (!creds.refreshToken) {
    return null;
  }

  try {
    const response = await fetch(`${GOOGLE_AUTH}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: 'refresh_token'
      })
    });

    if (!response.ok) {
      console.error('Google token refresh failed:', await response.text());
      return null;
    }

    const tokens = await response.json();

    // Store the new tokens
    setAccountCredentials('google_calendar', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000 // 1 min buffer
    });

    return tokens.access_token;
  } catch (error) {
    console.error('Google token refresh failed:', error);
    return null;
  }
}

// Core read function - used by both Express routes and MCP
export async function readService(accountName, path, { query = {}, raw: _raw = false } = {}) {
  const accessToken = await getAccessToken(accountName);
  if (!accessToken) {
    return { status: 401, data: { error: 'Google Calendar account not configured', message: `Set up Google Calendar account "${accountName}" in the admin UI` } };
  }

  const queryString = new URLSearchParams(query).toString();
  const url = `${GOOGLE_API}/${path}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  const data = await response.json();
  return { status: response.status, data };
}

// Proxy GET requests to Google Calendar API
router.get('/:accountName/*', async (req, res) => {
  try {
    const raw = req.headers['x-agentgate-raw'] === 'true' || !!(req.apiKeyInfo?.raw_results);
    const result = await readService(req.params.accountName, req.params[0] || '', { query: req.query, raw });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Google Calendar API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'google_calendar',
    account: req.params.accountName,
    description: 'Google Calendar API proxy. Append API path after account name.',
    examples: [
      `GET /api/calendar/${req.params.accountName}/users/me/calendarList`,
      `GET /api/calendar/${req.params.accountName}/calendars/primary/events`
    ]
  });
});

export default router;
