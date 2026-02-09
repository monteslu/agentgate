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
  getMessagesForAgent,
  getMessagingMode,
  getApiKeyByName,
  listApiKeys,
  createBroadcast,
  addBroadcastRecipient,
  markMessageRead,
  listBroadcastsWithRecipients,
  getBroadcast
} from '../lib/db.js';
import { notifyAgent } from '../lib/agentNotifier.js';

const MAX_MESSAGE_LENGTH = 10 * 1024; // 10KB limit
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.AGENTGATE_WEBHOOK_TIMEOUT_MS, 10) || 10000;

// Store active MCP sessions (sessionId -> { transport, server, agentName })
const activeSessions = new Map();

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
      // Create transport and server for this session
      const transport = new SSEServerTransport('/mcp', res);
      const server = createMCPServer(agentName);

      // Store session for POST message handling
      const sessionId = transport.sessionId;
      activeSessions.set(sessionId, { transport, server, agentName });

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

    // Let the transport handle the POST message
    await session.transport.handlePostMessage(req, res, req.body);
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
    description: 'AgentGate approval queue: request write operations (POST, PUT, DELETE) to external services. Credentials never leave the gateway. Writes are either queued for human approval or auto-approved (if bypass enabled), but always logged. Actions: submit, list, status, withdraw, warn, get_warnings',
    inputSchema: {
      action: z.enum(['submit', 'list', 'status', 'withdraw', 'warn', 'get_warnings']).describe('Operation to perform'),
      service: z.string().optional().describe('Service name (required for submit/status/withdraw/warn/get_warnings)'),
      account: z.string().optional().describe('Account name (required for submit/status/withdraw/warn/get_warnings)'),
      requests: z.array(z.object({
        method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string(),
        body: z.any().optional(),
        headers: z.record(z.string(), z.string()).optional()
      })).optional().describe('Array of write requests (required for submit)'),
      comment: z.string().optional().describe('Comment for submit action'),
      queue_id: z.string().optional().describe('Queue entry ID (required for status/withdraw/warn/get_warnings)'),
      reason: z.string().optional().describe('Withdrawal reason (optional for withdraw)'),
      message: z.string().optional().describe('Warning message (required for warn)')
    }
  }, async (args) => {
    return await handleQueueAction(agentName, args);
  });

  // Register messages tool
  server.registerTool('messages', {
    description: 'AgentGate inter-agent messaging: coordinate with other agents on this gateway (e.g., a coding agent and a social media agent working together). Actions: send, get, mark_read, list_agents, status, broadcast, list_broadcasts, get_broadcast',
    inputSchema: {
      action: z.enum(['send', 'get', 'mark_read', 'list_agents', 'status', 'broadcast', 'list_broadcasts', 'get_broadcast']).describe('Operation to perform'),
      to_agent: z.string().optional().describe('Recipient agent name (required for send)'),
      message: z.string().optional().describe('Message content (required for send/broadcast)'),
      unread_only: z.boolean().optional().default(false).describe('Only return unread messages (optional for get)'),
      message_id: z.string().optional().describe('Message ID to mark as read (required for mark_read)'),
      limit: z.number().optional().default(50).describe('Maximum broadcasts to return (optional for list_broadcasts)'),
      broadcast_id: z.string().optional().describe('Broadcast ID (required for get_broadcast)')
    }
  }, async (args) => {
    return await handleMessagesAction(agentName, args);
  });

  // Register mementos tool
  server.registerTool('mementos', {
    description: 'AgentGate persistent memory: store and retrieve notes across sessions using keywords. Useful for remembering context, decisions, or information between conversations. Actions: save, search, keywords, recent, get_by_ids',
    inputSchema: {
      action: z.enum(['save', 'search', 'keywords', 'recent', 'get_by_ids']).describe('Operation to perform'),
      content: z.string().optional().describe('Content to store (required for save)'),
      keywords: z.array(z.string()).optional().describe('Keywords for save/search (required for save/search)'),
      model: z.string().optional().describe('Model identifier (optional for save)'),
      role: z.string().optional().describe('Role: user, assistant, system (optional for save)'),
      limit: z.number().optional().default(10).describe('Maximum results (optional for search/recent)'),
      ids: z.array(z.string()).optional().describe('Memento IDs to fetch (required for get_by_ids)')
    }
  }, async (args) => {
    return await handleMementosAction(agentName, args);
  });

  // Register services tool
  server.registerTool('services', {
    description: 'AgentGate secure service access: read from connected services (GitHub, Bluesky, Mastodon, etc.) without ever seeing credentials - they stay on the gateway. Actions: whoami (your identity and bio), list (available services with bypass_auth status)',
    inputSchema: {
      action: z.enum(['whoami', 'list']).describe('Operation to perform')
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
        text: JSON.stringify({ error: message }, null, 2)
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

      if (mode === 'open' && recipient.webhook_url) {
        const payload = {
          type: 'agent_message',
          from: agentName,
          message: message,
          timestamp: new Date().toISOString(),
          text: `💬 [agentgate] Message from ${agentName}:\n${message.substring(0, 500)}`,
          mode: 'now'
        };

        const result = await notifyAgent(recipientName, payload);

        return toolResponse({
          status: result.success ? 'delivered' : 'failed',
          to: recipientName,
          error: result.error || null
        });
      } else {
        return toolResponse({
          status: 'pending',
          message: mode === 'supervised'
            ? 'Message queued for human approval'
            : 'Recipient has no webhook configured'
        });
      }
    }

    case 'get': {
      const mode = getMessagingMode();
      if (mode === 'off') {
        return toolError('Agent messaging is disabled');
      }

      const unreadOnly = args.unread_only || false;
      const messages = getMessagesForAgent(agentName, unreadOnly);

      return toolResponse({
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

      return toolResponse({ success: true });
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

      return toolResponse({ mode, agents });
    }

    case 'status': {
      const mode = getMessagingMode();

      if (mode === 'off') {
        return toolResponse({
          mode: 'off',
          enabled: false,
          message: 'Agent messaging is disabled'
        });
      }

      const messages = getMessagesForAgent(agentName, true);

      return toolResponse({
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

      return toolResponse({ broadcasts });
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

      return toolResponse(broadcast);
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
      return toolResponse(memento);
    }

    case 'search': {
      const matches = searchMementosByKeywords(agentName, args.keywords, args.limit || 10);
      return toolResponse({ matches });
    }

    case 'keywords': {
      const keywords = listMementoKeywords(agentName);
      return toolResponse({ keywords });
    }

    case 'recent': {
      const mementos = listRecentMementos(agentName, args.limit || 5);
      return toolResponse({ mementos });
    }

    case 'get_by_ids': {
      const mementos = getMementosByIds(agentName, args.ids);
      return toolResponse({ mementos });
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
        accessible_services_count: services.length,
        security_note: 'Credentials for connected services never leave this gateway. You can read data and request writes, but tokens are never exposed to you.',
        capabilities: {
          read: 'You can read from any service in your access list via the REST API (e.g., GET /api/github/{account}/user)',
          write: 'Write requests go through the gateway. Depending on config, they are either queued for human approval or auto-approved with bypass - but always logged.',
          memory: 'Use the mementos tool to persist notes across sessions'
        }
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
      const services = listAccessibleServices(agentName, { includeDocs: true });
      return toolResponse({ services });
    }

    default:
      return toolError(`Unknown services action: ${action}`);
    }
  } catch (error) {
    return toolError(error.message);
  }
}
