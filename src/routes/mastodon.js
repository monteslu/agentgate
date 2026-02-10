import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'mastodon',
  name: 'Mastodon',
  shortDesc: 'Timeline, notifications, profile (DMs blocked)',
  description: 'Mastodon API proxy (DMs blocked)',
  authType: 'access token',
  authMethods: ['access_token', 'oauth'],
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

// Simplify account/credentials - drop duplicate HTML fields, source echo, role
function simplifyAccount(data) {
  if (!data?.id) return data;
  return {
    id: data.id,
    username: data.username,
    acct: data.acct,
    display_name: data.display_name,
    note: data.source?.note || data.note,
    url: data.url,
    avatar: data.avatar,
    followers_count: data.followers_count,
    following_count: data.following_count,
    statuses_count: data.statuses_count,
    created_at: data.created_at,
    last_status_at: data.last_status_at,
    fields: data.source?.fields || data.fields
  };
}

// Simplify timeline statuses
function simplifyStatus(status) {
  return {
    id: status.id,
    created_at: status.created_at,
    content: status.content,
    account: {
      acct: status.account?.acct,
      display_name: status.account?.display_name
    },
    reblogs_count: status.reblogs_count,
    favourites_count: status.favourites_count,
    replies_count: status.replies_count,
    reblog: status.reblog ? { id: status.reblog.id, account: status.reblog.account?.acct, content: status.reblog.content } : undefined,
    media_attachments: status.media_attachments?.map(m => ({ type: m.type, url: m.url, description: m.description }))
  };
}

// Simplify notifications
function simplifyNotification(n) {
  return {
    id: n.id,
    type: n.type,
    created_at: n.created_at,
    account: { acct: n.account?.acct, display_name: n.account?.display_name },
    status: n.status ? simplifyStatus(n.status) : undefined
  };
}

// Match path to simplifier
function getSimplifier(path) {
  if (/api\/v1\/accounts\/verify_credentials/.test(path)) return simplifyAccount;
  if (/api\/v1\/timelines\//.test(path)) return data => Array.isArray(data) ? data.map(simplifyStatus) : data;
  if (/api\/v1\/notifications/.test(path)) return data => Array.isArray(data) ? data.map(simplifyNotification) : data;
  if (/api\/v1\/accounts\/\d+$/.test(path)) return simplifyAccount;
  return null;
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

    const raw = req.headers['x-agentgate-raw'] === 'true';
    const queryString = new URLSearchParams(req.query).toString();
    const url = `https://${config.instance}/${path}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'Accept': 'application/json'
      }
    });

    const data = await response.json();

    if (!raw && response.ok) {
      const simplifier = getSimplifier(path);
      if (simplifier) {
        return res.status(response.status).json(simplifier(data));
      }
    }

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
