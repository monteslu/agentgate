// Agents routes
import { Router } from 'express';
import { listApiKeys, createApiKey, deleteApiKey, updateAgentWebhook, getApiKeyById } from '../../lib/db.js';
import { escapeHtml, formatDate, simpleNavHeader } from './shared.js';

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

// Render function
function renderKeysPage(keys, error = null, newKey = null) {
  const renderKeyRow = (k) => `
    <tr id="key-${k.id}">
      <td><strong>${escapeHtml(k.name)}</strong></td>
      <td><code class="key-value">${escapeHtml(k.key_prefix)}</code></td>
      <td>
        ${k.webhook_url ? `
          <span class="webhook-status webhook-configured" title="${escapeHtml(k.webhook_url)}">✓ Configured</span>
        ` : `
          <span class="webhook-status webhook-none">Not set</span>
        `}
        <button type="button" class="btn-sm webhook-btn" data-id="${k.id}" data-name="${escapeHtml(k.name)}" data-url="${escapeHtml(k.webhook_url || '')}" data-token="${escapeHtml(k.webhook_token || '')}">Configure</button>
      </td>
      <td>${formatDate(k.created_at)}</td>
      <td>
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
  <style>
    .keys-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .keys-table th, .keys-table td { padding: 12px; text-align: left; border-bottom: 1px solid #374151; }
    .keys-table th { font-weight: 600; color: #9ca3af; font-size: 14px; }
    .key-value { background: #1f2937; padding: 4px 8px; border-radius: 4px; font-size: 13px; color: #e5e7eb; }
    .new-key-banner { background: #065f46; border: 1px solid #10b981; padding: 16px; border-radius: 8px; margin-bottom: 20px; color: #d1fae5; }
    .new-key-banner code { background: #1f2937; color: #10b981; padding: 8px 12px; border-radius: 4px; display: block; margin-top: 8px; font-size: 14px; word-break: break-all; }
    .delete-btn { background: none; border: none; color: #f87171; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; font-weight: bold; }
    .delete-btn:hover { color: #dc2626; }
    .back-link { color: #a78bfa; text-decoration: none; font-weight: 500; }
    .back-link:hover { text-decoration: underline; }
    .error-message { background: #7f1d1d; color: #fecaca; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
    .webhook-status { font-size: 12px; padding: 4px 8px; border-radius: 4px; margin-right: 8px; }
    .webhook-configured { background: #065f46; color: #6ee7b7; }
    .webhook-none { background: #374151; color: #9ca3af; }
    .btn-sm { font-size: 12px; padding: 4px 8px; background: #4f46e5; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .btn-sm:hover { background: #4338ca; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: #1f2937; border-radius: 12px; padding: 24px; max-width: 500px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
    .modal h3 { margin: 0 0 16px 0; color: #f3f4f6; }
    .modal label { display: block; margin-bottom: 4px; color: #d1d5db; font-size: 14px; }
    .modal input { width: 100%; padding: 10px; border: 1px solid #374151; border-radius: 6px; background: #111827; color: #f3f4f6; margin-bottom: 12px; box-sizing: border-box; }
    .modal input:focus { border-color: #6366f1; outline: none; }
    .modal-buttons { display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px; }
    .modal .help-text { font-size: 12px; color: #9ca3af; margin-top: -8px; margin-bottom: 12px; }
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
          <button type="submit" class="btn-primary">Save Webhook</button>
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
      document.getElementById('webhook-modal').classList.add('active');
    }

    function closeWebhookModal() {
      document.getElementById('webhook-modal').classList.remove('active');
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

    async function deleteKey(id) {
      if (!confirm('Delete this API key? Any agents using it will lose access.')) return;

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
          document.querySelector('.card:last-of-type h3').textContent = 'Existing Keys (' + count + ')';

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
  </script>
</body>
</html>`;
}

export default router;
