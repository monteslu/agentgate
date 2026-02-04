import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'mastodon',
  name: 'Mastodon',
  shortDesc: 'Timeline, notifications, profile (DMs blocked)',
  description: 'Mastodon API proxy (DMs blocked)',
  authType: 'oauth',
  docs: 'https://docs.joinmastodon.org/api/',
  examples: [
    'GET /api/mastodon/{accountName}/api/v1/timelines/home',
    'GET /api/mastodon/{accountName}/api/v1/accounts/verify_credentials',
    'GET /api/mastodon/{accountName}/api/v1/notifications'
  ]
};

// Blocked routes - no DMs or conversations
const BLOCKED_PATTERNS = [
  /^api\/v1\/conversations/,
  /^api\/v1\/markers/  // read position markers (privacy)
];

// Get the configured instance and access token for an account
function getMastodonConfig(accountName) {
  const creds = getAccountCredentials('mastodon', accountName);
  if (!creds || !creds.accessToken || !creds.instance) {
    return null;
  }
  return creds;
}

// Proxy GET requests to Mastodon API
// Route: /api/mastodon/:accountName/*
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const config = getMastodonConfig(accountName);
    if (!config) {
      return res.status(401).json({
        error: 'Mastodon account not configured',
        message: `Set up Mastodon account "${accountName}" in the admin UI`
      });
    }

    const path = req.params[0] || '';

    // Check blocked routes
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(path)) {
        return res.status(403).json({
          error: 'Route blocked',
          message: 'This endpoint is blocked for privacy (DMs/conversations)'
        });
      }
    }

    const queryString = new URLSearchParams(req.query).toString();
    const url = `https://${config.instance}/${path}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Mastodon API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'mastodon',
    account: req.params.accountName,
    description: 'Mastodon API proxy (DMs blocked). Append API path after account name.',
    examples: [
      `GET /api/mastodon/${req.params.accountName}/api/v1/timelines/home`,
      `GET /api/mastodon/${req.params.accountName}/api/v1/accounts/verify_credentials`
    ]
  });
});

export default router;
