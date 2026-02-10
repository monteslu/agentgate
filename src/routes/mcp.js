// MCP (Model Context Protocol) route handler
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
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
  createAgentMessage
} from '../lib/db.js';
import { notifyAgent } from '../lib/agentNotifier.js';

const MAX_MESSAGE_LENGTH = 10 * 1024; // 10KB limit
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.AGENTGATE_WEBHOOK_TIMEOUT_MS, 10) || 10000;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 1000;

// Store active MCP sessions (sessionId -> { transport, server, agentName, lastSeen })
const activeSessions = new Map();

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      console.log(`Cleaning up stale MCP session: ${sessionId}`);
      activeSessions.delete(sessionId);
    }
  }
}, 60 * 1000); // Check every minute

/**
 * Create MCP SSE handler for GET requests (establish SSE connection)
 */
export function createMCPSSEHandler() {
  return async (req, res) => {
    const agentName = req.apiKeyInfo?.name;

    if (!agentName) {
      return res.status(401).json({ error: 'API key authentication required' });
    }

    try {
      // Check session limit
      if (activeSessions.size >= MAX_SESSIONS) {
        console.warn(`MCP session limit reached (${MAX_SESSIONS}), rejecting new connection`);
        return res.status(503).json({ error: 'Too many active sessions' });
      }

      // Create transport and server for this session
      const transport = new SSEServerTransport('/mcp', res);
      const server = createMCPServer(agentName);

      // Store session for POST message handling
      const sessionId = transport.sessionId;
      activeSessions.set(sessionId, { transport, server, agentName, lastSeen: Date.now() });

      // Connect server to transport
      await server.connect(transport);

      // Handle transport errors
      transport.onerror = (error) => {
        console.error('[MCP] Transport error:', error);
      };

      // Cleanup on close - just remove from sessions, don't call server.close()
      // as that can cause infinite recursion when the transport is already closing
      transport.onclose = () => {
        activeSessions.delete(sessionId);
      };
    } catch (error) {
      console.error('[MCP] Error in SSE handler:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error', message: error.message });
      }
    }
  };
}

/**
 * Create MCP POST handler for incoming messages
 */
export function createMCPMessageHandler() {
  return async (req, res) => {
    const sessionId = req.query.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId query parameter' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    // Validate the API key matches the session's agent
    const agentName = req.apiKeyInfo?.name;
    if (!agentName || agentName !== session.agentName) {
      return res.status(403).json({ error: 'Session belongs to different agent' });
    }

    // Update last seen timestamp
    session.lastSeen = Date.now();

    // Let the transport handle the POST message
    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      console.error(`MCP message handling error for session ${sessionId}:`, err.message);
      // Only send error if response hasn't been sent
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to process MCP message' });
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

  // Register queue tool
  server.registerTool('queue', {
    description: 'Queue write operations (POST/PUT/DELETE) to external services. Actions: submit, list, status, withdraw, warn, get_warnings',
    inputSchema: {
      action: z.enum(['submit', 'list', 'status', 'withdraw', 'warn', 'get_warnings']).describe('Operation to perform'),
      service: z.string().optional().describe('Required for submit/status/withdraw/warn/get_warnings'),
      account: z.string().optional().describe('Required for submit/status/withdraw/warn/get_warnings'),
      requests: z.array(z.object({
        method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string(),
        body: z.any().optional(),
        headers: z.record(z.string(), z.string()).optional()
      })).optional().describe('Array of write requests (required for submit)'),
      comment: z.string().optional(),
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

  // Register services tool
  server.registerTool('services', {
    description: 'Read from connected services (GitHub, Bluesky, Mastodon, etc.). Actions: whoami, list, list_detail (with docs/examples), read',
    inputSchema: {
      action: z.enum(['whoami', 'list', 'list_detail', 'read']).describe('Operation to perform'),
      service: z.string().optional().describe('Required for read; optional filter for list_detail'),
      account: z.string().optional().describe('Required for read; optional filter for list_detail'),
      path: z.string().optional().describe('API path for read (e.g., "/web/search?q=hello")'),
      raw: z.boolean().optional().describe('Get raw upstream response without simplification')
    }
  }, async (args) => {
    return await handleServicesAction(agentName, args);
  });

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
    case 'submit': {
      const result = await submitWriteRequest(
        agentName,
        args.service,
        args.account,
        args.requests,
        args.comment,
        { emitEvents: false }
      );

      return toolResponse({
        id: result.id,
        status: result.status,
        message: result.message,
        bypassed: result.bypassed,
        results: result.results
      });
    }

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

// Services action handler
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

    case 'read': {
      const { service, account, path } = args;
      if (!service || !account || !path) {
        return toolError('service, account, and path are required');
      }

      // Check if agent has access to this service
      const access = checkServiceAccess(service, account, agentName);
      if (!access || !access.allowed) {
        return toolError(`Access denied to ${service}/${account}: ${access?.reason || 'no access object'} (agent: ${agentName}, access: ${JSON.stringify(access)})`);
      }

      // Make internal request to the service endpoint
      const PORT = process.env.PORT || 3050;
      const url = `http://localhost:${PORT}/api/${service}/${account}${path.startsWith('/') ? path : '/' + path}`;

      try {
        const headers = {
          'X-MCP-Internal': 'true',
          'X-Agent-Name': agentName
        };
        if (args.raw) {
          headers['X-Agentgate-Raw'] = 'true';
        }
        const response = await fetch(url, { headers });

        const contentType = response.headers.get('content-type') || '';
        let data;
        if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          data = await response.text();
        }

        if (!response.ok) {
          return toolError(`Service returned ${response.status}: ${JSON.stringify(data)}`);
        }

        return toolResponse(data);
      } catch (error) {
        return toolError(`Failed to read from service: ${error.message}`);
      }
    }

    default:
      return toolError(`Unknown services action: ${action}`);
    }
  } catch (error) {
    return toolError(error.message);
  }
}
