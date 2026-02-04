import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validateApiKey, getAccountsByService, getCookieSecret } from './lib/db.js';
import { connectHsync } from './lib/hsyncManager.js';
import githubRoutes from './routes/github.js';
import blueskyRoutes from './routes/bluesky.js';
import redditRoutes from './routes/reddit.js';
import calendarRoutes from './routes/calendar.js';
import mastodonRoutes from './routes/mastodon.js';
import linkedinRoutes from './routes/linkedin.js';
import youtubeRoutes from './routes/youtube.js';
import jiraRoutes from './routes/jira.js';
import fitbitRoutes from './routes/fitbit.js';
import queueRoutes from './routes/queue.js';
import uiRoutes from './routes/ui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3050;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(getCookieSecret()));
app.use('/public', express.static(join(__dirname, '../public')));

// API key auth middleware for /api routes
function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const key = authHeader.slice(7);
  const valid = validateApiKey(key);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.apiKeyInfo = valid;
  next();
}

// Read-only enforcement - only allow GET requests to API
function readOnlyEnforce(req, res, next) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Only GET requests allowed (read-only access)' });
  }
  next();
}

// API routes - require auth and read-only
// Pattern: /api/{service}/{accountName}/...
app.use('/api/github', apiKeyAuth, readOnlyEnforce, githubRoutes);
app.use('/api/bluesky', apiKeyAuth, readOnlyEnforce, blueskyRoutes);
app.use('/api/reddit', apiKeyAuth, readOnlyEnforce, redditRoutes);
app.use('/api/calendar', apiKeyAuth, readOnlyEnforce, calendarRoutes);
app.use('/api/mastodon', apiKeyAuth, readOnlyEnforce, mastodonRoutes);
app.use('/api/linkedin', apiKeyAuth, readOnlyEnforce, linkedinRoutes);
app.use('/api/youtube', apiKeyAuth, readOnlyEnforce, youtubeRoutes);
app.use('/api/jira', apiKeyAuth, readOnlyEnforce, jiraRoutes);
app.use('/api/fitbit', apiKeyAuth, readOnlyEnforce, fitbitRoutes);

// Queue routes - require auth but allow POST for submitting write requests
// Pattern: /api/queue/{service}/{accountName}/submit
app.use('/api/queue', apiKeyAuth, queueRoutes);

// UI routes - no API key needed (local admin access)
app.use('/ui', uiRoutes);

// Agent readme endpoint - requires auth
app.get('/api/readme', apiKeyAuth, (req, res) => {
  const accountsByService = getAccountsByService();

  const services = {
    github: {
      accounts: accountsByService.github || [],
      authType: 'personal access token',
      description: 'GitHub API proxy'
    },
    bluesky: {
      accounts: accountsByService.bluesky || [],
      authType: 'app password',
      description: 'Bluesky/AT Protocol proxy (DMs blocked)'
    },
    mastodon: {
      accounts: accountsByService.mastodon || [],
      authType: 'oauth',
      description: 'Mastodon API proxy (DMs blocked)'
    },
    reddit: {
      accounts: accountsByService.reddit || [],
      authType: 'oauth',
      description: 'Reddit API proxy (DMs blocked)'
    },
    calendar: {
      accounts: accountsByService.google_calendar || [],
      authType: 'oauth',
      description: 'Google Calendar API proxy (read-only)'
    },
    youtube: {
      accounts: accountsByService.youtube || [],
      authType: 'oauth',
      description: 'YouTube Data API proxy (read-only)'
    },
    linkedin: {
      accounts: accountsByService.linkedin || [],
      authType: 'oauth',
      description: 'LinkedIn API proxy (messaging blocked)'
    },
    jira: {
      accounts: accountsByService.jira || [],
      authType: 'api token',
      description: 'Jira API proxy (read-only)'
    },
    fitbit: {
      accounts: accountsByService.fitbit || [],
      authType: 'oauth',
      description: 'Fitbit API proxy (read-only)'
    }
  };

  res.json({
    name: 'agentgate',
    description: 'API gateway for personal data with human-in-the-loop write approval. Read requests (GET) execute immediately. Write requests (POST/PUT/DELETE) are queued for human approval before execution.',
    urlPattern: '/api/{service}/{accountName}/...',
    services,
    endpoints: {
      github: {
        base: '/api/github/{accountName}',
        description: 'GitHub API proxy',
        docs: 'https://docs.github.com/en/rest',
        examples: [
          'GET /api/github/{accountName}/users/{username}',
          'GET /api/github/{accountName}/repos/{owner}/{repo}',
          'GET /api/github/{accountName}/repos/{owner}/{repo}/commits'
        ],
        writeGuidelines: [
          'NEVER push directly to main/master branches (except for initial commits on new projects)',
          'Always create a new branch for changes to existing projects',
          'Run tests locally before submitting PRs (if tests exist)',
          'Create a pull request for review',
          'Workflow: create branch → commit changes → run tests → create PR'
        ]
      },
      bluesky: {
        base: '/api/bluesky/{accountName}',
        description: 'Bluesky/AT Protocol proxy (DMs blocked)',
        docs: 'https://docs.bsky.app/docs/api/',
        examples: [
          'GET /api/bluesky/{accountName}/app.bsky.feed.getTimeline',
          'GET /api/bluesky/{accountName}/app.bsky.feed.getAuthorFeed?actor={handle}',
          'GET /api/bluesky/{accountName}/app.bsky.actor.getProfile?actor={handle}'
        ]
      },
      mastodon: {
        base: '/api/mastodon/{accountName}',
        description: 'Mastodon API proxy (DMs blocked)',
        docs: 'https://docs.joinmastodon.org/api/',
        examples: [
          'GET /api/mastodon/{accountName}/api/v1/timelines/home',
          'GET /api/mastodon/{accountName}/api/v1/accounts/verify_credentials',
          'GET /api/mastodon/{accountName}/api/v1/notifications'
        ]
      },
      reddit: {
        base: '/api/reddit/{accountName}',
        description: 'Reddit API proxy (DMs blocked)',
        docs: 'https://www.reddit.com/dev/api/',
        examples: [
          'GET /api/reddit/{accountName}/api/v1/me',
          'GET /api/reddit/{accountName}/r/{subreddit}/hot',
          'GET /api/reddit/{accountName}/user/{username}/submitted'
        ]
      },
      calendar: {
        base: '/api/calendar/{accountName}',
        description: 'Google Calendar API proxy (read-only)',
        docs: 'https://developers.google.com/calendar/api/v3/reference',
        examples: [
          'GET /api/calendar/{accountName}/users/me/calendarList',
          'GET /api/calendar/{accountName}/calendars/primary/events',
          'GET /api/calendar/{accountName}/calendars/{calendarId}/events?timeMin={ISO8601}&timeMax={ISO8601}'
        ]
      },
      youtube: {
        base: '/api/youtube/{accountName}',
        description: 'YouTube Data API proxy (read-only)',
        docs: 'https://developers.google.com/youtube/v3/docs',
        examples: [
          'GET /api/youtube/{accountName}/channels?part=snippet,statistics&mine=true',
          'GET /api/youtube/{accountName}/videos?part=snippet,statistics&myRating=like',
          'GET /api/youtube/{accountName}/subscriptions?part=snippet&mine=true'
        ]
      },
      linkedin: {
        base: '/api/linkedin/{accountName}',
        description: 'LinkedIn API proxy (messaging blocked)',
        docs: 'https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api',
        examples: [
          'GET /api/linkedin/{accountName}/me',
          'GET /api/linkedin/{accountName}/userinfo'
        ]
      },
      jira: {
        base: '/api/jira/{accountName}',
        description: 'Jira API proxy (read-only)',
        docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
        examples: [
          'GET /api/jira/{accountName}/myself',
          'GET /api/jira/{accountName}/project',
          'GET /api/jira/{accountName}/search?jql=assignee=currentUser()',
          'GET /api/jira/{accountName}/issue/{issueKey}'
        ]
      },
      fitbit: {
        base: '/api/fitbit/{accountName}',
        description: 'Fitbit API proxy (read-only)',
        docs: 'https://dev.fitbit.com/build/reference/web-api/',
        examples: [
          'GET /api/fitbit/{accountName}/1/user/-/profile.json',
          'GET /api/fitbit/{accountName}/1/user/-/activities/date/today.json',
          'GET /api/fitbit/{accountName}/1/user/-/sleep/date/today.json',
          'GET /api/fitbit/{accountName}/1/user/-/body/log/weight/date/today.json'
        ]
      }
    },
    auth: {
      type: 'bearer',
      header: 'Authorization: Bearer {your_api_key}'
    },
    writeQueue: {
      description: 'For write operations (POST/PUT/DELETE), you must submit requests to the write queue. A human will review and approve or reject your request. You cannot execute write operations directly.',
      workflow: [
        '1. Submit your write request(s) with a comment explaining your intent',
        '2. Poll the status endpoint to check if approved/rejected',
        '3. If rejected, check rejection_reason and adjust your approach',
        '4. If approved and completed, results contain the API responses',
        '5. If failed, results show which request failed and why'
      ],
      importantNotes: [
        'Always include a clear comment explaining WHY you want to make these changes',
        'Include markdown links to relevant resources (issues, PRs, docs) so the reviewer has context',
        'Batch requests execute in order and stop on first failure',
        'You cannot approve your own requests - a human must review them',
        'Be patient - approval requires human action'
      ],
      commentFormat: {
        description: 'Comments support markdown. Include links to help the reviewer understand context.',
        example: 'Closing issue [#42](https://github.com/owner/repo/issues/42) as completed. See related PR [#45](https://github.com/owner/repo/pull/45) for the fix.'
      },
      submit: {
        method: 'POST',
        path: '/api/queue/{service}/{accountName}/submit',
        body: {
          requests: '[{ method: "POST"|"PUT"|"PATCH"|"DELETE", path: "/api/path", body?: {}, headers?: {} }, ...]',
          comment: 'Required: Explain what you are trying to do and why'
        },
        response: '{ id: "queue_entry_id", status: "pending" }'
      },
      checkStatus: {
        method: 'GET',
        path: '/api/queue/{service}/{accountName}/status/{id}',
        responses: {
          pending: '{ id, status: "pending", submitted_at }',
          rejected: '{ id, status: "rejected", rejection_reason: "why it was rejected", reviewed_at }',
          completed: '{ id, status: "completed", results: [{ ok: true, status: 200, body: {...} }, ...], completed_at }',
          failed: '{ id, status: "failed", results: [{ ok: true, ... }, { ok: false, status: 404, body: {...} }], completed_at }'
        }
      },
      listMyRequests: {
        description: 'List all queue entries you have submitted. Returns summary info only (no full request bodies or results). Use checkStatus with a specific ID to get full details.',
        methods: [
          { method: 'GET', path: '/api/queue/list', description: 'List all your submissions across all services' },
          { method: 'GET', path: '/api/queue/{service}/{accountName}/list', description: 'List your submissions for a specific service/account' }
        ],
        response: '{ count: number, entries: [{ id, service, account_name, comment, status, rejection_reason?, submitted_at, reviewed_at?, completed_at? }, ...] }'
      },
      statuses: {
        pending: 'Waiting for human approval',
        approved: 'Approved, about to execute',
        executing: 'Currently running the requests',
        completed: 'All requests succeeded',
        failed: 'One or more requests failed (check results)',
        rejected: 'Human rejected the request (check rejection_reason)'
      },
      example: {
        submit: {
          method: 'POST',
          url: '/api/queue/github/personal/submit',
          body: {
            requests: [
              { method: 'POST', path: '/repos/owner/repo/issues', body: { title: 'Bug report', body: 'Description here' } }
            ],
            comment: 'Creating an issue to track the bug we discussed in the conversation'
          }
        },
        checkStatus: {
          method: 'GET',
          url: '/api/queue/github/personal/status/{id_from_submit_response}'
        }
      }
    }
  });
});

// Root redirect to UI
app.get('/', (req, res) => {
  res.redirect('/ui');
});

const server = app.listen(PORT, async () => {
  console.log(`agentgate gateway running at http://localhost:${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/ui`);

  // Start hsync if configured
  try {
    await connectHsync(PORT);
  } catch (err) {
    console.error('hsync connection error:', err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use. Is another instance running?`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
