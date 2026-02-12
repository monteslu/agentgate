import { getAccountCredentials, setAccountCredentials, updateQueueStatus, getQueueEntry } from './db.js';
import { notifyAgentQueueStatus } from './agentNotifier.js';

// Service base URLs
const SERVICE_URLS = {
  github: 'https://api.github.com',
  bluesky: 'https://bsky.social/xrpc',
  reddit: 'https://oauth.reddit.com',
  mastodon: null, // Dynamic: https://{instance}
  calendar: 'https://www.googleapis.com/calendar/v3',
  google_calendar: 'https://www.googleapis.com/calendar/v3',
  youtube: 'https://www.googleapis.com/youtube/v3',
  linkedin: 'https://api.linkedin.com/v2',
  jira: null, // Dynamic: https://{domain}/rest/api/3
  fitbit: 'https://api.fitbit.com'
};

// Get access token for a service, refreshing if needed
async function getAccessToken(service, accountName) {
  const creds = getAccountCredentials(service, accountName);
  if (!creds) return null;

  switch (service) {
  case 'github':
    return creds.token || null;

  case 'bluesky':
    return await getBlueskyToken(accountName, creds);

  case 'reddit':
    return await getOAuthToken(accountName, creds, 'reddit', refreshRedditToken);

  case 'calendar':
  case 'google_calendar':
    return await getOAuthToken(accountName, creds, 'google_calendar', refreshGoogleToken);

  case 'youtube':
    return await getOAuthToken(accountName, creds, 'youtube', refreshGoogleToken);

  case 'linkedin':
    return await getOAuthToken(accountName, creds, 'linkedin', refreshLinkedInToken);

  case 'mastodon':
    return creds.accessToken || null;

  case 'jira':
    // Jira uses basic auth, return the creds object
    return creds;

  case 'fitbit':
    return await getOAuthToken(accountName, creds, 'fitbit', refreshFitbitToken);

  default:
    return null;
  }
}

// Generic OAuth token getter with refresh
async function getOAuthToken(accountName, creds, service, refreshFn) {
  if (creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt) {
    return creds.accessToken;
  }

  if (!creds.refreshToken) return null;

  const newToken = await refreshFn(accountName, creds, service);
  return newToken;
}

// Bluesky session token
async function getBlueskyToken(accountName, creds) {
  if (creds.accessJwt && creds.expiresAt && Date.now() < creds.expiresAt) {
    return creds.accessJwt;
  }

  try {
    const response = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: creds.identifier,
        password: creds.appPassword
      })
    });

    if (!response.ok) return null;

    const session = await response.json();
    setAccountCredentials('bluesky', accountName, {
      identifier: creds.identifier,
      appPassword: creds.appPassword,
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
      did: session.did,
      expiresAt: Date.now() + (90 * 60 * 1000)
    });

    return session.accessJwt;
  } catch {
    return null;
  }
}

// Refresh Google OAuth token (Calendar/YouTube)
async function refreshGoogleToken(accountName, creds, service) {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: 'refresh_token'
      })
    });

    if (!response.ok) return null;

    const tokens = await response.json();
    setAccountCredentials(service, accountName, {
      ...creds,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
    });

    return tokens.access_token;
  } catch {
    return null;
  }
}

// Refresh Reddit OAuth token
async function refreshRedditToken(accountName, creds) {
  try {
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
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

    if (!response.ok) return null;

    const tokens = await response.json();
    setAccountCredentials('reddit', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
    });

    return tokens.access_token;
  } catch {
    return null;
  }
}

// Refresh LinkedIn OAuth token
async function refreshLinkedInToken(accountName, creds) {
  try {
    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret
      })
    });

    if (!response.ok) return null;

    const tokens = await response.json();
    setAccountCredentials('linkedin', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
    });

    return tokens.access_token;
  } catch {
    return null;
  }
}

// Refresh Fitbit OAuth token
async function refreshFitbitToken(accountName, creds) {
  try {
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

    const response = await fetch('https://api.fitbit.com/oauth2/token', {
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

    if (!response.ok) return null;

    const tokens = await response.json();
    setAccountCredentials('fitbit', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
    });

    return tokens.access_token;
  } catch {
    return null;
  }
}

// Build the full URL for a service request
function buildUrl(service, accountName, path) {
  const creds = getAccountCredentials(service, accountName);

  // Handle dynamic URLs
  if (service === 'mastodon' && creds?.instance) {
    return `https://${creds.instance}/${path.replace(/^\//, '')}`;
  }
  if (service === 'jira' && creds?.domain) {
    return `https://${creds.domain}/rest/api/3/${path.replace(/^\//, '')}`;
  }

  const baseUrl = SERVICE_URLS[service];
  if (!baseUrl) return null;

  return `${baseUrl}/${path.replace(/^\//, '')}`;
}

// Build headers for a service request
function buildHeaders(service, token, customHeaders = {}) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...customHeaders
  };

  if (service === 'jira' && token?.email && token?.apiToken) {
    // Jira uses basic auth
    const basicAuth = Buffer.from(`${token.email}:${token.apiToken}`).toString('base64');
    headers['Authorization'] = `Basic ${basicAuth}`;
  } else if (token && typeof token === 'string') {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Service-specific headers
  if (service === 'github') {
    headers['Accept'] = 'application/vnd.github+json';
    headers['User-Agent'] = 'agentgate-gateway';
  }
  if (service === 'reddit') {
    headers['User-Agent'] = 'agentgate-gateway/1.0';
  }

  return headers;
}

// Helper to update status and send notification
// Fix for #218: await notification to ensure DB is updated before returning
async function finalizeEntry(entryId, status, results) {
  updateQueueStatus(entryId, status, { results });

  // Send notification to agent and wait for completion
  // This ensures notification status is recorded in DB before response is returned
  const updatedEntry = getQueueEntry(entryId);
  try {
    await notifyAgentQueueStatus(updatedEntry);
  } catch (err) {
    console.error('[agentNotifier] Failed to notify agent:', err.message);
  }
}

// Execute a single queued entry (batch of requests)
export async function executeQueueEntry(entry) {
  const results = [];
  const { service, account_name, requests } = entry;

  // Mark as executing
  updateQueueStatus(entry.id, 'executing');

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];

    try {
      // Get fresh token for each request (in case of expiry during batch)
      const token = await getAccessToken(service, account_name);
      if (!token) {
        results.push({
          index: i,
          ok: false,
          error: `Failed to get access token for ${service}/${account_name}`
        });
        await finalizeEntry(entry.id, 'failed', results);
        return { success: false, results };
      }

      // Build URL
      const url = buildUrl(service, account_name, req.path);
      if (!url) {
        results.push({
          index: i,
          ok: false,
          error: `Unknown service or invalid configuration: ${service}`
        });
        await finalizeEntry(entry.id, 'failed', results);
        return { success: false, results };
      }

      // Build headers
      const headers = buildHeaders(service, token, req.headers);

      // Make the request
      const fetchOptions = {
        method: req.method,
        headers
      };

      if (req.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
        if (req.binaryBase64) {
          // Binary data encoded as base64 (for blob uploads)
          fetchOptions.body = Buffer.from(req.body, 'base64');
        } else {
          fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
      }

      const response = await fetch(url, fetchOptions);

      // Parse response
      let responseBody;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      const result = {
        index: i,
        ok: response.ok,
        status: response.status,
        body: responseBody
      };

      results.push(result);

      // Stop on first failure
      if (!response.ok) {
        await finalizeEntry(entry.id, 'failed', results);
        return { success: false, results };
      }

    } catch (err) {
      results.push({
        index: i,
        ok: false,
        error: err.message
      });
      await finalizeEntry(entry.id, 'failed', results);
      return { success: false, results };
    }
  }

  // All requests succeeded
  await finalizeEntry(entry.id, 'completed', results);
  return { success: true, results };
}
