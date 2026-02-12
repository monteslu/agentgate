// MCP (Model Context Protocol) route handler — Streamable HTTP transport
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  submitWriteRequest,
  listQueueEntries,
  getQueueStatus,
  withdrawQueueEntry,
  addWarningToQueue,
  getWarningsForQueue
} from '../services/queueService.js';
import {
  searchMementosByKeywords,
  saveMemento,
  listMementoKeywords,
  listRecentMementos,
  getMementosByIds
} from '../services/mementoService.js';
import {
  listAccessibleServices
} from '../services/serviceService.js';
import {
  checkServiceAccess,
  getMessagesForAgent,
  getMessagingMode,
  getApiKeyByName,
  listApiKeys,
  createBroadcast,
  addBroadcastRecipient,
  markMessageRead,
  listBroadcastsWithRecipients,
  getBroadcast,
  createAgentMessage,
  upsertMcpSession,
  touchMcpSession as dbTouchMcpSession,
  getMcpSession,
  deleteMcpSession,
  deleteMcpSessionsForAgent,
  deleteStaleMcpSessions
} from '../lib/db.js';
import { notifyAgent } from '../lib/agentNotifier.js';
import { SERVICE_READERS, SERVICE_CATEGORIES } from '../lib/serviceRegistry.js';

const MAX_MESSAGE_LENGTH = 10 * 1024; // 10KB limit
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.AGENTGATE_WEBHOOK_TIMEOUT_MS, 10) || 10000;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 1000;
const TOUCH_DEBOUNCE_MS = 30 * 1000; // 30 seconds debounce for DB writes

// Store active MCP sessions (sessionId -> { transport, server, agentName, lastSeen, lastDbWrite, createdAt })
const activeSessions = new Map();

// Locks for lazy session recreation to prevent race conditions
const recreatingSessionLocks = new Map();

/**
 * Debounced touch — always updates in-memory lastSeen,
 * but only writes to DB if >TOUCH_DEBOUNCE_MS since last DB write.
 */
function debouncedTouchSession(sessionId, session) {
  session.lastSeen = Date.now();
  if (Date.now() - (session.lastDbWrite || 0) >= TOUCH_DEBOUNCE_MS) {
    session.lastDbWrite = Date.now();
    dbTouchMcpSession(sessionId);
  }
}

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      console.log(`Cleaning up stale MCP session: ${sessionId}`);
      session.transport.close().catch(() => {});
      activeSessions.delete(sessionId);
      deleteMcpSession(sessionId);
    }
  }
  // Also clean stale DB records (e.g., from crashed processes)
  deleteStaleMcpSessions(SESSION_TTL_MS);
}, 60 * 1000); // Check every minute

/**
 * Get info about all active sessions (for admin UI).
 */
export function getActiveSessionsInfo() {
  const result = [];
  for (const [sessionId, session] of activeSessions) {
    result.push({
      sessionId,
      agentName: session.agentName,
      lastSeen: new Date(session.lastSeen).toISOString(),
      createdAt: session.createdAt || null
    });
  }
  return result;
}

/**
 * Kill a specific session by ID.
 * Returns { found: boolean }
 */
export function killSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    // Still try to clean up DB record
    const dbResult = deleteMcpSession(sessionId);
    return { found: dbResult.changes > 0 };
  }
  session.transport.close().catch(() => {});
  activeSessions.delete(sessionId);
  deleteMcpSession(sessionId);
  return { found: true };
}

/**
 * Kill all sessions for an agent.
 * Returns { killed: number }
 */
export function killAgentSessions(agentName) {
  let killed = 0;
  for (const [sessionId, session] of activeSessions) {
    if (session.agentName.toLowerCase() === agentName.toLowerCase()) {
      session.transport.close().catch(() => {});
      activeSessions.delete(sessionId);
      killed++;
    }
  }
  // Also clean DB records for this agent
  deleteMcpSessionsForAgent(agentName);
  return { killed };
}

/**
 * Create MCP POST handler — handles initialization and all subsequent messages.
 * Per the Streamable HTTP spec (2025-11-25), POST is the primary transport method.
 */
export function createMCPPostHandler() {
  return async (req, res) => {
    const agentName = req.apiKeyInfo?.name;
    if (!agentName) {
      return res.status(401).json({ error: 'API key authentication required' });
    }

    const sessionId = req.headers['mcp-session-id'];

    try {
      if (sessionId) {
        // Existing session — route message to its transport
        let session = activeSessions.get(sessionId);

        // Lazy recreation: session in DB but not in memory (e.g., after restart)
        if (!session) {
          const dbSession = getMcpSession(sessionId);
          if (dbSession && dbSession.agent_name === agentName) {
            // Use a lock to prevent concurrent recreation of the same session
            if (recreatingSessionLocks.has(sessionId)) {
              // Another request is already recreating this session — wait for it
              try {
                await recreatingSessionLocks.get(sessionId);
                session = activeSessions.get(sessionId);
              } catch {
                // Recreation failed
              }
            } else {
              // We're the first — recreate
              const lockPromise = (async () => {
                const transport = new StreamableHTTPServerTransport({
                  sessionIdGenerator: () => sessionId
                });

                const server = createMCPServer(agentName);
                // Connect server to transport BEFORE adding to activeSessions (Luthien #2)
                await server.connect(transport);

                transport.onclose = () => {
                  activeSessions.delete(sessionId);
                  deleteMcpSession(sessionId);
                };

                const now = Date.now();
                activeSessions.set(sessionId, {
                  transport,
                  server,
                  agentName,
                  lastSeen: now,
                  lastDbWrite: now,
                  createdAt: dbSession.created_at
                });
                dbTouchMcpSession(sessionId);
              })();
              recreatingSessionLocks.set(sessionId, lockPromise);
              try {
                await lockPromise;
                session = activeSessions.get(sessionId);
              } catch (err) {
                console.error(`[MCP] Failed to recreate session ${sessionId}:`, err);
              } finally {
                recreatingSessionLocks.delete(sessionId);
              }
            }
          }
        }

        if (!session) {
          return res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session not found or expired' },
            id: null
          });
        }

        if (agentName !== session.agentName) {
          return res.status(403).json({ error: 'Session belongs to different agent' });
        }

        debouncedTouchSession(sessionId, session);
        await session.transport.handleRequest(req, res, req.body);
      } else if (isInitializeRequest(req.body)) {
        // New session initialization
        if (activeSessions.size >= MAX_SESSIONS) {
          console.warn(`MCP session limit reached (${MAX_SESSIONS}), rejecting new connection`);
          return res.status(503).json({ error: 'Too many active sessions' });
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            const now = Date.now();
            const createdAt = new Date(now).toISOString();
            activeSessions.set(sid, { transport, server, agentName, lastSeen: now, lastDbWrite: now, createdAt });
            upsertMcpSession(sid, agentName);
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            activeSessions.delete(sid);
            deleteMcpSession(sid);
          }
        };

        const server = createMCPServer(agentName);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        // No session ID and not an initialization request
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null
        });
      }
    } catch (error) {
      console.error('[MCP] Error in POST handler:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  };
}

/**
 * Create MCP GET handler — opens an SSE stream for server-initiated notifications.
 * Optional per the Streamable HTTP spec; clients that need server push use this.
 */
export function createMCPGetHandler() {
  return async (req, res) => {
    const agentName = req.apiKeyInfo?.name;
    if (!agentName) {
      return res.status(401).json({ error: 'API key authentication required' });
    }

    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing MCP-Session-Id header' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (agentName !== session.agentName) {
      return res.status(403).json({ error: 'Session belongs to different agent' });
    }

    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
  };
}

/**
 * Create MCP DELETE handler — terminates a session.
 * Per the Streamable HTTP spec, clients send DELETE to cleanly end a session.
 */
export function createMCPDeleteHandler() {
  return async (req, res) => {
    const agentName = req.apiKeyInfo?.name;
    if (!agentName) {
      return res.status(401).json({ error: 'API key authentication required' });
    }

    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing MCP-Session-Id header' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (agentName !== session.agentName) {
      return res.status(403).json({ error: 'Session belongs to different agent' });
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error('[MCP] Error handling session termination:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error processing session termination' });
      }
    }
  };
}

/**
 * Create MCP server with all tools configured
 */
function createMCPServer(agentName) {
  const server = new McpServer(
    {
      name: 'agentgate',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  // Register queue tool (management only — writes are submitted via category tools)
  server.registerTool('queue', {
    description: 'Manage queued write requests. Actions: list, status, withdraw, warn, get_warnings',
    inputSchema: {
      action: z.enum(['list', 'status', 'withdraw', 'warn', 'get_warnings']).describe('Operation to perform'),
      service: z.string().optional().describe('Optional filter for list; required for status/withdraw/warn/get_warnings'),
      account: z.string().optional().describe('Optional filter for list; required for status/withdraw/warn/get_warnings'),
      queue_id: z.string().optional().describe('Required for status/withdraw/warn/get_warnings'),
      reason: z.string().optional(),
      message: z.string().optional().describe('Warning message (required for warn)')
    }
  }, async (args) => {
    return await handleQueueAction(agentName, args);
  });

  // Register messages tool
  server.registerTool('messages', {
    description: 'Inter-agent messaging. Actions: send, get, mark_read, list_agents, status, broadcast, list_broadcasts, get_broadcast',
    inputSchema: {
      action: z.enum(['send', 'get', 'mark_read', 'list_agents', 'status', 'broadcast', 'list_broadcasts', 'get_broadcast']).describe('Operation to perform'),
      to_agent: z.string().optional().describe('Required for send'),
      message: z.string().optional().describe('Required for send/broadcast'),
      unread_only: z.boolean().optional().default(false),
      message_id: z.string().optional().describe('Required for mark_read'),
      limit: z.number().optional().default(50),
      broadcast_id: z.string().optional().describe('Required for get_broadcast')
    }
  }, async (args) => {
    return await handleMessagesAction(agentName, args);
  });

  // Register mementos tool
  server.registerTool('mementos', {
    description: 'Persistent memory: store and retrieve notes across sessions using keywords. Actions: save, search, keywords, recent, get_by_ids',
    inputSchema: {
      action: z.enum(['save', 'search', 'keywords', 'recent', 'get_by_ids']).describe('Operation to perform'),
      content: z.string().optional().describe('Required for save'),
      keywords: z.array(z.string()).optional().describe('Required for save/search'),
      model: z.string().optional(),
      role: z.string().optional().describe('user, assistant, or system'),
      limit: z.number().optional().default(10),
      ids: z.array(z.string()).optional().describe('Required for get_by_ids')
    }
  }, async (args) => {
    return await handleMementosAction(agentName, args);
  });

  // Register services tool (meta/discovery only — reads go through category tools)
  server.registerTool('services', {
    description: 'Identity and service discovery. Actions: whoami, list, list_detail (with docs/examples)',
    inputSchema: {
      action: z.enum(['whoami', 'list', 'list_detail']).describe('Operation to perform'),
      service: z.string().optional().describe('Optional filter for list_detail'),
      account: z.string().optional().describe('Optional filter for list_detail')
    }
  }, async (args) => {
    return await handleServicesAction(agentName, args);
  });

  // Register category tools dynamically based on agent's accessible services
  const accessibleServices = listAccessibleServices(agentName);

  for (const [category, catInfo] of Object.entries(SERVICE_CATEGORIES)) {
    // Filter to services in this category that the agent can access
    const categoryServices = accessibleServices.filter(svc =>
      catInfo.services.includes(svc.service)
    );

    // Skip if agent has no access to any service in this category
    if (categoryServices.length === 0) continue;

    // Build dynamic account list for description
    const accountList = categoryServices
      .map(svc => `${svc.service}: ${svc.account_name}`)
      .join(', ');

    const actions = catInfo.hasWrite ? ['read', 'write'] : ['read'];
    const actionDesc = catInfo.hasWrite ? 'Read and write' : 'Search';
    const serviceNames = [...new Set(categoryServices.map(svc => svc.service))].join(', ');

    const schemaFields = {
      action: z.enum(actions).describe('Operation to perform'),
      service: z.string().describe(`Service: ${serviceNames}`),
      account: z.string().describe('Account name'),
      path: z.string().optional().describe('API path for read (e.g., "/web/search?q=hello")'),
      raw: z.boolean().optional().describe('Override raw/simplified response')
    };

    // Add write fields for categories that support writes
    if (catInfo.hasWrite) {
      schemaFields.requests = z.array(z.object({
        method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string(),
        body: z.any().optional(),
        headers: z.record(z.string(), z.string()).optional()
      })).optional().describe('Write requests array (required for write)');
      schemaFields.comment = z.string().optional().describe('Explain what you are doing and why (required for write)');
    }

    const allowedServiceKeys = catInfo.services;
    server.registerTool(category, {
      description: `${actionDesc} — ${catInfo.description}. Accounts: ${accountList}`,
      inputSchema: schemaFields
    }, createCategoryHandler(agentName, category, allowedServiceKeys, catInfo.hasWrite));
  }

  return server;
}

// Helper to create tool response
function toolResponse(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function toolError(message) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ via: 'agentgate', error: message }, null, 2)
      }
    ],
    isError: true
  };
}

// Queue action handler
async function handleQueueAction(agentName, args) {
  const { action } = args;

  try {
    switch (action) {
    case 'list': {
      const result = listQueueEntries(agentName, args.service || null, args.account || null);
      return toolResponse(result);
    }

    case 'status': {
      const result = getQueueStatus(args.queue_id, args.service, args.account);
      return toolResponse(result);
    }

    case 'withdraw': {
      const result = withdrawQueueEntry(args.queue_id, agentName, args.reason, { emitEvents: false });
      return toolResponse(result);
    }

    case 'warn': {
      const result = await addWarningToQueue(args.queue_id, agentName, args.message, { emitEvents: false });
      return toolResponse(result);
    }

    case 'get_warnings': {
      const result = getWarningsForQueue(args.queue_id);
      return toolResponse(result);
    }

    default:
      return toolError(`Unknown queue action: ${action}`);
    }
  } catch (error) {
    return toolError(error.message);
  }
}

// Messages action handler
async function handleMessagesAction(agentName, args) {
  const { action } = args;

  try {
    switch (action) {
    case 'send': {
      const { to_agent, message } = args;

      if (!to_agent) {
        return toolError('to_agent is required');
      }
      if (!message) {
        return toolError('message is required');
      }
      if (message.length > MAX_MESSAGE_LENGTH) {
        return toolError(`Message too long. Maximum ${MAX_MESSAGE_LENGTH} bytes allowed.`);
      }

      const mode = getMessagingMode();
      if (mode === 'off') {
        return toolError('Agent messaging is disabled');
      }

      const recipient = getApiKeyByName(to_agent);
      if (!recipient) {
        return toolError(`Agent "${to_agent}" not found`);
      }

      const recipientName = recipient.name;

      if (recipientName.toLowerCase() === agentName.toLowerCase()) {
        return toolError('Cannot send message to yourself');
      }

      // Create the message record (status depends on mode: open=delivered, supervised=pending)
      const msg = createAgentMessage(agentName, recipientName, message);

      // If open mode and recipient has webhook, notify them
      if (mode === 'open' && recipient.webhook_url) {
        const payload = {
          type: 'agent_message',
          from: agentName,
          message_id: msg.id,
          message: message,
          timestamp: new Date().toISOString(),
          text: `💬 [agentgate] Message from ${agentName}:\n${message.substring(0, 500)}`,
          mode: 'now'
        };

        // Fire and forget - message is already persisted
        notifyAgent(recipientName, payload).catch(err => {
          console.error(`Failed to notify ${recipientName}:`, err.message);
        });
      }

      return toolResponse({
        id: msg.id,
        status: msg.status,
        to: recipientName,
        message: msg.status === 'pending'
          ? 'Message queued for human approval'
          : 'Message delivered',
        via: 'agentgate'
      });
    }

    case 'get': {
      const mode = getMessagingMode();
      if (mode === 'off') {
        return toolError('Agent messaging is disabled');
      }

      const unreadOnly = args.unread_only || false;
      const messages = getMessagesForAgent(agentName, unreadOnly);

      return toolResponse({
        via: 'agentgate',
        mode,
        messages: messages.map(m => ({
          id: m.id,
          from: m.from_agent,
          message: m.message,
          created_at: m.created_at,
          read: m.read_at !== null
        }))
      });
    }

    case 'mark_read': {
      const mode = getMessagingMode();
      if (mode === 'off') {
        return toolError('Agent messaging is disabled');
      }

      if (!args.message_id) {
        return toolError('message_id is required');
      }

      const result = markMessageRead(args.message_id, agentName);

      if (result.changes === 0) {
        return toolError('Message not found or already read');
      }

      return toolResponse({ success: true, via: 'agentgate' });
    }

    case 'list_agents': {
      const mode = getMessagingMode();
      if (mode === 'off') {
        return toolError('Agent messaging is disabled');
      }

      const apiKeys = listApiKeys();
      const agents = apiKeys
        .filter(k => k.name.toLowerCase() !== agentName.toLowerCase())
        .map(k => ({
          name: k.name,
          enabled: !!k.enabled
        }));

      return toolResponse({ via: 'agentgate', mode, agents });
    }

    case 'status': {
      const mode = getMessagingMode();

      if (mode === 'off') {
        return toolResponse({
          via: 'agentgate',
          mode: 'off',
          enabled: false,
          message: 'Agent messaging is disabled'
        });
      }

      const messages = getMessagesForAgent(agentName, true);

      return toolResponse({
        via: 'agentgate',
        mode,
        enabled: true,
        unread_count: messages.length
      });
    }

    case 'broadcast': {
      const { message } = args;

      if (!message) {
        return toolError('message is required');
      }
      if (message.length > MAX_MESSAGE_LENGTH) {
        return toolError(`Message too long. Maximum ${MAX_MESSAGE_LENGTH} bytes allowed.`);
      }

      const mode = getMessagingMode();
      if (mode === 'off') {
        return toolError('Agent messaging is disabled');
      }

      const apiKeys = listApiKeys();
      const recipients = apiKeys.filter(k =>
        k.webhook_url && k.enabled && k.name.toLowerCase() !== agentName.toLowerCase()
      );

      if (recipients.length === 0) {
        return toolResponse({
          via: 'agentgate',
          broadcast_id: null,
          delivered: [],
          failed: [],
          total: 0,
          message: 'No agents with webhooks available'
        });
      }

      const broadcastId = createBroadcast(agentName, message, recipients.length);

      const delivered = [];
      const failed = [];

      await Promise.allSettled(recipients.map(async (agent) => {
        const payload = {
          type: 'broadcast',
          from: agentName,
          message: message,
          broadcast_id: broadcastId,
          timestamp: new Date().toISOString(),
          text: `📢 [agentgate] Broadcast from ${agentName}:\n${message.substring(0, 500)}`,
          mode: 'now'
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

        try {
          const headers = { 'Content-Type': 'application/json' };
          if (agent.webhook_token) {
            headers['Authorization'] = `Bearer ${agent.webhook_token}`;
          }

          const response = await fetch(agent.webhook_url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          if (response.ok) {
            delivered.push(agent.name);
            addBroadcastRecipient(broadcastId, agent.name, 'delivered');
          } else {
            const errorMsg = `HTTP ${response.status}`;
            failed.push({ name: agent.name, error: errorMsg });
            addBroadcastRecipient(broadcastId, agent.name, 'failed', errorMsg);
          }
        } catch (err) {
          const errorMsg = err.name === 'AbortError' ? `Webhook timeout after ${WEBHOOK_TIMEOUT_MS}ms` : err.message;
          failed.push({ name: agent.name, error: errorMsg });
          addBroadcastRecipient(broadcastId, agent.name, 'failed', errorMsg);
        } finally {
          clearTimeout(timer);
        }
      }));

      return toolResponse({
        via: 'agentgate',
        broadcast_id: broadcastId,
        delivered,
        failed,
        total: recipients.length
      });
    }

    case 'list_broadcasts': {
      const mode = getMessagingMode();
      if (mode === 'off') {
        return toolError('Agent messaging is disabled');
      }

      const limit = args.limit || 50;
      const broadcasts = listBroadcastsWithRecipients(Math.min(limit, 100));

      return toolResponse({ via: 'agentgate', broadcasts });
    }

    case 'get_broadcast': {
      const mode = getMessagingMode();
      if (mode === 'off') {
        return toolError('Agent messaging is disabled');
      }

      if (!args.broadcast_id) {
        return toolError('broadcast_id is required');
      }

      const broadcast = getBroadcast(args.broadcast_id);
      if (!broadcast) {
        return toolError('Broadcast not found');
      }

      return toolResponse({ via: 'agentgate', ...broadcast });
    }

    default:
      return toolError(`Unknown messages action: ${action}`);
    }
  } catch (error) {
    return toolError(error.message);
  }
}

// Mementos action handler
async function handleMementosAction(agentName, args) {
  const { action } = args;

  try {
    switch (action) {
    case 'save': {
      const memento = saveMemento(agentName, args.content, args.keywords, args.model, args.role);
      return toolResponse({ via: 'agentgate', ...memento });
    }

    case 'search': {
      const matches = searchMementosByKeywords(agentName, args.keywords, args.limit || 10);
      return toolResponse({ via: 'agentgate', matches });
    }

    case 'keywords': {
      const keywords = listMementoKeywords(agentName);
      return toolResponse({ via: 'agentgate', keywords });
    }

    case 'recent': {
      const mementos = listRecentMementos(agentName, args.limit || 5);
      return toolResponse({ via: 'agentgate', mementos });
    }

    case 'get_by_ids': {
      const mementos = getMementosByIds(agentName, args.ids);
      return toolResponse({ via: 'agentgate', mementos });
    }

    default:
      return toolError(`Unknown mementos action: ${action}`);
    }
  } catch (error) {
    return toolError(error.message);
  }
}

// Category tool handler factory
function createCategoryHandler(agentName, categoryName, allowedServices, hasWrite) {
  return async (args) => {
    // Validate service is in this category
    if (!allowedServices.includes(args.service)) {
      return toolError(`Service "${args.service}" is not in the ${categoryName} category. Allowed: ${allowedServices.join(', ')}`);
    }

    try {
      switch (args.action) {
      case 'read':
        return await handleServiceRead(agentName, args);
      case 'write':
        if (!hasWrite) return toolError('This category does not support writes');
        return await handleServiceWrite(agentName, args);
      default:
        return toolError(`Unknown action: ${args.action}`);
      }
    } catch (error) {
      return toolError(error.message);
    }
  };
}

// Shared read handler for category tools
async function handleServiceRead(agentName, args) {
  const { service, account, path } = args;
  if (!service || !account || !path) {
    return toolError('service, account, and path are required for read');
  }

  const access = checkServiceAccess(service, account, agentName);
  if (!access.allowed) {
    return toolError(`Access denied to ${service}/${account}: ${access.reason} (agent: ${agentName})`);
  }

  const reader = SERVICE_READERS[service];
  if (!reader) {
    return toolError(`Unknown service: ${service}`);
  }

  try {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const [pathPart, qs] = cleanPath.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));

    const agent = getApiKeyByName(agentName);
    const raw = args.raw !== undefined ? !!args.raw : !!(agent?.raw_results);
    const result = await reader(account, pathPart, { query, raw });

    if (result.status >= 400) {
      return toolError(`Service returned ${result.status}: ${JSON.stringify(result.data)}`);
    }

    return toolResponse(result.data);
  } catch (error) {
    return toolError(`Failed to read from service: ${error.message}`);
  }
}

// Shared write handler for category tools — submits to approval queue
async function handleServiceWrite(agentName, args) {
  const { service, account, requests, comment } = args;
  if (!service || !account) {
    return toolError('service and account are required for write');
  }
  if (!requests || !Array.isArray(requests) || requests.length === 0) {
    return toolError('requests array is required and must not be empty for write');
  }
  if (!comment) {
    return toolError('comment is required for write — explain what you are doing and why');
  }

  try {
    const result = await submitWriteRequest(
      agentName,
      service,
      account,
      requests,
      comment,
      { emitEvents: false }
    );

    return toolResponse({
      id: result.id,
      status: result.status,
      message: result.message,
      bypassed: result.bypassed,
      results: result.results
    });
  } catch (error) {
    return toolError(error.message);
  }
}

// Services action handler (meta/discovery only)
async function handleServicesAction(agentName, args) {
  const { action } = args;

  try {
    switch (action) {
    case 'whoami': {
      const agent = getApiKeyByName(agentName);

      if (!agent) {
        return toolError('Agent not found');
      }

      const services = listAccessibleServices(agentName);

      const response = {
        name: agent.name,
        enabled: !!agent.enabled,
        accessible_services_count: services.length
      };

      // Include bio if configured
      if (agent.bio) {
        response.bio = agent.bio;
      }

      // Include webhook info if relevant
      if (agent.webhook_url) {
        response.webhook_configured = true;
      }

      return toolResponse(response);
    }

    case 'list': {
      const services = listAccessibleServices(agentName).map(svc => ({
        service: svc.service,
        account: svc.account_name,
        base_path: `/api/${svc.service}/${svc.account_name}`,
        bypass_auth: svc.bypass_auth
      }));
      return toolResponse({ services });
    }

    case 'list_detail': {
      let services = listAccessibleServices(agentName, { includeDocs: true });
      if (args.service) {
        services = services.filter(svc => svc.service === args.service);
        if (args.account) {
          services = services.filter(svc => svc.account_name === args.account);
        }
      }
      return toolResponse({ services });
    }

    default:
      return toolError(`Unknown services action: ${action}`);
    }
  } catch (error) {
    return toolError(error.message);
  }
}
