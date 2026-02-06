import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const LINKEDIN_API = 'https://api.linkedin.com/v2';

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'linkedin',
  name: 'LinkedIn',
  shortDesc: 'Profile (messaging blocked)',
  description: 'LinkedIn API proxy (messaging blocked)',
  authType: 'oauth',
  docs: 'https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api',
  examples: [
    'GET /api/linkedin/{accountName}/me',
    'GET /api/linkedin/{accountName}/userinfo'
  ]
};

// Blocked routes - no messaging
const BLOCKED_PATTERNS = [
  /^messaging/,                 // all messaging endpoints
  /^conversations/             // conversations
];

// Get a valid access token, refreshing if needed
async function getAccessToken(accountName) {
  const creds = getAccountCredentials('linkedin', accountName);
  if (!creds) {
    return null;
  }

  // If we have an access token and it's not expired, use it
  if (creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt) {
    return creds.accessToken;
  }

  // LinkedIn access tokens last 60 days, refresh tokens 365 days
  // Need to refresh the token
  if (!creds.refreshToken) {
    return null;
  }

  try {
    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret
      })
    });

    if (!response.ok) {
      console.error('LinkedIn token refresh failed:', await response.text());
      return null;
    }

    const tokens = await response.json();

    // Store the new tokens
    setAccountCredentials('linkedin', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000 // 1 min buffer
    });

    return tokens.access_token;
  } catch (error) {
    console.error('LinkedIn token refresh failed:', error);
    return null;
  }
}

// Proxy GET requests to LinkedIn API
// Route: /api/linkedin/:accountName/*
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const accessToken = await getAccessToken(accountName);
    if (!accessToken) {
      return res.status(401).json({
        error: 'LinkedIn account not configured',
        message: `Set up LinkedIn account "${accountName}" in the admin UI`
      });
    }

    const path = req.params[0] || '';

    // Check blocked routes
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(path)) {
        return res.status(403).json({
          error: 'Route blocked',
          message: 'This endpoint is blocked for privacy (messaging)'
        });
      }
    }

    const queryString = new URLSearchParams(req.query).toString();
    const url = `${LINKEDIN_API}/${path}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'LinkedIn-Version': '202401',
        'X-Restli-Protocol-Version': '2.0.0',
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'LinkedIn API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'linkedin',
    account: req.params.accountName,
    description: 'LinkedIn API proxy (messaging blocked). Append API path after account name.',
    examples: [
      `GET /api/linkedin/${req.params.accountName}/me`,
      `GET /api/linkedin/${req.params.accountName}/userinfo`
    ]
  });
});

export default router;
