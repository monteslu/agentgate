// Agents routes
import { Router } from 'express';
import { join } from 'path';
import { writeFileSync } from 'fs';
import crypto from 'crypto';
import { listApiKeys, createApiKey, deleteApiKey, regenerateApiKey, updateAgentWebhook, updateAgentBio, getApiKeyById, getAvatarsDir, getAvatarFilename, deleteAgentAvatar, setAgentEnabled, setAgentRawResults, updateGatewayProxy, regenerateProxyId, getAgentDataCounts, getAgentServiceAccess, listMcpSessions, updateChannel, disableChannel } from '../../lib/db.js';
import { escapeHtml, formatDate, renderAvatar } from './shared.js';
import { renderPage } from '../../lib/render.js';

const router = Router();

// Agents Management
router.get('/', (req, res) => {
  const keys = listApiKeys();
  renderPage(res, 'pages/keys', {
    title: 'Agents',
    includeSocket: true,
    keys,
    error: null,
    newKey: null,
    escapeHtml,
    formatDate,
    renderAvatar
  });
});

// Agent details page
router.get('/:id', (req, res, next) => {
  const { id } = req.params;
  // Skip if this looks like a sub-route (avatar, counts, etc.)
  if (id === 'create' || id === 'avatar') {
    return next();
  }
  const agent = getApiKeyById(id);
  if (!agent) {
    return renderPage(res, 'pages/service-not-found', {
      title: 'Agent Not Found',
      includeSocket: true,
      message: `The agent with ID "${escapeHtml(String(id))}" does not exist.`
    });
  }
  const counts = getAgentDataCounts(agent.name);
  const serviceAccess = getAgentServiceAccess(agent.name);
  // Generate admin chat token if channel is enabled
  const adminChatToken = agent.channel_enabled ? generateAdminChatToken(agent.channel_id) : null;
  renderPage(res, 'pages/key-detail', {
    title: agent.name + ' - Agent Details',
    includeSocket: true,
    includeMarkdown: !!agent.channel_enabled,
    agent,
    counts,
    serviceAccess,
    adminChatToken,
    escapeHtml,
    formatDate,
    renderAvatar,
    getServiceIcon,
    getServiceDisplayName,
    getChatScript
  });
});

router.post('/create', async (req, res) => {
  const { name } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  if (!name || !name.trim()) {
    if (wantsJson) {
      return res.status(400).json({ error: 'Name is required' });
    }
    return renderPage(res, 'pages/keys', {
      title: 'Agents',
      includeSocket: true,
      keys: listApiKeys(),
      error: 'Name is required',
      newKey: null,
      escapeHtml,
      formatDate,
      renderAvatar
    });
  }

  const newKey = await createApiKey(name.trim());
  const keys = listApiKeys();

  if (wantsJson) {
    return res.json({ success: true, key: newKey.key, keyPrefix: newKey.keyPrefix, name: newKey.name, keys });
  }
  renderPage(res, 'pages/keys', {
    title: 'Agents',
    includeSocket: true,
    keys,
    error: null,
    newKey,
    escapeHtml,
    formatDate,
    renderAvatar
  });
});

// Get agent data counts for delete warning
router.get('/:id/counts', (req, res) => {
  const { id } = req.params;
  const agent = getApiKeyById(id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const counts = getAgentDataCounts(agent.name);
  res.json({ name: agent.name, counts });
});

router.post('/:id/delete', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  deleteApiKey(id);
  const keys = listApiKeys();

  if (wantsJson) {
    return res.json({ success: true, keys });
  }
  res.redirect('/ui/keys');
});

router.post('/:id/webhook', (req, res) => {
  const { id } = req.params;
  const { webhook_url, webhook_token } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const agent = getApiKeyById(id);
  if (!agent) {
    return wantsJson
      ? res.status(404).json({ error: 'Agent not found' })
      : res.status(404).send('Agent not found');
  }

  updateAgentWebhook(id, webhook_url, webhook_token);
  const keys = listApiKeys();

  if (wantsJson) {
    return res.json({ success: true, keys });
  }
  res.redirect('/ui/keys');
});

// Update agent bio
router.post('/:id/bio', (req, res) => {
  const { id } = req.params;
  const { bio } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const agent = getApiKeyById(id);
  if (!agent) {
    return wantsJson
      ? res.status(404).json({ error: 'Agent not found' })
      : res.status(404).send('Agent not found');
  }

  updateAgentBio(id, bio);
  const keys = listApiKeys();

  if (wantsJson) {
    return res.json({ success: true, keys });
  }
  res.redirect('/ui/keys');
});

// Test webhook
router.post('/:id/test-webhook', async (req, res) => {
  const { id } = req.params;
  const agent = getApiKeyById(id);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  if (!agent.webhook_url) {
    return res.status(400).json({ error: 'No webhook URL configured for this agent' });
  }

  const payload = {
    text: `🧪 [agentgate] Webhook test for ${agent.name} - if you see this, your webhook is working!`,
    mode: 'now',
    test: true
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (agent.webhook_token) {
      headers['Authorization'] = `Bearer ${agent.webhook_token}`;
    }

    const response = await fetch(agent.webhook_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const responseText = await response.text().catch(() => '');

    if (response.ok) {
      return res.json({
        success: true,
        status: response.status,
        message: `Webhook test successful (HTTP ${response.status})`
      });
    } else {
      return res.json({
        success: false,
        status: response.status,
        message: `Webhook returned HTTP ${response.status}`,
        response: responseText.substring(0, 500)
      });
    }
  } catch (err) {
    return res.json({
      success: false,
      status: 0,
      message: `Connection failed: ${err.message}`
    });
  }
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  deleteApiKey(id);
  const keys = listApiKeys();

  if (wantsJson) {
    return res.json({ success: true, keys });
  }
  res.redirect('/ui/keys');
});

// Regenerate API key
router.post('/:id/regenerate', async (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const agent = getApiKeyById(id);
  if (!agent) {
    return wantsJson
      ? res.status(404).json({ error: 'Agent not found' })
      : res.status(404).send('Agent not found');
  }

  try {
    const newKey = await regenerateApiKey(id);
    const keys = listApiKeys();

    if (wantsJson) {
      return res.json({ success: true, key: newKey.key, keyPrefix: newKey.keyPrefix, name: newKey.name, keys });
    }
    renderPage(res, 'pages/keys', {
      title: 'Agents',
      includeSocket: true,
      keys,
      error: null,
      newKey,
      escapeHtml,
      formatDate,
      renderAvatar
    });
  } catch (err) {
    console.error('Key regeneration error:', err);
    if (wantsJson) {
      return res.status(500).json({ error: err.message || 'Failed to regenerate key' });
    }
    renderPage(res, 'pages/keys', {
      title: 'Agents',
      includeSocket: true,
      keys: listApiKeys(),
      error: err.message || 'Failed to regenerate key',
      newKey: null,
      escapeHtml,
      formatDate,
      renderAvatar
    });
  }
});


// Toggle agent enabled status
router.post('/:id/toggle-enabled', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const agent = getApiKeyById(id);
  if (!agent) {
    return wantsJson
      ? res.status(404).json({ error: 'Agent not found' })
      : res.status(404).send('Agent not found');
  }

  const newEnabled = agent.enabled === 0 ? 1 : 0;
  setAgentEnabled(id, newEnabled);

  const keys = listApiKeys();
  if (wantsJson) {
    return res.json({ success: true, enabled: newEnabled === 1, keys });
  }
  res.redirect('/ui/agents');
});

// Toggle agent raw_results setting
router.post('/:id/toggle-raw-results', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const agent = getApiKeyById(id);
  if (!agent) {
    return wantsJson
      ? res.status(404).json({ error: 'Agent not found' })
      : res.status(404).send('Agent not found');
  }

  const newRawResults = agent.raw_results ? 0 : 1;
  setAgentRawResults(id, newRawResults);

  if (wantsJson) {
    return res.json({ success: true, raw_results: newRawResults === 1 });
  }
  res.redirect('/ui/keys/' + id);
});

// Avatar routes

// Get avatar for an agent by name
router.get('/avatar/:name', (req, res) => {
  const { name } = req.params;
  const filename = getAvatarFilename(name);

  if (filename) {
    const filepath = join(getAvatarsDir(), filename);
    return res.sendFile(filepath);
  }

  // Return 404 - client should handle with fallback/initials
  res.status(404).send('Avatar not found');
});

// Upload avatar for an agent (by id)
router.post('/:id/avatar', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const agent = getApiKeyById(id);
  if (!agent) {
    return wantsJson
      ? res.status(404).json({ error: 'Agent not found' })
      : res.status(404).send('Agent not found');
  }

  // Check if file was uploaded
  if (!req.body || !req.body.avatar) {
    return wantsJson
      ? res.status(400).json({ error: 'No avatar data provided' })
      : res.status(400).send('No avatar data provided');
  }

  try {
    // Expect base64 encoded image with data URI prefix
    const avatarData = req.body.avatar;
    const matches = avatarData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);

    if (!matches) {
      return wantsJson
        ? res.status(400).json({ error: 'Invalid image format. Use base64 data URI.' })
        : res.status(400).send('Invalid image format');
    }

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // Size limit: 500KB
    if (buffer.length > 500 * 1024) {
      return wantsJson
        ? res.status(400).json({ error: 'Avatar too large. Maximum size is 500KB.' })
        : res.status(400).send('Avatar too large');
    }

    // Delete any existing avatar for this agent
    deleteAgentAvatar(agent.name);

    // Save new avatar
    const safeName = agent.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const filename = `${safeName}.${ext}`;
    const filepath = join(getAvatarsDir(), filename);
    writeFileSync(filepath, buffer);

    if (wantsJson) {
      return res.json({ success: true, filename, url: `/ui/keys/avatar/${encodeURIComponent(agent.name)}` });
    }
    res.redirect('/ui/keys');
  } catch (err) {
    console.error('Avatar upload error:', err);
    return wantsJson
      ? res.status(500).json({ error: 'Failed to save avatar' })
      : res.status(500).send('Failed to save avatar');
  }
});

// Delete avatar for an agent
router.delete('/:id/avatar', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const agent = getApiKeyById(id);
  if (!agent) {
    return wantsJson
      ? res.status(404).json({ error: 'Agent not found' })
      : res.status(404).send('Agent not found');
  }

  deleteAgentAvatar(agent.name);

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/keys');
});

// Gateway proxy configuration
router.post('/:id/proxy', (req, res) => {
  const { id } = req.params;
  const { proxy_enabled, proxy_url } = req.body;

  const agent = getApiKeyById(id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const enabled = proxy_enabled === 'on' || proxy_enabled === '1' || proxy_enabled === true;
  updateGatewayProxy(id, enabled, proxy_url);
  const updated = getApiKeyById(id);

  res.json({
    success: true,
    proxy_enabled: !!updated.gateway_proxy_enabled,
    proxy_id: updated.gateway_proxy_id,
    proxy_url: updated.gateway_proxy_url
  });
});

// Regenerate proxy ID
router.post('/:id/regenerate-proxy', (req, res) => {
  const { id } = req.params;

  const agent = getApiKeyById(id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const newProxyId = regenerateProxyId(id);
  res.json({ success: true, proxy_id: newProxyId });
});

// Channel WebSocket management
router.post('/:id/channel', async (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body;
  const agent = getApiKeyById(id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  if (enabled) {
    const channelKey = crypto.randomBytes(24).toString('base64url');
    const result = await updateChannel(id, true, channelKey);
    res.json({ success: true, channel_id: result.channelId, channel_key: channelKey });
  } else {
    disableChannel(id);
    res.json({ success: true, disabled: true });
  }
});

router.post('/:id/channel/regenerate', async (req, res) => {
  const { id } = req.params;
  const agent = getApiKeyById(id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!agent.channel_enabled) return res.status(400).json({ error: 'Channel not enabled' });

  const channelKey = crypto.randomBytes(24).toString('base64url');
  const result = await updateChannel(id, true, channelKey);
  res.json({ success: true, channel_id: result.channelId, channel_key: channelKey });
});

// Sessions routes for agent detail page
// Uses dynamic import to avoid circular dependency with mcp.js
router.get('/:id/sessions', async (req, res) => {
  const { id } = req.params;
  const agent = getApiKeyById(id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const { getActiveSessionsInfo } = await import('../mcp.js');
  const activeSessionsList = getActiveSessionsInfo().filter(
    s => s.agentName.toLowerCase() === agent.name.toLowerCase()
  );
  const dbSessions = listMcpSessions(agent.name);

  // Merge: use active session info where available, fall back to DB
  const sessionMap = new Map();
  for (const dbS of dbSessions) {
    sessionMap.set(dbS.session_id, {
      sessionId: dbS.session_id,
      agentName: dbS.agent_name,
      createdAt: dbS.created_at,
      lastSeen: dbS.last_seen_at,
      active: false
    });
  }
  for (const activeS of activeSessionsList) {
    const existing = sessionMap.get(activeS.sessionId) || {};
    sessionMap.set(activeS.sessionId, {
      sessionId: activeS.sessionId,
      agentName: activeS.agentName,
      createdAt: activeS.createdAt || existing.createdAt || null,
      lastSeen: activeS.lastSeen,
      active: true
    });
  }

  res.json({ sessions: Array.from(sessionMap.values()) });
});

router.post('/:id/sessions/:sessionId/kill', async (req, res) => {
  const { id, sessionId } = req.params;
  const agent = getApiKeyById(id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const { killSession } = await import('../mcp.js');
  const result = killSession(sessionId);
  res.json({ success: true, found: result.found });
});

router.post('/:id/sessions/kill-all', async (req, res) => {
  const { id } = req.params;
  const agent = getApiKeyById(id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const { killAgentSessions } = await import('../mcp.js');
  const result = killAgentSessions(agent.name);
  res.json({ success: true, killed: result.killed });
});

// Admin chat token store (short-lived tokens for auto-connect)
const adminChatTokens = new Map();
const ADMIN_TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

function generateAdminChatToken(channelId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + ADMIN_TOKEN_TTL;
  adminChatTokens.set(token, { channelId, expires });
  // Cleanup expired tokens periodically
  if (adminChatTokens.size > 100) {
    const now = Date.now();
    for (const [k, v] of adminChatTokens) {
      if (v.expires < now) adminChatTokens.delete(k);
    }
  }
  return token;
}

function validateAdminChatToken(token, channelId) {
  const entry = adminChatTokens.get(token);
  if (!entry) return false;
  if (entry.expires < Date.now()) {
    adminChatTokens.delete(token);
    return false;
  }
  if (entry.channelId !== channelId) return false;
  adminChatTokens.delete(token); // One-time use
  return true;
}

// Export for channel.js to use
export { validateAdminChatToken };

// Chat popout window - standalone page, NOT through layout
router.get('/:id/chat', (req, res) => {
  const { id } = req.params;
  const agent = getApiKeyById(id);
  if (!agent) {
    return res.status(404).send('Agent not found');
  }
  if (!agent.channel_enabled) {
    return res.status(400).send('Channel not enabled for this agent');
  }
  // Generate one-time admin token for auto-connect
  const adminToken = generateAdminChatToken(agent.channel_id);
  res.send(renderChatPopout(agent, adminToken));
});

// Shared chat script - fixes XSS, adds message limit, deduplicates code
function getChatScript() {
  return `
    const MAX_MESSAGE_LENGTH = 10240; // 10KB limit

    // Configure marked for safe rendering
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false
      });
    }

    // Safe markdown renderer using marked library with DOMPurify
    function renderMarkdown(text) {
      if (!text) return '';

      // Use marked if available, otherwise basic escaping
      if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        const html = marked.parse(text);
        return DOMPurify.sanitize(html, {
          ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'del', 'span', 'div'],
          ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
          ALLOW_DATA_ATTR: false,
          ADD_ATTR: ['target'],
          FORCE_BODY: true,
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i
        });
      }

      // Fallback: basic escaping
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\\\\n/g, '<br>');
    }

    function createChatController(channelId, opts) {
      opts = opts || {};
      let ws = null;
      let reconnectAttempts = 0;
      const maxReconnectAttempts = 3;

      // Streaming state
      let streamingContent = '';
      let streamingMessageId = null;

      const controller = {
        onStatus: opts.onStatus || function() {},
        onMessage: opts.onMessage || function() {},
        onChunk: opts.onChunk || function() {},
        onStreamEnd: opts.onStreamEnd || function() {},
        onConnected: opts.onConnected || function() {},
        onDisconnected: opts.onDisconnected || function() {},

        connect: function(authKey, authType) {
          if (ws) ws.close();

          const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsUrl = protocol + '//' + location.host + '/channel/' + channelId;

          controller.onStatus('Connecting...', 'pending');
          ws = new WebSocket(wsUrl);

          ws.onopen = function() {
            controller.onStatus('Authenticating...', 'pending');
            const authMsg = { type: 'auth' };
            if (authType === 'admin') {
              authMsg.adminToken = authKey;
            } else {
              authMsg.key = authKey;
            }
            ws.send(JSON.stringify(authMsg));
          };

          ws.onmessage = function(e) {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === 'auth') {
                if (msg.success) {
                  controller.onStatus('Connected', 'connected');
                  reconnectAttempts = 0;
                  controller.onConnected();
                } else {
                  controller.onStatus('Auth failed: ' + (msg.error || 'Invalid credentials'), 'error');
                }
              } else if (msg.type === 'chunk') {
                const chunk = msg.content || msg.text || '';
                streamingContent += chunk;
                if (!streamingMessageId) {
                  streamingMessageId = 'stream-' + Date.now();
                }
                controller.onChunk(streamingContent, streamingMessageId, msg.timestamp);
              } else if (msg.type === 'done') {
                const finalContent = msg.content || streamingContent;
                controller.onStreamEnd(finalContent, streamingMessageId, msg.timestamp);
                streamingContent = '';
                streamingMessageId = null;
              } else if (msg.type === 'message' || msg.type === 'response') {
                const content = msg.content || msg.text || msg.message || JSON.stringify(msg);
                controller.onMessage('agent', content, msg.timestamp);
              } else if (msg.type === 'error') {
                controller.onMessage('agent', '⚠️ ' + (msg.error || msg.message || 'Unknown error'));
              }
            } catch (err) {
              console.error('Chat message parse error:', err);
            }
          };

          ws.onclose = function() {
            controller.onStatus('Disconnected', 'error');
            controller.onDisconnected();
            streamingContent = '';
            streamingMessageId = null;
          };

          ws.onerror = function() {
            controller.onStatus('Connection error', 'error');
          };
        },

        send: function(text) {
          if (!text || !ws || ws.readyState !== WebSocket.OPEN) return false;
          if (text.length > MAX_MESSAGE_LENGTH) {
            controller.onMessage('system', '⚠️ Message too long (max ' + Math.round(MAX_MESSAGE_LENGTH/1024) + 'KB)');
            return false;
          }
          ws.send(JSON.stringify({ type: 'send', content: text }));
          return true;
        },

        close: function() {
          if (ws) ws.close();
        }
      };

      return controller;
    }
  `;
}

function renderChatPopout(agent, adminToken) {
  const channelId = escapeHtml(agent.channel_id || '');
  const agentName = escapeHtml(agent.name);
  const safeAdminToken = escapeHtml(adminToken || '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chat - ${agentName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg, #0a0a0a); color: var(--text-primary, #e5e5e5); height: 100vh; display: flex; flex-direction: column; }
    .header { padding: 12px 16px; background: var(--bg-surface, #1a1a1a); border-bottom: 1px solid var(--border-default, #333333); display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 16px; font-weight: 600; }
    .status { font-size: 12px; color: var(--text-dim, #6b7280); }
    .status.connected { color: var(--primary-light, #34d399); }
    .status.pending { color: var(--warning-light, #fbbf24); }
    .status.error { color: var(--danger, #ef4444); }
    #messages { flex: 1; overflow-y: auto; padding: 16px; font-family: monospace; font-size: 13px; }
    .message { margin-bottom: 12px; }
    .input-area { padding: 12px 16px; background: var(--bg-surface, #1a1a1a); border-top: 1px solid var(--border-default, #333333); display: flex; gap: 8px; }
    .input-area input { flex: 1; padding: 10px 14px; background: var(--bg-input, #252525); border: 1px solid var(--border-input, #333333); border-radius: 6px; color: var(--text-primary, #e5e5e5); font-size: 14px; outline: none; }
    .input-area input:focus { border-color: #60a5fa; }
    .input-area button { padding: 10px 20px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; }
    .input-area button:hover { background: #2563eb; }
    .input-area button:disabled { background: #4b5563; cursor: not-allowed; }
    .streaming { opacity: 0.8; }
    .streaming::after { content: '▊'; animation: blink 1s infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    #messages pre { background: var(--bg-surface, #1a1a1a); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
    #messages code { background: #374151; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    #messages pre code { background: none; padding: 0; }
    #messages table { border-collapse: collapse; margin: 8px 0; width: 100%; }
    #messages th, #messages td { border: 1px solid #4b5563; padding: 8px; text-align: left; }
    #messages th { background: var(--bg-surface, #1a1a1a); }
    #messages blockquote { border-left: 3px solid #4b5563; margin: 8px 0; padding-left: 12px; color: #9ca3af; }
    #messages a { color: #60a5fa; }
    #messages ul, #messages ol { margin: 8px 0; padding-left: 24px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
</head>
<body>
  <div class="header">
    <h1>💬 ${agentName}</h1>
    <span id="status" class="status">Connecting...</span>
  </div>
  <div id="messages">
    <p class="text-dim-center">Connecting to agent...</p>
  </div>
  <div class="input-area">
    <input type="text" id="chat-input" placeholder="Type a message..." maxlength="10240" disabled>
    <button id="send-btn" disabled>Send</button>
  </div>
  <script>
    ${getChatScript()}

    const channelId = '${channelId}';
    const adminToken = '${safeAdminToken}';

    const statusEl = document.getElementById('status');
    const messagesDiv = document.getElementById('messages');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');

    function addMessage(role, content, timestamp) {
      const div = document.createElement('div');
      div.className = 'message';
      const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
      const roleClass = role === 'user' ? 'role-user' : (role === 'system' ? 'role-system' : 'role-agent');
      const roleLabel = role === 'user' ? 'You' : (role === 'system' ? 'System' : 'Agent');
      div.innerHTML = '<div class="' + roleClass + ' role-label">' + roleLabel + ' <span class="subheading-dim">' + time + '</span></div><div class="text-primary-color">' + renderMarkdown(content) + '</div>';
      messagesDiv.appendChild(div);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function handleChunk(content, messageId, timestamp) {
      let div = document.getElementById(messageId);
      if (!div) {
        div = document.createElement('div');
        div.id = messageId;
        div.className = 'message streaming';
        const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
        div.innerHTML = '<div class="role-label text-success">Agent <span class="subheading-dim">' + time + '</span></div><div class="content text-primary-color"></div>';
        messagesDiv.appendChild(div);
      }
      const contentDiv = div.querySelector('.content');
      if (contentDiv) {
        contentDiv.innerHTML = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>');
      }
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function handleStreamEnd(content, messageId, timestamp) {
      let div = document.getElementById(messageId);
      if (div) {
        div.className = 'message';
        const contentDiv = div.querySelector('.content');
        if (contentDiv) {
          contentDiv.innerHTML = renderMarkdown(content);
        }
      } else {
        addMessage('agent', content, timestamp);
      }
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    const chat = createChatController(channelId, {
      onStatus: function(text, cls) {
        statusEl.textContent = text;
        statusEl.className = 'status ' + (cls || '');
      },
      onMessage: addMessage,
      onChunk: handleChunk,
      onStreamEnd: handleStreamEnd,
      onConnected: function() {
        messagesDiv.innerHTML = '<p class="text-success-center">✓ Connected to agent</p>';
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.focus();
      },
      onDisconnected: function() {
        chatInput.disabled = true;
        sendBtn.disabled = true;
      }
    });

    function sendMessage() {
      const text = chatInput.value.trim();
      if (!text) return;
      if (chat.send(text)) {
        addMessage('user', text);
        chatInput.value = '';
      }
    }

    sendBtn.onclick = sendMessage;
    chatInput.onkeydown = function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };

    chat.connect(adminToken, 'admin');
  </script>
</body>
</html>`;
}

function getServiceIcon(service) {
  const icons = {
    github: '/public/icons/github.svg',
    bluesky: '/public/icons/bluesky.svg',
    mastodon: '/public/icons/mastodon.svg',
    reddit: '/public/icons/reddit.svg',
    google_calendar: '/public/icons/google-calendar.svg',
    youtube: '/public/icons/youtube.svg',
    linkedin: '/public/icons/linkedin.svg',
    jira: '/public/icons/jira.svg',
    fitbit: '/public/icons/fitbit.svg',
    brave: '/public/icons/brave.svg',
    google_search: '/public/icons/google-search.svg'
  };
  return icons[service] || '/public/favicon.svg';
}

function getServiceDisplayName(service) {
  const names = {
    github: 'GitHub',
    bluesky: 'Bluesky',
    mastodon: 'Mastodon',
    reddit: 'Reddit',
    google_calendar: 'Calendar',
    youtube: 'YouTube',
    linkedin: 'LinkedIn',
    jira: 'Jira',
    fitbit: 'Fitbit',
    brave: 'Brave',
    google_search: 'Google Search'
  };
  return names[service] || service;
}

export default router;
