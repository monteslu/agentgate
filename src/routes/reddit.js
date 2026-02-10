import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const REDDIT_API = 'https://oauth.reddit.com';
const REDDIT_AUTH = 'https://www.reddit.com/api/v1';

// Service metadata - exported for /api/agent_start_here and /api/skill
export const serviceInfo = {
  key: 'reddit',
  name: 'Reddit',
  shortDesc: 'Subreddits, posts, comments (DMs blocked)',
  description: 'Reddit API proxy (DMs blocked)',
  authType: 'oauth',
  authMethods: ['oauth'],
  docs: 'https://www.reddit.com/dev/api/',
  examples: [
    'GET /api/reddit/{accountName}/api/v1/me',
    'GET /api/reddit/{accountName}/r/{subreddit}/hot',
    'GET /api/reddit/{accountName}/user/{username}/submitted'
  ]
};

// Blocked routes - no DMs/private messages
const BLOCKED_PATTERNS = [
  /^message\//,                 // /message/inbox, /message/sent, etc.
  /^api\/v1\/me\/blocked/,      // blocked users list
  /^api\/v1\/me\/friends/      // friends list (privacy)
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

// Core read function - used by both Express routes and MCP
export async function readService(accountName, path, { query = {}, raw: _raw = false } = {}) {
  const accessToken = await getAccessToken(accountName);
  if (!accessToken) {
    return { status: 401, data: { error: 'Reddit account not configured', message: `Set up Reddit account "${accountName}" in the admin UI` } };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(path)) {
      return { status: 403, data: { error: 'Route blocked', message: 'This endpoint is blocked for privacy (DMs/messages)' } };
    }
  }

  const queryString = new URLSearchParams(query).toString();
  const url = `${REDDIT_API}/${path}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'agentgate-gateway/1.0'
    }
  });

  const data = await response.json();
  return { status: response.status, data };
}

// Proxy GET requests to Reddit API
router.get('/:accountName/*', async (req, res) => {
  try {
    const rawHeader = req.headers['x-agentgate-raw'];
    const raw = rawHeader !== undefined ? rawHeader === 'true' : !!(req.apiKeyInfo?.raw_results);
    const result = await readService(req.params.accountName, req.params[0] || '', { query: req.query, raw });
    res.status(result.status).json(result.data);
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
