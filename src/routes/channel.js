/**
 * Channel WebSocket endpoint — AgentGate-owned human-facing chat API.
 * 
 * Provides a simple, documented chat interface for human clients.
 * The OpenClaw channel plugin connects TO this endpoint to send/receive messages.
 * 
 * Endpoint: WS /channel/<channel-id>
 * Auth: channel key in first message { type: "auth", key: "..." }
 * 
 * Protocol:
 *   Client: { type: "auth", key: "<channel-key>" }
 *   Server: { type: "auth", success: true }
 *   Client: { type: "message", text: "hello" }
 *   Server: { type: "message", from: "agent", text: "hi", id: "msg_123", timestamp: "..." }
 *   Server: { type: "chunk", text: "partial..." }
 *   Server: { type: "done", id: "msg_123" }
 *   Server: { type: "typing" }
 *   Server: { type: "error", error: "..." }
 * 
 * Architecture:
 *   Human App ←WS→ AgentGate /channel/<id> ←WS→ OpenClaw (agentgate-channel plugin)
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { 
  getChannel, 
  markChannelConnected,
  saveChatMessage,
  getChatHistory,
  getChannelAgentConnection
} from '../lib/db.js';

// Configuration
const AUTH_TIMEOUT_MS = 30000;  // 30 seconds to authenticate
const MAX_AUTH_ATTEMPTS = 3;    // Max failed auth attempts before disconnect
const MAX_MESSAGE_SIZE = 4096;  // 4KB message limit
const PING_INTERVAL_MS = 30000; // Keepalive ping interval

// Store active connections per channel
// channelId -> { humans: Map<connId, socket>, agent: socket | null }
const channelConnections = new Map();

/**
 * Log channel events with timestamp for audit trail
 */
function channelLog(channelId, event, details = '') {
  const ts = new Date().toISOString();
  console.log(`[channel][${ts}] ${channelId}: ${event}${details ? ' - ' + details : ''}`);
}

/**
 * Verify channel key against stored bcrypt hash
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
 * Get or create channel connections structure
 */
function getChannelConns(channelId) {
  if (!channelConnections.has(channelId)) {
    channelConnections.set(channelId, {
      humans: new Map(),
      agent: null,
      agentConnId: null
    });
  }
  return channelConnections.get(channelId);
}

/**
 * Create a WebSocket text frame
 */
function createWebSocketFrame(message) {
  const payload = Buffer.from(message, 'utf8');
  const length = payload.length;
  
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
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
 * Parse WebSocket frames from buffer.
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
    
    offset += 2;

    if (payloadLength === 126) {
      if (buffer.length - offset < 2) break;
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 8) break;
      payloadLength = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buffer.length - offset < 4) break;
      maskKey = buffer.slice(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length - offset < payloadLength) break;

    const payload = buffer.slice(offset, offset + payloadLength);
    offset += payloadLength;

    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    // Handle different opcodes
    if (opcode === 8) {
      // Close frame
      messages.push({ type: 'close' });
    } else if (opcode === 9) {
      // Ping - respond with pong
      messages.push({ type: 'ping', payload });
    } else if (opcode === 10) {
      // Pong - ignore
    } else if (fin && opcode === 1) {
      // Text frame
      messages.push({ type: 'text', data: payload.toString('utf8') });
    }
  }

  return messages;
}

/**
 * Create a WebSocket pong frame
 */
function createPongFrame(payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x8A; // FIN + pong opcode
    header[1] = length;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x8A;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Send a message to a WebSocket client
 */
function sendToSocket(socket, msg) {
  if (socket && socket.writable) {
    socket.write(createWebSocketFrame(JSON.stringify(msg)));
  }
}

/**
 * Broadcast to all human clients on a channel
 */
function broadcastToHumans(channelId, msg) {
  const conns = channelConnections.get(channelId);
  if (!conns) return;
  
  const frame = createWebSocketFrame(JSON.stringify(msg));
  for (const [, socket] of conns.humans) {
    if (socket && socket.writable) {
      socket.write(frame);
    }
  }
}

/**
 * Send a message to the agent connection
 */
function sendToAgent(channelId, msg) {
  const conns = channelConnections.get(channelId);
  if (conns?.agent && conns.agent.writable) {
    conns.agent.write(createWebSocketFrame(JSON.stringify(msg)));
    return true;
  }
  return false;
}

/**
 * Handle a message from a human client
 */
async function handleHumanMessage(channelId, connId, parsed) {
  const conns = channelConnections.get(channelId);
  
  if (parsed.type === 'message') {
    // Validate message size
    if (!parsed.text || parsed.text.length > MAX_MESSAGE_SIZE) {
      sendToSocket(conns.humans.get(connId), {
        type: 'error',
        error: `Message exceeds maximum size of ${MAX_MESSAGE_SIZE} bytes`
      });
      return;
    }

    // Generate message ID and timestamp
    const msgId = `msg_${nanoid(12)}`;
    const timestamp = new Date().toISOString();

    // Save to database
    saveChatMessage({
      channelId,
      messageId: msgId,
      from: 'human',
      fromConnId: connId,
      text: parsed.text,
      timestamp
    });

    channelLog(channelId, 'human_message', `connId=${connId} msgId=${msgId}`);

    // Forward to agent if connected
    if (conns.agent) {
      sendToAgent(channelId, {
        type: 'message',
        from: 'human',
        text: parsed.text,
        id: msgId,
        timestamp,
        connId  // So agent knows which human sent it
      });
    } else {
      // No agent connected - queue message or return error
      sendToSocket(conns.humans.get(connId), {
        type: 'error',
        error: 'Agent not connected',
        messageId: msgId
      });
    }
  } else if (parsed.type === 'ping') {
    sendToSocket(conns.humans.get(connId), { type: 'pong' });
  } else if (parsed.type === 'history') {
    // Client requesting chat history
    const limit = Math.min(parsed.limit || 50, 100);
    const history = getChatHistory(channelId, limit, parsed.before);
    sendToSocket(conns.humans.get(connId), {
      type: 'history',
      messages: history
    });
  }
}

/**
 * Handle a message from the agent (OpenClaw plugin)
 */
function handleAgentMessage(channelId, parsed) {
  const conns = channelConnections.get(channelId);
  if (!conns) return;

  if (parsed.type === 'message') {
    // Agent sending a response
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

    // Broadcast to all human clients (or specific one if connId provided)
    if (parsed.connId && conns.humans.has(parsed.connId)) {
      sendToSocket(conns.humans.get(parsed.connId), {
        type: 'message',
        from: 'agent',
        text: parsed.text,
        id: msgId,
        timestamp
      });
    } else {
      broadcastToHumans(channelId, {
        type: 'message',
        from: 'agent',
        text: parsed.text,
        id: msgId,
        timestamp
      });
    }
  } else if (parsed.type === 'chunk') {
    // Streaming chunk
    if (parsed.connId && conns.humans.has(parsed.connId)) {
      sendToSocket(conns.humans.get(parsed.connId), {
        type: 'chunk',
        text: parsed.text,
        id: parsed.id
      });
    } else {
      broadcastToHumans(channelId, {
        type: 'chunk',
        text: parsed.text,
        id: parsed.id
      });
    }
  } else if (parsed.type === 'done') {
    // Streaming complete
    const timestamp = new Date().toISOString();
    
    // Save final message if text provided
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

    if (parsed.connId && conns.humans.has(parsed.connId)) {
      sendToSocket(conns.humans.get(parsed.connId), {
        type: 'done',
        id: parsed.id,
        timestamp
      });
    } else {
      broadcastToHumans(channelId, {
        type: 'done',
        id: parsed.id,
        timestamp
      });
    }
  } else if (parsed.type === 'typing') {
    // Agent is typing indicator
    broadcastToHumans(channelId, { type: 'typing' });
  } else if (parsed.type === 'error') {
    // Error from agent
    if (parsed.connId && conns.humans.has(parsed.connId)) {
      sendToSocket(conns.humans.get(parsed.connId), {
        type: 'error',
        error: parsed.error,
        messageId: parsed.messageId
      });
    } else {
      broadcastToHumans(channelId, {
        type: 'error',
        error: parsed.error
      });
    }
  } else if (parsed.type === 'ping') {
    sendToAgent(channelId, { type: 'pong' });
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
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  return true;
}

/**
 * Set up human client connection
 */
function setupHumanConnection(channel, socket, connId) {
  const channelId = channel.channel_id;
  const conns = getChannelConns(channelId);
  
  conns.humans.set(connId, socket);
  channelLog(channelId, 'human_connected', `connId=${connId}`);

  // Notify agent of new human connection
  if (conns.agent) {
    sendToAgent(channelId, {
      type: 'human_connected',
      connId
    });
  }

  // Set up keepalive
  const pingInterval = setInterval(() => {
    if (socket.writable) {
      socket.write(createWebSocketFrame(JSON.stringify({ type: 'ping' })));
    }
  }, PING_INTERVAL_MS);

  // Handle incoming data
  let buffer = Buffer.alloc(0);
  socket.on('data', async (data) => {
    buffer = Buffer.concat([buffer, data]);
    const frames = parseWebSocketFrames(buffer);
    buffer = Buffer.alloc(0); // Clear buffer after parsing
    
    for (const frame of frames) {
      if (frame.type === 'close') {
        socket.end();
        return;
      }
      if (frame.type === 'ping') {
        socket.write(createPongFrame(frame.payload));
        continue;
      }
      if (frame.type !== 'text') continue;

      try {
        const parsed = JSON.parse(frame.data);
        await handleHumanMessage(channelId, connId, parsed);
      } catch (err) {
        sendToSocket(socket, { type: 'error', error: 'Invalid message format' });
      }
    }
  });

  // Cleanup on disconnect
  const cleanup = () => {
    clearInterval(pingInterval);
    conns.humans.delete(connId);
    channelLog(channelId, 'human_disconnected', `connId=${connId}`);
    
    // Notify agent
    if (conns.agent) {
      sendToAgent(channelId, {
        type: 'human_disconnected',
        connId
      });
    }

    // Clean up empty channel
    if (conns.humans.size === 0 && !conns.agent) {
      channelConnections.delete(channelId);
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/**
 * Set up agent (OpenClaw plugin) connection
 */
function setupAgentConnection(channel, socket) {
  const channelId = channel.channel_id;
  const conns = getChannelConns(channelId);
  const connId = `agent_${nanoid(8)}`;

  // Only one agent connection per channel
  if (conns.agent) {
    channelLog(channelId, 'agent_rejected', 'already connected');
    sendToSocket(socket, { type: 'error', error: 'Agent already connected' });
    socket.end();
    return;
  }

  conns.agent = socket;
  conns.agentConnId = connId;
  channelLog(channelId, 'agent_connected');
  markChannelConnected(channel.id);

  // Notify agent of currently connected humans
  const humanConnIds = Array.from(conns.humans.keys());
  sendToAgent(channelId, {
    type: 'connected',
    channelId,
    humans: humanConnIds
  });

  // Set up keepalive
  const pingInterval = setInterval(() => {
    if (socket.writable) {
      socket.write(createWebSocketFrame(JSON.stringify({ type: 'ping' })));
    }
  }, PING_INTERVAL_MS);

  // Handle incoming data
  let buffer = Buffer.alloc(0);
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    const frames = parseWebSocketFrames(buffer);
    buffer = Buffer.alloc(0);
    
    for (const frame of frames) {
      if (frame.type === 'close') {
        socket.end();
        return;
      }
      if (frame.type === 'ping') {
        socket.write(createPongFrame(frame.payload));
        continue;
      }
      if (frame.type !== 'text') continue;

      try {
        const parsed = JSON.parse(frame.data);
        handleAgentMessage(channelId, parsed);
      } catch (err) {
        sendToSocket(socket, { type: 'error', error: 'Invalid message format' });
      }
    }
  });

  // Cleanup on disconnect
  const cleanup = () => {
    clearInterval(pingInterval);
    conns.agent = null;
    conns.agentConnId = null;
    channelLog(channelId, 'agent_disconnected');

    // Notify all humans
    broadcastToHumans(channelId, {
      type: 'agent_disconnected'
    });

    // Clean up empty channel
    if (conns.humans.size === 0) {
      channelConnections.delete(channelId);
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/**
 * Set up channel WebSocket handling on the HTTP server.
 */
export function setupChannelProxy(server) {
  server.on('upgrade', async (req, socket, _head) => {
    const match = req.url.match(/^\/channel\/([^/?]+)(.*)/);
    if (!match) return; // Not a channel request

    const channelId = match[1];
    const queryString = match[2];
    const channel = getChannel(channelId);

    channelLog(channelId, 'connection_attempt', `from=${req.socket.remoteAddress}`);

    if (!channel || !channel.channel_enabled) {
      channelLog(channelId, 'rejected', 'channel not found or disabled');
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Determine connection type from query param: ?role=agent or default to human
    const isAgent = queryString.includes('role=agent');

    // Complete WebSocket handshake
    if (!completeHandshake(req, socket)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Wait for auth message
    let authenticated = false;
    let authAttempts = 0;
    let buffer = Buffer.alloc(0);
    const connId = `conn_${nanoid(8)}`;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        channelLog(channelId, 'auth_timeout');
        sendToSocket(socket, { type: 'error', error: 'Authentication timeout' });
        socket.end();
      }
    }, AUTH_TIMEOUT_MS);

    const authHandler = async (data) => {
      buffer = Buffer.concat([buffer, data]);
      const frames = parseWebSocketFrames(buffer);
      
      for (const frame of frames) {
        if (frame.type !== 'text') continue;
        
        try {
          const parsed = JSON.parse(frame.data);
          
          if (parsed.type === 'auth') {
            const valid = await verifyChannelKey(channel, parsed.key);
            
            if (valid) {
              clearTimeout(authTimeout);
              authenticated = true;
              socket.removeListener('data', authHandler);
              channelLog(channelId, 'auth_success', isAgent ? 'agent' : 'human');
              
              sendToSocket(socket, { type: 'auth', success: true });

              if (isAgent) {
                setupAgentConnection(channel, socket);
              } else {
                setupHumanConnection(channel, socket, connId);
              }
              return;
            } else {
              authAttempts++;
              channelLog(channelId, 'auth_failed', `attempt ${authAttempts}/${MAX_AUTH_ATTEMPTS}`);
              
              if (authAttempts >= MAX_AUTH_ATTEMPTS) {
                clearTimeout(authTimeout);
                sendToSocket(socket, { 
                  type: 'auth', 
                  success: false, 
                  error: 'Max auth attempts exceeded' 
                });
                socket.end();
                return;
              }
              
              sendToSocket(socket, { 
                type: 'auth', 
                success: false,
                error: 'Invalid credentials',
                attemptsRemaining: MAX_AUTH_ATTEMPTS - authAttempts
              });
              buffer = Buffer.alloc(0);
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

export default { setupChannelProxy };
