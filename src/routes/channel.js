/**
 * Channel WebSocket endpoint — filtered gateway proxy for chat clients.
 * 
 * Provides limited, filtered access to an agent's gateway. Only allows
 * messaging operations; blocks admin ops, config, tools, etc.
 * 
 * Endpoint: WS /channel/<channel-id>
 * Auth: bcrypt key in first message or x-channel-key header
 */

import bcrypt from 'bcrypt';
import { getChannel, markChannelConnected } from '../lib/db.js';
import http from 'http';
import https from 'https';

// Whitelist of allowed message types from client → gateway
const ALLOWED_CLIENT_MESSAGES = new Set([
  'send',           // Send a message
  'subscribe',      // Subscribe to session events
  'ping',           // Keepalive
  'pong',           // Keepalive response
]);

// Message types from gateway that we forward to client
const ALLOWED_GATEWAY_MESSAGES = new Set([
  'message',        // Agent response
  'response',       // Response to send
  'event',          // Session events (typing, etc.)
  'ping',
  'pong',
  'subscribed',     // Confirmation of subscription
  'error',          // Errors (filtered)
]);

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
 * Filter a message from client before forwarding to gateway.
 * Returns the message if allowed, null if blocked.
 */
function filterClientMessage(message) {
  try {
    const parsed = JSON.parse(message);
    const type = parsed.type || parsed.action || parsed.method;
    
    if (!type || !ALLOWED_CLIENT_MESSAGES.has(type)) {
      console.log(`[channel] Blocked client message type: ${type}`);
      return null;
    }
    
    return message; // Pass through as-is
  } catch {
    // Non-JSON messages are blocked
    console.log('[channel] Blocked non-JSON client message');
    return null;
  }
}

/**
 * Filter a message from gateway before forwarding to client.
 * Returns the message if allowed, null if blocked.
 */
function filterGatewayMessage(message) {
  try {
    const parsed = JSON.parse(message);
    const type = parsed.type || parsed.action || parsed.method;
    
    // Allow all response types that aren't admin/config related
    if (type && ALLOWED_GATEWAY_MESSAGES.has(type)) {
      return message;
    }
    
    // Block anything with sensitive data patterns
    const str = message.toLowerCase();
    if (str.includes('config') || str.includes('admin') || str.includes('token')) {
      console.log(`[channel] Blocked gateway message with sensitive content`);
      return null;
    }
    
    // Default: forward if it looks like a regular response
    if (parsed.content || parsed.text || parsed.message) {
      return message;
    }
    
    console.log(`[channel] Blocked unknown gateway message type: ${type}`);
    return null;
  } catch {
    // Non-JSON from gateway is unusual but forward it
    return message;
  }
}

/**
 * Set up channel WebSocket handling on the HTTP server.
 * Called after setupWebSocketProxy() to handle /channel/* paths.
 */
export function setupChannelProxy(server) {
  server.on('upgrade', async (req, socket, head) => {
    const match = req.url.match(/^\/channel\/([^/?]+)(.*)/);
    if (!match) return; // Not a channel request

    const channelId = match[1];
    const channel = getChannel(channelId);

    if (!channel || !channel.channel_enabled) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!channel.gateway_proxy_url) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nGateway not configured');
      socket.destroy();
      return;
    }

    // Check for key in header (preferred)
    const headerKey = req.headers['x-channel-key'];
    if (headerKey) {
      const valid = await verifyChannelKey(channel, headerKey);
      if (!valid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // Auth passed, proceed to connect
      connectToGateway(channel, socket, head);
      return;
    }

    // No header key — expect auth in first WebSocket message
    // Complete the WebSocket handshake first, then wait for auth
    completeHandshakeAndWaitForAuth(channel, req, socket, head);
  });
}

/**
 * Complete WebSocket handshake and wait for auth message
 */
function completeHandshakeAndWaitForAuth(channel, req, socket, head) {
  // Simple WebSocket handshake
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const crypto = require('crypto');
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

  let authenticated = false;
  let gatewaySocket = null;
  let buffer = Buffer.alloc(0);

  // Simple WebSocket frame parser for auth
  socket.on('data', async (data) => {
    if (authenticated) {
      // Already authed, forward to gateway
      if (gatewaySocket && gatewaySocket.writable) {
        // Parse, filter, then forward
        const messages = parseWebSocketFrames(data);
        for (const msg of messages) {
          const filtered = filterClientMessage(msg);
          if (filtered) {
            gatewaySocket.write(createWebSocketFrame(filtered));
          } else {
            // Send error back to client
            const errorFrame = createWebSocketFrame(JSON.stringify({
              type: 'error',
              error: 'Message type not allowed on channel endpoint'
            }));
            socket.write(errorFrame);
          }
        }
      }
      return;
    }

    // Waiting for auth message
    buffer = Buffer.concat([buffer, data]);
    const messages = parseWebSocketFrames(buffer);
    
    if (messages.length > 0) {
      const firstMsg = messages[0];
      try {
        const parsed = JSON.parse(firstMsg);
        if (parsed.type === 'auth' && parsed.key) {
          const valid = await verifyChannelKey(channel, parsed.key);
          if (valid) {
            authenticated = true;
            // Send auth success
            socket.write(createWebSocketFrame(JSON.stringify({ type: 'auth', success: true })));
            // Now connect to gateway
            gatewaySocket = await connectToGatewayFiltered(channel, socket);
            markChannelConnected(channel.id);
          } else {
            socket.write(createWebSocketFrame(JSON.stringify({ type: 'auth', success: false, error: 'Invalid key' })));
            socket.end();
          }
        } else {
          socket.write(createWebSocketFrame(JSON.stringify({ type: 'error', error: 'First message must be auth' })));
          socket.end();
        }
      } catch {
        socket.write(createWebSocketFrame(JSON.stringify({ type: 'error', error: 'Invalid auth message' })));
        socket.end();
      }
    }
  });

  socket.on('error', () => {
    if (gatewaySocket) gatewaySocket.destroy();
  });
  socket.on('close', () => {
    if (gatewaySocket) gatewaySocket.destroy();
  });
}

/**
 * Connect to gateway with message filtering
 */
function connectToGatewayFiltered(channel, clientSocket) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(channel.gateway_proxy_url);
    const isHttps = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    const transport = isHttps ? https : http;

    const wsPath = parsed.pathname || '/';
    const headers = {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': require('crypto').randomBytes(16).toString('base64'),
      'Host': parsed.host
    };

    const proxyReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: wsPath,
      method: 'GET',
      headers
    });

    proxyReq.on('upgrade', (proxyRes, gatewaySocket, proxyHead) => {
      // Pipe gateway messages to client (filtered)
      gatewaySocket.on('data', (data) => {
        const messages = parseWebSocketFrames(data);
        for (const msg of messages) {
          const filtered = filterGatewayMessage(msg);
          if (filtered) {
            clientSocket.write(createWebSocketFrame(filtered));
          }
        }
      });

      gatewaySocket.on('error', () => clientSocket.destroy());
      gatewaySocket.on('close', () => clientSocket.end());

      resolve(gatewaySocket);
    });

    proxyReq.on('error', (err) => {
      console.error('[channel] Gateway connection error:', err.message);
      reject(err);
    });

    proxyReq.end();
  });
}

/**
 * Connect directly to gateway (when auth via header)
 */
function connectToGateway(channel, socket, head) {
  const parsed = new URL(channel.gateway_proxy_url);
  const isHttps = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const transport = isHttps ? https : http;

  const forwardHeaders = {
    'Connection': 'Upgrade',
    'Upgrade': 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': require('crypto').randomBytes(16).toString('base64'),
    'Host': parsed.host
  };

  const proxyReq = transport.request({
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname || '/',
    method: 'GET',
    headers: forwardHeaders
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    // Send upgrade response to client
    let responseHead = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(value)) {
        value.forEach(v => { responseHead += `${key}: ${v}\r\n`; });
      } else {
        responseHead += `${key}: ${value}\r\n`;
      }
    }
    responseHead += '\r\n';
    socket.write(responseHead);

    if (proxyHead && proxyHead.length > 0) socket.write(proxyHead);
    if (head && head.length > 0) proxySocket.write(head);

    // Filtered bidirectional pipe
    proxySocket.on('data', (data) => {
      const messages = parseWebSocketFrames(data);
      for (const msg of messages) {
        const filtered = filterGatewayMessage(msg);
        if (filtered) {
          socket.write(createWebSocketFrame(filtered));
        }
      }
    });

    socket.on('data', (data) => {
      const messages = parseWebSocketFrames(data);
      for (const msg of messages) {
        const filtered = filterClientMessage(msg);
        if (filtered) {
          proxySocket.write(createWebSocketFrame(filtered));
        }
      }
    });

    socket.on('error', () => proxySocket.destroy());
    proxySocket.on('error', () => socket.destroy());
    socket.on('close', () => proxySocket.destroy());
    proxySocket.on('close', () => socket.destroy());

    markChannelConnected(channel.id);
  });

  proxyReq.on('response', (proxyRes) => {
    let responseHead = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      responseHead += `${key}: ${value}\r\n`;
    }
    responseHead += '\r\n';
    socket.write(responseHead);
    proxyRes.pipe(socket);
  });

  proxyReq.on('error', (err) => {
    console.error('[channel] Gateway error:', err.message);
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
  });

  proxyReq.end();
}

// Simple WebSocket frame parsing (text frames only for filtering)
function parseWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;

    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
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

    let payload = buffer.slice(offset, offset + payloadLength);
    offset += payloadLength;

    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    // Only handle text frames (opcode 1)
    if (opcode === 1) {
      messages.push(payload.toString('utf8'));
    }
  }

  return messages;
}

// Create a WebSocket text frame
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

export default { setupChannelProxy };
