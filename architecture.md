# agentgate Architecture

A read-only API gateway that gives AI agents controlled access to your personal data across multiple services. Agents get a single API key and can read (but never write to) your calendar, social media, project management tools, and more.

## Core Philosophy

1. **Read-only by design** - All requests are enforced as GET-only at the middleware level. Agents cannot post, delete, or modify anything.
2. **Single API key** - Agents use one `rms_*` key to access all configured services. You manage OAuth/tokens once in the UI.
3. **DMs blocked** - Private messages and conversations are explicitly blocked across all social platforms.
4. **Separation of concerns** - Run this gateway on a different machine than your agents. Agents should never have access to the box running agentgate.

## Directory Structure

```
agentgate/
├── src/
│   ├── index.js              # Main Express server, middleware, /api/readme endpoint
│   ├── cli.js                # CLI tool for API key management
│   ├── lib/
│   │   ├── db.js             # SQLite database helpers (credentials, API keys)
│   │   └── hsyncManager.js   # hsync connection manager (remote access)
│   └── routes/
│       ├── ui.js             # Admin web UI and OAuth callbacks
│       ├── github.js         # GitHub API proxy (no auth needed)
│       ├── bluesky.js        # Bluesky/AT Protocol proxy
│       ├── mastodon.js       # Mastodon API proxy
│       ├── reddit.js         # Reddit API proxy
│       ├── calendar.js       # Google Calendar API proxy
│       ├── youtube.js        # YouTube Data API proxy
│       ├── linkedin.js       # LinkedIn API proxy
│       └── jira.js           # Jira API proxy
├── data.db                   # SQLite database (gitignored, created on first run)
├── package.json
├── .gitignore
└── agentgate.service       # systemd user service file
```

## Database Schema

Located in `src/lib/db.js`. SQLite database at `./data.db`.

### Tables

**api_keys**
```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,           -- nanoid
  name TEXT NOT NULL,            -- human-readable name (e.g., "claude-agent")
  key TEXT UNIQUE NOT NULL,      -- the actual key (rms_xxxxx)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**service_credentials**
```sql
CREATE TABLE service_credentials (
  id TEXT PRIMARY KEY,           -- nanoid
  service TEXT UNIQUE NOT NULL,  -- service name (e.g., "bluesky", "google_calendar")
  credentials TEXT NOT NULL,     -- JSON blob of credentials
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Database Functions

- `createApiKey(name)` - Creates a new API key with `rms_` prefix
- `listApiKeys()` - Returns all API keys
- `deleteApiKey(id)` - Deletes an API key by ID
- `validateApiKey(key)` - Checks if a key is valid, returns key info or null
- `setCredentials(service, credentials)` - Upserts service credentials (JSON)
- `getCredentials(service)` - Gets parsed credentials for a service
- `listServices()` - Lists all configured services
- `deleteCredentials(service)` - Removes a service's credentials

## Main Server (src/index.js)

### Middleware Stack

1. **express.json()** - Parse JSON bodies
2. **express.urlencoded()** - Parse form bodies
3. **apiKeyAuth** - Validates `Authorization: Bearer rms_*` header
4. **readOnlyEnforce** - Rejects any non-GET request with 405

### Route Mounting

```javascript
// API routes - require auth and read-only enforcement
app.use('/api/github', apiKeyAuth, readOnlyEnforce, githubRoutes);
app.use('/api/bluesky', apiKeyAuth, readOnlyEnforce, blueskyRoutes);
app.use('/api/reddit', apiKeyAuth, readOnlyEnforce, redditRoutes);
app.use('/api/calendar', apiKeyAuth, readOnlyEnforce, calendarRoutes);
app.use('/api/mastodon', apiKeyAuth, readOnlyEnforce, mastodonRoutes);
app.use('/api/linkedin', apiKeyAuth, readOnlyEnforce, linkedinRoutes);
app.use('/api/youtube', apiKeyAuth, readOnlyEnforce, youtubeRoutes);
app.use('/api/jira', apiKeyAuth, readOnlyEnforce, jiraRoutes);

// UI routes - no API key needed (local admin access)
app.use('/ui', uiRoutes);
```

### /api/readme Endpoint

Returns a JSON manifest describing all available services, their configuration status, and example endpoints. Agents should call this first to understand what's available.

```json
{
  "name": "agentgate",
  "description": "Read-only API gateway for personal data...",
  "services": {
    "github": { "configured": true, "authType": "none (public API)" },
    "bluesky": { "configured": true, "authType": "app password" },
    ...
  },
  "endpoints": {
    "github": {
      "base": "/api/github",
      "description": "GitHub public API proxy",
      "examples": ["GET /api/github/users/{username}", ...]
    },
    ...
  },
  "auth": {
    "type": "bearer",
    "header": "Authorization: Bearer {your_api_key}"
  }
}
```

### Startup

On startup, the server:
1. Starts Express on PORT (default 3050)
2. Calls `connectHsync(PORT)` to establish remote tunnel if configured

## Service Proxies

Each service proxy follows a similar pattern:

### Pattern: OAuth Services (Google Calendar, YouTube, Reddit, LinkedIn, Mastodon)

```javascript
// 1. Get access token, refreshing if expired
async function getAccessToken() {
  const creds = getCredentials('service_name');
  if (!creds) return null;

  // Return cached token if still valid
  if (creds.accessToken && Date.now() < creds.expiresAt) {
    return creds.accessToken;
  }

  // Refresh the token
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret
    })
  });

  const tokens = await response.json();

  // Store new tokens
  setCredentials('service_name', {
    ...creds,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
  });

  return tokens.access_token;
}

// 2. Proxy GET requests
router.get('/*', async (req, res) => {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return res.status(401).json({ error: 'Service not configured' });
  }

  // Check blocked routes (DMs, etc.)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(path)) {
      return res.status(403).json({ error: 'Route blocked' });
    }
  }

  // Proxy the request
  const response = await fetch(`${API_BASE}/${path}?${queryString}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  res.status(response.status).json(await response.json());
});
```

### Pattern: App Password/Token Services (Bluesky, Jira)

These services don't use OAuth refresh tokens. Instead:

**Bluesky**: Uses app password to create a session on first request. Session tokens are cached and refreshed when expired.

**Jira**: Uses basic auth with email + API token on every request.

### Pattern: No Auth (GitHub)

Public GitHub API is proxied directly with no authentication. Rate limits apply (60 req/hour unauthenticated).

## Blocked Routes (DM Protection)

Each social service blocks private messaging endpoints:

**Bluesky** (`src/routes/bluesky.js`)
```javascript
const BLOCKED_PATTERNS = [
  /^chat\./,                    // all chat.bsky.* endpoints
  /^com\.atproto\.admin/,       // admin endpoints
];
```

**Mastodon** (`src/routes/mastodon.js`)
```javascript
const BLOCKED_PATTERNS = [
  /^api\/v1\/conversations/,    // DMs
  /^api\/v1\/markers/,          // read position markers
];
```

**Reddit** (`src/routes/reddit.js`)
```javascript
const BLOCKED_PATTERNS = [
  /^message\//,                 // inbox, sent, etc.
  /^api\/v1\/me\/blocked/,      // blocked users
  /^api\/v1\/me\/friends/,      // friends list
];
```

**LinkedIn** (`src/routes/linkedin.js`)
```javascript
const BLOCKED_PATTERNS = [
  /^messaging/,                 // all messaging
  /^conversations/,             // conversations
];
```

## Admin UI (src/routes/ui.js)

Served at `/ui`. Pure server-rendered HTML with inline CSS. No frontend framework.

### Features

1. **Configuration Section**
   - hsync remote access toggle (URL + token)

2. **Services Section**
   - Each service shows Configured/Not Configured status
   - Configured: Shows connection info + Disconnect button
   - Not Configured: Shows setup form with help text

3. **OAuth Flow Handlers**
   - `POST /ui/{service}/setup` - Stores client credentials, redirects to OAuth
   - `GET /ui/{service}/callback` - Handles OAuth callback, stores tokens
   - `POST /ui/{service}/delete` - Removes credentials

4. **Copy Buttons**
   - Redirect URIs have copy-to-clipboard buttons for easy setup

### Credentials Storage by Service

| Service | Stored Fields |
|---------|---------------|
| bluesky | identifier, appPassword, accessJwt, refreshJwt, did, expiresAt |
| mastodon | instance, clientId, clientSecret, accessToken |
| reddit | clientId, clientSecret, accessToken, refreshToken, expiresAt |
| google_calendar | clientId, clientSecret, accessToken, refreshToken, expiresAt |
| youtube | clientId, clientSecret, accessToken, refreshToken, expiresAt |
| linkedin | clientId, clientSecret, accessToken, refreshToken, expiresAt |
| jira | domain, email, apiToken |
| hsync | url, token, enabled |

## CLI (src/cli.js)

Manages API keys from command line (more secure than web UI).

```bash
npm run keys list              # List all API keys
npm run keys create <name>     # Create new key
npm run keys delete <id>       # Delete key by ID
```

Keys are prefixed with `rms_` followed by 32 random characters.

## hsync Integration (src/lib/hsyncManager.js)

Optional reverse proxy for exposing the gateway to remote agents.

### Exports

- `connectHsync(port)` - Connects to hsync server using stored config
- `disconnectHsync()` - Closes active connection
- `getHsyncUrl()` - Returns public URL if connected
- `isHsyncConnected()` - Returns boolean connection status

### Connection Flow

1. On server startup, `connectHsync(PORT)` is called
2. If hsync credentials exist and are enabled, connects to hsync server
3. Public URL is stored and displayed in UI
4. When disabled in UI, `disconnectHsync()` is called before removing credentials

### Configuration

Stored in `service_credentials` table with service name `hsync`:
```json
{
  "url": "https://yourname.hsync.tech",
  "token": "optional-token",
  "enabled": true
}
```

## Adding a New Service

1. **Create route file** (`src/routes/newservice.js`)
   ```javascript
   import { Router } from 'express';
   import { getCredentials, setCredentials } from '../lib/db.js';

   const router = Router();

   // Add BLOCKED_PATTERNS if service has DMs

   // Add token refresh logic if OAuth

   router.get('/*', async (req, res) => {
     // Validate credentials exist
     // Check blocked routes
     // Proxy request
   });

   export default router;
   ```

2. **Add to main server** (`src/index.js`)
   ```javascript
   import newserviceRoutes from './routes/newservice.js';

   app.use('/api/newservice', apiKeyAuth, readOnlyEnforce, newserviceRoutes);
   ```

3. **Add to /api/readme** in `src/index.js`
   - Add to `services` object
   - Add to `endpoints` object with examples

4. **Add UI configuration** (`src/routes/ui.js`)
   - Get credentials in main route handler
   - Pass to `renderPage()`
   - Add setup/callback/delete routes
   - Add HTML card in template

## Security Considerations

1. **API keys** - Managed via CLI only, not exposed in web UI
2. **Credentials storage** - SQLite file should be protected, is gitignored
3. **Read-only enforcement** - Middleware rejects non-GET at framework level
4. **DM blocking** - Regex patterns block private messaging routes
5. **Separation** - Gateway should run on different machine than agents
6. **OAuth scopes** - Request minimal read-only scopes where possible

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3050 | Server port |
| BASE_URL | http://localhost:$PORT | Base URL for OAuth callbacks |
| NODE_ENV | - | Set to "production" in systemd service |

## systemd Service

User service file at `agentgate.service`. Install with:

```bash
mkdir -p ~/.config/systemd/user
cp agentgate.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable agentgate
systemctl --user start agentgate
sudo loginctl enable-linger $USER  # run without login
```

## API Usage Examples

```bash
# Set your API key
KEY="rms_your_key_here"
BASE="http://localhost:3050"

# Get service manifest
curl -H "Authorization: Bearer $KEY" $BASE/api/readme

# GitHub (no config needed)
curl -H "Authorization: Bearer $KEY" $BASE/api/github/users/octocat

# Google Calendar
curl -H "Authorization: Bearer $KEY" $BASE/api/calendar/users/me/calendarList
curl -H "Authorization: Bearer $KEY" "$BASE/api/calendar/calendars/primary/events?timeMin=2024-01-01T00:00:00Z"

# Bluesky
curl -H "Authorization: Bearer $KEY" $BASE/api/bluesky/app.bsky.feed.getTimeline
curl -H "Authorization: Bearer $KEY" "$BASE/api/bluesky/app.bsky.actor.getProfile?actor=bsky.app"

# Mastodon
curl -H "Authorization: Bearer $KEY" $BASE/api/mastodon/api/v1/timelines/home
curl -H "Authorization: Bearer $KEY" $BASE/api/mastodon/api/v1/trends/tags

# Reddit
curl -H "Authorization: Bearer $KEY" $BASE/api/reddit/api/v1/me
curl -H "Authorization: Bearer $KEY" $BASE/api/reddit/r/programming/hot

# YouTube
curl -H "Authorization: Bearer $KEY" "$BASE/api/youtube/channels?part=snippet,statistics&mine=true"

# LinkedIn
curl -H "Authorization: Bearer $KEY" $BASE/api/linkedin/userinfo

# Jira
curl -H "Authorization: Bearer $KEY" $BASE/api/jira/myself
curl -H "Authorization: Bearer $KEY" "$BASE/api/jira/search?jql=assignee=currentUser()"
```

## Future Considerations

- **Rate limiting** - Per-service or global rate limits
- **Request logging** - Audit trail of agent requests
- **Multiple accounts** - Support multiple Google/social accounts
- **Webhooks** - Push notifications for calendar events, mentions, etc.
- **Caching** - Reduce API calls for frequently requested data
- **Service account support** - Google Workspace domain-wide delegation
