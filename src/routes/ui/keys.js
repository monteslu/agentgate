// Agents routes
import { Router } from 'express';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { listApiKeys, createApiKey, deleteApiKey, regenerateApiKey, updateAgentWebhook, getApiKeyById, getAvatarsDir, getAvatarFilename, deleteAgentAvatar, setAgentEnabled, updateGatewayProxy, regenerateProxyId, getAgentDataCounts } from '../../lib/db.js';
import { escapeHtml, formatDate, simpleNavHeader, socketScript, localizeScript, renderAvatar } from './shared.js';

const router = Router();

// Agents Management
router.get('/', (req, res) => {
  const keys = listApiKeys();
  res.send(renderKeysPage(keys));
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

// Render function
function renderKeysPage(keys, error = null, newKey = null) {
  const renderKeyRow = (k) => `
    <tr id="key-${k.id}" class="${k.enabled === 0 ? 'agent-disabled' : ''}">
      <td>
        <div class="agent-with-avatar">
          <span class="avatar-clickable" data-id="${k.id}" data-name="${escapeHtml(k.name)}" title="Click to change avatar">
            ${renderAvatar(k.name, { size: 32 })}
          </span>
          <div>
            <strong>${escapeHtml(k.name)}</strong>
            ${k.enabled === 0 ? '<span class="status-disabled">Disabled</span>' : ''}
          </div>
        </div>
      </td>
      <td><code class="key-value">${escapeHtml(k.key_prefix)}</code></td>
      <td>
        ${k.webhook_url ? `
          <span class="webhook-status webhook-configured" title="${escapeHtml(k.webhook_url)}">✓ Configured</span>
        ` : `
          <span class="webhook-status webhook-none">Not set</span>
        `}
        <button type="button" class="btn-sm webhook-btn" data-id="${k.id}" data-name="${escapeHtml(k.name)}" data-url="${escapeHtml(k.webhook_url || '')}" data-token="${escapeHtml(k.webhook_token || '')}">Configure</button>
      </td>
      <td>
        ${k.gateway_proxy_enabled ? `
          <span class="proxy-status proxy-configured" title="${escapeHtml(k.gateway_proxy_url || '')}">✓ Enabled</span>
        ` : `
          <span class="proxy-status proxy-none">Off</span>
        `}
        <button type="button" class="btn-sm proxy-btn" data-id="${k.id}" data-name="${escapeHtml(k.name)}" data-enabled="${k.gateway_proxy_enabled ? '1' : '0'}" data-proxy-id="${escapeHtml(k.gateway_proxy_id || '')}" data-proxy-url="${escapeHtml(k.gateway_proxy_url || '')}">Configure</button>
      </td>
      <td>${formatDate(k.created_at)}</td>
      <td style="white-space: nowrap;">
        <button type="button" class="btn-sm btn-regen" data-id="${k.id}" data-name="${escapeHtml(k.name)}" data-prefix="${escapeHtml(k.key_prefix)}" title="Regenerate API Key">🔄</button>
        <button type="button" class="btn-sm btn-toggle ${k.enabled === 0 ? 'btn-enable' : 'btn-disable'}" onclick="toggleEnabled('${k.id}')" title="${k.enabled === 0 ? 'Enable' : 'Disable'}">${k.enabled === 0 ? '✓' : '⏸'}</button>
        <button type="button" class="delete-btn" onclick="deleteKey('${k.id}')" title="Delete">&times;</button>
      </td>
    </tr>
  `;

  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Agents</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    .keys-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .keys-table th, .keys-table td { padding: 12px; text-align: left; border-bottom: 1px solid #374151; }
    .keys-table th { font-weight: 600; color: #9ca3af; font-size: 14px; }
    .key-value { background: #1f2937; padding: 4px 8px; border-radius: 4px; font-size: 13px; color: #e5e7eb; }
    .new-key-banner { background: #065f46; border: 1px solid #10b981; padding: 16px; border-radius: 8px; margin-bottom: 20px; color: #d1fae5; }
    .new-key-banner code { background: #1f2937; color: #10b981; padding: 8px 12px; border-radius: 4px; display: block; margin-top: 8px; font-size: 14px; word-break: break-all; }
    .delete-btn { background: none; border: none; color: #f87171; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; font-weight: bold; }
    .delete-btn:hover { color: #dc2626; }
    .btn-regen { background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); color: #fbbf24; font-size: 14px; padding: 4px 8px; cursor: pointer; border-radius: 4px; margin-right: 8px; }
    .btn-regen:hover { background: rgba(245, 158, 11, 0.25); border-color: rgba(245, 158, 11, 0.5); }
    .back-link { color: #a78bfa; text-decoration: none; font-weight: 500; }
    .back-link:hover { text-decoration: underline; }
    .error-message { background: #7f1d1d; color: #fecaca; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
    .webhook-status { font-size: 12px; padding: 4px 8px; border-radius: 4px; margin-right: 8px; }
    .webhook-configured { background: #065f46; color: #6ee7b7; }
    .webhook-none { background: #374151; color: #9ca3af; }
    .proxy-status { font-size: 12px; padding: 4px 8px; border-radius: 4px; margin-right: 8px; }
    .proxy-configured { background: #164e63; color: #67e8f9; }
    .proxy-none { background: #374151; color: #9ca3af; }
    .proxy-url-box { background: #111827; padding: 10px 12px; border-radius: 6px; margin: 12px 0; word-break: break-all; font-size: 13px; color: #67e8f9; display: flex; align-items: center; gap: 8px; }
    .proxy-url-box code { flex: 1; }
    .btn-copy-sm { background: #374151; border: 1px solid #4b5563; color: #d1d5db; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .btn-copy-sm:hover { background: #4b5563; }
    .btn-sm { font-size: 12px; padding: 4px 8px; background: #4f46e5; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .btn-sm:hover { background: #4338ca; }
    .btn-test { padding: 10px 20px; background: #059669; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; }
    .btn-test:hover { background: #047857; }
    .btn-test:disabled { background: #6b7280; cursor: not-allowed; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: #1f2937; border-radius: 12px; padding: 24px; max-width: 500px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
    .modal h3 { margin: 0 0 16px 0; color: #f3f4f6; }
    .modal label { display: block; margin-bottom: 4px; color: #d1d5db; font-size: 14px; }
    .modal input { width: 100%; padding: 10px; border: 1px solid #374151; border-radius: 6px; background: #111827; color: #f3f4f6; margin-bottom: 12px; box-sizing: border-box; }
    .modal input:focus { border-color: #6366f1; outline: none; }
    .modal-buttons { display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px; }
    .modal .help-text { font-size: 12px; color: #9ca3af; margin-top: -8px; margin-bottom: 12px; }
    .avatar-clickable { cursor: pointer; display: inline-block; border-radius: 50%; transition: transform 0.15s ease, box-shadow 0.15s ease; }
    .avatar-clickable:hover { transform: scale(1.1); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.4); }

    .agent-disabled { opacity: 0.5; }
    .status-disabled { background: #7f1d1d; color: #fca5a5; font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-left: 8px; }
    .btn-toggle { margin-right: 8px; }
    .btn-enable { background: #065f46; border-color: #10b981; color: #6ee7b7; }
    .btn-enable:hover { background: #047857; }
    .btn-disable { background: #7f1d1d; border-color: #ef4444; color: #fca5a5; }
    .btn-disable:hover { background: #991b1b; }
  </style>
</head>
<body>
  <div>
    ${simpleNavHeader()}
  </div>
  <p>Manage API keys for your agents. Keys are hashed and can only be viewed once at creation.</p>

  ${error ? `<div class="error-message">${escapeHtml(error)}</div>` : ''}

  ${newKey ? `
    <div class="new-key-banner">
      <strong>New API key created!</strong> Copy it now - you won't be able to see it again.
      <code>${newKey.key}</code>
      <button type="button" class="btn-sm btn-primary" onclick="copyKey('${newKey.key}', this)" style="margin-top: 8px;">Copy to Clipboard</button>
    </div>
  ` : ''}

  <div class="card">
    <h3>Create New Key</h3>
    <form method="POST" action="/ui/keys/create" style="display: flex; gap: 12px; align-items: flex-end;">
      <div style="flex: 1;">
        <label>Key Name</label>
        <input type="text" name="name" placeholder="e.g., clawdbot, moltbot, dev-agent" required>
      </div>
      <button type="submit" class="btn-primary">Create Key</button>
    </form>
  </div>

  <div class="card">
    <h3>Existing Keys (${keys.length})</h3>
    ${keys.length === 0 ? `
      <p style="color: var(--gray-500); text-align: center; padding: 20px;">No API keys yet. Create one above.</p>
    ` : `
      <table class="keys-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key Prefix</th>
            <th>Webhook</th>
            <th>Proxy</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="keys-tbody">
          ${keys.map(renderKeyRow).join('')}
        </tbody>
      </table>
    `}
  </div>

  <!-- Webhook Modal -->
  <div id="webhook-modal" class="modal-overlay">
    <div class="modal">
      <h3>Configure Webhook for <span id="modal-agent-name"></span></h3>
      <p style="color: #9ca3af; font-size: 14px; margin-bottom: 16px;">
        When messages or queue updates are ready, agentgate will POST to this URL.
      </p>
      <form id="webhook-form">
        <input type="hidden" id="webhook-agent-id" name="id">
        <label for="webhook-url">Webhook URL</label>
        <input type="url" id="webhook-url" name="webhook_url" placeholder="https://your-agent-gateway.com/webhook">
        <p class="help-text">The endpoint that will receive POST notifications</p>

        <label for="webhook-token">Authorization Token (optional)</label>
        <input type="text" id="webhook-token" name="webhook_token" placeholder="secret-token">
        <p class="help-text">Sent as Bearer token in Authorization header</p>

        <div class="modal-buttons">
          <button type="button" class="btn-secondary" onclick="closeWebhookModal()">Cancel</button>
          <button type="button" id="webhook-test-btn" class="btn-test" onclick="testWebhook()" style="display: none;">Test</button>
          <button type="submit" class="btn-primary">Save Webhook</button>
        </div>
      </form>
      <div id="webhook-test-result" style="margin-top: 12px; display: none;"></div>
    </div>
  </div>

  <!-- Regenerate Key Modal -->
  <div id="regen-modal" class="modal-overlay">
    <div class="modal">
      <h3>🔄 Regenerate API Key</h3>
      <!-- Confirmation view -->
      <div id="regen-confirm-view">
        <p style="color: #fbbf24; font-size: 14px; margin-bottom: 16px; background: rgba(245, 158, 11, 0.1); padding: 12px; border-radius: 8px; border: 1px solid rgba(245, 158, 11, 0.3);">
          ⚠️ <strong>Warning:</strong> This will immediately invalidate the current API key. Any agents using it will lose access until updated with the new key.
        </p>
        <p style="color: #9ca3af; margin-bottom: 8px;">Agent: <strong id="regen-agent-name" style="color: #f3f4f6;"></strong></p>
        <p style="color: #9ca3af; margin-bottom: 16px;">Current key: <code id="regen-key-prefix" style="background: #374151; padding: 2px 6px; border-radius: 4px;"></code></p>
        <input type="hidden" id="regen-agent-id">
        <div class="modal-buttons">
          <button type="button" class="btn-secondary" onclick="closeRegenModal()">Cancel</button>
          <button type="button" id="regen-confirm-btn" class="btn-danger" onclick="confirmRegenerate()">Regenerate Key</button>
        </div>
      </div>
      <!-- Success view with new key -->
      <div id="regen-success-view" style="display: none;">
        <p style="color: #34d399; font-size: 14px; margin-bottom: 16px; background: rgba(16, 185, 129, 0.1); padding: 12px; border-radius: 8px; border: 1px solid rgba(16, 185, 129, 0.3);">
          ✅ <strong>Key regenerated!</strong> Copy it now - you won't be able to see it again.
        </p>
        <p style="color: #9ca3af; margin-bottom: 8px;">Agent: <strong id="regen-success-name" style="color: #f3f4f6;"></strong></p>
        <div style="background: #1f2937; padding: 12px; border-radius: 8px; margin-bottom: 16px; word-break: break-all;">
          <code id="regen-new-key" style="color: #34d399; font-size: 14px;"></code>
        </div>
        <div class="modal-buttons">
          <button type="button" id="regen-copy-btn" class="btn-primary" onclick="copyRegenKey()">Copy to Clipboard</button>
          <button type="button" class="btn-secondary" onclick="closeRegenModalAndRefresh()">Done</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Avatar Modal -->
  <div id="avatar-modal" class="modal-overlay">
    <div class="modal">
      <h3>Avatar for <span id="avatar-agent-name"></span></h3>
      <p style="color: #9ca3af; font-size: 14px; margin-bottom: 16px;">
        Upload an image (PNG, JPG, GIF, WebP). Max size: 500KB.
      </p>
      <input type="hidden" id="avatar-agent-id">
      
      <div id="avatar-preview-container" style="text-align: center; margin-bottom: 16px;">
        <div id="avatar-preview" style="width: 80px; height: 80px; border-radius: 50%; margin: 0 auto; background: #374151; display: flex; align-items: center; justify-content: center; overflow: hidden;">
          <span id="avatar-preview-text" style="color: #9ca3af;">No image</span>
          <img id="avatar-preview-img" style="width: 100%; height: 100%; object-fit: cover; display: none;">
        </div>
      </div>
      
      <input type="file" id="avatar-file" accept="image/png,image/jpeg,image/gif,image/webp" style="margin-bottom: 16px;">
      <p class="help-text">Select an image file to upload</p>
      
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" onclick="closeAvatarModal()">Cancel</button>
        <button type="button" id="avatar-delete-btn" class="btn-danger" onclick="deleteAvatar()" style="display: none;">Delete</button>
        <button type="button" id="avatar-upload-btn" class="btn-primary" onclick="uploadAvatar()" disabled>Upload</button>
      </div>
    </div>
  </div>

  <!-- Proxy Modal -->
  <div id="proxy-modal" class="modal-overlay">
    <div class="modal">
      <h3>Gateway Proxy for <span id="proxy-agent-name"></span></h3>
      <p style="color: #9ca3af; font-size: 14px; margin-bottom: 16px;">
        Expose this agent's OpenClaw gateway through AgentGate. Clients connect to the proxy URL and traffic is forwarded transparently.
      </p>
      <form id="proxy-form">
        <input type="hidden" id="proxy-agent-id">

        <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; cursor: pointer;">
          <input type="checkbox" id="proxy-enabled" style="width: auto; margin: 0;">
          <span>Enable gateway proxy</span>
        </label>

        <div id="proxy-fields" style="display: none;">
          <label for="proxy-url-input">Internal Gateway URL</label>
          <input type="url" id="proxy-url-input" placeholder="http://localhost:18789">
          <p class="help-text">The internal URL of the agent's OpenClaw gateway</p>

          <div id="proxy-url-display" style="display: none;">
            <label>Proxy URL <span style="color: #9ca3af; font-weight: normal;">(share with clients)</span></label>
            <div class="proxy-url-box">
              <code id="proxy-full-url"></code>
              <button type="button" class="btn-copy-sm" onclick="copyProxyUrl()">Copy</button>
            </div>
            <button type="button" class="btn-sm" style="background: #7f1d1d; border: 1px solid rgba(239,68,68,0.3); margin-bottom: 12px;" onclick="regenProxyId()">Regenerate Proxy ID</button>
            <p class="help-text" style="color: #fbbf24;">⚠️ Regenerating will break existing client connections</p>
          </div>
        </div>

        <div class="modal-buttons">
          <button type="button" class="btn-secondary" onclick="closeProxyModal()">Cancel</button>
          <button type="submit" class="btn-primary">Save</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function copyKey(key, btn) {
      navigator.clipboard.writeText(key).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    function showWebhookModal(btn) {
      document.getElementById('webhook-agent-id').value = btn.dataset.id;
      document.getElementById('modal-agent-name').textContent = btn.dataset.name;
      document.getElementById('webhook-url').value = btn.dataset.url;
      document.getElementById('webhook-token').value = btn.dataset.token;
      // Show test button if webhook URL is already configured
      const testBtn = document.getElementById('webhook-test-btn');
      const testResult = document.getElementById('webhook-test-result');
      testBtn.style.display = btn.dataset.url ? 'inline-block' : 'none';
      testResult.style.display = 'none';
      testResult.innerHTML = '';
      document.getElementById('webhook-modal').classList.add('active');
    }

    function closeWebhookModal() {
      document.getElementById('webhook-modal').classList.remove('active');
    }

    // Regenerate key modal functions
    let regenNewKey = null;

    function showRegenModal(btn) {
      document.getElementById('regen-agent-id').value = btn.dataset.id;
      document.getElementById('regen-agent-name').textContent = btn.dataset.name;
      document.getElementById('regen-key-prefix').textContent = btn.dataset.prefix;
      // Reset to confirmation view
      document.getElementById('regen-confirm-view').style.display = '';
      document.getElementById('regen-success-view').style.display = 'none';
      document.getElementById('regen-confirm-btn').disabled = false;
      document.getElementById('regen-confirm-btn').textContent = 'Regenerate Key';
      regenNewKey = null;
      document.getElementById('regen-modal').classList.add('active');
    }

    function closeRegenModal() {
      document.getElementById('regen-modal').classList.remove('active');
    }

    function closeRegenModalAndRefresh() {
      closeRegenModal();
      window.location.reload();
    }

    function copyRegenKey() {
      if (!regenNewKey) return;
      navigator.clipboard.writeText(regenNewKey).then(() => {
        const btn = document.getElementById('regen-copy-btn');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    async function confirmRegenerate() {
      const id = document.getElementById('regen-agent-id').value;
      const btn = document.getElementById('regen-confirm-btn');
      btn.disabled = true;
      btn.textContent = 'Regenerating...';

      try {
        const res = await fetch('/ui/keys/' + id + '/regenerate', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          // Show success view with new key
          regenNewKey = data.key;
          document.getElementById('regen-success-name').textContent = data.name;
          document.getElementById('regen-new-key').textContent = data.key;
          document.getElementById('regen-confirm-view').style.display = 'none';
          document.getElementById('regen-success-view').style.display = '';
        } else {
          alert(data.error || 'Failed to regenerate key');
          btn.disabled = false;
          btn.textContent = 'Regenerate Key';
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Regenerate Key';
      }
    }

    document.querySelectorAll('.btn-regen').forEach(btn => {
      btn.addEventListener('click', () => showRegenModal(btn));
    });

    document.getElementById('regen-modal').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        closeRegenModal();
      }
    });

    async function testWebhook() {
      const id = document.getElementById('webhook-agent-id').value;
      const testBtn = document.getElementById('webhook-test-btn');
      const testResult = document.getElementById('webhook-test-result');
      
      testBtn.disabled = true;
      testBtn.textContent = 'Testing...';
      testResult.style.display = 'block';
      testResult.innerHTML = '<span style="color: #9ca3af;">Sending test webhook...</span>';
      
      try {
        const res = await fetch('/ui/keys/' + id + '/test-webhook', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        
        if (data.success) {
          testResult.innerHTML = '<span style="color: #34d399;">✓ ' + data.message + '</span>';
        } else {
          testResult.innerHTML = '<span style="color: #f87171;">✗ ' + data.message + '</span>';
        }
      } catch (err) {
        testResult.innerHTML = '<span style="color: #f87171;">✗ Error: ' + err.message + '</span>';
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test';
      }
    }

    document.querySelectorAll('.webhook-btn').forEach(btn => {
      btn.addEventListener('click', () => showWebhookModal(btn));
    });

    document.getElementById('webhook-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('webhook-agent-id').value;
      const webhookUrl = document.getElementById('webhook-url').value;
      const webhookToken = document.getElementById('webhook-token').value;

      try {
        const res = await fetch('/ui/keys/' + id + '/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ webhook_url: webhookUrl, webhook_token: webhookToken })
        });
        const data = await res.json();

        if (data.success) {
          closeWebhookModal();
          window.location.reload();
        } else {
          alert(data.error || 'Failed to save webhook');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });

    document.getElementById('webhook-modal').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        closeWebhookModal();
      }
    });

    async function toggleEnabled(id) {
      try {
        const res = await fetch('/ui/keys/' + id + '/toggle-enabled', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          alert(data.error || 'Failed to toggle agent status');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function deleteKey(id) {
      // Fetch data counts first
      try {
        const countsRes = await fetch('/ui/keys/' + id + '/counts', { headers: { 'Accept': 'application/json' } });
        const countsData = await countsRes.json();
        if (countsData.error) {
          alert(countsData.error);
          return;
        }

        const c = countsData.counts;
        const items = [];
        if (c.messages > 0) items.push(c.messages + ' message' + (c.messages > 1 ? 's' : ''));
        if (c.queueEntries > 0) items.push(c.queueEntries + ' queue entr' + (c.queueEntries > 1 ? 'ies' : 'y'));
        if (c.mementos > 0) items.push(c.mementos + ' memento' + (c.mementos > 1 ? 's' : ''));
        if (c.broadcasts > 0) items.push(c.broadcasts + ' broadcast' + (c.broadcasts > 1 ? 's' : ''));
        if (c.warnings > 0) items.push(c.warnings + ' warning' + (c.warnings > 1 ? 's' : ''));
        if (c.serviceAccess > 0) items.push(c.serviceAccess + ' service access rule' + (c.serviceAccess > 1 ? 's' : ''));

        let warning = '⚠️ DELETE AGENT: ' + countsData.name + '\\n\\n';
        if (items.length > 0) {
          warning += 'This will permanently delete:\\n- ' + items.join('\\n- ') + '\\n- API key access\\n\\n';
        } else {
          warning += 'This will permanently delete the API key.\\n\\n';
        }
        warning += 'Type the agent name to confirm:';

        const confirmation = prompt(warning);
        if (confirmation === null) return;
        if (confirmation.toLowerCase() !== countsData.name.toLowerCase()) {
          alert('Name does not match. Deletion cancelled.');
          return;
        }
      } catch (err) {
        // Fallback to simple confirm if counts endpoint fails
        if (!confirm('Delete this API key? Any agents using it will lose access.')) return;
      }

      try {
        const res = await fetch('/ui/keys/' + id, {
          method: 'DELETE',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
          const row = document.getElementById('key-' + id);
          if (row) row.remove();

          const tbody = document.getElementById('keys-tbody');
          const count = tbody ? tbody.querySelectorAll('tr').length : 0;
          const heading = document.querySelector('.card:last-of-type h3');
          if (heading) {
            heading.textContent = 'Existing Keys (' + count + ')';
          }

          if (count === 0) {
            const table = document.querySelector('.keys-table');
            if (table) {
              table.outerHTML = '<p style="color: #9ca3af; text-align: center; padding: 20px;">No API keys yet. Create one above.</p>';
            }
          }
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    // Avatar functionality
    let currentAvatarData = null;

    function showAvatarModal(btn) {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      document.getElementById('avatar-agent-id').value = id;
      document.getElementById('avatar-agent-name').textContent = name;
      document.getElementById('avatar-file').value = '';
      document.getElementById('avatar-upload-btn').disabled = true;
      currentAvatarData = null;
      
      // Try to load existing avatar
      const img = document.getElementById('avatar-preview-img');
      const text = document.getElementById('avatar-preview-text');
      img.src = '/ui/keys/avatar/' + encodeURIComponent(name) + '?t=' + Date.now();
      img.onload = function() {
        img.style.display = 'block';
        text.style.display = 'none';
        document.getElementById('avatar-delete-btn').style.display = '';
      };
      img.onerror = function() {
        img.style.display = 'none';
        text.style.display = '';
        document.getElementById('avatar-delete-btn').style.display = 'none';
      };
      
      document.getElementById('avatar-modal').classList.add('active');
    }

    function closeAvatarModal() {
      document.getElementById('avatar-modal').classList.remove('active');
    }

    document.querySelectorAll('.avatar-clickable').forEach(el => {
      el.addEventListener('click', () => showAvatarModal(el));
    });

    document.getElementById('avatar-file').addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      
      if (file.size > 500 * 1024) {
        alert('File too large. Maximum size is 500KB.');
        e.target.value = '';
        return;
      }
      
      const reader = new FileReader();
      reader.onload = function(event) {
        currentAvatarData = event.target.result;
        const img = document.getElementById('avatar-preview-img');
        const text = document.getElementById('avatar-preview-text');
        img.src = currentAvatarData;
        img.style.display = 'block';
        text.style.display = 'none';
        document.getElementById('avatar-upload-btn').disabled = false;
      };
      reader.readAsDataURL(file);
    });

    async function uploadAvatar() {
      if (!currentAvatarData) return;
      
      const id = document.getElementById('avatar-agent-id').value;
      const btn = document.getElementById('avatar-upload-btn');
      btn.disabled = true;
      btn.textContent = 'Uploading...';
      
      try {
        const res = await fetch('/ui/keys/' + id + '/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ avatar: currentAvatarData })
        });
        const data = await res.json();
        
        if (data.success) {
          closeAvatarModal();
          window.location.reload();
        } else {
          alert(data.error || 'Failed to upload avatar');
          btn.disabled = false;
          btn.textContent = 'Upload';
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Upload';
      }
    }

    async function deleteAvatar() {
      if (!confirm('Delete this avatar?')) return;
      
      const id = document.getElementById('avatar-agent-id').value;
      
      try {
        const res = await fetch('/ui/keys/' + id + '/avatar', {
          method: 'DELETE',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        
        if (data.success) {
          closeAvatarModal();
          window.location.reload();
        } else {
          alert(data.error || 'Failed to delete avatar');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    document.getElementById('avatar-modal').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        closeAvatarModal();
      }
    });

    // Proxy modal functions
    function showProxyModal(btn) {
      document.getElementById('proxy-agent-id').value = btn.dataset.id;
      document.getElementById('proxy-agent-name').textContent = btn.dataset.name;
      var enabled = btn.dataset.enabled === '1';
      document.getElementById('proxy-enabled').checked = enabled;
      document.getElementById('proxy-url-input').value = btn.dataset.proxyUrl || '';
      toggleProxyFields();
      if (enabled && btn.dataset.proxyId) {
        showProxyUrl(btn.dataset.proxyId);
      }
      document.getElementById('proxy-modal').classList.add('active');
    }

    function closeProxyModal() {
      document.getElementById('proxy-modal').classList.remove('active');
    }

    function toggleProxyFields() {
      var enabled = document.getElementById('proxy-enabled').checked;
      document.getElementById('proxy-fields').style.display = enabled ? '' : 'none';
    }

    function showProxyUrl(proxyId) {
      if (!proxyId) {
        document.getElementById('proxy-url-display').style.display = 'none';
        return;
      }
      var baseUrl = window.location.origin;
      document.getElementById('proxy-full-url').textContent = baseUrl + '/px/' + proxyId + '/';
      document.getElementById('proxy-url-display').style.display = '';
    }

    function copyProxyUrl() {
      var url = document.getElementById('proxy-full-url').textContent;
      navigator.clipboard.writeText(url).then(function() {
        var btns = document.querySelectorAll('.btn-copy-sm');
        btns.forEach(function(b) { b.textContent = 'Copied!'; });
        setTimeout(function() { btns.forEach(function(b) { b.textContent = 'Copy'; }); }, 1500);
      });
    }

    async function regenProxyId() {
      if (!confirm('Regenerate proxy ID? This will break existing client connections.')) return;
      var id = document.getElementById('proxy-agent-id').value;
      try {
        var res = await fetch('/ui/keys/' + id + '/regenerate-proxy', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        var data = await res.json();
        if (data.success) {
          showProxyUrl(data.proxy_id);
        } else {
          alert(data.error || 'Failed to regenerate proxy ID');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    document.getElementById('proxy-enabled').addEventListener('change', toggleProxyFields);

    document.querySelectorAll('.proxy-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { showProxyModal(btn); });
    });

    document.getElementById('proxy-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var id = document.getElementById('proxy-agent-id').value;
      var enabled = document.getElementById('proxy-enabled').checked;
      var proxyUrl = document.getElementById('proxy-url-input').value;

      try {
        var res = await fetch('/ui/keys/' + id + '/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ proxy_enabled: enabled ? 'on' : '', proxy_url: proxyUrl })
        });
        var data = await res.json();
        if (data.success) {
          closeProxyModal();
          window.location.reload();
        } else {
          alert(data.error || 'Failed to save proxy settings');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });

    document.getElementById('proxy-modal').addEventListener('click', function(e) {
      if (e.target.classList.contains('modal-overlay')) {
        closeProxyModal();
      }
    });
  </script>
${socketScript()}
${localizeScript()}
</body>
</html>`;
}

export default router;
