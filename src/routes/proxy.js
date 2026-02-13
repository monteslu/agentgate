import { getGatewayProxy } from '../lib/db.js';
import http from 'http';
import https from 'https';

// Default timeout for proxy requests (30 seconds)
const PROXY_TIMEOUT_MS = 30000;

// Hop-by-hop headers that should not be forwarded (RFC 2616 Section 13.5.1)
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
];

/**
 * Filter hop-by-hop headers from a headers object
 */
function filterHopByHopHeaders(headers) {
  const filtered = { ...headers };
  HOP_BY_HOP_HEADERS.forEach(h => delete filtered[h]);
  return filtered;
}

/**
 * Gateway proxy — transparently forwards HTTP requests to an agent's
 * internal gateway URL. Mounted at /px/:proxyId in Express.
 *
 * WebSocket upgrades are handled separately via setupWebSocketProxy()
 * on the raw HTTP server.
 */
export function createProxyRouter() {
  // Catch-all handler for /px/:proxyId/*
  return function proxyHandler(req, res) {
    const { proxyId } = req.params;
    const proxy = getGatewayProxy(proxyId);

    if (!proxy || !proxy.gateway_proxy_enabled) {
      return res.status(404).json({ error: 'Not found' });
    }

    const targetUrl = proxy.gateway_proxy_url;
    if (!targetUrl) {
      return res.status(502).json({ error: 'Proxy target not configured' });
    }

    // Strip the /px/<proxyId> prefix to get the forwarded path
    const prefix = '/px/' + proxyId;
    const forwardPath = req.originalUrl.slice(prefix.length) || '/';

    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Build forwarded headers — filter hop-by-hop, update host
    const forwardHeaders = filterHopByHopHeaders(req.headers);
    forwardHeaders.host = parsed.host;

    const proxyReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: forwardPath,
      method: req.method,
      headers: forwardHeaders,
      timeout: PROXY_TIMEOUT_MS
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    // Handle timeout
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Proxy timeout' });
      }
    });

    proxyReq.on('error', (err) => {
      console.error(`Proxy error for ${proxy.name}:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy target unreachable' });
      }
    });

    // Pipe request body for POST/PUT/PATCH
    req.pipe(proxyReq);
  };
}

/**
 * Set up WebSocket upgrade handling on the HTTP server.
 * Must be called after server.listen() but works on the server 'upgrade' event.
 */
export function setupWebSocketProxy(server) {
  server.on('upgrade', (req, socket, head) => {
    const match = req.url.match(/^\/px\/([^/?]+)(.*)/);
    if (!match) return; // Not a proxy request, let socket.io or others handle it

    const proxyId = match[1];
    const forwardPath = match[2] || '/';

    const proxy = getGatewayProxy(proxyId);
    if (!proxy || !proxy.gateway_proxy_enabled || !proxy.gateway_proxy_url) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const parsed = new URL(proxy.gateway_proxy_url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Build the WebSocket upgrade request to the target — filter hop-by-hop headers
    // Note: 'upgrade' and 'connection' are needed for WebSocket, so we handle them specially
    const forwardHeaders = { ...req.headers };
    forwardHeaders.host = parsed.host;
    // Remove only non-WebSocket hop-by-hop headers
    ['keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding'].forEach(h => delete forwardHeaders[h]);

    const proxyReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: forwardPath,
      method: 'GET',
      headers: forwardHeaders,
      timeout: PROXY_TIMEOUT_MS
    });

    // Handle timeout
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      socket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      socket.destroy();
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      // Send the upgrade response back to the client
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

      // Write any buffered head data
      if (proxyHead && proxyHead.length > 0) {
        socket.write(proxyHead);
      }
      if (head && head.length > 0) {
        proxySocket.write(head);
      }

      // Bidirectional pipe
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      // Clean up on close/error
      socket.on('error', () => proxySocket.destroy());
      proxySocket.on('error', () => socket.destroy());
      socket.on('close', () => proxySocket.destroy());
      proxySocket.on('close', () => socket.destroy());
    });

    proxyReq.on('response', (proxyRes) => {
      // Target didn't upgrade — forward the error response
      let responseHead = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (Array.isArray(value)) {
          value.forEach(v => { responseHead += `${key}: ${v}\r\n`; });
        } else {
          responseHead += `${key}: ${value}\r\n`;
        }
      }
      responseHead += '\r\n';
      socket.write(responseHead);
      proxyRes.pipe(socket);
    });

    proxyReq.on('error', (err) => {
      console.error(`WebSocket proxy error for ${proxy.name}:`, err.message);
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    });

    proxyReq.end();
  });
}
