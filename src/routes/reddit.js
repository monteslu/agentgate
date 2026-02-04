import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const REDDIT_API = 'https://oauth.reddit.com';
const REDDIT_AUTH = 'https://www.reddit.com/api/v1';

// Blocked routes - no DMs/private messages
const BLOCKED_PATTERNS = [
  /^message\//,                 // /message/inbox, /message/sent, etc.
  /^api\/v1\/me\/blocked/,      // blocked users list
  /^api\/v1\/me\/friends/,      // friends list (privacy)
];

// Get a valid access token, refreshing if needed
async function getAccessToken(accountName) {
  const creds = getAccountCredentials('reddit', accountName);
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

    const response = await fetch(`${REDDIT_AUTH}/access_token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken
      })
    });

    if (!response.ok) {
      console.error('Reddit token refresh failed:', await response.text());
      return null;
    }

    const tokens = await response.json();

    // Store the new tokens
    setAccountCredentials('reddit', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000 // 1 min buffer
    });

    return tokens.access_token;
  } catch (error) {
    console.error('Reddit token refresh failed:', error);
    return null;
  }
}

// Proxy GET requests to Reddit API
// Route: /api/reddit/:accountName/*
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const accessToken = await getAccessToken(accountName);
    if (!accessToken) {
      return res.status(401).json({
        error: 'Reddit account not configured',
        message: `Set up Reddit account "${accountName}" in the admin UI`
      });
    }

    const path = req.params[0] || '';

    // Check blocked routes
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(path)) {
        return res.status(403).json({
          error: 'Route blocked',
          message: 'This endpoint is blocked for privacy (DMs/messages)'
        });
      }
    }

    const queryString = new URLSearchParams(req.query).toString();
    const url = `${REDDIT_API}/${path}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'agentgate-gateway/1.0'
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Reddit API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'reddit',
    account: req.params.accountName,
    description: 'Reddit API proxy (DMs blocked). Append API path after account name.',
    examples: [
      `GET /api/reddit/${req.params.accountName}/api/v1/me`,
      `GET /api/reddit/${req.params.accountName}/r/programming/hot`
    ]
  });
});

export default router;
