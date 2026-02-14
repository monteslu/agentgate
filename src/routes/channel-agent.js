/**
 * Agent Channel WebSocket endpoint.
 * 
 * Endpoint: WS /api/channel/<channel-id>
 * Auth: Bearer token (same as other /api/* routes)
 * 
 * This is where the OpenClaw channel plugin connects.
 * Humans connect via /channel/<id>.
 * 
 * Protocol:
 *   Server: { type: "connected", channelId, humans: [...] }  // On connect
 *   Server: { type: "human_connected", connId }
 *   Server: { type: "human_disconnected", connId }
 *   Server: { type: "message", from: "human", text, id, timestamp, connId }
 *   
 *   Agent: { type: "message", text, id?, connId? }  // Response to human
 *   Agent: { type: "chunk", text, id, connId? }     // Streaming
 *   Agent: { type: "done", id, text?, connId? }     // Stream complete
 *   Agent: { type: "typing", connId? }              // Typing indicator
 *   Agent: { type: "error", error, messageId?, connId? }
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

// Configuration
const AUTH_TIMEOUT_MS = 30000;
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
 * Verify Bearer token
 */
function verifyBearerToken(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  
  const token = auth.slice(7);
  const apiKey = getApiKeyByKey(token);
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
 * Create WebSocket text frame
 */
function createWebSocketFrame(message) {
  const payload = Buffer.from(message, 'utf8');
  const length = payload.length;
  
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Parse WebSocket frames
 */
function parseWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;

    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (buffer.length - offset < 4) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 10) break;
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const totalFrameLength = headerLength + maskLength + payloadLength;
    if (buffer.length - offset < totalFrameLength) break;

    let maskKey = null;
    if (masked) {
      maskKey = buffer.slice(offset + headerLength, offset + headerLength + 4);
    }

    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.slice(payloadStart, payloadStart + payloadLength));

    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    offset += totalFrameLength;

    if (opcode === 8) {
      messages.push({ type: 'close' });
    } else if (opcode === 9) {
      messages.push({ type: 'ping', payload });
    } else if (fin && opcode === 1) {
      messages.push({ type: 'text', data: payload.toString('utf8') });
    }
  }

  return { messages, remainder: offset < buffer.length ? buffer.slice(offset) : Buffer.alloc(0) };
}

function createPongFrame(payload) {
  const length = payload.length;
  const header = Buffer.alloc(length < 126 ? 2 : 4);
  header[0] = 0x8A;
  if (length < 126) {
    header[1] = length;
  } else {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  }
  return Buffer.concat([header, payload]);
}

function sendToSocket(socket, msg) {
  if (socket && socket.writable) {
    socket.write(createWebSocketFrame(JSON.stringify(msg)));
  }
}

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
 * Handle agent message
 */
function handleAgentMessage(channelId, parsed, socket, rateLimit) {
  if (!checkRateLimit(rateLimit)) {
    sendToSocket(socket, { type: 'error', error: 'Rate limited' });
    return;
  }

  const bridge = getChannelBridge(channelId);

  if (parsed.type === 'message') {
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
      type: 'message',
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

  } else if (parsed.type === 'chunk') {
    const msg = { type: 'chunk', text: parsed.text, id: parsed.id };
    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }

  } else if (parsed.type === 'done') {
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

    const msg = { type: 'done', id: parsed.id, timestamp };
    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }

  } else if (parsed.type === 'typing') {
    const msg = { type: 'typing' };
    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }

  } else if (parsed.type === 'error') {
    const msg = { type: 'error', error: parsed.error, messageId: parsed.messageId };
    if (parsed.connId) {
      bridge.sendToHuman(parsed.connId, msg);
    } else {
      bridge.broadcastToHumans(msg);
    }

  } else if (parsed.type === 'ping') {
    sendToSocket(socket, { type: 'pong' });
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
    sendToSocket(socket, { type: 'error', error: 'Agent already connected to this channel' });
    socket.end();
    return;
  }

  channelLog(channelId, 'agent_connected', `agent=${agentName}`);
  markChannelConnected(channel.id);

  const pingInterval = setInterval(() => {
    if (socket.writable) sendToSocket(socket, { type: 'ping' });
  }, PING_INTERVAL_MS);

  let buffer = Buffer.alloc(0);
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    const { messages, remainder } = parseWebSocketFrames(buffer);
    buffer = remainder;

    for (const frame of messages) {
      if (frame.type === 'close') { socket.end(); return; }
      if (frame.type === 'ping') { socket.write(createPongFrame(frame.payload)); continue; }
      if (frame.type !== 'text') continue;

      try {
        const parsed = JSON.parse(frame.data);
        handleAgentMessage(channelId, parsed, socket, rateLimit);
      } catch {
        sendToSocket(socket, { type: 'error', error: 'Invalid message format' });
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
    // Only handle /api/channel/<id>
    const match = req.url.match(/^\/api\/channel\/([^/?]+)/);
    if (!match) return;

    const channelId = match[1];
    
    // Verify Bearer token
    const apiKey = verifyBearerToken(req);
    if (!apiKey) {
      channelLog(channelId, 'agent_rejected', 'invalid or missing Bearer token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
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

    // Verify the agent is authorized for this channel
    // For now, any valid API key can connect (can add channel-specific ACL later)

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
