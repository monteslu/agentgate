// LLM Provider management UI routes
import { Router } from 'express';
import {
  listLlmProviders, createLlmProvider, getLlmProvider, updateLlmProvider, deleteLlmProvider,
  listAllAgentLlmModels, setAgentLlmModel, removeAgentLlmModel, listApiKeys,
  getPendingQueueCount, listPendingMessages, getMessagingMode
} from '../../lib/db.js';
import { htmlHead, navHeader, socketScript, localizeScript, menuScript, escapeHtml } from './shared.js';

const router = Router();

// ============ HTML UI Page ============

const PROVIDER_ICONS = { openai: '🤖', anthropic: '🧠', google: '🔮', custom: '⚙️' };

router.get('/', (req, res) => {
  const providers = listLlmProviders();
  const models = listAllAgentLlmModels();
  const agents = listApiKeys().map(k => k.name).sort();
  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = messagingMode !== 'off' ? listPendingMessages().length : 0;

  const providerCards = providers.map(p => {
    const icon = PROVIDER_ICONS[p.provider_type] || '⚙️';
    const enabledClass = p.enabled ? 'configured' : 'not-configured';
    const enabledLabel = p.enabled ? 'Enabled' : 'Disabled';
    return `
      <div class="card provider-card" id="provider-${p.id}">
        <div class="provider-header">
          <div class="provider-info">
            <span class="provider-icon">${icon}</span>
            <div>
              <strong class="provider-name">${escapeHtml(p.name)}</strong>
              <span class="provider-type">${escapeHtml(p.provider_type)}</span>
              ${p.base_url ? `<div class="provider-url">${escapeHtml(p.base_url)}</div>` : ''}
            </div>
          </div>
          <div class="provider-actions">
            <span class="status ${enabledClass}">${enabledLabel}</span>
            <button class="btn-sm" onclick="testProvider(${p.id})">Test</button>
            <button class="btn-sm" onclick="toggleProvider(${p.id}, ${p.enabled ? 0 : 1})">${p.enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn-sm" onclick="editProvider(${p.id})">Edit</button>
            <button class="btn-sm btn-danger" onclick="deleteProvider(${p.id}, '${escapeHtml(p.name).replace(/'/g, "\\'")}')">Delete</button>
          </div>
        </div>
        <div id="provider-test-${p.id}" class="provider-test-result"></div>
        <div id="provider-edit-${p.id}" class="provider-edit-form d-none">
          <div class="form-grid">
            <div class="form-group">
              <label for="edit-name-${p.id}">Name</label>
              <input type="text" id="edit-name-${p.id}" value="${escapeHtml(p.name)}" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="edit-type-${p.id}">Type</label>
              <select id="edit-type-${p.id}">
                <option value="openai" ${p.provider_type === 'openai' ? 'selected' : ''}>OpenAI</option>
                <option value="anthropic" ${p.provider_type === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                <option value="google" ${p.provider_type === 'google' ? 'selected' : ''}>Google</option>
                <option value="custom" ${p.provider_type === 'custom' ? 'selected' : ''}>Custom</option>
              </select>
            </div>
            <div class="form-group">
              <label for="edit-key-${p.id}">API Key</label>
              <input type="password" id="edit-key-${p.id}" placeholder="Leave blank to keep current" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="edit-url-${p.id}">Base URL (optional) <span class="help-hint" title="Only needed for self-hosted or custom API endpoints (e.g. local LLM servers, Azure OpenAI). Leave blank for standard providers like OpenAI, Anthropic, or Google.">?</span></label>
              <input type="text" id="edit-url-${p.id}" value="${escapeHtml(p.base_url || '')}" placeholder="https://api.example.com" autocomplete="off">
            </div>
          </div>
          <div class="form-actions">
            <button class="btn-primary" onclick="saveProvider(${p.id})">Save Changes</button>
            <button class="btn-secondary" onclick="document.getElementById('provider-edit-${p.id}').style.display='none'">Cancel</button>
          </div>
        </div>
      </div>`;
  }).join('');

  const modelRows = models.map(m => {
    const provName = providers.find(p => p.id === m.provider_id)?.name || `#${m.provider_id}`;
    return `
      <tr id="model-${escapeHtml(m.agent_name)}-${m.provider_id}-${escapeHtml(m.model_id)}">
        <td>${escapeHtml(m.agent_name)}</td>
        <td>${escapeHtml(m.model_id)}</td>
        <td>${escapeHtml(provName)}</td>
        <td>${m.is_default ? '✅' : ''}</td>
        <td><button class="btn-sm btn-danger" onclick="deleteModel('${escapeHtml(m.agent_name).replace(/'/g, "\\'")}', ${m.provider_id}, '${escapeHtml(m.model_id).replace(/'/g, "\\'")}')">Remove</button></td>
      </tr>`;
  }).join('');

  const providerOptions = providers.map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)} (${p.provider_type})</option>`
  ).join('');

  const agentOptions = ['<option value="*">* (default/wildcard)</option>']
    .concat(agents.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`))
    .join('');

  const html = `${htmlHead('LLM Providers', { includeSocket: true })}

<body>
  ${navHeader({ pendingQueueCount, pendingMessagesCount, messagingMode })}

  <div class="llm-section">
    <h2>🔌 LLM Providers</h2>

    <div class="card">
      <h3>Add Provider</h3>
      <p class="help">Connect an LLM provider to enable AI capabilities for agents.</p>
      <div class="form-grid">
        <div class="form-group">
          <label for="add-name">Name</label>
          <input type="text" id="add-name" placeholder="my-openai" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="add-type">Type</label>
          <select id="add-type">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="google">Google</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label for="add-key">API Key</label>
          <input type="password" id="add-key" placeholder="sk-..." autocomplete="off">
        </div>
        <div class="form-group">
          <label for="add-url">Base URL (optional) <span class="help-hint" title="Only needed for self-hosted or custom API endpoints (e.g. local LLM servers, Azure OpenAI). Leave blank for standard providers like OpenAI, Anthropic, or Google.">?</span></label>
          <input type="text" id="add-url" placeholder="https://api.example.com" autocomplete="off">
        </div>
      </div>
      <button class="btn-primary" onclick="addProvider()">Add Provider</button>
      <div id="add-result" class="form-result"></div>
    </div>

    <div id="providers-list">
      ${providerCards || '<div class="empty-state-box">No providers configured yet.</div>'}
    </div>
  </div>

  <div class="llm-section">
    <h2>🎯 Agent Model Assignments</h2>

    <div class="card">
      <h3>Assign Model</h3>
      <p class="help">Map agents to specific models. Use * as a wildcard for default assignments. <span class="help-hint" title="Assign a model to a specific agent, or use * to set a fallback model for all agents without their own assignment. Specific agent assignments always override the * wildcard.">?</span></p>
      <div class="form-grid" style="grid-template-columns: repeat(3, 1fr);">
        <div class="form-group">
          <label for="assign-agent">Agent</label>
          <select id="assign-agent">${agentOptions}</select>
        </div>
        <div class="form-group">
          <label for="assign-provider">Provider</label>
          <select id="assign-provider">${providerOptions || '<option value="">No providers</option>'}</select>
        </div>
        <div class="form-group">
          <label for="assign-model">Model ID</label>
          <input type="text" id="assign-model" placeholder="gpt-4o" autocomplete="off">
        </div>
      </div>
      <div class="flex-center gap-16">
        <label class="flex-center gap-8 m-0 cursor-pointer text-muted">
          <input type="checkbox" id="assign-default" class="icon-18 m-0" autocomplete="off">
          Set as default <span class="help-hint" title="When checked, this becomes the agent's default model. If another model was previously the default for this agent, it will be replaced.">?</span>
        </label>
        <button class="btn-primary" onclick="assignModel()">Assign Model</button>
      </div>
      <div id="assign-result" class="form-result"></div>
    </div>

    <div class="card">
      <table class="models-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Model</th>
            <th>Provider</th>
            <th>Default</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="models-tbody">
          ${modelRows || '<tr class="empty-row"><td colspan="5">No model assignments yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>

  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
  <script>
    function showMsg(elId, msg, isError) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.innerHTML = '<span class="' + (isError ? 'status-error' : 'status-success') + '">' + msg + '</span>';
      setTimeout(() => el.innerHTML = '', 5000);
    }

    async function addProvider() {
      const name = document.getElementById('add-name').value.trim();
      const provider_type = document.getElementById('add-type').value;
      const api_key = document.getElementById('add-key').value;
      const base_url = document.getElementById('add-url').value.trim() || undefined;
      if (!name || !api_key) return showMsg('add-result', 'Name and API key required', true);
      const res = await fetch('/ui/llm/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, provider_type, api_key, base_url })
      });
      const data = await res.json();
      if (data.success) location.reload();
      else showMsg('add-result', data.error || 'Failed', true);
    }

    async function deleteProvider(id, name) {
      if (!confirm('Delete provider "' + name + '"?')) return;
      await fetch('/ui/llm/providers/' + id, { method: 'DELETE' });
      location.reload();
    }

    function editProvider(id) {
      document.getElementById('provider-edit-' + id).style.display = '';
    }

    async function saveProvider(id) {
      const body = {};
      const name = document.getElementById('edit-name-' + id).value.trim();
      const provider_type = document.getElementById('edit-type-' + id).value;
      const api_key = document.getElementById('edit-key-' + id).value;
      const base_url = document.getElementById('edit-url-' + id).value.trim();
      if (name) body.name = name;
      if (provider_type) body.provider_type = provider_type;
      if (api_key) body.api_key = api_key;
      if (base_url) body.base_url = base_url;
      const res = await fetch('/ui/llm/providers/' + id, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) location.reload();
      else alert(data.error || 'Failed');
    }

    async function toggleProvider(id, enabled) {
      await fetch('/ui/llm/providers/' + id, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      location.reload();
    }

    async function testProvider(id) {
      const el = document.getElementById('provider-test-' + id);
      el.innerHTML = '<span class="opacity-60">Testing...</span>';
      try {
        const res = await fetch('/ui/llm/providers/' + id + '/test', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          el.innerHTML = '<span class="text-success">✅ Connected — ' + data.latency + 'ms</span>';
        } else {
          el.innerHTML = '<span class="text-danger">❌ ' + (data.error || 'Failed') + (data.latency ? ' (' + data.latency + 'ms)' : '') + '</span>';
        }
      } catch (e) {
        el.innerHTML = '<span class="text-danger">❌ Network error</span>';
      }
    }

    async function assignModel() {
      const agent_name = document.getElementById('assign-agent').value;
      const provider_id = parseInt(document.getElementById('assign-provider').value);
      const model_id = document.getElementById('assign-model').value.trim();
      const is_default = document.getElementById('assign-default').checked;
      if (!model_id) return showMsg('assign-result', 'Model ID required', true);
      if (!provider_id) return showMsg('assign-result', 'Select a provider', true);
      const res = await fetch('/ui/llm/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name, provider_id, model_id, is_default })
      });
      const data = await res.json();
      if (data.success) location.reload();
      else showMsg('assign-result', data.error || 'Failed', true);
    }

    async function deleteModel(agent_name, provider_id, model_id) {
      if (!confirm('Remove model assignment?')) return;
      await fetch('/ui/llm/models', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name, provider_id, model_id })
      });
      location.reload();
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// ============ Test provider endpoint (UI-facing) ============

router.post('/providers/:id/test', async (req, res) => {
  const { id } = req.params;
  const provider = getLlmProvider(id);
  if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });
  if (!provider.enabled) return res.json({ success: false, error: 'Provider is disabled' });

  const PROVIDER_DEFAULTS = {
    openai: 'https://api.openai.com',
    anthropic: 'https://api.anthropic.com',
    google: 'https://generativelanguage.googleapis.com'
  };

  const baseUrl = provider.base_url || PROVIDER_DEFAULTS[provider.provider_type] || '';
  if (!baseUrl) return res.json({ success: false, error: 'No base URL configured' });

  // Build a simple models list request
  let url, headers;
  if (provider.provider_type === 'anthropic') {
    url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    headers = { 'x-api-key': provider.api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    // Just do a HEAD-like check: send minimal invalid request, expect 400 not 401
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] })
      });
      clearTimeout(timer);
      const latency = Date.now() - start;
      // 400 = auth works, payload bad. 401/403 = bad key
      if (resp.status === 401 || resp.status === 403) {
        return res.json({ success: false, error: 'Authentication failed', latency });
      }
      return res.json({ success: true, latency });
    } catch (e) {
      return res.json({ success: false, error: e.message, latency: Date.now() - start });
    }
  } else {
    url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
    headers = { 'Authorization': `Bearer ${provider.api_key}` };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    const latency = Date.now() - start;
    if (resp.status === 401 || resp.status === 403) {
      return res.json({ success: false, error: 'Authentication failed', latency });
    }
    if (!resp.ok) {
      return res.json({ success: false, error: `HTTP ${resp.status}`, latency });
    }
    return res.json({ success: true, latency });
  } catch (e) {
    return res.json({ success: false, error: e.message, latency: Date.now() - start });
  }
});

// ============ JSON API endpoints ============

// List providers (no API keys exposed)
router.get('/providers', (req, res) => {
  const providers = listLlmProviders();
  res.json(providers);
});

// Create provider
router.post('/providers', (req, res) => {
  const { name, provider_type, api_key, base_url } = req.body;
  if (!name || !provider_type || !api_key) {
    return res.status(400).json({ error: 'name, provider_type, and api_key are required' });
  }
  try {
    const provider = createLlmProvider(name, provider_type, api_key, base_url);
    res.json({ success: true, provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update provider
router.post('/providers/:id', (req, res) => {
  const { id } = req.params;
  const provider = getLlmProvider(id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  updateLlmProvider(id, req.body);
  res.json({ success: true });
});

// Delete provider
router.delete('/providers/:id', (req, res) => {
  const { id } = req.params;
  deleteLlmProvider(id);
  res.json({ success: true });
});

// List all model assignments
router.get('/models', (req, res) => {
  const models = listAllAgentLlmModels();
  res.json(models);
});

// Assign model to agent
router.post('/models', (req, res) => {
  const { agent_name, provider_id, model_id, is_default } = req.body;
  if (!agent_name || !provider_id || !model_id) {
    return res.status(400).json({ error: 'agent_name, provider_id, and model_id are required' });
  }
  try {
    setAgentLlmModel(agent_name, provider_id, model_id, is_default || false);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove model assignment
router.delete('/models', (req, res) => {
  const { agent_name, provider_id, model_id } = req.body;
  if (!agent_name || !provider_id || !model_id) {
    return res.status(400).json({ error: 'agent_name, provider_id, and model_id are required' });
  }
  removeAgentLlmModel(agent_name, provider_id, model_id);
  res.json({ success: true });
});

export default router;
