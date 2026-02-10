import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const BSKY_API = 'https://bsky.social/xrpc';

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'bluesky',
  name: 'Bluesky',
  shortDesc: 'Timeline, posts, profile (DMs blocked)',
  description: 'Bluesky/AT Protocol proxy (DMs blocked)',
  authType: 'app password',
  authMethods: ['app_password'],
  docs: 'https://docs.bsky.app/docs/api/',
  examples: [
    'GET /api/bluesky/{accountName}/app.bsky.feed.getTimeline',
    'GET /api/bluesky/{accountName}/app.bsky.feed.getAuthorFeed?actor={handle}',
    'GET /api/bluesky/{accountName}/app.bsky.actor.getProfile?actor={handle}'
  ],
  writeGuidelines: [
    'Posts require FACETS for clickable links, mentions, and hashtags - they are NOT auto-detected',
    'Facet positions use UTF-8 BYTE offsets, not character positions (emoji=4 bytes, em-dash=3 bytes)',
    'Link facet: { index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://..." }] }',
    'Mention facet requires DID (resolve via com.atproto.identity.resolveHandle), not handle',
    'Hashtag facet: tag value should NOT include the # symbol',
    'Always include "langs" array (e.g. ["en"]) and "createdAt" ISO timestamp',
    'Use TextEncoder to calculate byte offsets: encoder.encode(text.slice(0, start)).length'
  ]
};

// Blocked routes - no DMs/chat
const BLOCKED_PATTERNS = [
  /^chat\./,                    // all chat.bsky.* endpoints
  /^com\.atproto\.admin/       // admin endpoints
];

// Simplify timeline/feed responses
function simplifyFeed(data) {
  if (!data?.feed) return data;
  return {
    cursor: data.cursor,
    posts: data.feed.map(item => {
      const post = item.post;
      const record = post.record || {};
      return {
        uri: post.uri,
        cid: post.cid,
        author: {
          handle: post.author?.handle,
          displayName: post.author?.displayName
        },
        text: record.text || '',
        createdAt: record.createdAt,
        replyCount: post.replyCount || 0,
        repostCount: post.repostCount || 0,
        likeCount: post.likeCount || 0,
        hasImages: !!(record.embed?.images?.length || record.embed?.media?.images?.length),
        isRepost: !!item.reason?.by,
        isReply: !!record.reply
      };
    })
  };
}

// Simplify profile response
function simplifyProfile(data) {
  if (!data?.did) return data;
  return {
    did: data.did,
    handle: data.handle,
    displayName: data.displayName,
    description: data.description,
    avatar: data.avatar,
    followersCount: data.followersCount,
    followsCount: data.followsCount,
    postsCount: data.postsCount
  };
}

// Simplify single post/thread
function simplifyThread(data) {
  if (!data?.thread?.post) return data;
  const post = data.thread.post;
  const record = post.record || {};
  return {
    post: {
      uri: post.uri,
      cid: post.cid,
      author: {
        handle: post.author?.handle,
        displayName: post.author?.displayName
      },
      text: record.text || '',
      createdAt: record.createdAt,
      replyCount: post.replyCount || 0,
      repostCount: post.repostCount || 0,
      likeCount: post.likeCount || 0,
      embed: record.embed,
      facets: record.facets
    },
    replies: data.thread.replies?.map(r => ({
      uri: r.post?.uri,
      author: r.post?.author?.handle,
      text: r.post?.record?.text
    })) || []
  };
}

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

// Core read function - used by both Express routes and MCP
export async function readService(accountName, path, { query = {}, raw = false } = {}) {
  const accessToken = await getAccessToken(accountName);
  if (!accessToken) {
    return { status: 401, data: { error: 'Bluesky account not configured', message: `Set up Bluesky account "${accountName}" in the admin UI` } };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(path)) {
      return { status: 403, data: { error: 'Route blocked', message: 'This endpoint is blocked for privacy (DMs/chat)' } };
    }
  }

  const queryString = new URLSearchParams(query).toString();
  const url = `${BSKY_API}/${path}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  let data = await response.json();

  if (!raw && response.ok) {
    if (path === 'app.bsky.feed.getTimeline' || path === 'app.bsky.feed.getAuthorFeed') {
      data = simplifyFeed(data);
    } else if (path === 'app.bsky.actor.getProfile') {
      data = simplifyProfile(data);
    } else if (path === 'app.bsky.feed.getPostThread') {
      data = simplifyThread(data);
    }
  }

  return { status: response.status, data };
}

// Proxy GET requests to Bluesky API
router.get('/:accountName/*', async (req, res) => {
  try {
    const raw = req.headers['x-agentgate-raw'] === 'true' || !!(req.apiKeyInfo?.raw_results);
    const result = await readService(req.params.accountName, req.params[0] || '', { query: req.query, raw });
    res.status(result.status).json(result.data);
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
