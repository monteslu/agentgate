/**
 * Agent Channel WebSocket endpoint.
 * 
 * Endpoint: WS /api/channel or /api/channel/<channel-id>
 * Auth: Bearer token (same as other /api/* routes)
 * 
 * This is where the OpenClaw channel plugin connects.
 * Humans connect via /channel/<id>.
 *
 * When the path omits the channel id, the id is derived from the bearer token.
 * The explicit /api/channel/<id> form remains supported for older clients.
 * 
 * See docs/channel-ws-protocol.md for the full protocol specification.
 */

import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { 
  getChannel,
  getApiKeyByKey,
  markChannelConnected,
  saveChatMessage
} from '../lib/db.js';
import { getChannelBridge } from './channel-bridge.js';
import { 
  createWebSocketFrame, 
  parseWebSocketFrames, 
  createPongFrame,
  WS_OPCODES 
} from '../lib/ws-utils.js';
import {
  ENVELOPE_TYPES,
  validateEnvelope,
  createError as createErrorEnvelope
} from '../lib/channelProtocol.js';

// Configuration
const PING_INTERVAL_MS = 30000;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 50; // Higher limit for agent

/**
 * Log channel events
 */
function channelLog(channelId, event, details = '') {
  const ts = new Date().toISOString();
  console.log(`[api/channel][${ts}] ${channelId}: ${event}${details ? ' - ' + details : ''}`);
}

/**
 * Verify Bearer token (async - uses bcrypt)
 */
async function verifyBearerToken(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  
  const token = auth.slice(7);
  const apiKey = await getApiKeyByKey(token);
  return apiKey;
}

/**
 * Rate limiter
 */
function checkRateLimit(state) {
  const now = Date.now();
  if (now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count++;
  return state.count <= RATE_LIMIT_MAX_MESSAGES;
}

/**
 * Send JSON message to socket
 */
function sendToSocket(socket, msg) {
  if (socket && socket.writable) {
    socket.write(createWebSocketFrame(JSON.stringify(msg)));
  }
}

/**
 * Complete WebSocket handshake
 */
function completeHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return false;

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );
  return true;
}

/**
 * Handle agent message — validates envelope and routes by type.
 */
function handleAgentMessage(channelId, parsed, socket, rateLimit) {
  if (!checkRateLimit(rateLimit)) {
    sendToSocket(socket, createErrorEnvelope('Rate limited'));
    return;
  }

  // Validate envelope structure
  const validation = validateEnvelope(parsed);
  if (!validation.valid) {
    sendToSocket(socket, createErrorEnvelope(validation.error));
    return;
  }

  const bridge = getChannelBridge(channelId);

  switch (parsed.type) {
  case ENVELOPE_TYPES.MESSAGE: {
    const msgId = parsed.id || `msg_${nanoid(12)}`;
    const timestamp = parsed.timestamp || new Date().toISOString();

    // Save to database
    saveChatMessage({
      channelId,
      messageId: msgId,
      from: 'agent',
      text: parsed.text,
      timestamp,
      replyTo: parsed.replyTo
    });

    channelLog(channelId, 'agent_message', `msgId=${msgId}`);

    const msg = {
      type: ENVELOPE_TYPES.MESSAGE,
      from: 'agent',
      text: parsed.text,
      id: msgId,
      timestamp
    };

    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }
    break;
  }

  case ENVELOPE_TYPES.CHUNK: {
    const msg = { type: ENVELOPE_TYPES.CHUNK, text: parsed.text, id: parsed.id };
    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }
    break;
  }

  case ENVELOPE_TYPES.DONE: {
    const timestamp = new Date().toISOString();

    if (parsed.text) {
      saveChatMessage({
        channelId,
        messageId: parsed.id,
        from: 'agent',
        text: parsed.text,
        timestamp,
        replyTo: parsed.replyTo
      });
    }

    const msg = { type: ENVELOPE_TYPES.DONE, id: parsed.id, timestamp };
    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }
    break;
  }

  case ENVELOPE_TYPES.TYPING: {
    const msg = { type: ENVELOPE_TYPES.TYPING };
    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }
    break;
  }

  case ENVELOPE_TYPES.ERROR: {
    const msg = { type: ENVELOPE_TYPES.ERROR, error: parsed.error, messageId: parsed.messageId };
    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }
    break;
  }

  case ENVELOPE_TYPES.ACK: {
    channelLog(channelId, 'agent_ack', `id=${parsed.id} status=${parsed.status}`);
    const msg = { type: ENVELOPE_TYPES.ACK, id: parsed.id, status: parsed.status };
    if (parsed.error) msg.error = parsed.error;

    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }
    break;
  }

  case ENVELOPE_TYPES.PING: {
    sendToSocket(socket, { type: ENVELOPE_TYPES.PONG });
    break;
  }

  case ENVELOPE_TYPES.PONG: {
    // Received pong from plugin — no action needed (keepalive confirmed)
    break;
  }

  default: {
    // reply type from issue spec — treat as message for backward compatibility
    if (parsed.type === ENVELOPE_TYPES.REPLY) {
      handleAgentMessage(channelId, { ...parsed, type: ENVELOPE_TYPES.MESSAGE }, socket, rateLimit);
    } else {
      sendToSocket(socket, createErrorEnvelope(`Unhandled envelope type: ${parsed.type}`, parsed.id));
    }
    break;
  }
  }
}

/**
 * Set up agent connection
 */
function setupAgentConnection(channel, socket, agentName) {
  const channelId = channel.channel_id;
  const bridge = getChannelBridge(channelId);
  const rateLimit = { windowStart: Date.now(), count: 0 };

  if (!bridge.setAgent(socket)) {
    channelLog(channelId, 'agent_rejected', 'already connected');
    sendToSocket(socket, createErrorEnvelope('Agent already connected to this channel'));
    socket.end();
    return;
  }

  channelLog(channelId, 'agent_connected', `agent=${agentName}`);
  markChannelConnected(channel.id);

  // bridge.setAgent() already sends the `connected` envelope via the bridge

  const pingInterval = setInterval(() => {
    if (socket.writable) sendToSocket(socket, { type: ENVELOPE_TYPES.PING });
  }, PING_INTERVAL_MS);

  let buffer = Buffer.alloc(0);
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    const { messages, remainder } = parseWebSocketFrames(buffer);
    buffer = remainder;

    for (const frame of messages) {
      if (frame.opcode === WS_OPCODES.CLOSE) { 
        socket.end(); 
        return; 
      }
      if (frame.opcode === WS_OPCODES.PING) { 
        socket.write(createPongFrame(frame.payload)); 
        continue; 
      }
      if (frame.opcode !== WS_OPCODES.TEXT) continue;

      try {
        const parsed = JSON.parse(frame.payload.toString('utf8'));
        handleAgentMessage(channelId, parsed, socket, rateLimit);
      } catch {
        sendToSocket(socket, createErrorEnvelope('Invalid message format'));
      }
    }
  });

  const cleanup = () => {
    clearInterval(pingInterval);
    bridge.removeAgent();
    channelLog(channelId, 'agent_disconnected');
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/**
 * Set up agent channel WebSocket handling
 */
export function setupAgentChannelProxy(server) {
  server.on('upgrade', async (req, socket, _head) => {
    // Handle /api/channel and /api/channel/<id>. The no-id form derives the
    // channel from the bearer token, matching the agentgate-channel plugin.
    const match = req.url.match(/^\/api\/channel(?:\/([^/?]+))?(?:[/?]|$)/);
    if (!match) return;

    let channelId = match[1] || null;
    
    // Verify Bearer token (async - uses bcrypt)
    const apiKey = await verifyBearerToken(req);
    if (!apiKey) {
      channelLog(channelId || 'unknown', 'agent_rejected', 'invalid or missing Bearer token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!apiKey.channel_enabled || !apiKey.channel_id) {
      channelLog(channelId || 'unknown', 'agent_rejected', `agent ${apiKey.name} has no channel enabled`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!channelId) {
      channelId = apiKey.channel_id;
    }

    // Verify the agent is authorized for THIS specific channel.
    if (apiKey.channel_id !== channelId) {
      channelLog(channelId, 'agent_rejected', `agent ${apiKey.name} not authorized for channel ${channelId}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const channel = getChannel(channelId);

    channelLog(channelId, 'agent_connection_attempt', `agent=${apiKey.name}`);

    if (!channel || !channel.channel_enabled) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!completeHandshake(req, socket)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // No auth message needed - already authenticated via Bearer token
    setupAgentConnection(channel, socket, apiKey.name);
  });
}

export default { setupAgentChannelProxy };
