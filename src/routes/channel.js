/**
 * Channel WebSocket endpoint — filtered gateway proxy for chat clients.
 * 
 * Provides limited, filtered access to an agent's gateway. Only allows
 * messaging operations; blocks admin ops, config, tools, etc.
 * 
 * Endpoint: WS /channel/<channel-id>
 * Auth: bcrypt key in first message or x-channel-key header
 * 
 * Security model: STRICT WHITELIST ONLY
 * - Only explicitly allowed message types pass through
 * - Non-JSON messages are blocked
 * - No fallback heuristics for unknown message types
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { getChannel, markChannelConnected } from '../lib/db.js';

// Admin token validation is injected at runtime to avoid circular imports
let validateAdminChatToken = null;
export function setAdminTokenValidator(fn) {
  validateAdminChatToken = fn;
}

// Configuration
const AUTH_TIMEOUT_MS = 30000;  // 30 seconds to authenticate
const MAX_AUTH_ATTEMPTS = 3;    // Max failed auth attempts before disconnect

// Whitelist of allowed message types from client → gateway
const ALLOWED_CLIENT_MESSAGES = new Set([
  'send',           // Send a message
  'subscribe',      // Subscribe to session events
  'ping',           // Keepalive
  'pong'            // Keepalive response
]);

// Message types from gateway that we forward to client
const ALLOWED_GATEWAY_MESSAGES = new Set([
  'message',        // Agent response
  'response',       // Response to send
  'chunk',          // Streaming chunk (partial response)
  'done',           // Streaming done (final message)
  'event',          // Session events (typing, etc.)
  'ping',
  'pong',
  'subscribed',     // Confirmation of subscription
  'error'           // Errors (filtered)
]);

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
 * Filter a message from client before forwarding to gateway.
 * STRICT WHITELIST: Returns the message if type is explicitly allowed, null otherwise.
 */
function filterClientMessage(message, channelId) {
  try {
    const parsed = JSON.parse(message);
    const type = parsed.type || parsed.action || parsed.method;
    
    if (!type || !ALLOWED_CLIENT_MESSAGES.has(type)) {
      channelLog(channelId, 'blocked_client_msg', `type=${type}`);
      return null;
    }
    
    return message;
  } catch {
    channelLog(channelId, 'blocked_client_msg', 'non-JSON');
    return null;
  }
}

/**
 * Filter a message from gateway before forwarding to client.
 * STRICT WHITELIST: Only explicitly allowed types pass through.
 * Non-JSON and unknown types are BLOCKED (not forwarded).
 */
function filterGatewayMessage(message, channelId) {
  try {
    const parsed = JSON.parse(message);
    const type = parsed.type || parsed.action || parsed.method;
    
    // STRICT: Only allow explicitly whitelisted types
    if (type && ALLOWED_GATEWAY_MESSAGES.has(type)) {
      return message;
    }
    
    channelLog(channelId, 'blocked_gateway_msg', `type=${type}`);
    return null;
  } catch {
    // Non-JSON from gateway is blocked (security: could leak binary/raw data)
    channelLog(channelId, 'blocked_gateway_msg', 'non-JSON');
    return null;
  }
}

/**
 * Set up channel WebSocket handling on the HTTP server.
 * Called after setupWebSocketProxy() to handle /channel/* paths.
 */
export function setupChannelProxy(server) {
  server.on('upgrade', async (req, socket, _head) => {
    const match = req.url.match(/^\/channel\/([^/?]+)(.*)/);
    if (!match) return; // Not a channel request

    const channelId = match[1];
    const channel = getChannel(channelId);

    channelLog(channelId, 'connection_attempt', `from=${req.socket.remoteAddress}`);

    if (!channel || !channel.channel_enabled) {
      channelLog(channelId, 'rejected', 'channel not found or disabled');
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!channel.gateway_proxy_url) {
      channelLog(channelId, 'rejected', 'gateway not configured');
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nGateway not configured');
      socket.destroy();
      return;
    }

    // Check for key in header (preferred)
    const headerKey = req.headers['x-channel-key'];
    if (headerKey) {
      const valid = await verifyChannelKey(channel, headerKey);
      if (!valid) {
        channelLog(channelId, 'auth_failed', 'invalid header key');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      channelLog(channelId, 'auth_success', 'via header');
      connectToGatewayFiltered(channel, req, socket);
      return;
    }

    // No header key — expect auth in first WebSocket message
    completeHandshakeAndWaitForAuth(channel, req, socket);
  });
}

/**
 * Complete WebSocket handshake and wait for auth message
 */
function completeHandshakeAndWaitForAuth(channel, req, socket) {
  const channelId = channel.channel_id;
  
  // Simple WebSocket handshake
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

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
  let authAttempts = 0;

  // Auth timeout - disconnect if no auth within timeout period
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      channelLog(channelId, 'auth_timeout', `after ${AUTH_TIMEOUT_MS}ms`);
      socket.write(createWebSocketFrame(JSON.stringify({ 
        type: 'error', 
        error: 'Authentication timeout' 
      })));
      socket.end();
    }
  }, AUTH_TIMEOUT_MS);

  // Cleanup function
  const cleanup = () => {
    clearTimeout(authTimeout);
    if (gatewaySocket) gatewaySocket.destroy();
  };

  socket.on('data', async (data) => {
    if (authenticated) {
      // Already authed, forward to gateway (filtered)
      if (gatewaySocket && gatewaySocket.writable) {
        const messages = parseWebSocketFrames(data);
        for (const msg of messages) {
          const filtered = filterClientMessage(msg, channelId);
          if (filtered) {
            gatewaySocket.write(createWebSocketFrame(filtered));
          } else {
            socket.write(createWebSocketFrame(JSON.stringify({
              type: 'error',
              error: 'Message type not allowed on channel endpoint'
            })));
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
        if (parsed.type === 'auth') {
          let valid = false;
          let authMethod = '';
          
          // Check for admin token first (one-time tokens from admin UI)
          if (parsed.adminToken && validateAdminChatToken) {
            valid = validateAdminChatToken(parsed.adminToken, channelId);
            authMethod = 'admin_token';
          }
          // Fall back to channel key
          else if (parsed.key) {
            valid = await verifyChannelKey(channel, parsed.key);
            authMethod = 'channel_key';
          }
          
          if (valid) {
            clearTimeout(authTimeout);
            authenticated = true;
            channelLog(channelId, 'auth_success', `via ${authMethod}`);
            socket.write(createWebSocketFrame(JSON.stringify({ type: 'auth', success: true })));
            gatewaySocket = await connectToGatewayFilteredInternal(channel, socket);
            markChannelConnected(channel.id);
          } else {
            authAttempts++;
            channelLog(channelId, 'auth_failed', `attempt ${authAttempts}/${MAX_AUTH_ATTEMPTS}`);
            
            if (authAttempts >= MAX_AUTH_ATTEMPTS) {
              socket.write(createWebSocketFrame(JSON.stringify({ 
                type: 'auth', 
                success: false, 
                error: 'Max auth attempts exceeded' 
              })));
              cleanup();
              socket.end();
            } else {
              socket.write(createWebSocketFrame(JSON.stringify({ 
                type: 'auth', 
                success: false, 
                error: 'Invalid credentials',
                attemptsRemaining: MAX_AUTH_ATTEMPTS - authAttempts
              })));
              // Clear buffer to allow retry
              buffer = Buffer.alloc(0);
            }
          }
        } else {
          socket.write(createWebSocketFrame(JSON.stringify({ 
            type: 'error', 
            error: 'First message must be auth' 
          })));
          cleanup();
          socket.end();
        }
      } catch {
        socket.write(createWebSocketFrame(JSON.stringify({ 
          type: 'error', 
          error: 'Invalid auth message' 
        })));
        cleanup();
        socket.end();
      }
    }
  });

  socket.on('error', cleanup);
  socket.on('close', cleanup);
}

/**
 * Connect to gateway with full message filtering (for header auth path)
 * Completes WS handshake to client, then connects to gateway with filtering
 */
function connectToGatewayFiltered(channel, req, socket) {
  const channelId = channel.channel_id;
  
  // Complete WS handshake with client first
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

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

  // Now connect to gateway with filtering
  connectToGatewayFilteredInternal(channel, socket).then(gatewaySocket => {
    channelLog(channelId, 'connected', 'gateway proxy established');
    markChannelConnected(channel.id);
    
    // Set up client→gateway filtering
    socket.on('data', (data) => {
      if (gatewaySocket && gatewaySocket.writable) {
        const messages = parseWebSocketFrames(data);
        for (const msg of messages) {
          const filtered = filterClientMessage(msg, channelId);
          if (filtered) {
            gatewaySocket.write(createWebSocketFrame(filtered));
          } else {
            socket.write(createWebSocketFrame(JSON.stringify({
              type: 'error',
              error: 'Message type not allowed on channel endpoint'
            })));
          }
        }
      }
    });

    socket.on('error', () => gatewaySocket.destroy());
    socket.on('close', () => gatewaySocket.destroy());
  }).catch(err => {
    channelLog(channelId, 'gateway_error', err.message);
    socket.write(createWebSocketFrame(JSON.stringify({
      type: 'error',
      error: 'Failed to connect to gateway'
    })));
    socket.end();
  });
}

/**
 * Internal: Connect to gateway and set up gateway→client filtering
 * Returns the gateway socket for bidirectional communication
 */
function connectToGatewayFilteredInternal(channel, clientSocket) {
  const channelId = channel.channel_id;
  
  return new Promise((resolve, reject) => {
    const parsed = new URL(channel.gateway_proxy_url);
    const isHttps = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    const transport = isHttps ? https : http;

    const wsPath = parsed.pathname || '/';
    const headers = {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      'Host': parsed.host
    };

    const proxyReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: wsPath,
      method: 'GET',
      headers
    });

    proxyReq.on('upgrade', (_proxyRes, gatewaySocket, _proxyHead) => {
      // NOTE: We intentionally do NOT forward proxyHead to client
      // as it could contain unfiltered data from the gateway handshake
      
      // Set up gateway→client filtering
      gatewaySocket.on('data', (data) => {
        const messages = parseWebSocketFrames(data);
        for (const msg of messages) {
          const filtered = filterGatewayMessage(msg, channelId);
          if (filtered) {
            clientSocket.write(createWebSocketFrame(filtered));
          }
          // Blocked messages are silently dropped (logged in filterGatewayMessage)
        }
      });

      gatewaySocket.on('error', () => {
        channelLog(channelId, 'gateway_socket_error');
        clientSocket.destroy();
      });
      gatewaySocket.on('close', () => {
        channelLog(channelId, 'gateway_disconnected');
        clientSocket.end();
      });

      resolve(gatewaySocket);
    });

    proxyReq.on('error', (err) => {
      channelLog(channelId, 'gateway_connection_error', err.message);
      reject(err);
    });

    proxyReq.end();
  });
}

/**
 * Parse WebSocket frames from buffer.
 * NOTE: This is a simplified parser that only handles complete, non-fragmented
 * text frames (FIN=1, opcode=1). Fragmented messages (FIN=0 continuation frames)
 * are not supported and will be dropped. For production use, consider using
 * the 'ws' library which handles all frame types correctly.
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

    // Only handle complete text frames (FIN=1, opcode=1)
    // Fragmented frames (FIN=0) and continuation frames (opcode=0) are dropped
    if (fin && opcode === 1) {
      messages.push(payload.toString('utf8'));
    }
    // Close frames (opcode=8) could be handled here for graceful shutdown
  }

  return messages;
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

export default { setupChannelProxy };
