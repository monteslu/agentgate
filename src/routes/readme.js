import { Router } from 'express';
import { getAccountsByService, getMessagingMode, checkServiceAccess } from '../lib/db.js';
import SERVICE_REGISTRY from '../lib/serviceRegistry.js';

const router = Router();

// Agent readme endpoint
router.get('/', (req, res) => {
  const accountsByService = getAccountsByService();
  const agentName = req.apiKeyInfo?.name;

  // Build services object from registry, filtering by agent access
  const services = {};
  for (const [key, info] of Object.entries(SERVICE_REGISTRY)) {
    const dbKey = info.dbKey || key;
    const allAccounts = accountsByService[dbKey] || [];
    
    // Filter accounts based on agent access
    const accessibleAccounts = allAccounts.filter(accountName => {
      const access = checkServiceAccess(key, accountName, agentName);
      return access.allowed;
    });
    
    // Only include service if agent has access to at least one account
    if (accessibleAccounts.length > 0) {
      services[key] = {
        accounts: accessibleAccounts,
        authType: info.authType,
        description: info.description
      };
    }
  }

  // Build endpoints object from registry (only for accessible services)
  const endpoints = {};
  for (const [key, info] of Object.entries(SERVICE_REGISTRY)) {
    // Only include endpoint if agent has access to this service
    if (services[key]) {
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
    responseSimplification: {
      description: 'Service responses are simplified by default to reduce token usage (e.g., GitHub user profiles omit _url fields, Fitbit profiles omit badge images). To get the raw upstream response, set the header X-Agentgate-Raw: true',
      header: 'X-Agentgate-Raw: true',
      default: 'Simplified (token-optimized)',
      services: ['brave', 'bluesky', 'github', 'mastodon', 'fitbit', 'jira', 'google_search']
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
        body: {
          reason: 'Optional: Explain why you are withdrawing this request'
        },
        constraints: [
          'Only the submitting agent can withdraw their own items',
          'Only works for "pending" status - cannot withdraw approved/completed/etc',
          'Requires admin to enable agent_withdraw_enabled setting'
        ],
        response: '{ success: true, message: "Queue entry withdrawn", id, reason }'
      },
      warn: {
        description: 'Add a warning to a pending queue item (peer review). Cannot warn your own items.',
        method: 'POST',
        path: '/api/queue/{service}/{accountName}/{id}/warn',
        body: { message: 'Why this item is risky or problematic' },
        response: '{ success: true, message: "Warning added", warning_id, queue_id }',
        rules: [
          'Any agent can warn pending items submitted by other agents',
          'Cannot warn your own items (use withdraw instead)',
          'Only pending items can receive warnings',
          'Submitting agent is notified via webhook when their item receives a warning',
          'Warning agents are notified when the warned item is resolved (approved/rejected/completed/failed)'
        ]
      },
      getWarnings: {
        description: 'Get all warnings for a queue item',
        method: 'GET',
        path: '/api/queue/{service}/{accountName}/{id}/warnings',
        response: '{ warnings: [{ id, agent_id, message, created_at }, ...] }'
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
      events: ['completed', 'failed', 'rejected', 'agent_message', 'broadcast', 'message_rejected', 'queue_warning_resolved'],
      troubleshooting: [
        'Check webhook URL/token in API Keys → Configure',
        'Ensure hooks.enabled=true in your gateway config',
        'Test endpoint: curl -X POST <url> -H "Authorization: Bearer <token>" -d \'{"text":"test"}\''
      ],
      compatible: 'OpenClaw/Clawdbot gateway /hooks/wake endpoint',
      bestPractice: {
        description: 'Treat notifications as action triggers, not just acknowledgments',
        examples: [
          'Queue completed (PR created) → Request code review from teammate',
          'PR merged → Update docs, notify stakeholders, start next task',
          'Queue rejected → Read reason, fix issue, resubmit',
          'Queue failed → Check error, debug, resubmit',
          'Message received → Respond if needed and act on implied tasks',
          'Queue warning resolved → Check if your warning was heeded or overridden'
        ]
      },
      webhookResponsiveness: {
        description: 'Best practices for handling webhook notifications reliably',
        guidelines: [
          'Prioritize system notifications (💬/✅/❌/📢) before routine heartbeat tasks',
          'Reply to agent messages on the backchannel immediately — do not process silently',
          'Mark messages as read after handling (POST /api/agents/messages/:id/read)',
          'Never mix real content with heartbeat ack responses (e.g., HEARTBEAT_OK) — the entire message may be suppressed',
          'Keep processing turns short — long multi-tool turns make agents blind to incoming notifications',
          'Poll GET /api/agents/messages?unread=true on heartbeats to catch missed webhooks',
          'Use the warning system (POST /api/queue/:service/:account/:id/warn) for peer review of risky queue items'
        ],
        heartbeatTemplate: 'If there are System: messages above (💬, 📢, ✅, ❌, [agentgate]), ACT ON THEM FIRST. Do NOT reply HEARTBEAT_OK if there are unhandled notifications. Otherwise: check /api/agents/messages?unread=true and respond to anything pending.'
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
            body: { to_agent: 'recipient_agent_name', message: 'Your message content' },
            response: mode === 'supervised'
              ? '{ id, status: "pending", to: "recipient", message: "Message queued for human approval", via: "agentgate" }'
              : '{ id, status: "delivered", to: "recipient", message: "Message delivered", via: "agentgate" }'
          },
          getMessages: {
            method: 'GET',
            path: '/api/agents/messages',
            queryParams: { unread: 'true (optional) - only return unread messages' },
            response: '{ via: "agentgate", mode, messages: [{ id, from, message, created_at, read }, ...] }'
          },
          markRead: {
            method: 'POST',
            path: '/api/agents/messages/:id/read',
            response: '{ success: true, via: "agentgate" }'
          },
          status: {
            method: 'GET',
            path: '/api/agents/status',
            response: '{ via: "agentgate", mode, enabled, unread_count }'
          },
          discoverAgents: {
            method: 'GET',
            path: '/api/agents/messageable',
            description: 'Discover which agents you can message',
            response: '{ via: "agentgate", mode, agents: [{ name, enabled }, ...] }'
          },
          broadcast: {
            method: 'POST',
            path: '/api/agents/broadcast',
            description: 'Send a message to ALL agents with webhooks (excluding yourself)',
            body: { message: 'Your broadcast message' },
            response: '{ via: "agentgate", broadcast_id, delivered: ["Agent1", "Agent2"], failed: [{ name: "Agent3", error: "HTTP 500" }], total: 3 }',
            notes: [
              'Broadcasts are stored in the database and appear in message history',
              'Sender is automatically excluded from recipients',
              'Requires messaging mode to be "supervised" or "open" (not "off")',
              'View broadcast history in Admin UI under Messages → Broadcast'
            ]
          },
          getBroadcasts: {
            method: 'GET',
            path: '/api/agents/messages',
            description: 'Broadcasts appear in your regular message history with from="[BROADCAST]"',
            note: 'No separate endpoint - broadcasts are included with regular messages'
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
          'Maximum message length is 10KB',
          'All responses include "via": "agentgate" to distinguish from other messaging systems',
          'Use "to_agent" field (not sessionKey, label, or other identifiers from different systems)'
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
    },
    bypassAuth: {
      description: 'Trusted agents can bypass the write queue entirely, executing write operations immediately without human approval.',
      warning: 'Use with extreme caution. Only enable for agents you completely trust with unsupervised write access.',
      setup: {
        description: 'Configure in Admin UI under API Keys → Configure → Auth Bypass',
        note: 'This is a per-agent setting managed by the admin'
      },
      behavior: {
        enabled: [
          'All write operations (POST/PUT/DELETE) execute immediately',
          'No queue entries are created',
          'The agent is effectively operating unsupervised',
          'Reads work the same as before'
        ],
        disabled: 'Default behavior - writes are queued for human approval'
      },
      checkStatus: {
        method: 'GET',
        path: '/api/agents/status',
        description: 'Check if your agent has bypass_auth enabled',
        response: '{ mode, enabled, unread_count, bypass_auth: true|false }'
      },
      notes: [
        'Bypass applies to all services the agent has access to',
        'Useful for automation agents that need to perform routine operations',
        'Admin can revoke bypass at any time'
      ]
    }
  });
});

export default router;
