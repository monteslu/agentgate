// Message service layer - shared business logic for HTTP and MCP
import {
  createMessage,
  listMessagesForAgent,
  getAllMessagesForAgent,
  markMessageDelivered,
  listAgentsForMessaging,
  checkMessageable,
  updateBroadcastEnabled,
  getBroadcastEnabled
} from '../lib/db.js';
import { notifyAgentMessage, notifyAgentMessagesBatch } from '../lib/agentNotifier.js';
import { emitEvent } from '../lib/socketManager.js';

/**
 * Send a message to another agent
 * @param {string} fromAgent - Sender agent name
 * @param {string} toAgent - Recipient agent name
 * @param {string} message - Message text
 * @param {Object} options - Options object
 * @param {boolean} options.emitEvents - Whether to emit socket.io events (default: true)
 * @returns {Object} Created message object
 * @throws {Error} If validation fails or messaging not allowed
 */
export function sendMessage(fromAgent, toAgent, message, { emitEvents = true } = {}) {
  if (!toAgent || typeof toAgent !== 'string') {
    throw new Error('to_agent is required');
  }

  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }

  if (fromAgent === toAgent) {
    throw new Error('Cannot send message to yourself');
  }

  // Check if messaging is enabled for recipient
  const messageable = checkMessageable(toAgent);
  if (!messageable) {
    throw new Error(`Agent "${toAgent}" does not have messageable enabled`);
  }

  // Create the message
  const msg = createMessage(fromAgent, toAgent, message);

  if (emitEvents) {
    emitEvent('newMessage', {
      id: msg.id,
      from: fromAgent,
      to: toAgent,
      created_at: msg.created_at
    });
  }

  return {
    id: msg.id,
    status: msg.status,
    created_at: msg.created_at,
    message: 'Message queued for delivery'
  };
}

/**
 * Broadcast a message to all agents with messageable enabled
 * @param {string} fromAgent - Sender agent name
 * @param {string} message - Message text
 * @param {Object} options - Options object
 * @param {boolean} options.emitEvents - Whether to emit socket.io events (default: true)
 * @returns {Object} Result with sent count and message IDs
 * @throws {Error} If broadcast is disabled or validation fails
 */
export function broadcastMessage(fromAgent, message, { emitEvents = true } = {}) {
  if (!getBroadcastEnabled()) {
    throw new Error('Broadcast messaging is disabled. Ask admin to enable broadcast_enabled setting.');
  }

  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }

  // Get all agents with messageable enabled (excluding sender)
  const recipients = listAgentsForMessaging(fromAgent);

  if (recipients.length === 0) {
    throw new Error('No agents available to receive broadcast (all must have messageable enabled)');
  }

  // Create messages for each recipient
  const messages = recipients.map(agent => {
    const msg = createMessage(fromAgent, agent.name, message);

    if (emitEvents) {
      emitEvent('newMessage', {
        id: msg.id,
        from: fromAgent,
        to: agent.name,
        created_at: msg.created_at
      });
    }

    return msg;
  });

  return {
    sent_to: recipients.length,
    message_ids: messages.map(m => m.id),
    recipients: recipients.map(r => r.name)
  };
}

/**
 * Get messages for an agent (defaults to undelivered only)
 * @param {string} agentName - Agent name
 * @param {boolean} all - If true, return all messages (not just undelivered)
 * @param {Object} options - Options object
 * @param {boolean} options.emitEvents - Whether to emit socket.io events (default: true)
 * @returns {Object} Object with count and messages array
 */
export async function getMessages(agentName, all = false, { emitEvents = true } = {}) {
  const messages = all
    ? getAllMessagesForAgent(agentName)
    : listMessagesForAgent(agentName);

  // Mark undelivered messages as delivered and notify senders
  const undelivered = messages.filter(m => m.status === 'pending');

  if (undelivered.length > 0) {
    for (const msg of undelivered) {
      markMessageDelivered(msg.id);
    }

    // Notify senders in parallel (fire and forget)
    notifyAgentMessagesBatch(undelivered.map(m => ({
      ...m,
      delivered_at: new Date().toISOString()
    }))).catch(err => {
      console.error('Failed to notify message senders:', err.message);
    });

    if (emitEvents) {
      emitEvent('messagesDelivered', {
        count: undelivered.length,
        agent: agentName
      });
    }
  }

  return {
    count: messages.length,
    undelivered: undelivered.length,
    messages: messages.map(m => ({
      id: m.id,
      from: m.from_agent,
      message: m.message,
      status: m.status,
      created_at: m.created_at,
      delivered_at: m.delivered_at
    }))
  };
}
