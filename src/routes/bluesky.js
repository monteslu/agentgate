import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const BSKY_API = 'https://bsky.social/xrpc';

// Blocked routes - no DMs/chat
const BLOCKED_PATTERNS = [
  /^chat\./,                    // all chat.bsky.* endpoints
  /^com\.atproto\.admin/,       // admin endpoints
];

// Get a valid access token, refreshing if needed
async function getAccessToken(accountName) {
  const creds = getAccountCredentials('bluesky', accountName);
  if (!creds) {
    return null;
  }

  // If we have an access token and it's not expired, use it
  if (creds.accessJwt && creds.expiresAt && Date.now() < creds.expiresAt) {
    return creds.accessJwt;
  }

  // Need to create a new session with app password
  try {
    const response = await fetch(`${BSKY_API}/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: creds.identifier,
        password: creds.appPassword
      })
    });

    if (!response.ok) {
      console.error('Bluesky auth failed:', await response.text());
      return null;
    }

    const session = await response.json();

    // Store the new tokens (access token valid for ~2 hours)
    setAccountCredentials('bluesky', accountName, {
      identifier: creds.identifier,
      appPassword: creds.appPassword,
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
      did: session.did,
      expiresAt: Date.now() + (90 * 60 * 1000) // 90 minutes to be safe
    });

    return session.accessJwt;
  } catch (error) {
    console.error('Bluesky session creation failed:', error);
    return null;
  }
}

// Proxy GET requests to Bluesky API
// Route: /api/bluesky/:accountName/*
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const accessToken = await getAccessToken(accountName);
    if (!accessToken) {
      return res.status(401).json({
        error: 'Bluesky account not configured',
        message: `Set up Bluesky account "${accountName}" in the admin UI`
      });
    }

    const path = req.params[0] || '';

    // Check blocked routes
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(path)) {
        return res.status(403).json({
          error: 'Route blocked',
          message: 'This endpoint is blocked for privacy (DMs/chat)'
        });
      }
    }

    const queryString = new URLSearchParams(req.query).toString();
    const url = `${BSKY_API}/${path}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Bluesky API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'bluesky',
    account: req.params.accountName,
    description: 'Bluesky/AT Protocol proxy (DMs blocked). Append XRPC method after account name.',
    examples: [
      `GET /api/bluesky/${req.params.accountName}/app.bsky.feed.getTimeline`,
      `GET /api/bluesky/${req.params.accountName}/app.bsky.actor.getProfile?actor=handle.bsky.social`
    ]
  });
});

export default router;
