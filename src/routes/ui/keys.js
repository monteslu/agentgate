// Agents routes
import { Router } from 'express';
import { join } from 'path';
import { writeFileSync } from 'fs';
import crypto from 'crypto';
import { listApiKeys, createApiKey, deleteApiKey, regenerateApiKey, updateAgentWebhook, updateAgentBio, getApiKeyById, getAvatarsDir, getAvatarFilename, deleteAgentAvatar, setAgentEnabled, setAgentRawResults, updateGatewayProxy, regenerateProxyId, getAgentDataCounts, getAgentServiceAccess, listMcpSessions, updateChannel, disableChannel } from '../../lib/db.js';
import { escapeHtml, formatDate, htmlHead, navHeader, socketScript, localizeScript, menuScript, renderAvatar } from './shared.js';

const router = Router();

// Agents Management
router.get('/', (req, res) => {
  const keys = listApiKeys();
  res.send(renderKeysPage(keys));
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
    return res.status(404).send(renderAgentNotFound(id));
  }
  const counts = getAgentDataCounts(agent.name);
  const serviceAccess = getAgentServiceAccess(agent.name);
  // Generate admin chat token if channel is enabled
  const adminChatToken = agent.channel_enabled ? generateAdminChatToken(agent.channel_id) : null;
  res.send(renderAgentDetailPage(agent, counts, serviceAccess, adminChatToken));
});

router.post('/create', async (req, res) => {
  const { name } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  if (!name || !name.trim()) {
    return wantsJson
      ? res.status(400).json({ error: 'Name is required' })
      : res.send(renderKeysPage(listApiKeys(), 'Name is required'));
  }

  const newKey = await createApiKey(name.trim());
  const keys = listApiKeys();

  if (wantsJson) {
    return res.json({ success: true, key: newKey.key, keyPrefix: newKey.keyPrefix, name: newKey.name, keys });
  }
  res.send(renderKeysPage(keys, null, newKey));
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
    res.send(renderKeysPage(keys, null, newKey));
  } catch (err) {
    console.error('Key regeneration error:', err);
    return wantsJson
      ? res.status(500).json({ error: err.message || 'Failed to regenerate key' })
      : res.send(renderKeysPage(listApiKeys(), err.message || 'Failed to regenerate key'));
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

// Chat popout window
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

// Render function
function renderKeysPage(keys, error = null, newKey = null) {
  const renderKeyRow = (k) => `
    <tr id="key-${k.id}" class="${k.enabled === 0 ? 'agent-disabled' : ''}">
      <td>
        <div class="agent-with-avatar">
          ${renderAvatar(k.name, { size: 32 })}
          <strong>${escapeHtml(k.name)}</strong>
          <span class="status-disabled${k.enabled === 0 ? '' : ' d-none'}">Disabled</span>
        </div>
      </td>
      <td>${formatDate(k.created_at)}</td>
      <td class="whitespace-nowrap">
        <label class="toggle">
          <input type="checkbox" ${k.enabled ? 'checked' : ''} onchange="toggleEnabled('${k.id}', this)" autocomplete="off">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td>
        <a href="/ui/keys/${k.id}" class="btn-sm">Details</a>
      </td>
    </tr>
  `;

  return `${htmlHead('Agents', { includeSocket: true })}
  
  
</head>
<body>
  ${navHeader()}

  ${error ? `<div class="error-message">${escapeHtml(error)}</div>` : ''}

  ${newKey ? `
    <div class="new-key-banner">
      <strong>New API key created!</strong> Copy it now - you won't be able to see it again.
      <code>${newKey.key}</code>
      <button type="button" class="btn-sm btn-primary" onclick="copyKey('${newKey.key}', this)" class="mt-8">Copy to Clipboard</button>
    </div>
  ` : ''}

  <form method="POST" action="/ui/keys/create" class="add-agent-box">
    <label>New Agent</label>
    <input type="text" name="name" placeholder="e.g., johnny-5, clawdbot, Her, Hal" required autocomplete="off">
    <button type="submit" class="btn-primary">Create</button>
  </form>

  <div class="card">
    <h3>Agents (${keys.length})</h3>
    ${keys.length === 0 ? `
      <p class="text-dim-center p-20">No agents yet. Create one above.</p>
    ` : `
      <table class="agents-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Created</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${keys.map(renderKeyRow).join('')}
        </tbody>
      </table>
    `}
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function showToast(msg, type) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast ' + type + ' show';
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    function copyKey(key, btn) {
      navigator.clipboard.writeText(key).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    async function toggleEnabled(id, checkbox) {
      checkbox.disabled = true;
      try {
        const res = await fetch('/ui/keys/' + id + '/toggle-enabled', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
          const row = document.getElementById('key-' + id);
          const badge = row.querySelector('.status-disabled');
          if (data.enabled) {
            row.classList.remove('agent-disabled');
            badge.style.display = 'none';
          } else {
            row.classList.add('agent-disabled');
            badge.style.display = '';
          }
        } else {
          checkbox.checked = !checkbox.checked;
          showToast(data.error || 'Failed to toggle', 'error');
        }
      } catch (err) {
        checkbox.checked = !checkbox.checked;
        showToast('Network error', 'error');
      }
      checkbox.disabled = false;
    }
  </script>
${socketScript()}
${menuScript()}
${localizeScript()}
</body>
</html>`;
}

function renderAgentNotFound(id) {
  return `${htmlHead('Agent Not Found', { includeSocket: true })}
<body>
  ${navHeader()}
  <div class="card text-center p-40">
    <h2>Agent Not Found</h2>
    <p class="text-muted">The agent with ID "${escapeHtml(String(id))}" does not exist.</p>
    <a href="/ui/keys" class="btn-primary inline-block mt-16">Back to Agents</a>
  </div>
  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
</body>
</html>`;
}

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
          // Only allow safe URL schemes
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))/i
        });
      }
      
      // Fallback: basic escaping
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\\n/g, '<br>');
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
        onChunk: opts.onChunk || function() {},       // Streaming chunk
        onStreamEnd: opts.onStreamEnd || function() {}, // Stream complete
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
                // Streaming: accumulate chunks
                const chunk = msg.content || msg.text || '';
                streamingContent += chunk;
                if (!streamingMessageId) {
                  streamingMessageId = 'stream-' + Date.now();
                }
                controller.onChunk(streamingContent, streamingMessageId, msg.timestamp);
              } else if (msg.type === 'done') {
                // Streaming complete: finalize with full markdown render
                const finalContent = msg.content || streamingContent;
                controller.onStreamEnd(finalContent, streamingMessageId, msg.timestamp);
                streamingContent = '';
                streamingMessageId = null;
              } else if (msg.type === 'message' || msg.type === 'response') {
                // Non-streaming message
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
            // Reset streaming state on disconnect
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg, #111827); color: var(--text-primary, #f3f4f6); height: 100vh; display: flex; flex-direction: column; }
    .header { padding: 12px 16px; background: var(--bg-surface, #1f2937); border-bottom: 1px solid var(--border-default, #374151); display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 16px; font-weight: 600; }
    .status { font-size: 12px; color: var(--text-dim, #6b7280); }
    .status.connected { color: var(--primary-light, #34d399); }
    .status.pending { color: var(--warning-light, #fbbf24); }
    .status.error { color: var(--danger, #ef4444); }
    #messages { flex: 1; overflow-y: auto; padding: 16px; font-family: monospace; font-size: 13px; }
    .message { margin-bottom: 12px; }
    .input-area { padding: 12px 16px; background: var(--bg-surface, #1f2937); border-top: 1px solid var(--border-default, #374151); display: flex; gap: 8px; }
    .input-area input { flex: 1; padding: 10px 14px; background: var(--bg-input, #374151); border: 1px solid var(--border-input, #4b5563); border-radius: 6px; color: var(--text-primary, #f3f4f6); font-size: 14px; outline: none; }
    .input-area input:focus { border-color: #60a5fa; }
    .input-area button { padding: 10px 20px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; }
    .input-area button:hover { background: #2563eb; }
    .input-area button:disabled { background: #4b5563; cursor: not-allowed; }
    .streaming { opacity: 0.8; }
    .streaming::after { content: '▊'; animation: blink 1s infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    /* Markdown styles */
    #messages pre { background: var(--bg-surface, #1f2937); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
    #messages code { background: #374151; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    #messages pre code { background: none; padding: 0; }
    #messages table { border-collapse: collapse; margin: 8px 0; width: 100%; }
    #messages th, #messages td { border: 1px solid #4b5563; padding: 8px; text-align: left; }
    #messages th { background: var(--bg-surface, #1f2937); }
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

    // Handle streaming chunks - update or create streaming message div
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
      // Update content with partial markdown (basic escaping during stream)
      const contentDiv = div.querySelector('.content');
      if (contentDiv) {
        contentDiv.innerHTML = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>');
      }
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    // Handle stream end - finalize with full markdown render
    function handleStreamEnd(content, messageId, timestamp) {
      let div = document.getElementById(messageId);
      if (div) {
        div.className = 'message'; // Remove streaming class
        const contentDiv = div.querySelector('.content');
        if (contentDiv) {
          contentDiv.innerHTML = renderMarkdown(content);
        }
      } else {
        // Fallback: create new message if no streaming div exists
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

    // Auto-connect with admin token
    chat.connect(adminToken, 'admin');
  </script>
</body>
</html>`;
}

function renderAgentDetailPage(agent, counts, serviceAccess = [], adminChatToken = null) {
  return `${htmlHead(agent.name + ' - Agent Details', { includeSocket: true, includeMarkdown: agent.channel_enabled })}

<body>
  ${navHeader()}

  <div class="agent-header">
    <div class="avatar-large" id="avatar-clickable" title="Click to change avatar">
      ${renderAvatar(agent.name, { size: 64 })}
    </div>
    <h2>${escapeHtml(agent.name)}</h2>
    <div class="toggle-wrapper">
      <span class="toggle-label" id="toggle-label">${agent.enabled ? 'Enabled' : 'Disabled'}</span>
      <label class="toggle">
        <input type="checkbox" id="enabled-toggle" ${agent.enabled ? 'checked' : ''} autocomplete="off">
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="toggle-wrapper">
      <span class="toggle-label" id="raw-results-label">Raw Results <span class="help-hint" title="When enabled, this agent receives full upstream API responses by default. When disabled, responses are simplified to save tokens. Per-request override is still available via the raw parameter (MCP) or X-Agentgate-Raw header (REST).">?</span></span>
      <label class="toggle">
        <input type="checkbox" id="raw-results-toggle" ${agent.raw_results ? 'checked' : ''} autocomplete="off">
        <span class="toggle-slider"></span>
      </label>
    </div>
    <a href="/ui/keys" class="btn-secondary">← Back</a>
  </div>

  <div class="stats-row">
    <a href="/ui/messages" class="stat-box stat-link"><div class="stat-value">${counts.messages}</div><div class="stat-label">Messages</div></a>
    <a href="/ui/queue" class="stat-box stat-link"><div class="stat-value">${counts.queueEntries}</div><div class="stat-label">Queue</div></a>
    <a href="/ui/mementos?agent=${encodeURIComponent(agent.name)}" class="stat-box stat-link"><div class="stat-value">${counts.mementos}</div><div class="stat-label">Mementos</div></a>
    <a href="/ui/messages" class="stat-box stat-link"><div class="stat-value">${counts.broadcasts}</div><div class="stat-label">Broadcasts</div></a>
  </div>

  <div class="card">
    <div class="detail-section">
      <h3>Service Access</h3>
      ${serviceAccess.length === 0 ? '<p class="no-access">No services configured, or access denied to all.</p>' : `<div class="service-access-list">${serviceAccess.map(s => `<a href="/ui/services/${s.id}" class="service-chip"><img src="${getServiceIcon(s.service)}" alt="">${getServiceDisplayName(s.service)} / ${escapeHtml(s.account_name)}${s.bypass_auth ? '<span class="bypass-badge">bypass</span>' : ''}</a>`).join('')}</div>`}
    </div>
  </div>

  <div class="card">
    <div class="detail-section">
      <h3>API Key</h3>
      <div class="detail-row">
        <span class="label">Key Prefix</span>
        <span class="value">${escapeHtml(agent.key_prefix)}</span>
      </div>
      <div class="detail-row">
        <span class="label">Created</span>
        <span class="value">${formatDate(agent.created_at)}</span>
      </div>
      <div class="btn-row">
        <button type="button" class="btn-secondary" id="regen-btn">🔄 Regenerate Key</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="detail-section">
      <h3>Bio</h3>
      ${agent.bio ? `<div class="bio-text">${escapeHtml(agent.bio)}</div>` : '<p class="value muted">No bio set. The agent sees this via whoami.</p>'}
      <div class="btn-row">
        <button type="button" class="btn-secondary" id="bio-btn">Edit Bio</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="detail-section">
      <h3>Agent Notifications</h3>
      <div class="config-card">
        <h4><span class="status-dot ${agent.webhook_url ? 'active' : 'inactive'}"></span> Outbound Webhook</h4>
        ${agent.webhook_url ? `
          <div class="detail-row">
            <span class="label">URL</span>
            <span class="value text-xs break-all">${escapeHtml(agent.webhook_url)}</span>
          </div>
          <div class="detail-row">
            <span class="label">Token</span>
            <span class="value">${agent.webhook_token ? '••••••••' : 'Not set'}</span>
          </div>
        ` : '<p class="value muted">Not configured. Agent notifications send messages and queue updates to the agent\'s gateway.</p>'}
        <div class="btn-row">
          <button type="button" class="btn-secondary" id="webhook-btn">Configure</button>
          ${agent.webhook_url ? '<button type="button" class="btn-secondary" id="test-webhook-btn">Test</button>' : ''}
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="detail-section">
      <h3>Gateway Proxy</h3>
      <div class="config-card">
        <h4><span class="status-dot ${agent.gateway_proxy_enabled ? 'active' : 'inactive'}"></span> Proxy</h4>
        ${agent.gateway_proxy_enabled ? `
          <div class="detail-row">
            <span class="label">Internal URL</span>
            <span class="value text-xs">${escapeHtml(agent.gateway_proxy_url || 'Not set')}</span>
          </div>
          <div class="detail-row">
            <span class="label">HTTP Proxy URL</span>
            <span class="value" id="proxy-http-url" class="text-xs break-all"></span>
          </div>
          <div class="detail-row">
            <span class="label">WebSocket Proxy URL</span>
            <span class="value" id="proxy-ws-url" class="text-xs break-all"></span>
          </div>
          <div class="proxy-url-box">
            <code id="proxy-url"></code>
            <button type="button" class="btn-copy-sm" onclick="copyProxyUrl()">Copy</button>
          </div>
        ` : '<p class="value muted">Not enabled. Proxy exposes the agent\'s gateway through AgentGate.</p>'}
        <div class="btn-row">
          <button type="button" class="btn-secondary" id="proxy-btn">Configure</button>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="detail-section">
      <h3>Channel WebSocket</h3>
      <div class="config-card">
        <h4><span class="status-dot ${agent.channel_enabled ? 'active' : 'inactive'}"></span> Channel</h4>
        ${agent.channel_enabled ? `
          <div class="detail-row">
            <span class="label">Channel ID</span>
            <span class="value text-xs break-all">${escapeHtml(agent.channel_id || '')}</span>
          </div>
          <div class="detail-row">
            <span class="label">WebSocket URL</span>
            <span class="value" id="channel-ws-url" class="text-xs break-all"></span>
          </div>
          <div class="detail-row">
            <span class="label">Last Connected</span>
            <span class="value ${agent.channel_last_connected ? '' : 'muted'}">${agent.channel_last_connected ? formatDate(agent.channel_last_connected) : 'Never'}</span>
          </div>
          <div id="channel-key-display" class="d-none">
            <div class="proxy-url-box">
              <code id="channel-key-value"></code>
              <button type="button" class="btn-copy-sm" onclick="copyChannelKey()">Copy</button>
            </div>
            <p class="help-text text-warning">⚠️ Save this key — it won't be shown again.</p>
          </div>
          <div class="btn-row">
            <button type="button" class="btn-secondary" id="channel-regen-btn">🔑 Regenerate Key</button>
            <button type="button" class="btn-danger btn-sm" id="channel-disable-btn">Disable</button>
          </div>
        ` : `
          <p class="value muted">Not enabled. Channel provides a filtered WebSocket endpoint for chat clients.</p>
          <div class="btn-row">
            <button type="button" class="btn-primary" id="channel-enable-btn">Enable Channel</button>
          </div>
        `}
      </div>
    </div>
  </div>

  ${agent.channel_enabled ? `
  <div class="card" id="chat-card">
    <div class="detail-section">
      <h3 class="flex-center">
        💬 Admin Chat
        <span id="chat-status" class="ml-12 text-xs font-normal text-warning">Connecting...</span>
        <button type="button" class="btn-secondary btn-sm" id="chat-popout-btn" class="ml-auto text-xs">⧉ Popout</button>
      </h3>
      <div id="chat-messages" class="log-viewer">
        <p class="text-dim-center">Connecting to agent...</p>
      </div>
      <div class="flex gap-8">
        <input type="text" id="chat-input" placeholder="Type a message..." maxlength="10240" class="chat-input" disabled>
        <button type="button" class="btn-primary" id="chat-send-btn" disabled>Send</button>
      </div>
    </div>
  </div>
  <script>const ADMIN_CHAT_TOKEN = '${escapeHtml(adminChatToken || '')}';</script>
  ` : ''}

  <div class="card">
    <div class="detail-section">
      <h3>MCP Sessions</h3>
      <div id="sessions-container">
        <p class="text-muted">Loading sessions...</p>
      </div>
      <div class="btn-row">
        <button type="button" class="btn-secondary" id="refresh-sessions-btn">🔄 Refresh</button>
        <button type="button" class="btn-danger" id="kill-all-sessions-btn" class="d-none">Kill All Sessions</button>
      </div>
    </div>
  </div>

  <div class="danger-zone">
    <h3>Danger Zone</h3>
    <p>Deleting this agent will remove the API key and all associated data (${counts.messages} messages, ${counts.mementos} mementos, ${counts.queueEntries} queue entries).</p>
    <button type="button" class="btn-danger" id="delete-btn">Delete Agent</button>
  </div>

  <!-- Bio Modal -->
  <div id="bio-modal" class="modal-overlay">
    <div class="modal">
      <h3>Edit Bio</h3>
      <p class="description-muted">Describe this agent's role. Shown via <code>whoami</code>.</p>
      <textarea id="bio-text" rows="4" placeholder="e.g., You are a cybersecurity expert..." autocomplete="off">${escapeHtml(agent.bio || '')}</textarea>
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" onclick="closeModal('bio-modal')">Cancel</button>
        <button type="button" class="btn-primary" onclick="saveBio()">Save</button>
      </div>
    </div>
  </div>

  <!-- Webhook Modal -->
  <div id="webhook-modal" class="modal-overlay">
    <div class="modal">
      <h3>Configure Outbound Webhook</h3>
      <label>Notification URL</label>
      <input type="url" id="webhook-url" value="${escapeHtml(agent.webhook_url || '')}" placeholder="https://your-agent.com/webhook" autocomplete="off">
      <p class="help-text">Receives POST notifications for messages and queue updates</p>
      <label>Authorization Token (optional)</label>
      <input type="text" id="webhook-token" value="${escapeHtml(agent.webhook_token || '')}" placeholder="secret-token" autocomplete="off">
      <p class="help-text">Sent as Bearer token in Authorization header</p>
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" onclick="closeModal('webhook-modal')">Cancel</button>
        <button type="button" class="btn-primary" onclick="saveWebhook()">Save</button>
      </div>
    </div>
  </div>

  <!-- Proxy Modal -->
  <div id="proxy-modal" class="modal-overlay">
    <div class="modal">
      <h3>Configure Gateway Proxy</h3>
      <label class="flex-center gap-8 mb-16 cursor-pointer">
        <input type="checkbox" id="proxy-enabled" ${agent.gateway_proxy_enabled ? 'checked' : ''} class="w-auto m-0" autocomplete="off">
        <span>Enable gateway proxy <span class="help-hint" title="When enabled, this agent's own gateway becomes accessible through AgentGate via a proxy URL. Other agents can call this agent's gateway without direct network access.">?</span></span>
      </label>
      <div id="proxy-fields" style="${agent.gateway_proxy_enabled ? '' : 'display: none;'}">
        <label>Internal Gateway URL</label>
        <input type="url" id="proxy-url-input" value="${escapeHtml(agent.gateway_proxy_url || '')}" placeholder="http://localhost:18789" autocomplete="off">
        <p class="help-text">The internal URL of the agent's gateway <span class="help-hint" title="The URL where this agent's gateway is running locally, e.g. http://localhost:18789. AgentGate will forward proxy requests to this address.">?</span></p>
      </div>
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" onclick="closeModal('proxy-modal')">Cancel</button>
        <button type="button" class="btn-primary" onclick="saveProxy()">Save</button>
      </div>
    </div>
  </div>

  <!-- Regenerate Key Modal -->
  <div id="regen-modal" class="modal-overlay">
    <div class="modal">
      <h3>🔄 Regenerate API Key</h3>
      <div id="regen-confirm">
        <p class="warning-banner">
          ⚠️ This will immediately invalidate the current key. The agent will lose access until updated.
        </p>
        <div class="modal-buttons">
          <button type="button" class="btn-secondary" onclick="closeModal('regen-modal')">Cancel</button>
          <button type="button" class="btn-danger" onclick="confirmRegen()">Regenerate</button>
        </div>
      </div>
      <div id="regen-success" class="d-none">
        <p class="info-banner">
          ✅ Key regenerated! Copy it now - you won't see it again.
        </p>
        <div class="hash-display">
          <code id="new-key" class="text-success"></code>
        </div>
        <div class="modal-buttons">
          <button type="button" class="btn-primary" onclick="copyNewKey()">Copy</button>
          <button type="button" class="btn-secondary" onclick="location.reload()">Done</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Avatar Modal -->
  <div id="avatar-modal" class="modal-overlay">
    <div class="modal">
      <h3>Change Avatar</h3>
      <div class="text-center mb-16">
        <div id="avatar-preview" class="avatar-circle-lg">
          ${renderAvatar(agent.name, { size: 80 })}
        </div>
      </div>
      <input type="file" id="avatar-file" accept="image/png,image/jpeg,image/gif,image/webp" autocomplete="off">
      <p class="help-text">PNG, JPG, GIF, WebP. Max 500KB.</p>
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" onclick="closeModal('avatar-modal')">Cancel</button>
        <button type="button" class="btn-danger" id="avatar-delete-btn" onclick="deleteAvatar()" style="${agent.name ? '' : 'display:none;'}">Delete</button>
        <button type="button" class="btn-primary" id="avatar-upload-btn" onclick="uploadAvatar()" disabled>Upload</button>
      </div>
    </div>
  </div>

  <!-- Delete Confirmation Modal -->
  <div id="delete-modal" class="modal-overlay">
    <div class="modal">
      <h3 class="text-danger">Delete Agent</h3>
      <p class="description-dim">This will permanently delete <strong>${escapeHtml(agent.name)}</strong> and all associated data.</p>
      <label>Type "<strong>${escapeHtml(agent.name)}</strong>" to confirm:</label>
      <input type="text" id="delete-confirm-input" class="delete-confirm-input" placeholder="Enter agent name" autocomplete="off">
      <div id="delete-error" class="inline-error d-none"></div>
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" onclick="closeModal('delete-modal')">Cancel</button>
        <button type="button" class="btn-danger" id="delete-confirm-btn" onclick="confirmDelete()">Delete</button>
      </div>
    </div>
  </div>

  <!-- Delete Avatar Confirmation Modal -->
  <div id="delete-avatar-modal" class="modal-overlay">
    <div class="modal">
      <h3>Remove Avatar</h3>
      <p class="description-dim">Remove the custom avatar and use the default?</p>
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" onclick="closeModal('delete-avatar-modal')">Cancel</button>
        <button type="button" class="btn-danger" onclick="confirmDeleteAvatar()">Remove</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const agentId = ${JSON.stringify(agent.id)};
    const agentName = ${JSON.stringify(agent.name)};

    function showToast(msg, type) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast ' + type + ' show';
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }

    function openModal(id) {
      document.getElementById(id).classList.add('active');
    }

    document.querySelectorAll('.modal-overlay').forEach(m => {
      m.addEventListener('click', e => {
        if (e.target.classList.contains('modal-overlay')) closeModal(m.id);
      });
    });

    // Bio
    document.getElementById('bio-btn').onclick = () => openModal('bio-modal');
    async function saveBio() {
      const bio = document.getElementById('bio-text').value;
      const res = await fetch('/ui/keys/' + agentId + '/bio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ bio })
      });
      if ((await res.json()).success) location.reload();
    }

    // Webhook
    document.getElementById('webhook-btn').onclick = () => openModal('webhook-modal');
    ${agent.webhook_url ? 'document.getElementById(\'test-webhook-btn\').onclick = testWebhook;' : ''}
    async function saveWebhook() {
      const url = document.getElementById('webhook-url').value;
      const token = document.getElementById('webhook-token').value;
      const res = await fetch('/ui/keys/' + agentId + '/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ webhook_url: url, webhook_token: token })
      });
      if ((await res.json()).success) location.reload();
    }
    async function testWebhook() {
      const btn = document.getElementById('test-webhook-btn');
      btn.disabled = true; btn.textContent = 'Testing...';
      const res = await fetch('/ui/keys/' + agentId + '/test-webhook', { method: 'POST', headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      btn.disabled = false; btn.textContent = 'Test';
      showToast(data.message, data.success ? 'success' : 'error');
    }

    // Proxy
    document.getElementById('proxy-btn').onclick = () => openModal('proxy-modal');
    document.getElementById('proxy-enabled').onchange = function() {
      document.getElementById('proxy-fields').style.display = this.checked ? '' : 'none';
    };
    async function saveProxy() {
      const enabled = document.getElementById('proxy-enabled').checked;
      const url = document.getElementById('proxy-url-input').value;
      const res = await fetch('/ui/keys/' + agentId + '/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ proxy_enabled: enabled ? 'on' : '', proxy_url: url })
      });
      if ((await res.json()).success) location.reload();
    }
    function copyProxyUrl() {
      const url = document.getElementById('proxy-url').textContent;
      navigator.clipboard.writeText(url);
      showToast('Copied!', 'success');
    }

    // Regen
    document.getElementById('regen-btn').onclick = () => openModal('regen-modal');
    async function confirmRegen() {
      const res = await fetch('/ui/keys/' + agentId + '/regenerate', { method: 'POST', headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      if (data.success) {
        document.getElementById('new-key').textContent = data.key;
        document.getElementById('regen-confirm').style.display = 'none';
        document.getElementById('regen-success').style.display = '';
      }
    }
    function copyNewKey() {
      navigator.clipboard.writeText(document.getElementById('new-key').textContent);
      showToast('Copied!', 'success');
    }

    // Toggle enable/disable
    document.getElementById('enabled-toggle').onchange = async function() {
      const checkbox = this;
      const label = document.getElementById('toggle-label');
      checkbox.disabled = true;
      try {
        const res = await fetch('/ui/keys/' + agentId + '/toggle-enabled', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          label.textContent = data.enabled ? 'Enabled' : 'Disabled';
        } else {
          checkbox.checked = !checkbox.checked;
          showToast('Failed to update', 'error');
        }
      } catch (err) {
        checkbox.checked = !checkbox.checked;
        showToast('Network error', 'error');
      }
      checkbox.disabled = false;
    };

    // Toggle raw results
    document.getElementById('raw-results-toggle').onchange = async function() {
      const checkbox = this;
      checkbox.disabled = true;
      try {
        const res = await fetch('/ui/keys/' + agentId + '/toggle-raw-results', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (!data.success) {
          checkbox.checked = !checkbox.checked;
          showToast('Failed to update', 'error');
        }
      } catch (err) {
        checkbox.checked = !checkbox.checked;
        showToast('Network error', 'error');
      }
      checkbox.disabled = false;
    };

    // Delete
    document.getElementById('delete-btn').onclick = () => {
      document.getElementById('delete-confirm-input').value = '';
      document.getElementById('delete-error').style.display = 'none';
      openModal('delete-modal');
    };
    async function confirmDelete() {
      const input = document.getElementById('delete-confirm-input');
      const errorEl = document.getElementById('delete-error');
      if (input.value.toLowerCase() !== agentName.toLowerCase()) {
        errorEl.textContent = 'Name does not match';
        errorEl.style.display = '';
        input.focus();
        return;
      }
      const res = await fetch('/ui/keys/' + agentId, { method: 'DELETE', headers: { 'Accept': 'application/json' } });
      if ((await res.json()).success) location.href = '/ui/keys';
    }

    // Gateway Proxy URLs
    ${agent.gateway_proxy_enabled ? `
    (function() {
      var proxyId = '${escapeHtml(agent.gateway_proxy_id || '')}';
      if (proxyId) {
        var httpUrl = location.protocol + '//' + location.host + '/px/' + proxyId + '/';
        var wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var wsUrl = wsProto + location.host + '/px/' + proxyId + '/';
        var httpEl = document.getElementById('proxy-http-url');
        var wsEl = document.getElementById('proxy-ws-url');
        var codeEl = document.getElementById('proxy-url');
        if (httpEl) httpEl.textContent = httpUrl;
        if (wsEl) wsEl.textContent = wsUrl;
        if (codeEl) codeEl.textContent = wsUrl;
      }
    })();
    ` : ''}

    // Channel WebSocket
    ${agent.channel_enabled ? `
    (function() {
      var wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      var wsUrl = wsProto + location.host + '/channel/${escapeHtml(agent.channel_id || '')}';
      var el = document.getElementById('channel-ws-url');
      if (el) el.textContent = wsUrl;
    })();
    document.getElementById('channel-regen-btn').onclick = async function() {
      if (!confirm('Regenerate channel key? The old key will stop working immediately.')) return;
      this.disabled = true;
      try {
        const res = await fetch('/ui/keys/' + agentId + '/channel/regenerate', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          document.getElementById('channel-key-value').textContent = data.channel_key;
          document.getElementById('channel-key-display').style.display = '';
          showToast('Channel key regenerated', 'success');
        } else {
          showToast(data.error || 'Failed', 'error');
        }
      } catch (err) { showToast('Error: ' + err.message, 'error'); }
      this.disabled = false;
    };
    document.getElementById('channel-disable-btn').onclick = async function() {
      if (!confirm('Disable channel? Active connections will be dropped.')) return;
      const res = await fetch('/ui/keys/' + agentId + '/channel', {
        method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });
      if ((await res.json()).success) location.reload();
    };
    ` : `
    document.getElementById('channel-enable-btn').onclick = async function() {
      this.disabled = true;
      const res = await fetch('/ui/keys/' + agentId + '/channel', {
        method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('channel-enable-btn').style.display = 'none';
        // Show key in a display+copy pattern inline
        const card = document.getElementById('channel-enable-btn').closest('.config-card');
        const keyDiv = document.createElement('div');
        keyDiv.innerHTML = '<div class="proxy-url-box"><code>' + data.channel_key + '</code><button type="button" class="btn-copy-sm" onclick="navigator.clipboard.writeText(\\'' + data.channel_key + '\\');showToast(\\'Copied!\\',\\'success\\')">Copy</button></div><p class="help-text text-warning">⚠️ Save this key — it won\\'t be shown again. Page will reload in 5s.</p>';
        card.appendChild(keyDiv);
        setTimeout(() => location.reload(), 5000);
      } else {
        showToast(data.error || 'Failed', 'error');
        this.disabled = false;
      }
    };
    `}
    function copyChannelKey() {
      navigator.clipboard.writeText(document.getElementById('channel-key-value').textContent);
      showToast('Copied!', 'success');
    }

    // Chat functionality (uses shared getChatScript from server)
    ${agent.channel_enabled ? `
    ${getChatScript()}
    (function() {
      const channelId = '${escapeHtml(agent.channel_id || '')}';
      const adminToken = ADMIN_CHAT_TOKEN;
      
      const messagesDiv = document.getElementById('chat-messages');
      const chatInput = document.getElementById('chat-input');
      const sendBtn = document.getElementById('chat-send-btn');
      const statusEl = document.getElementById('chat-status');
      const popoutBtn = document.getElementById('chat-popout-btn');

      function addMessage(role, content, timestamp) {
        const div = document.createElement('div');
        div.style.marginBottom = '12px';
        const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
        const roleColor = role === 'user' ? '#60a5fa' : (role === 'system' ? '#fbbf24' : '#34d399');
        const roleLabel = role === 'user' ? 'You' : (role === 'system' ? 'System' : 'Agent');
        div.innerHTML = '<div style="color:' + roleColor + ';font-weight:600;font-size:11px;margin-bottom:2px;">' + roleLabel + ' <span class="subheading-dim">' + time + '</span></div><div class="text-primary-color">' + renderMarkdown(content) + '</div>';
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      }

      // Handle streaming chunks - progressive rendering
      function handleChunk(content, messageId, timestamp) {
        let div = document.getElementById(messageId);
        if (!div) {
          div = document.createElement('div');
          div.id = messageId;
          div.style.marginBottom = '12px';
          const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
          div.innerHTML = '<div class="role-label text-success">Agent <span class="subheading-dim">' + time + '</span></div><div class="stream-content text-primary-color"></div><span class="opacity-50">▊</span>';
          messagesDiv.appendChild(div);
        }
        const contentDiv = div.querySelector('.stream-content');
        if (contentDiv) {
          contentDiv.innerHTML = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>');
        }
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      }

      // Handle stream end - finalize with full markdown
      function handleStreamEnd(content, messageId, timestamp) {
        let div = document.getElementById(messageId);
        if (div) {
          const cursor = div.querySelector('span');
          if (cursor) cursor.remove();
          const contentDiv = div.querySelector('.stream-content');
          if (contentDiv) contentDiv.innerHTML = renderMarkdown(content);
        } else {
          addMessage('agent', content, timestamp);
        }
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      }

      const chat = createChatController(channelId, {
        onStatus: function(text, cls) {
          statusEl.textContent = text;
          const classes = { connected: 'status-success', pending: 'status-warning', error: 'status-error' };
          statusEl.className = 'status ' + (classes[cls] || 'status-default');
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
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      };

      popoutBtn.onclick = function() {
        const popoutUrl = '/ui/keys/' + agentId + '/chat';
        window.open(popoutUrl, 'chat-' + agentId, 'width=500,height=600,menubar=no,toolbar=no');
      };

      // Auto-connect with admin token on page load
      chat.connect(adminToken, 'admin');
    })();
    ` : ''}

    // Sessions (event delegation for kill buttons — no inline onclick, addresses XSS concern)
    async function loadSessions() {
      try {
        const res = await fetch('/ui/keys/' + agentId + '/sessions');
        const data = await res.json();
        const container = document.getElementById('sessions-container');
        const killAllBtn = document.getElementById('kill-all-sessions-btn');

        if (!data.sessions || data.sessions.length === 0) {
          container.innerHTML = '<p class="text-dim italic">No active sessions.</p>';
          killAllBtn.style.display = 'none';
          return;
        }

        killAllBtn.style.display = '';
        
        // Format timestamp to human-readable local time
        function formatTime(dateStr) {
          if (!dateStr) return '-';
          try {
            const d = new Date(dateStr);
            const now = new Date();
            const diffMs = now - d;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);
            
            // Relative time for recent timestamps
            if (diffMins < 1) return 'just now';
            if (diffMins < 60) return diffMins + 'm ago';
            if (diffHours < 24) return diffHours + 'h ago';
            if (diffDays < 7) return diffDays + 'd ago';
            
            // Full date for older timestamps
            return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
          } catch { return dateStr; }
        }
        
        let html = '<table class="agents-table sessions-table"><thead><tr><th>Session ID</th><th>Created</th><th>Last Seen</th><th>Status</th><th></th></tr></thead><tbody>';
        for (const s of data.sessions) {
          const shortId = s.sessionId.substring(0, 8) + '...';
          const status = s.active 
            ? '<span class="status-badge status-active">● Active</span>' 
            : '<span class="status-badge status-db">○ DB Only</span>';
          const created = formatTime(s.createdAt);
          const lastSeen = formatTime(s.lastSeen);
          html += '<tr>' +
            '<td title="' + s.sessionId + '"><code class="session-id">' + shortId + '</code></td>' +
            '<td class="timestamp" title="' + (s.createdAt || '') + '">' + created + '</td>' +
            '<td class="timestamp" title="' + (s.lastSeen || '') + '">' + lastSeen + '</td>' +
            '<td>' + status + '</td>' +
            '<td><button class="btn-sm btn-danger kill-session-btn" data-session-id="' + s.sessionId + '">Kill</button></td>' +
            '</tr>';
        }
        html += '</tbody></table>';
        container.innerHTML = html;
      } catch (err) {
        document.getElementById('sessions-container').innerHTML = '<p class="text-danger">Failed to load sessions.</p>';
      }
    }

    // Event delegation for session kill buttons
    document.getElementById('sessions-container').addEventListener('click', async function(e) {
      const btn = e.target.closest('.kill-session-btn');
      if (!btn) return;
      const sid = btn.dataset.sessionId;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await fetch('/ui/keys/' + agentId + '/sessions/' + encodeURIComponent(sid) + '/kill', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        showToast(data.found ? 'Session killed' : 'Session not found (already expired?)', data.found ? 'success' : 'error');
        loadSessions();
      } catch (err) {
        showToast('Failed to kill session', 'error');
        btn.disabled = false;
        btn.textContent = 'Kill';
      }
    });

    document.getElementById('kill-all-sessions-btn').onclick = async function() {
      if (!confirm('Kill all MCP sessions for ' + agentName + '?')) return;
      try {
        const res = await fetch('/ui/keys/' + agentId + '/sessions/kill-all', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        showToast('Killed ' + data.killed + ' session(s)', 'success');
        loadSessions();
      } catch (err) {
        showToast('Failed to kill sessions', 'error');
      }
    };

    document.getElementById('refresh-sessions-btn').onclick = loadSessions;
    loadSessions();

    // Avatar
    document.getElementById('avatar-clickable').onclick = () => openModal('avatar-modal');
    let avatarData = null;
    document.getElementById('avatar-file').onchange = function(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) {
        showToast('File too large. Max 500KB.', 'error');
        e.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = function(ev) {
        avatarData = ev.target.result;
        document.getElementById('avatar-preview').innerHTML = '<img src="' + avatarData + '" class="avatar-img-cover">';
        document.getElementById('avatar-upload-btn').disabled = false;
      };
      reader.readAsDataURL(file);
    };
    async function uploadAvatar() {
      if (!avatarData) return;
      const res = await fetch('/ui/keys/' + agentId + '/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ avatar: avatarData })
      });
      if ((await res.json()).success) location.reload();
    }
    function deleteAvatar() {
      openModal('delete-avatar-modal');
    }
    async function confirmDeleteAvatar() {
      const res = await fetch('/ui/keys/' + agentId + '/avatar', { method: 'DELETE', headers: { 'Accept': 'application/json' } });
      if ((await res.json()).success) location.reload();
    }
  </script>
  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
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

