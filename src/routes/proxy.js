import { getGatewayProxy } from '../lib/db.js';
import http from 'http';
import https from 'https';

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

    // Build forwarded headers — pass through most, update host
    const forwardHeaders = { ...req.headers };
    forwardHeaders.host = parsed.host;
    delete forwardHeaders['connection'];

    const proxyReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: forwardPath,
      method: req.method,
      headers: forwardHeaders
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
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

    // Build the WebSocket upgrade request to the target
    const forwardHeaders = { ...req.headers };
    forwardHeaders.host = parsed.host;

    const proxyReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: forwardPath,
      method: 'GET',
      headers: forwardHeaders
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
