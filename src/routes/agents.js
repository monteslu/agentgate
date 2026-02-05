import { Router } from 'express';
import {
  getMessagingMode,
  createAgentMessage,
  getAgentMessage,
  getMessagesForAgent,
  markMessageRead,
  listApiKeys,
  getApiKeyByName
} from '../lib/db.js';
import { notifyAgentMessage } from '../lib/agentNotifier.js';
import { emitCountUpdate } from '../lib/socketManager.js';

const router = Router();

const MAX_MESSAGE_LENGTH = 10 * 1024; // 10KB limit

// POST /api/agents/message - Send a message to another agent
router.post('/message', async (req, res) => {
  const { to, message } = req.body;
  const fromAgent = req.apiKeyName; // Set by apiKeyAuth middleware

  if (!to) {
    return res.status(400).json({ error: 'Missing "to" field (recipient agent name)' });
  }

  if (!message) {
    return res.status(400).json({ error: 'Missing "message" field' });
  }

  // Check message length
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      error: `Message too long. Maximum ${MAX_MESSAGE_LENGTH} bytes allowed.`,
      length: message.length,
      max: MAX_MESSAGE_LENGTH
    });
  }

  const mode = getMessagingMode();

  if (mode === 'off') {
    return res.status(403).json({
      error: 'Agent messaging is disabled',
      hint: 'Admin can enable messaging in the agentgate UI'
    });
  }

  // Validate recipient exists (case-insensitive lookup)
  const recipient = getApiKeyByName(to);
  if (!recipient) {
    return res.status(404).json({ error: `Agent "${to}" not found` });
  }

  // Use canonical name from database
  const recipientName = recipient.name;

  // Can't message yourself (case-insensitive)
  if (recipientName.toLowerCase() === fromAgent.toLowerCase()) {
    return res.status(400).json({ error: 'Cannot send message to yourself' });
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
        message: 'Message queued for human approval'
      });
    } else {
      // open mode - notify recipient immediately
      const fullMessage = getAgentMessage(result.id);
      notifyAgentMessage(fullMessage);

      return res.json({
        id: result.id,
        status: 'delivered',
        message: 'Message delivered'
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/messages - Get messages for the current agent
router.get('/messages', async (req, res) => {
  const agentName = req.apiKeyName;
  const unreadOnly = req.query.unread === 'true';

  const mode = getMessagingMode();

  if (mode === 'off') {
    return res.status(403).json({
      error: 'Agent messaging is disabled',
      hint: 'Admin can enable messaging in the agentgate UI'
    });
  }

  const messages = getMessagesForAgent(agentName, unreadOnly);

  return res.json({
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
    return res.status(403).json({ error: 'Agent messaging is disabled' });
  }

  const result = markMessageRead(id, agentName);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Message not found or already read' });
  }

  return res.json({ success: true });
});

// GET /api/agents/status - Get messaging status and mode
router.get('/status', async (req, res) => {
  const mode = getMessagingMode();
  const agentName = req.apiKeyName;

  if (mode === 'off') {
    return res.json({
      mode: 'off',
      enabled: false,
      message: 'Agent messaging is disabled'
    });
  }

  const messages = getMessagesForAgent(agentName, true);

  return res.json({
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
      error: 'Agent messaging is disabled',
      agents: []
    });
  }

  const apiKeys = listApiKeys();

  // Return all agents except self
  const agents = apiKeys
    .filter(k => k.name.toLowerCase() !== callerName.toLowerCase())
    .map(k => ({
      name: k.name
    }));

  return res.json({
    mode,
    agents
  });
});

export default router;
