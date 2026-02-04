import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const GOOGLE_AUTH = 'https://oauth2.googleapis.com';

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'youtube',
  name: 'YouTube',
  shortDesc: 'Channels, videos, subscriptions',
  description: 'YouTube Data API proxy',
  authType: 'oauth',
  docs: 'https://developers.google.com/youtube/v3/docs',
  examples: [
    'GET /api/youtube/{accountName}/channels?part=snippet,statistics&mine=true',
    'GET /api/youtube/{accountName}/videos?part=snippet,statistics&myRating=like',
    'GET /api/youtube/{accountName}/subscriptions?part=snippet&mine=true'
  ]
};

// Get a valid access token, refreshing if needed
async function getAccessToken(accountName) {
  const creds = getAccountCredentials('youtube', accountName);
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
      console.error('YouTube token refresh failed:', await response.text());
      return null;
    }

    const tokens = await response.json();

    // Store the new tokens
    setAccountCredentials('youtube', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000 // 1 min buffer
    });

    return tokens.access_token;
  } catch (error) {
    console.error('YouTube token refresh failed:', error);
    return null;
  }
}

// Proxy GET requests to YouTube API
// Route: /api/youtube/:accountName/*
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const accessToken = await getAccessToken(accountName);
    if (!accessToken) {
      return res.status(401).json({
        error: 'YouTube account not configured',
        message: `Set up YouTube account "${accountName}" in the admin UI`
      });
    }

    const path = req.params[0] || '';
    const queryString = new URLSearchParams(req.query).toString();
    const url = `${YOUTUBE_API}/${path}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'YouTube API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'youtube',
    account: req.params.accountName,
    description: 'YouTube Data API proxy. Append API path after account name.',
    examples: [
      `GET /api/youtube/${req.params.accountName}/channels?part=snippet,statistics&mine=true`,
      `GET /api/youtube/${req.params.accountName}/playlists?part=snippet&mine=true`
    ]
  });
});

export default router;
