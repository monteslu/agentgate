import { Router } from 'express';
import {
  getMessagingMode,
  createAgentMessage,
  getAgentMessage,
  getMessagesForAgent,
  markMessageRead,
  listApiKeys,
  getApiKeyByName,
  createBroadcast,
  addBroadcastRecipient,
  listBroadcastsWithRecipients,
  getBroadcast
} from '../lib/db.js';
import { notifyAgentMessage } from '../lib/agentNotifier.js';
import { emitCountUpdate } from '../lib/socketManager.js';

const router = Router();

const MAX_MESSAGE_LENGTH = 10 * 1024; // 10KB limit

// POST /api/agents/message - Send a message to another agent
router.post('/message', async (req, res) => {
  const { to_agent, to, message } = req.body;
  const targetAgent = to_agent || to; // Prefer to_agent, fall back to to for backwards compatibility
  const fromAgent = req.apiKeyName; // Set by apiKeyAuth middleware

  if (!targetAgent) {
    return res.status(400).json({
      via: 'agentgate',
      error: 'Missing recipient: provide "to_agent" (preferred) or "to"'
    });
  }

  if (!message) {
    return res.status(400).json({ via: 'agentgate', error: 'Missing "message" field' });
  }

  // Check message length
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      via: 'agentgate',
      error: `Message too long. Maximum ${MAX_MESSAGE_LENGTH} bytes allowed.`,
      length: message.length,
      max: MAX_MESSAGE_LENGTH
    });
  }

  const mode = getMessagingMode();

  if (mode === 'off') {
    return res.status(403).json({
      via: 'agentgate',
      error: 'Agent messaging is disabled',
      hint: 'Admin can enable messaging in the agentgate UI'
    });
  }

  // Validate recipient exists (case-insensitive lookup)
  const recipient = getApiKeyByName(targetAgent);
  if (!recipient) {
    return res.status(404).json({ via: 'agentgate', error: `Agent "${targetAgent}" not found` });
  }

  // Use canonical name from database
  const recipientName = recipient.name;

  // Can't message yourself (case-insensitive)
  if (recipientName.toLowerCase() === fromAgent.toLowerCase()) {
    return res.status(400).json({ via: 'agentgate', error: 'Cannot send message to yourself' });
  }

  try {
    // Use canonical recipient name from database
    const result = createAgentMessage(fromAgent, recipientName, message);

    // Emit real-time update
    emitCountUpdate();

    if (mode === 'supervised') {
      return res.json({
        id: result.id,
        status: 'pending',
        to: recipientName,
        message: 'Message queued for human approval',
        via: 'agentgate'
      });
    } else {
      // open mode - notify recipient immediately
      const fullMessage = getAgentMessage(result.id);
      notifyAgentMessage(fullMessage);

      return res.json({
        id: result.id,
        status: 'delivered',
        to: recipientName,
        message: 'Message delivered',
        via: 'agentgate'
      });
    }
  } catch (err) {
    return res.status(500).json({ via: 'agentgate', error: err.message });
  }
});

// GET /api/agents/messages - Get messages for the current agent
router.get('/messages', async (req, res) => {
  const agentName = req.apiKeyName;
  const unreadOnly = req.query.unread === 'true';

  const mode = getMessagingMode();

  if (mode === 'off') {
    return res.status(403).json({
      via: 'agentgate',
      error: 'Agent messaging is disabled',
      hint: 'Admin can enable messaging in the agentgate UI'
    });
  }

  const messages = getMessagesForAgent(agentName, unreadOnly);

  return res.json({
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
});

// POST /api/agents/messages/:id/read - Mark a message as read
router.post('/messages/:id/read', async (req, res) => {
  const { id } = req.params;
  const agentName = req.apiKeyName;

  const mode = getMessagingMode();

  if (mode === 'off') {
    return res.status(403).json({ via: 'agentgate', error: 'Agent messaging is disabled' });
  }

  const result = markMessageRead(id, agentName);

  if (result.changes === 0) {
    return res.status(404).json({ via: 'agentgate', error: 'Message not found or already read' });
  }

  return res.json({ success: true, via: 'agentgate' });
});

// GET /api/agents/status - Get messaging status and mode
router.get('/status', async (req, res) => {
  const mode = getMessagingMode();
  const agentName = req.apiKeyName;

  if (mode === 'off') {
    return res.json({
      via: 'agentgate',
      mode: 'off',
      enabled: false,
      message: 'Agent messaging is disabled'
    });
  }

  const messages = getMessagesForAgent(agentName, true);

  return res.json({
    via: 'agentgate',
    mode,
    enabled: true,
    unread_count: messages.length
  });
});

// GET /api/agents/messageable - Discover which agents can be messaged
router.get('/messageable', async (req, res) => {
  const mode = getMessagingMode();
  const callerName = req.apiKeyName;

  if (mode === 'off') {
    return res.status(403).json({
      via: 'agentgate',
      error: 'Agent messaging is disabled',
      agents: []
    });
  }

  const apiKeys = listApiKeys();

  // Return all agents except self
  const agents = apiKeys
    .filter(k => k.name.toLowerCase() !== callerName.toLowerCase())
    .map(k => ({
      name: k.name,
      enabled: !!k.enabled
    }));

  return res.json({
    via: 'agentgate',
    mode,
    agents
  });
});


// POST /api/agents/broadcast - Broadcast a message to all agents
router.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  const fromAgent = req.apiKeyName || 'admin';

  if (!message) {
    return res.status(400).json({ via: 'agentgate', error: 'Missing "message" field' });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      via: 'agentgate',
      error: `Message too long. Maximum ${MAX_MESSAGE_LENGTH} bytes allowed.`
    });
  }

  const mode = getMessagingMode();
  if (mode === 'off') {
    return res.status(403).json({ via: 'agentgate', error: 'Agent messaging is disabled' });
  }

  // Get all agents with webhooks (excluding sender)
  const apiKeys = listApiKeys();
  const recipients = apiKeys.filter(k => 
    k.webhook_url && k.enabled && k.name.toLowerCase() !== fromAgent.toLowerCase()
  );

  if (recipients.length === 0) {
    return res.json({ via: 'agentgate', broadcast_id: null, delivered: [], failed: [], total: 0 });
  }

  // Create broadcast record
  const broadcastId = createBroadcast(fromAgent, message, recipients.length);

  const delivered = [];
  const failed = [];

  const TIMEOUT_MS = parseInt(process.env.AGENTGATE_WEBHOOK_TIMEOUT_MS, 10) || 10000;

  await Promise.allSettled(recipients.map(async (agent) => {
    const payload = {
      type: 'broadcast',
      from: fromAgent,
      message: message,
      broadcast_id: broadcastId,
      timestamp: new Date().toISOString(),
      text: `📢 [agentgate] Broadcast from ${fromAgent}:\n${message.substring(0, 500)}`,
      mode: 'now'
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
      const errorMsg = err.name === 'AbortError' ? `Webhook timeout after ${TIMEOUT_MS}ms` : err.message;
      failed.push({ name: agent.name, error: errorMsg });
      addBroadcastRecipient(broadcastId, agent.name, 'failed', errorMsg);
    } finally {
      clearTimeout(timer);
    }
  }));

  return res.json({ via: 'agentgate', broadcast_id: broadcastId, delivered, failed, total: recipients.length });
});

// GET /api/agents/broadcasts - List broadcast history
router.get('/broadcasts', (req, res) => {
  const mode = getMessagingMode();
  if (mode === 'off') {
    return res.status(403).json({ via: 'agentgate', error: 'Agent messaging is disabled' });
  }

  const limit = parseInt(req.query.limit) || 50;
  const broadcasts = listBroadcastsWithRecipients(Math.min(limit, 100));
  return res.json({ via: 'agentgate', broadcasts });
});

// GET /api/agents/broadcasts/:id - Get specific broadcast
router.get('/broadcasts/:id', (req, res) => {
  const mode = getMessagingMode();
  if (mode === 'off') {
    return res.status(403).json({ via: 'agentgate', error: 'Agent messaging is disabled' });
  }

  const broadcast = getBroadcast(req.params.id);
  if (!broadcast) {
    return res.status(404).json({ via: 'agentgate', error: 'Broadcast not found' });
  }
  return res.json({ via: 'agentgate', ...broadcast });
});

export default router;