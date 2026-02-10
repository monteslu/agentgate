// Agents routes
import { Router } from 'express';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { listApiKeys, createApiKey, deleteApiKey, regenerateApiKey, updateAgentWebhook, updateAgentBio, getApiKeyById, getAvatarsDir, getAvatarFilename, deleteAgentAvatar, setAgentEnabled, setAgentRawResults, updateGatewayProxy, regenerateProxyId, getAgentDataCounts, getAgentServiceAccess } from '../../lib/db.js';
import { escapeHtml, formatDate, htmlHead, navHeader, socketScript, localizeScript, menuScript, renderAvatar, BASE_URL } from './shared.js';

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
  res.send(renderAgentDetailPage(agent, counts, serviceAccess));
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

// Render function
function renderKeysPage(keys, error = null, newKey = null) {
  const renderKeyRow = (k) => `
    <tr id="key-${k.id}" class="${k.enabled === 0 ? 'agent-disabled' : ''}">
      <td>
        <div class="agent-with-avatar">
          ${renderAvatar(k.name, { size: 32 })}
          <strong>${escapeHtml(k.name)}</strong>
          <span class="status-disabled" ${k.enabled === 0 ? '' : 'style="display:none"'}>Disabled</span>
        </div>
      </td>
      <td>${formatDate(k.created_at)}</td>
      <td style="white-space: nowrap;">
        <label class="toggle">
          <input type="checkbox" ${k.enabled ? 'checked' : ''} onchange="toggleEnabled('${k.id}', this)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td>
        <a href="/ui/keys/${k.id}" class="btn-sm">Details</a>
      </td>
    </tr>
  `;

  return `${htmlHead('Agents', { includeSocket: true })}
  <style>
    .add-agent-box {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .add-agent-box label {
      color: #9ca3af;
      font-size: 14px;
      white-space: nowrap;
      margin: 0;
    }
    .add-agent-box input {
      flex: 1;
      max-width: 280px;
      padding: 8px 12px;
      border: 1px solid #374151;
      border-radius: 6px;
      background: #111827;
      color: #f3f4f6;
      height: 38px;
      box-sizing: border-box;
    }
    .add-agent-box input:focus {
      border-color: #6366f1;
      outline: none;
    }
    .add-agent-box .btn-primary {
      height: 38px;
      padding: 0 16px;
      display: flex;
      align-items: center;
    }
  </style>
  <style>
    .agents-table { width: 100%; border-collapse: collapse; }
    .agents-table th, .agents-table td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .agents-table th { font-weight: 600; color: #9ca3af; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; }
    .agent-with-avatar { display: flex; align-items: center; gap: 12px; }
    .agent-disabled { opacity: 0.5; }
    .status-disabled { background: #7f1d1d; color: #fca5a5; font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-left: 8px; }
    .new-key-banner { background: #065f46; border: 1px solid #10b981; padding: 16px; border-radius: 8px; margin-bottom: 20px; color: #d1fae5; }
    .new-key-banner code { background: #1f2937; color: #10b981; padding: 8px 12px; border-radius: 4px; display: block; margin-top: 8px; font-size: 14px; word-break: break-all; }
    .error-message { background: #7f1d1d; color: #fecaca; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
    .btn-sm { font-size: 12px; padding: 6px 12px; background: rgba(99,102,241,0.2); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.4); border-radius: 4px; cursor: pointer; text-decoration: none; }
    .btn-sm:hover { background: rgba(99,102,241,0.3); }

    /* Toggle switch */
    .toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #374151; transition: 0.3s; border-radius: 24px; }
    .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%; }
    .toggle input:checked + .toggle-slider { background-color: #10b981; }
    .toggle input:checked + .toggle-slider:before { transform: translateX(20px); }
    .toggle input:disabled + .toggle-slider { opacity: 0.5; cursor: not-allowed; }

    /* Toast notifications */
    .toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 14px; z-index: 1000; opacity: 0; transform: translateY(20px); transition: opacity 0.3s, transform 0.3s; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { background: #dc2626; }
    .toast.success { background: #059669; }
  </style>
</head>
<body>
  ${navHeader()}

  ${error ? `<div class="error-message">${escapeHtml(error)}</div>` : ''}

  ${newKey ? `
    <div class="new-key-banner">
      <strong>New API key created!</strong> Copy it now - you won't be able to see it again.
      <code>${newKey.key}</code>
      <button type="button" class="btn-sm btn-primary" onclick="copyKey('${newKey.key}', this)" style="margin-top: 8px;">Copy to Clipboard</button>
    </div>
  ` : ''}

  <form method="POST" action="/ui/keys/create" class="add-agent-box">
    <label>New Agent</label>
    <input type="text" name="name" placeholder="e.g., johnny-5, clawdbot, Her, Hal" required>
    <button type="submit" class="btn-primary">Create</button>
  </form>

  <div class="card">
    <h3>Agents (${keys.length})</h3>
    ${keys.length === 0 ? `
      <p style="color: #6b7280; text-align: center; padding: 20px;">No agents yet. Create one above.</p>
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
  <div class="card" style="text-align: center; padding: 40px;">
    <h2>Agent Not Found</h2>
    <p style="color: #9ca3af;">The agent with ID "${escapeHtml(String(id))}" does not exist.</p>
    <a href="/ui/keys" class="btn-primary" style="display: inline-block; margin-top: 16px;">Back to Agents</a>
  </div>
  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
</body>
</html>`;
}

function renderAgentDetailPage(agent, counts, serviceAccess = []) {
  return `${htmlHead(agent.name + ' - Agent Details', { includeSocket: true })}
<style>
  .agent-header {
    display: flex;
    align-items: center;
    gap: 20px;
    margin-bottom: 24px;
  }
  .agent-header .avatar-large {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: #374151;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    font-weight: 600;
    color: #9ca3af;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    overflow: hidden;
  }
  .agent-header .avatar-large:hover {
    transform: scale(1.05);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.4);
  }
  .agent-header .avatar-large img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .agent-header h2 {
    margin: 0;
    flex: 1;
  }
  .agent-header .toggle-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .agent-header .toggle-label {
    font-size: 13px;
    color: #9ca3af;
  }

  /* Toggle switch */
  .toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #374151; transition: 0.3s; border-radius: 24px; }
  .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%; }
  .toggle input:checked + .toggle-slider { background-color: #10b981; }
  .toggle input:checked + .toggle-slider:before { transform: translateX(20px); }
  .toggle input:disabled + .toggle-slider { opacity: 0.5; cursor: not-allowed; }

  .detail-section { margin-bottom: 24px; }
  .detail-section h3 { margin: 0 0 12px 0; color: #e5e7eb; font-size: 1em; }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .detail-row:last-child { border-bottom: none; }
  .detail-row .label { color: #9ca3af; font-size: 14px; }
  .detail-row .value { color: #e5e7eb; font-family: monospace; }
  .detail-row .value.muted { color: #6b7280; font-style: italic; font-family: inherit; }

  .bio-text {
    background: rgba(0,0,0,0.2);
    padding: 12px;
    border-radius: 6px;
    color: #d1d5db;
    white-space: pre-wrap;
    font-size: 14px;
  }

  .config-card {
    background: rgba(0,0,0,0.15);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .config-card h4 {
    margin: 0 0 12px 0;
    color: #e5e7eb;
    font-size: 0.95em;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .config-card .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .config-card .status-dot.active { background: #10b981; }
  .config-card .status-dot.inactive { background: #6b7280; }

  .btn-row {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .danger-zone {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    padding: 20px;
    margin-top: 24px;
  }
  .danger-zone h3 { color: #f87171; margin: 0 0 8px 0; }
  .danger-zone p { color: #9ca3af; margin: 0 0 16px 0; font-size: 14px; }

  .stats-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .stat-box {
    background: rgba(0,0,0,0.2);
    padding: 12px 16px;
    border-radius: 6px;
    text-align: center;
    min-width: 80px;
  }
  .stat-box .stat-value { font-size: 20px; font-weight: 600; color: #e5e7eb; }
  .stat-box .stat-label { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; }
  a.stat-link { text-decoration: none; transition: background 0.2s, border-color 0.2s; border: 1px solid transparent; }
  a.stat-link:hover { background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.3); }

  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: #1f2937; border-radius: 12px; padding: 24px; max-width: 500px; width: 90%; }
  .modal h3 { margin: 0 0 16px 0; color: #f3f4f6; }
  .modal label { display: block; margin-bottom: 4px; color: #d1d5db; font-size: 14px; }
  .modal input, .modal textarea { width: 100%; padding: 10px; border: 1px solid #374151; border-radius: 6px; background: #111827; color: #f3f4f6; margin-bottom: 12px; box-sizing: border-box; }
  .modal input:focus, .modal textarea:focus { border-color: #6366f1; outline: none; }
  .modal-buttons { display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px; }
  .help-text { font-size: 12px; color: #9ca3af; margin-top: -8px; margin-bottom: 12px; }

  .proxy-url-box { background: #111827; padding: 10px 12px; border-radius: 6px; word-break: break-all; font-size: 13px; color: #67e8f9; display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .proxy-url-box code { flex: 1; }
  .btn-copy-sm { background: #374151; border: 1px solid #4b5563; color: #d1d5db; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }

  /* Toast */
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 14px; z-index: 1001; opacity: 0; transform: translateY(20px); transition: opacity 0.3s, transform 0.3s; }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.error { background: #dc2626; }
  .toast.success { background: #059669; }

  /* Inline error */
  .inline-error { color: #f87171; font-size: 13px; margin-top: 4px; }

  /* Delete confirmation input */
  .delete-confirm-input { border-color: #ef4444 !important; }
  .delete-confirm-input:focus { border-color: #ef4444 !important; box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2); }

  /* Service access list */
  .service-access-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .service-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); border-radius: 20px; font-size: 13px; color: #c7d2fe; text-decoration: none; transition: background 0.2s, border-color 0.2s; }
  .service-chip:hover { background: rgba(99,102,241,0.25); border-color: rgba(99,102,241,0.5); }
  .service-chip img { width: 16px; height: 16px; }
  .service-chip .bypass-badge { font-size: 10px; background: #065f46; color: #6ee7b7; padding: 2px 6px; border-radius: 8px; margin-left: 4px; }
  .no-access { color: #9ca3af; font-style: italic; font-size: 14px; padding: 12px 0; }
</style>
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
        <input type="checkbox" id="enabled-toggle" ${agent.enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="toggle-wrapper">
      <span class="toggle-label" id="raw-results-label">${agent.raw_results ? 'Raw Results' : 'Simplified Results'}</span>
      <label class="toggle">
        <input type="checkbox" id="raw-results-toggle" ${agent.raw_results ? 'checked' : ''}>
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
      <h3>Webhook</h3>
      <div class="config-card">
        <h4><span class="status-dot ${agent.webhook_url ? 'active' : 'inactive'}"></span> Webhook Notifications</h4>
        ${agent.webhook_url ? `
          <div class="detail-row">
            <span class="label">URL</span>
            <span class="value" style="font-size: 12px; word-break: break-all;">${escapeHtml(agent.webhook_url)}</span>
          </div>
          <div class="detail-row">
            <span class="label">Token</span>
            <span class="value">${agent.webhook_token ? '••••••••' : 'Not set'}</span>
          </div>
        ` : '<p class="value muted">Not configured. Webhooks notify the agent of messages and queue updates.</p>'}
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
            <span class="value" style="font-size: 12px;">${escapeHtml(agent.gateway_proxy_url || 'Not set')}</span>
          </div>
          <div class="proxy-url-box">
            <code id="proxy-url">${escapeHtml(getProxyUrl(agent.gateway_proxy_id))}</code>
            <button type="button" class="btn-copy-sm" onclick="copyProxyUrl()">Copy</button>
          </div>
        ` : '<p class="value muted">Not enabled. Proxy exposes the agent\'s gateway through AgentGate.</p>'}
        <div class="btn-row">
          <button type="button" class="btn-secondary" id="proxy-btn">Configure</button>
        </div>
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
      <p style="color: #9ca3af; font-size: 14px; margin-bottom: 16px;">Describe this agent's role. Shown via <code>whoami</code>.</p>
      <textarea id="bio-text" rows="4" placeholder="e.g., You are a cybersecurity expert...">${escapeHtml(agent.bio || '')}</textarea>
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" onclick="closeModal('bio-modal')">Cancel</button>
        <button type="button" class="btn-primary" onclick="saveBio()">Save</button>
      </div>
    </div>
  </div>

  <!-- Webhook Modal -->
  <div id="webhook-modal" class="modal-overlay">
    <div class="modal">
      <h3>Configure Webhook</h3>
      <label>Webhook URL</label>
      <input type="url" id="webhook-url" value="${escapeHtml(agent.webhook_url || '')}" placeholder="https://your-agent.com/webhook">
      <p class="help-text">Receives POST notifications for messages and queue updates</p>
      <label>Authorization Token (optional)</label>
      <input type="text" id="webhook-token" value="${escapeHtml(agent.webhook_token || '')}" placeholder="secret-token">
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
      <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px; cursor: pointer;">
        <input type="checkbox" id="proxy-enabled" ${agent.gateway_proxy_enabled ? 'checked' : ''} style="width: auto; margin: 0;">
        <span>Enable gateway proxy</span>
      </label>
      <div id="proxy-fields" style="${agent.gateway_proxy_enabled ? '' : 'display: none;'}">
        <label>Internal Gateway URL</label>
        <input type="url" id="proxy-url-input" value="${escapeHtml(agent.gateway_proxy_url || '')}" placeholder="http://localhost:18789">
        <p class="help-text">The internal URL of the agent's gateway</p>
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
        <p style="color: #fbbf24; background: rgba(245,158,11,0.1); padding: 12px; border-radius: 8px; border: 1px solid rgba(245,158,11,0.3); margin-bottom: 16px;">
          ⚠️ This will immediately invalidate the current key. The agent will lose access until updated.
        </p>
        <div class="modal-buttons">
          <button type="button" class="btn-secondary" onclick="closeModal('regen-modal')">Cancel</button>
          <button type="button" class="btn-danger" onclick="confirmRegen()">Regenerate</button>
        </div>
      </div>
      <div id="regen-success" style="display: none;">
        <p style="color: #34d399; background: rgba(16,185,129,0.1); padding: 12px; border-radius: 8px; border: 1px solid rgba(16,185,129,0.3); margin-bottom: 16px;">
          ✅ Key regenerated! Copy it now - you won't see it again.
        </p>
        <div style="background: #111827; padding: 12px; border-radius: 8px; margin-bottom: 16px; word-break: break-all;">
          <code id="new-key" style="color: #34d399;"></code>
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
      <div style="text-align: center; margin-bottom: 16px;">
        <div id="avatar-preview" style="width: 80px; height: 80px; border-radius: 50%; margin: 0 auto; background: #374151; display: flex; align-items: center; justify-content: center; overflow: hidden;">
          ${renderAvatar(agent.name, { size: 80 })}
        </div>
      </div>
      <input type="file" id="avatar-file" accept="image/png,image/jpeg,image/gif,image/webp">
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
      <h3 style="color: #f87171;">Delete Agent</h3>
      <p style="color: #d1d5db; margin-bottom: 16px;">This will permanently delete <strong>${escapeHtml(agent.name)}</strong> and all associated data.</p>
      <label>Type "<strong>${escapeHtml(agent.name)}</strong>" to confirm:</label>
      <input type="text" id="delete-confirm-input" class="delete-confirm-input" placeholder="Enter agent name" autocomplete="off">
      <div id="delete-error" class="inline-error" style="display: none;"></div>
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
      <p style="color: #d1d5db; margin-bottom: 16px;">Remove the custom avatar and use the default?</p>
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
      const label = document.getElementById('raw-results-label');
      checkbox.disabled = true;
      try {
        const res = await fetch('/ui/keys/' + agentId + '/toggle-raw-results', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          label.textContent = data.raw_results ? 'Raw Results' : 'Simplified Results';
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
        document.getElementById('avatar-preview').innerHTML = '<img src="' + avatarData + '" style="width:100%;height:100%;object-fit:cover;">';
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

function getProxyUrl(proxyId) {
  if (!proxyId) return '';
  return BASE_URL + '/px/' + proxyId + '/';
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
