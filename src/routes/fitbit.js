import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const FITBIT_API = 'https://api.fitbit.com';
const FITBIT_AUTH = 'https://api.fitbit.com/oauth2/token';

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'fitbit',
  name: 'Fitbit',
  shortDesc: 'Activity, sleep, heart rate, profile',
  description: 'Fitbit API proxy',
  authType: 'oauth',
  authMethods: ['oauth'],
  docs: 'https://dev.fitbit.com/build/reference/web-api/',
  examples: [
    'GET /api/fitbit/{accountName}/1/user/-/profile.json',
    'GET /api/fitbit/{accountName}/1/user/-/activities/date/today.json',
    'GET /api/fitbit/{accountName}/1/user/-/sleep/date/today.json',
    'GET /api/fitbit/{accountName}/1/user/-/body/log/weight/date/today.json'
  ]
};

// Get a valid access token, refreshing if needed
async function getAccessToken(accountName) {
  const creds = getAccountCredentials('fitbit', accountName);
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
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

    const response = await fetch(FITBIT_AUTH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken
      })
    });

    if (!response.ok) {
      console.error('Fitbit token refresh failed:', await response.text());
      return null;
    }

    const tokens = await response.json();

    // Store the new tokens
    setAccountCredentials('fitbit', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000 // 1 min buffer
    });

    return tokens.access_token;
  } catch (error) {
    console.error('Fitbit token refresh failed:', error);
    return null;
  }
}

// Export for queue executor
export { getAccessToken };

// Proxy GET requests to Fitbit API
// Route: /api/fitbit/:accountName/*
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const accessToken = await getAccessToken(accountName);
    if (!accessToken) {
      return res.status(401).json({
        error: 'Fitbit account not configured',
        message: `Set up Fitbit account "${accountName}" in the admin UI`
      });
    }

    const path = req.params[0] || '';
    const queryString = new URLSearchParams(req.query).toString();
    const url = `${FITBIT_API}/${path}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Fitbit API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'fitbit',
    account: req.params.accountName,
    description: 'Fitbit API proxy. Append API path after account name.',
    examples: [
      `GET /api/fitbit/${req.params.accountName}/1/user/-/profile.json`,
      `GET /api/fitbit/${req.params.accountName}/1/user/-/activities/date/today.json`,
      `GET /api/fitbit/${req.params.accountName}/1/user/-/sleep/date/today.json`,
      `GET /api/fitbit/${req.params.accountName}/1/user/-/body/log/weight/date/today.json`
    ]
  });
});

export default router;
