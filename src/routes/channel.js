/**
 * Channel WebSocket endpoint for HUMAN clients.
 * 
 * Endpoint: WS /channel/<channel-id>
 * Auth: Channel key in first message { type: "auth", key: "..." }
 * 
 * This is the human-facing chat interface. Agent connects via /api/channel/<id>.
 * 
 * Protocol:
 *   Client: { type: "auth", key: "<channel-key>" }
 *   Server: { type: "auth", success: true }
 *   Client: { type: "message", text: "hello" }
 *   Server: { type: "message", from: "agent", text: "hi", id: "msg_123", timestamp: "..." }
 *   Server: { type: "chunk", text: "partial...", id: "msg_123" }
 *   Server: { type: "done", id: "msg_123" }
 *   Server: { type: "typing" }
 *   Server: { type: "error", error: "..." }
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { 
  getChannel, 
  saveChatMessage,
  getChatHistory
} from '../lib/db.js';
import { getChannelBridge } from './channel-bridge.js';
import { 
  createWebSocketFrame, 
  parseWebSocketFrames, 
  createPongFrame,
  WS_OPCODES 
} from '../lib/ws-utils.js';

// Admin token validation is injected at runtime to avoid circular imports
let validateAdminChatToken = null;
export function setAdminTokenValidator(fn) {
  validateAdminChatToken = fn;
}

// Configuration
const AUTH_TIMEOUT_MS = 30000;
const MAX_AUTH_ATTEMPTS = 3;
const MAX_MESSAGE_SIZE = 4096;
const PING_INTERVAL_MS = 30000;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 10;

/**
 * Log channel events
 */
function channelLog(channelId, event, details = '') {
  const ts = new Date().toISOString();
  console.log(`[channel][${ts}] ${channelId}: ${event}${details ? ' - ' + details : ''}`);
}

/**
 * Verify channel key
 */
async function verifyChannelKey(channel, providedKey) {
  if (!channel.channel_key_hash || !providedKey) return false;
  try {
    return await bcrypt.compare(providedKey, channel.channel_key_hash);
  } catch {
    return false;
  }
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
 * Handle human message
 */
async function handleHumanMessage(channelId, connId, parsed, socket, rateLimit) {
  if (!checkRateLimit(rateLimit)) {
    sendToSocket(socket, { type: 'error', error: 'Rate limited' });
    return;
  }

  const bridge = getChannelBridge(channelId);

  if (parsed.type === 'message') {
    if (!parsed.text || typeof parsed.text !== 'string' || parsed.text.length > MAX_MESSAGE_SIZE) {
      sendToSocket(socket, { type: 'error', error: 'Invalid message' });
      return;
    }

    const msgId = `msg_${nanoid(12)}`;
    const timestamp = new Date().toISOString();

    saveChatMessage({ channelId, messageId: msgId, from: 'human', fromConnId: connId, text: parsed.text, timestamp });
    channelLog(channelId, 'human_message', `connId=${connId} msgId=${msgId}`);

    // Forward to agent via bridge
    bridge.sendToAgent({
      type: 'message',
      from: 'human',
      text: parsed.text,
      id: msgId,
      timestamp,
      connId
    });

  } else if (parsed.type === 'ping') {
    sendToSocket(socket, { type: 'pong' });
  } else if (parsed.type === 'history') {
    const limit = Math.min(parsed.limit || 50, 100);
    const history = getChatHistory(channelId, limit, parsed.before);
    sendToSocket(socket, { type: 'history', messages: history });
  }
}

/**
 * Set up human connection
 */
function setupHumanConnection(channel, socket, connId) {
  const channelId = channel.channel_id;
  const bridge = getChannelBridge(channelId);
  const rateLimit = { windowStart: Date.now(), count: 0 };

  bridge.addHuman(connId, socket);
  channelLog(channelId, 'human_connected', `connId=${connId}`);

  const pingInterval = setInterval(() => {
    if (socket.writable) sendToSocket(socket, { type: 'ping' });
  }, PING_INTERVAL_MS);

  let buffer = Buffer.alloc(0);
  socket.on('data', async (data) => {
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
        await handleHumanMessage(channelId, connId, parsed, socket, rateLimit);
      } catch {
        sendToSocket(socket, { type: 'error', error: 'Invalid message format' });
      }
    }
  });

  const cleanup = () => {
    clearInterval(pingInterval);
    bridge.removeHuman(connId);
    channelLog(channelId, 'human_disconnected', `connId=${connId}`);
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/**
 * Set up human channel WebSocket handling
 */
export function setupHumanChannelProxy(server) {
  server.on('upgrade', async (req, socket, _head) => {
    // Only handle /channel/<id>, not /api/channel/<id>
    if (req.url.startsWith('/api/')) return;
    
    const match = req.url.match(/^\/channel\/([^/?]+)/);
    if (!match) return;

    const channelId = match[1];
    const channel = getChannel(channelId);

    channelLog(channelId, 'human_connection_attempt', `from=${req.socket.remoteAddress}`);

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

    // Auth flow
    let authenticated = false;
    let authAttempts = 0;
    let buffer = Buffer.alloc(0);
    const connId = `human_${nanoid(8)}`;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        sendToSocket(socket, { type: 'error', error: 'Authentication timeout' });
        socket.end();
      }
    }, AUTH_TIMEOUT_MS);

    const authHandler = async (data) => {
      buffer = Buffer.concat([buffer, data]);
      const { messages, remainder } = parseWebSocketFrames(buffer);
      buffer = remainder;

      for (const frame of messages) {
        if (frame.opcode !== WS_OPCODES.TEXT) continue;

        try {
          const parsed = JSON.parse(frame.payload.toString('utf8'));

          if (parsed.type === 'auth') {
            let valid = false;
            
            // Check admin token first (one-time tokens from admin UI)
            if (parsed.adminToken && validateAdminChatToken) {
              valid = validateAdminChatToken(parsed.adminToken, channelId);
            }
            // Fall back to channel key
            if (!valid && parsed.key) {
              valid = await verifyChannelKey(channel, parsed.key);
            }

            if (valid) {
              clearTimeout(authTimeout);
              authenticated = true;
              socket.removeListener('data', authHandler);
              channelLog(channelId, 'human_auth_success');
              sendToSocket(socket, { type: 'auth', success: true });
              setupHumanConnection(channel, socket, connId);
              return;
            } else {
              authAttempts++;
              if (authAttempts >= MAX_AUTH_ATTEMPTS) {
                clearTimeout(authTimeout);
                sendToSocket(socket, { type: 'auth', success: false, error: 'Max attempts exceeded' });
                socket.end();
                return;
              }
              sendToSocket(socket, { type: 'auth', success: false, error: 'Invalid key', attemptsRemaining: MAX_AUTH_ATTEMPTS - authAttempts });
            }
          } else {
            sendToSocket(socket, { type: 'error', error: 'First message must be auth' });
            clearTimeout(authTimeout);
            socket.end();
            return;
          }
        } catch {
          sendToSocket(socket, { type: 'error', error: 'Invalid auth message' });
          clearTimeout(authTimeout);
          socket.end();
          return;
        }
      }
    };

    socket.on('data', authHandler);
    socket.on('error', () => clearTimeout(authTimeout));
    socket.on('close', () => clearTimeout(authTimeout));
  });
}

export default { setupHumanChannelProxy, setAdminTokenValidator };
