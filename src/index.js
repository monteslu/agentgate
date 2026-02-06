import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validateApiKey, getAccountsByService, getCookieSecret, getMessagingMode, checkServiceAccess } from './lib/db.js';
import { connectHsync } from './lib/hsyncManager.js';
import { initSocket } from './lib/socketManager.js';
import githubRoutes, { serviceInfo as githubInfo } from './routes/github.js';
import blueskyRoutes, { serviceInfo as blueskyInfo } from './routes/bluesky.js';
import redditRoutes, { serviceInfo as redditInfo } from './routes/reddit.js';
import calendarRoutes, { serviceInfo as calendarInfo } from './routes/calendar.js';
import mastodonRoutes, { serviceInfo as mastodonInfo } from './routes/mastodon.js';
import linkedinRoutes, { serviceInfo as linkedinInfo } from './routes/linkedin.js';
import youtubeRoutes, { serviceInfo as youtubeInfo } from './routes/youtube.js';
import jiraRoutes, { serviceInfo as jiraInfo } from './routes/jira.js';
import fitbitRoutes, { serviceInfo as fitbitInfo } from './routes/fitbit.js';
import queueRoutes from './routes/queue.js';
import agentsRoutes from './routes/agents.js';
import mementoRoutes from './routes/memento.js';
import uiRoutes from './routes/ui/index.js';
import webhooksRoutes from './routes/webhooks.js';
import servicesRoutes from './routes/services.js';

// Aggregate service metadata from all routes
const SERVICE_REGISTRY = {
  [githubInfo.key]: githubInfo,
  [blueskyInfo.key]: blueskyInfo,
  [mastodonInfo.key]: mastodonInfo,
  [redditInfo.key]: redditInfo,
  [calendarInfo.key]: calendarInfo,
  [youtubeInfo.key]: youtubeInfo,
  [linkedinInfo.key]: linkedinInfo,
  [jiraInfo.key]: jiraInfo,
  [fitbitInfo.key]: fitbitInfo
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3050;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    // Capture raw body for webhook signature verification
    if (req.originalUrl.startsWith('/webhooks')) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(getCookieSecret()));
app.use('/public', express.static(join(__dirname, '../public')));

// API key auth middleware for /api routes
async function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const key = authHeader.slice(7);
  const valid = await validateApiKey(key);
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


// Service access control middleware factory
// Checks if the agent has access to the requested service/account
function serviceAccessCheck(serviceName) {
  return (req, res, next) => {
    const accountName = req.params.accountName || req.params[0]?.split('/')[0];
    if (!accountName) {
      return next(); // No account specified, let the route handle it
    }

    const agentName = req.apiKeyInfo?.name;
    if (!agentName) {
      return next(); // No agent info, let other middleware handle auth
    }

    const access = checkServiceAccess(serviceName, accountName, agentName);
    if (!access.allowed) {
      return res.status(403).json({
        error: `Agent '${agentName}' does not have access to service '${serviceName}/${accountName}'`,
        reason: access.reason
      });
    }
    next();
  };
}

// API routes - require auth, read-only, and service access check
// Pattern: /api/{service}/{accountName}/...
app.use('/api/github', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('github'), githubRoutes);
app.use('/api/bluesky', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('bluesky'), blueskyRoutes);
app.use('/api/reddit', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('reddit'), redditRoutes);
app.use('/api/calendar', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('calendar'), calendarRoutes);
app.use('/api/mastodon', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('mastodon'), mastodonRoutes);
app.use('/api/linkedin', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('linkedin'), linkedinRoutes);
app.use('/api/youtube', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('youtube'), youtubeRoutes);
app.use('/api/jira', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('jira'), jiraRoutes);
app.use('/api/fitbit', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('fitbit'), fitbitRoutes);

// Service access management - admin API (requires auth)
app.use('/api/services', apiKeyAuth, servicesRoutes);

// Queue routes - require auth but allow POST for submitting write requests
// Pattern: /api/queue/{service}/{accountName}/submit
app.use('/api/queue', apiKeyAuth, queueRoutes);

// Agent messaging routes - require auth, allow POST for sending messages
// Includes apiKeyName in req for sender identification
app.use('/api/agents', apiKeyAuth, (req, res, next) => {
  req.apiKeyName = req.apiKeyInfo.name;
  next();
}, agentsRoutes);

// Memento routes - require auth, allow POST for creating mementos
app.use('/api/agents/memento', apiKeyAuth, (req, res, next) => {
  req.apiKeyName = req.apiKeyInfo.name;
  next();
}, mementoRoutes);

// UI routes - no API key needed (local admin access)
app.use('/ui', uiRoutes);

// Webhook routes - no API key needed (uses signature verification instead)
app.use('/webhooks', webhooksRoutes);

// Agent readme endpoint - requires auth
app.get('/api/readme', apiKeyAuth, (req, res) => {
  const accountsByService = getAccountsByService();

  // Build services object from registry
  const services = {};
  for (const [key, info] of Object.entries(SERVICE_REGISTRY)) {
    const dbKey = info.dbKey || key;
    services[key] = {
      accounts: accountsByService[dbKey] || [],
      authType: info.authType,
      description: info.description
    };
  }

  // Build endpoints object from registry
  const endpoints = {};
  for (const [key, info] of Object.entries(SERVICE_REGISTRY)) {
    endpoints[key] = {
      base: `/api/${key}/{accountName}`,
      description: info.description,
      docs: info.docs,
      examples: info.examples
    };
    if (info.writeGuidelines) {
      endpoints[key].writeGuidelines = info.writeGuidelines;
    }
  }

  res.json({
    name: 'agentgate',
    description: 'API gateway for personal data with human-in-the-loop write approval. Read requests (GET) execute immediately. Write requests (POST/PUT/DELETE) are queued for human approval before execution.',
    urlPattern: '/api/{service}/{accountName}/...',
    services,
    endpoints,
    auth: {
      type: 'bearer',
      header: 'Authorization: Bearer {your_api_key}'
    },
    writeQueue: {
      description: 'For write operations (POST/PUT/DELETE), you must submit requests to the write queue. A human will review and approve or reject your request. You cannot execute write operations directly.',
      workflow: [
        '1. Submit your write request(s) with a comment explaining your intent',
        '2. Wait for webhook notification OR poll the status endpoint',
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
          requests: '[{ method: "POST"|"PUT"|"PATCH"|"DELETE", path: "/api/path", body?: {}, headers?: {}, binaryBase64?: boolean }, ...]',
          comment: 'Required: Explain what you are trying to do and why'
        },
        response: '{ id: "queue_entry_id", status: "pending" }'
      },
      binaryUploads: {
        description: 'For binary data uploads (images, files), set binaryBase64: true and provide base64-encoded data in body',
        example: {
          method: 'POST',
          path: 'com.atproto.repo.uploadBlob',
          binaryBase64: true,
          headers: { 'Content-Type': 'image/jpeg' },
          body: '<base64 encoded image data>'
        },
        note: 'The executor will decode base64 to binary before sending'
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
        response: '{ count: number, shared_visibility: boolean, entries: [{ id, service, account_name, comment, status, submitted_by, rejection_reason?, submitted_at, reviewed_at?, completed_at? }, ...] }',
        sharedVisibility: 'When shared_queue_visibility is enabled by admin, agents can see ALL queue items (not just their own). Response includes shared_visibility: true when active.'
      },
      withdraw: {
        description: 'Withdraw your own pending submission (requires agent_withdraw_enabled setting)',
        method: 'DELETE',
        path: '/api/queue/{service}/{accountName}/status/{id}',
        constraints: [
          'Only the submitting agent can withdraw their own items',
          'Only works for "pending" status - cannot withdraw approved/completed/etc',
          'Requires admin to enable agent_withdraw_enabled setting'
        ],
        response: '{ success: true, message: "Queue entry withdrawn", id }'
      },
      statuses: {
        pending: 'Waiting for human approval',
        approved: 'Approved, about to execute',
        executing: 'Currently running the requests',
        completed: 'All requests succeeded',
        failed: 'One or more requests failed (check results)',
        rejected: 'Human rejected the request (check rejection_reason)',
        withdrawn: 'Agent withdrew their own pending request'
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
    },
    notifications: {
      description: 'Agents receive webhook notifications for queue status updates (completed/failed/rejected) and agent messages. Each agent configures their own webhook.',
      setup: {
        agentgateConfig: {
          description: 'Configure YOUR webhook in agentgate Admin UI',
          steps: [
            '1. Go to Admin UI → API Keys',
            '2. Click "Configure" next to your API key',
            '3. Enter Webhook URL (e.g., https://your-gateway.com/hooks/wake)',
            '4. Enter Authorization Token (bearer token for your gateway)'
          ]
        },
        gatewayConfig: {
          description: 'Your gateway must ALSO have webhooks enabled to receive POSTs',
          openclaw: 'Add to config: { "hooks": { "enabled": true, "token": "your-token" } }',
          note: 'Without this, your gateway returns 405 and notifications fail silently'
        }
      },
      webhookFormat: {
        description: 'POST to your webhook URL with JSON body',
        payload: {
          text: 'Notification message with status, service, result URL, and original comment',
          mode: 'now'
        },
        example: '✅ [agentgate] Queue #abc123 completed\\n→ github/monteslu\\n→ https://github.com/...\\nOriginal: "Create PR"'
      },
      events: ['completed', 'failed', 'rejected', 'agent_message', 'broadcast', 'message_rejected'],
      troubleshooting: [
        'Check webhook URL/token in API Keys → Configure',
        'Ensure hooks.enabled=true in your gateway config',
        'Test endpoint: curl -X POST <url> -H "Authorization: Bearer <token>" -d \'{"text":"test"}\''
      ],
      compatible: 'OpenClaw/Clawdbot /hooks/wake endpoint',
      bestPractice: {
        description: 'Treat notifications as action triggers, not just acknowledgments',
        examples: [
          'Queue completed (PR created) → Request code review from teammate',
          'PR merged → Update docs, notify stakeholders, start next task',
          'Queue rejected → Read reason, fix issue, resubmit',
          'Queue failed → Check error, debug, resubmit',
          'Message received → Respond if needed and act on implied tasks'
        ]
      }
    },
    skill: {
      description: 'Generate a SKILL.md file for OpenClaw/AgentSkills compatible systems',
      endpoint: 'GET /api/skill',
      docs: 'https://docs.openclaw.ai/tools/skills',
      queryParams: {
        base_url: 'Override the base URL in the generated skill (optional)'
      }
    },
    agentMessaging: (() => {
      const mode = getMessagingMode();
      return {
        enabled: mode !== 'off',
        mode,
        description: mode === 'off'
          ? 'Agent-to-agent messaging is disabled. Admin can enable it in the agentgate UI.'
          : mode === 'supervised'
            ? 'Agents can message each other. Messages require human approval before delivery.'
            : 'Agents can message each other freely without approval.',
        endpoints: {
          sendMessage: {
            method: 'POST',
            path: '/api/agents/message',
            body: { to: 'recipient_agent_name', message: 'Your message content' },
            response: mode === 'supervised'
              ? '{ id, status: "pending", message: "Message queued for human approval" }'
              : '{ id, status: "delivered", message: "Message delivered" }'
          },
          getMessages: {
            method: 'GET',
            path: '/api/agents/messages',
            queryParams: { unread: 'true (optional) - only return unread messages' },
            response: '{ mode, messages: [{ id, from, message, created_at, read }, ...] }'
          },
          markRead: {
            method: 'POST',
            path: '/api/agents/messages/:id/read',
            response: '{ success: true }'
          },
          status: {
            method: 'GET',
            path: '/api/agents/status',
            response: '{ mode, enabled, unread_count }'
          },
          discoverAgents: {
            method: 'GET',
            path: '/api/agents/messageable',
            description: 'Discover which agents you can message',
            response: '{ mode, agents: [{ name }, ...] }'
          },
          broadcast: {
            method: 'POST',
            path: '/api/agents/broadcast',
            description: 'Send a message to ALL agents with webhooks (excluding yourself)',
            body: { message: 'Your broadcast message' },
            response: '{ delivered: ["Agent1", "Agent2"], failed: [{ name: "Agent3", error: "HTTP 500" }], total: 3 }',
            notes: [
              'Broadcasts go directly to agent webhooks - not stored in messages table',
              'Sender is automatically excluded from recipients',
              'Requires messaging mode to be "supervised" or "open" (not "off")'
            ]
          }
        },
        modes: {
          off: 'Messaging disabled - agents cannot communicate',
          supervised: 'Messages require human approval before delivery',
          open: 'Messages delivered immediately without approval'
        },
        notes: [
          'Agent names are case-insensitive (e.g., "WorkBot" and "workbot" are the same)',
          'Agents cannot message themselves',
          'Maximum message length is 10KB'
        ]
      };
    })(),
    memento: {
      description: 'Durable memory storage for agents. Store and retrieve memory snapshots tagged with keywords.',
      design: {
        appendOnly: 'Mementos are immutable once stored. New memories can be added but not edited.',
        keywordTagging: 'Each memento has 1-10 keywords. Keywords are normalized (lowercase) and stemmed (Porter stemmer).',
        twoStepRetrieval: 'Search returns metadata only. Fetch specific IDs to get full content. This prevents context bloat.',
        tokenBudget: 'Recommended ~1.5-2K tokens per memento. Hard cap: 12KB characters.'
      },
      endpoints: {
        store: {
          method: 'POST',
          path: '/api/agents/memento',
          body: {
            content: 'Your memory content (required)',
            keywords: ['keyword1', 'keyword2', '...'],
            model: 'Model at time of storage (optional)',
            role: 'Agent role/tier (optional)'
          },
          response: '{ id, agent_id, keywords, created_at }'
        },
        listKeywords: {
          method: 'GET',
          path: '/api/agents/memento/keywords',
          description: 'List all keywords you have used (returned in stemmed form, e.g., "games" → "game")',
          response: '{ keywords: [{ keyword, count }, ...] }'
        },
        search: {
          method: 'GET',
          path: '/api/agents/memento/search?keywords=game,project&limit=10',
          description: 'Search mementos by keyword. Returns metadata only (preview, not full content).',
          response: '{ matches: [{ id, keywords, created_at, preview, match_count }, ...] }'
        },
        recent: {
          method: 'GET',
          path: '/api/agents/memento/recent?limit=5',
          description: 'Get most recent mementos (metadata only)',
          response: '{ mementos: [{ id, keywords, created_at, preview }, ...] }'
        },
        fetch: {
          method: 'GET',
          path: '/api/agents/memento/42,38,15',
          description: 'Fetch full content by IDs (comma-separated, max 20)',
          response: '{ mementos: [{ id, agent_id, model, role, keywords, content, created_at }, ...] }'
        }
      },
      retrievalHierarchy: [
        '1. Check current context first — already in conversation?',
        '2. Query Memento — if not in context, search by keyword',
        '3. Web search — if no memento, fall back to internet'
      ],
      notes: [
        'Each agent sees only their own mementos',
        'Keywords are stemmed: "games" matches "game", "running" matches "run"',
        'Maximum 10 keywords per memento',
        'Maximum 12KB content per memento'
      ]
    },
    serviceAccess: {
      description: 'Service-level access control. Restrict which agents can access specific services.',
      accessModes: {
        all: 'All agents can access (default)',
        allowlist: 'Only listed agents can access',
        denylist: 'All agents EXCEPT listed ones can access'
      },
      endpoints: {
        list: {
          method: 'GET',
          path: '/api/services',
          description: 'List all services with their access configuration',
          response: '{ services: [{ service, account_name, access_mode, agent_count }, ...] }'
        },
        getAccess: {
          method: 'GET',
          path: '/api/services/:service/:account/access',
          description: 'Get access config for a specific service/account',
          response: '{ service, account_name, access_mode, agents: [{ name, allowed }, ...] }'
        },
        setMode: {
          method: 'PUT',
          path: '/api/services/:service/:account/access',
          body: { access_mode: 'all | allowlist | denylist' },
          description: 'Set access mode for a service/account',
          response: '{ success: true, access_mode }'
        },
        setAgents: {
          method: 'POST',
          path: '/api/services/:service/:account/access/agents',
          body: { agents: [{ name: 'AgentName', allowed: true }, '...'] },
          description: 'Set which agents are in the allow/deny list',
          response: '{ success: true, agents: [...] }'
        }
      },
      errorResponse: {
        status: 403,
        body: '{ error: "Agent \'X\' does not have access to service \'Y/Z\'", reason: "not_in_allowlist" }'
      },
      notes: [
        'Access checks apply to all service API calls',
        'Default mode is "all" (backwards compatible)',
        'Agent names are case-insensitive',
        'Admin UI shows visual indicators for restricted services'
      ]
    }
  });
});

// Generate SKILL.md for OpenClaw/AgentSkills compatible systems
// See: https://docs.openclaw.ai/tools/skills
app.get('/api/skill', apiKeyAuth, (req, res) => {
  const baseUrl = req.query.base_url || BASE_URL;
  const accountsByService = getAccountsByService();

  // Build list of configured services dynamically
  const configuredServices = [];
  for (const [serviceKey, info] of Object.entries(SERVICE_REGISTRY)) {
    const dbKey = info.dbKey || serviceKey;
    const accounts = accountsByService[dbKey] || [];
    if (accounts.length > 0) {
      configuredServices.push(`- **${info.name}**: ${accounts.join(', ')}`);
    }
  }

  // Build supported services list for description
  const supportedServices = Object.values(SERVICE_REGISTRY).map(s => s.name).join(', ');

  // Generate example read endpoints from configured services
  const readExamples = [];
  for (const [serviceKey, info] of Object.entries(SERVICE_REGISTRY)) {
    const dbKey = info.dbKey || serviceKey;
    const accounts = accountsByService[dbKey] || [];
    if (accounts.length > 0 && info.examples && info.examples.length > 0) {
      // Take first example, replace {accountName} with actual account
      const example = info.examples[0].replace('{accountName}', accounts[0]);
      readExamples.push(`- \`${example.replace('GET ', baseUrl)}\``);
      if (readExamples.length >= 3) break;
    }
  }

  // Collect any write guidelines
  const writeGuidelines = [];
  for (const [_serviceKey, info] of Object.entries(SERVICE_REGISTRY)) {
    if (info.writeGuidelines) {
      writeGuidelines.push(`### ${info.name}\n${info.writeGuidelines.map(g => `- ${g}`).join('\n')}`);
    }
  }

  const skillMd = `---
name: agentgate
description: Access personal data through agentgate API gateway. Supports ${supportedServices}. Read requests execute immediately. Write requests are queued for human approval.
metadata: { "openclaw": { "emoji": "🚪", "requires": { "env": ["AGENTGATE_API_KEY"] } } }
---

# agentgate

API gateway for accessing personal data with human-in-the-loop write approval.

## Configuration

- **Base URL**: \`${baseUrl}\`
- **API Key**: Use the \`AGENTGATE_API_KEY\` environment variable

## Configured Services

${configuredServices.length > 0 ? configuredServices.join('\n') : '_No services configured yet_'}

## Authentication

All requests require the API key in the Authorization header:

\`\`\`
Authorization: Bearer $AGENTGATE_API_KEY
\`\`\`

## Read Requests (Immediate)

Make GET requests to \`${baseUrl}/api/{service}/{accountName}/...\`

${readExamples.length > 0 ? 'Examples:\n' + readExamples.join('\n') : ''}

## Write Requests (Queued for Approval)

Write operations (POST/PUT/DELETE) must go through the queue:

1. **Submit request**:
   \`\`\`
   POST ${baseUrl}/api/queue/{service}/{accountName}/submit
   {
     "requests": [{ "method": "POST", "path": "/path", "body": {...} }],
     "comment": "Explain what you're doing and why. Include [links](url) to relevant issues/PRs."
   }
   \`\`\`

2. **Poll for status**:
   \`\`\`
   GET ${baseUrl}/api/queue/{service}/{accountName}/status/{id}
   \`\`\`

3. **Check response**: \`pending\`, \`completed\`, \`failed\`, or \`rejected\` (with reason)

## Binary Uploads

For binary data (images, files), set \`binaryBase64: true\` in the request:

\`\`\`json
{
  "method": "POST",
  "path": "com.atproto.repo.uploadBlob",
  "binaryBase64": true,
  "headers": { "Content-Type": "image/jpeg" },
  "body": "<base64 encoded data>"
}
\`\`\`

## Important Notes

- Always include a clear comment explaining your intent
- Include markdown links to relevant resources (issues, PRs, docs)
- Be patient - approval requires human action
- For binary uploads, encode data as base64 and set binaryBase64: true

${writeGuidelines.length > 0 ? '## Service-Specific Guidelines\n\n' + writeGuidelines.join('\n\n') : ''}

## Full API Documentation

For complete endpoint documentation, fetch:
\`\`\`
GET ${baseUrl}/api/readme
\`\`\`
`;

  res.type('text/markdown').send(skillMd);
});

// Root redirect to UI
app.get('/', (req, res) => {
  res.redirect('/ui');
});

const server = app.listen(PORT, async () => {
  console.log(`agentgate gateway running at http://localhost:${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/ui`);

  // Initialize socket.io for real-time updates
  initSocket(server);
  console.log('Socket.io initialized for real-time updates');

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

