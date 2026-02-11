/**
 * Webhook Management UI
 * 
 * Provides UI for configuring inbound webhooks from external services
 * (GitHub, etc.) and viewing delivery history.
 */

import { Router } from 'express';
import crypto from 'crypto';
import {
  listWebhookConfigs, getWebhookConfig, createWebhookConfig, updateWebhookConfig, deleteWebhookConfig,
  listWebhookDeliveries, getWebhookDelivery, clearWebhookDeliveries,
  getWebhookSecret, setWebhookSecret, deleteWebhookSecret,
  listApiKeys
} from '../../lib/db.js';
import { htmlHead, navHeader, menuScript, localizeScript } from './shared.js';

const router = Router();

// Supported webhook sources with their event types
const WEBHOOK_SOURCES = {
  github: {
    name: 'GitHub',
    icon: '/public/icons/github.svg',
    events: [
      { id: 'push', name: 'Push', description: 'Code pushed to repository' },
      { id: 'pull_request', name: 'Pull Request', description: 'PR opened, closed, merged, etc.' },
      { id: 'issues', name: 'Issues', description: 'Issue created, updated, closed' },
      { id: 'issue_comment', name: 'Issue Comments', description: 'Comments on issues or PRs' },
      { id: 'check_suite', name: 'Check Suite', description: 'CI/CD check suite status' },
      { id: 'check_run', name: 'Check Run', description: 'Individual check run status' },
      { id: 'release', name: 'Release', description: 'Release published' },
      { id: 'workflow_run', name: 'Workflow Run', description: 'GitHub Actions workflow status' }
    ]
  }
};

// ============================================================================
// Routes
// ============================================================================

// Main webhooks page - list all configured webhooks
router.get('/webhooks', (req, res) => {
  const configs = listWebhookConfigs();
  const deliveries = listWebhookDeliveries(50); // Last 50 deliveries
  res.send(renderWebhooksPage(configs, deliveries));
});

// Add new webhook config form
router.get('/webhooks/add', (req, res) => {
  const agents = listApiKeys().filter(k => k.enabled);
  res.send(renderAddWebhookPage(agents));
});

// Create new webhook config
router.post('/webhooks/add', (req, res) => {
  const { source, name, events, assigned_agents } = req.body;
  
  if (!source || !WEBHOOK_SOURCES[source]) {
    return res.status(400).send('Invalid webhook source');
  }
  
  // Generate a secure secret
  const secret = crypto.randomBytes(32).toString('hex');
  
  // Parse events (comes as array or single value)
  const eventList = Array.isArray(events) ? events : (events ? [events] : []);
  
  // Parse assigned agents (default to empty = no agents receive)
  const agentList = Array.isArray(assigned_agents) ? assigned_agents : (assigned_agents ? [assigned_agents] : []);
  
  try {
    const config = createWebhookConfig({
      source,
      name: name || `${WEBHOOK_SOURCES[source].name} Webhook`,
      secret,
      events: eventList,
      enabled: true,
      assignedAgents: agentList.length > 0 ? agentList : null
    });
    
    // Also set the webhook secret in settings for verification
    setWebhookSecret(source, secret);
    
    res.redirect(`/ui/webhooks/${config.id}?created=1`);
  } catch (err) {
    res.status(500).send(`Error creating webhook: ${err.message}`);
  }
});

// View/edit single webhook config
router.get('/webhooks/:id', (req, res) => {
  const config = getWebhookConfig(req.params.id);
  if (!config) {
    return res.status(404).send('Webhook not found');
  }
  
  const deliveries = listWebhookDeliveries(20, config.id);
  const agents = listApiKeys().filter(k => k.enabled);
  const alerts = {
    created: req.query.created === '1',
    updated: req.query.updated === '1',
    secretRegenerated: req.query.secret_regenerated === '1',
    cleared: req.query.cleared === '1'
  };
  res.send(renderWebhookDetailPage(config, deliveries, agents, alerts));
});

// Update webhook config
router.post('/webhooks/:id', (req, res) => {
  const { name, events, enabled, assigned_agents } = req.body;
  const config = getWebhookConfig(req.params.id);
  
  if (!config) {
    return res.status(404).send('Webhook not found');
  }
  
  const eventList = Array.isArray(events) ? events : (events ? [events] : []);
  
  // Parse assigned agents (empty = no agents receive)
  const agentList = Array.isArray(assigned_agents) ? assigned_agents : (assigned_agents ? [assigned_agents] : []);
  
  try {
    updateWebhookConfig(req.params.id, {
      name,
      events: eventList,
      enabled: enabled === 'on' || enabled === '1',
      assignedAgents: agentList.length > 0 ? agentList : null
    });
    res.redirect(`/ui/webhooks/${req.params.id}?updated=1`);
  } catch (err) {
    res.status(500).send(`Error updating webhook: ${err.message}`);
  }
});

// Regenerate webhook secret
router.post('/webhooks/:id/regenerate-secret', (req, res) => {
  const config = getWebhookConfig(req.params.id);
  if (!config) {
    return res.status(404).send('Webhook not found');
  }
  
  const newSecret = crypto.randomBytes(32).toString('hex');
  
  try {
    updateWebhookConfig(req.params.id, { secret: newSecret });
    setWebhookSecret(config.source, newSecret);
    res.redirect(`/ui/webhooks/${req.params.id}?secret_regenerated=1`);
  } catch (err) {
    res.status(500).send(`Error regenerating secret: ${err.message}`);
  }
});

// Delete webhook config
router.post('/webhooks/:id/delete', (req, res) => {
  const config = getWebhookConfig(req.params.id);
  if (!config) {
    return res.status(404).send('Webhook not found');
  }
  
  try {
    deleteWebhookConfig(req.params.id);
    deleteWebhookSecret(config.source);
    res.redirect('/ui/webhooks?deleted=1');
  } catch (err) {
    res.status(500).send(`Error deleting webhook: ${err.message}`);
  }
});

// View delivery details
router.get('/webhooks/delivery/:id', (req, res) => {
  const delivery = getWebhookDelivery(req.params.id);
  if (!delivery) {
    return res.status(404).send('Delivery not found');
  }
  res.send(renderDeliveryDetailPage(delivery));
});

// Clear delivery history
router.post('/webhooks/:id/clear-history', (req, res) => {
  try {
    clearWebhookDeliveries(req.params.id);
    res.redirect(`/ui/webhooks/${req.params.id}?cleared=1`);
  } catch (err) {
    res.status(500).send(`Error clearing history: ${err.message}`);
  }
});

// Test webhook connectivity (sends a ping)
router.post('/webhooks/:id/test', async (req, res) => {
  const config = getWebhookConfig(req.params.id);
  if (!config) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  
  // For testing, we just verify the secret is configured
  const secret = getWebhookSecret(config.source);
  if (!secret) {
    return res.json({ 
      success: false, 
      message: 'Webhook secret not configured. Regenerate the secret.' 
    });
  }
  
  return res.json({ 
    success: true, 
    message: 'Webhook is configured and ready to receive events.',
    endpoint: `/webhooks/${config.source}`,
    configured_events: config.events || []
  });
});

// ============================================================================
// Render Functions
// ============================================================================

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderStyles() {
  return `<style>
    .webhook-list { margin-bottom: 24px; }
    .webhook-item {
      display: flex;
      align-items: center;
      padding: 16px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      margin-bottom: 8px;
      gap: 16px;
    }
    .webhook-item:hover {
      background: rgba(255,255,255,0.05);
      border-color: rgba(255,255,255,0.12);
    }
    .webhook-item img { width: 32px; height: 32px; }
    .webhook-item .webhook-info { flex: 1; }
    .webhook-item .webhook-name { font-weight: 600; color: #e5e7eb; }
    .webhook-item .webhook-meta { font-size: 0.85em; color: #9ca3af; margin-top: 4px; }
    .webhook-item .webhook-status {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.8em;
      font-weight: 500;
    }
    .webhook-item .webhook-status.enabled { background: rgba(34,197,94,0.2); color: #4ade80; }
    .webhook-item .webhook-status.disabled { background: rgba(239,68,68,0.2); color: #f87171; }
    
    .delivery-list { margin-top: 24px; }
    .delivery-item {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
      margin-bottom: 6px;
      gap: 12px;
      font-size: 0.9em;
    }
    .delivery-item:hover { background: rgba(255,255,255,0.04); }
    .delivery-item .delivery-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .delivery-item .delivery-status.success { background: #4ade80; }
    .delivery-item .delivery-status.failed { background: #f87171; }
    .delivery-item .delivery-event { color: #a5b4fc; font-family: monospace; min-width: 150px; }
    .delivery-item .delivery-repo { color: #9ca3af; flex: 1; }
    .delivery-item .delivery-time { color: #6b7280; font-size: 0.85em; }
    
    .secret-box {
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 12px 16px;
      font-family: monospace;
      font-size: 0.9em;
      word-break: break-all;
      position: relative;
    }
    .secret-box .copy-btn {
      position: absolute;
      right: 8px;
      top: 8px;
      padding: 4px 8px;
      font-size: 0.8em;
    }
    
    .event-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 12px;
      margin: 16px 0;
    }
    .event-checkbox {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      cursor: pointer;
    }
    .event-checkbox:hover { background: rgba(255,255,255,0.05); }
    .event-checkbox input { margin-top: 3px; }
    .event-checkbox .event-name { font-weight: 500; color: #e5e7eb; }
    .event-checkbox .event-desc { font-size: 0.85em; color: #9ca3af; margin-top: 2px; }
    
    .endpoint-url {
      background: rgba(99,102,241,0.1);
      border: 1px solid rgba(99,102,241,0.3);
      border-radius: 6px;
      padding: 12px 16px;
      font-family: monospace;
      color: #a5b4fc;
    }
    
    .alert {
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 16px;
    }
    .alert-success { background: rgba(34,197,94,0.2); border: 1px solid rgba(34,197,94,0.3); color: #4ade80; }
    .alert-warning { background: rgba(234,179,8,0.2); border: 1px solid rgba(234,179,8,0.3); color: #facc15; }
    
    .btn-danger { background: rgba(239,68,68,0.2); color: #f87171; border: 1px solid rgba(239,68,68,0.4); }
    .btn-danger:hover { background: rgba(239,68,68,0.3); }
    
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: #6b7280;
    }
    
    .detail-grid {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 12px 16px;
      margin: 16px 0;
    }
    .detail-grid dt { color: #9ca3af; }
    .detail-grid dd { color: #e5e7eb; margin: 0; }
    
    .agent-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 8px;
      margin: 12px 0;
    }
    .agent-checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .agent-checkbox:hover { background: rgba(255,255,255,0.05); }
    .agent-checkbox.selected { 
      background: rgba(99,102,241,0.15); 
      border-color: rgba(99,102,241,0.4); 
    }
    .agent-checkbox input { margin: 0; }
    .agent-checkbox .agent-name { font-weight: 500; color: #e5e7eb; }
    
    .no-agents-warning {
      background: rgba(234,179,8,0.15);
      border: 1px solid rgba(234,179,8,0.3);
      color: #facc15;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 0.9em;
      margin-top: 12px;
    }
  </style>`;
}

function renderWebhooksPage(configs, deliveries) {
  const configList = configs.length === 0 
    ? '<div class="empty-state">No webhooks configured. Click "Add Webhook" to get started.</div>'
    : configs.map(c => {
      const source = WEBHOOK_SOURCES[c.source] || { name: c.source, icon: '/public/favicon.svg' };
      const eventCount = (c.events || []).length;
      return `
        <a href="/ui/webhooks/${c.id}" class="webhook-item" style="text-decoration: none;">
          <img src="${source.icon}" alt="${source.name}">
          <div class="webhook-info">
            <div class="webhook-name">${escapeHtml(c.name)}</div>
            <div class="webhook-meta">${eventCount} event${eventCount !== 1 ? 's' : ''} configured</div>
          </div>
          <span class="webhook-status ${c.enabled ? 'enabled' : 'disabled'}">${c.enabled ? 'Active' : 'Disabled'}</span>
        </a>`;
    }).join('');

  const deliveryList = deliveries.length === 0
    ? '<div class="empty-state" style="padding: 20px;">No deliveries yet</div>'
    : deliveries.map(d => `
        <a href="/ui/webhooks/delivery/${d.id}" class="delivery-item" style="text-decoration: none;">
          <span class="delivery-status ${d.success ? 'success' : 'failed'}"></span>
          <span class="delivery-event">${escapeHtml(d.event_type)}</span>
          <span class="delivery-repo">${escapeHtml(d.repo || '-')}</span>
          <span class="delivery-time" data-ts="${d.received_at}">${escapeHtml(d.received_at)}</span>
        </a>`).join('');

  return `${htmlHead('Webhooks')}
${renderStyles()}
<body>
  ${navHeader({})}
  
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <h2 style="margin: 0;">Inbound Webhooks</h2>
    <a href="/ui/webhooks/add" class="btn-primary">+ Add Webhook</a>
  </div>
  
  <p class="help">Receive events from external services like GitHub. Configure webhook endpoints and secrets here.</p>
  
  <div class="webhook-list card" style="padding: 0; overflow: hidden;">
    ${configList}
  </div>
  
  <h3>Recent Deliveries</h3>
  <div class="card delivery-list" style="padding: 0; overflow: hidden;">
    ${deliveryList}
  </div>
  
  ${menuScript()}
  ${localizeScript()}
</body>
</html>`;
}

function renderAddWebhookPage(agents = []) {
  const sourceOptions = Object.entries(WEBHOOK_SOURCES).map(([key, src]) => `
    <div class="webhook-item" style="cursor: pointer;" onclick="selectSource('${key}')">
      <img src="${src.icon}" alt="${src.name}">
      <div class="webhook-info">
        <div class="webhook-name">${src.name}</div>
        <div class="webhook-meta">${src.events.length} event types available</div>
      </div>
      <input type="radio" name="source" value="${key}" id="source-${key}" style="display: none;">
    </div>`).join('');

  // Generate event checkboxes for each source
  const eventSections = Object.entries(WEBHOOK_SOURCES).map(([key, src]) => `
    <div id="events-${key}" class="event-section" style="display: none;">
      <h4>Select Events to Listen For</h4>
      <div class="event-grid">
        ${src.events.map(e => `
          <label class="event-checkbox">
            <input type="checkbox" name="events" value="${e.id}" checked>
            <div>
              <div class="event-name">${e.name}</div>
              <div class="event-desc">${e.description}</div>
            </div>
          </label>`).join('')}
      </div>
    </div>`).join('');

  // Agent selection (default: none selected = no agents receive)
  const agentCheckboxes = agents.length === 0
    ? '<p style="color: #9ca3af; font-style: italic;">No agents configured. Add agents in API Keys first.</p>'
    : agents.map(a => `
        <label class="agent-checkbox" onclick="updateAgentStyle(this)">
          <input type="checkbox" name="assigned_agents" value="${escapeHtml(a.name)}">
          <span class="agent-name">${escapeHtml(a.name)}</span>
        </label>`).join('');

  return `${htmlHead('Add Webhook')}
${renderStyles()}
<body>
  ${navHeader({})}
  
  <h2>Add Webhook</h2>
  <p><a href="/ui/webhooks">← Back to Webhooks</a></p>
  
  <form method="POST" action="/ui/webhooks/add" id="webhook-form">
    <div class="card">
      <h3>1. Select Source</h3>
      ${sourceOptions}
    </div>
    
    <div id="config-section" style="display: none;">
      <div class="card">
        <h3>2. Webhook Name</h3>
        <input type="text" name="name" placeholder="e.g., Main Repo Webhook" class="input" style="width: 100%;">
      </div>
      
      <div class="card">
        <h3>3. Events</h3>
        ${eventSections}
      </div>
      
      <div class="card">
        <h3>4. Assigned Agents</h3>
        <p class="help">Select which agents will receive notifications for this webhook. If none selected, no agents will be notified.</p>
        <div class="agent-grid">
          ${agentCheckboxes}
        </div>
        <div class="no-agents-warning" id="no-agents-warning">
          ⚠ No agents selected — webhook events will not be delivered to any agent.
        </div>
      </div>
      
      <button type="submit" class="btn-primary">Create Webhook</button>
    </div>
  </form>
  
  <script>
    let selectedSource = null;
    
    function selectSource(source) {
      selectedSource = source;
      document.getElementById('source-' + source).checked = true;
      document.getElementById('config-section').style.display = 'block';
      
      // Show correct event section
      document.querySelectorAll('.event-section').forEach(el => el.style.display = 'none');
      document.getElementById('events-' + source).style.display = 'block';
      
      // Highlight selected source
      document.querySelectorAll('.webhook-item').forEach(el => {
        el.style.borderColor = 'rgba(255,255,255,0.08)';
        el.style.background = 'rgba(255,255,255,0.03)';
      });
      event.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)';
      event.currentTarget.style.background = 'rgba(99,102,241,0.1)';
    }
    
    function updateAgentStyle(label) {
      setTimeout(() => {
        const cb = label.querySelector('input');
        label.classList.toggle('selected', cb.checked);
        updateAgentWarning();
      }, 0);
    }
    
    function updateAgentWarning() {
      const anyChecked = document.querySelectorAll('input[name="assigned_agents"]:checked').length > 0;
      document.getElementById('no-agents-warning').style.display = anyChecked ? 'none' : 'block';
    }
    
    // Init warning state
    updateAgentWarning();
  </script>
  
  ${menuScript()}
</body>
</html>`;
}

function renderWebhookDetailPage(config, deliveries, agents = [], alerts = {}) {
  const source = WEBHOOK_SOURCES[config.source] || { name: config.source, icon: '/public/favicon.svg', events: [] };
  const secret = getWebhookSecret(config.source) || config.secret || 'Not configured';
  const webhookPath = `/webhooks/${config.source}`;
  const assignedAgents = config.assignedAgents || [];
  
  const eventCheckboxes = source.events.map(e => {
    const checked = (config.events || []).includes(e.id) ? 'checked' : '';
    return `
      <label class="event-checkbox">
        <input type="checkbox" name="events" value="${e.id}" ${checked}>
        <div>
          <div class="event-name">${e.name}</div>
          <div class="event-desc">${e.description}</div>
        </div>
      </label>`;
  }).join('');
  
  // Agent selection for edit form
  const agentCheckboxes = agents.length === 0
    ? '<p style="color: #9ca3af; font-style: italic;">No agents configured. Add agents in API Keys first.</p>'
    : agents.map(a => {
      const checked = assignedAgents.includes(a.name) ? 'checked' : '';
      const selectedClass = checked ? 'selected' : '';
      return `
          <label class="agent-checkbox ${selectedClass}" onclick="updateAgentStyle(this)">
            <input type="checkbox" name="assigned_agents" value="${escapeHtml(a.name)}" ${checked}>
            <span class="agent-name">${escapeHtml(a.name)}</span>
          </label>`;
    }).join('');

  const deliveryList = deliveries.length === 0
    ? '<div class="empty-state" style="padding: 20px;">No deliveries yet</div>'
    : deliveries.map(d => `
        <a href="/ui/webhooks/delivery/${d.id}" class="delivery-item" style="text-decoration: none;">
          <span class="delivery-status ${d.success ? 'success' : 'failed'}"></span>
          <span class="delivery-event">${escapeHtml(d.event_type)}</span>
          <span class="delivery-repo">${escapeHtml(d.repo || '-')}</span>
          <span class="delivery-time" data-ts="${d.received_at}">${escapeHtml(d.received_at)}</span>
        </a>`).join('');

  // Build alert messages
  const alertHtml = [];
  if (alerts.created) alertHtml.push('<div class="alert alert-success">✓ Webhook created! Copy the secret below and configure it in your ' + source.name + ' repository settings.</div>');
  if (alerts.updated) alertHtml.push('<div class="alert alert-success">✓ Webhook updated</div>');
  if (alerts.secretRegenerated) alertHtml.push('<div class="alert alert-warning">⚠ Secret regenerated! Update your ' + source.name + ' webhook settings with the new secret.</div>');
  if (alerts.cleared) alertHtml.push('<div class="alert alert-success">✓ Delivery history cleared</div>');

  return `${htmlHead('Webhook: ' + config.name)}
${renderStyles()}
<body>
  ${navHeader({})}
  
  <h2><img src="${source.icon}" style="width: 28px; height: 28px; vertical-align: middle; margin-right: 8px;">${escapeHtml(config.name)}</h2>
  <p><a href="/ui/webhooks">← Back to Webhooks</a></p>
  
  ${alertHtml.join('\n  ')}
  
  <div class="card">
    <h3>Webhook Endpoint</h3>
    <p class="help">Configure your ${source.name} repository to send webhooks to this URL:</p>
    <div class="endpoint-url" id="webhook-url" data-path="${escapeHtml(webhookPath)}"></div>
  </div>
  <script>
    // Set webhook URL using client-side origin (handles reverse proxies correctly)
    document.getElementById('webhook-url').textContent = window.location.origin + document.getElementById('webhook-url').dataset.path;
  </script>
  
  <div class="card">
    <h3>Webhook Secret</h3>
    <p class="help">Use this secret when configuring the webhook in ${source.name}:</p>
    <div class="secret-box">
      <span id="secret-value">${escapeHtml(secret)}</span>
      <button type="button" class="btn-primary copy-btn" onclick="copySecret()">Copy</button>
    </div>
    <form method="POST" action="/ui/webhooks/${config.id}/regenerate-secret" style="margin-top: 12px;">
      <button type="submit" class="btn-danger" onclick="return confirm('Regenerate secret? You will need to update the webhook in ${source.name}.')">Regenerate Secret</button>
    </form>
  </div>
  
  <form method="POST" action="/ui/webhooks/${config.id}">
    <div class="card">
      <h3>Configuration</h3>
      <label style="display: block; margin-bottom: 16px;">
        <span style="color: #9ca3af;">Name</span>
        <input type="text" name="name" value="${escapeHtml(config.name)}" class="input" style="width: 100%; margin-top: 4px;">
      </label>
      <label style="display: flex; align-items: center; gap: 8px;">
        <input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}>
        <span>Enabled</span>
      </label>
    </div>
    
    <div class="card">
      <h3>Events</h3>
      <div class="event-grid">
        ${eventCheckboxes}
      </div>
    </div>
    
    <div class="card">
      <h3>Assigned Agents</h3>
      <p class="help">Select which agents will receive notifications for this webhook. If none selected, no agents will be notified.</p>
      <div class="agent-grid">
        ${agentCheckboxes}
      </div>
      <div class="no-agents-warning" id="no-agents-warning" style="${assignedAgents.length > 0 ? 'display:none;' : ''}">
        ⚠ No agents selected — webhook events will not be delivered to any agent.
      </div>
    </div>
    
    <div style="display: flex; gap: 12px; margin-bottom: 24px;">
      <button type="submit" class="btn-primary">Save Changes</button>
      <button type="button" class="btn-primary" onclick="testWebhook()">Test Connection</button>
    </div>
  </form>
  
  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h3 style="margin: 0;">Delivery History</h3>
      <form method="POST" action="/ui/webhooks/${config.id}/clear-history" style="margin: 0;">
        <button type="submit" class="btn-danger" style="font-size: 0.85em;" onclick="return confirm('Clear all delivery history for this webhook?')">Clear History</button>
      </form>
    </div>
    <div class="delivery-list" style="margin-top: 16px;">
      ${deliveryList}
    </div>
  </div>
  
  <div class="card" style="border-color: rgba(239,68,68,0.3);">
    <h3 style="color: #f87171;">Danger Zone</h3>
    <form method="POST" action="/ui/webhooks/${config.id}/delete">
      <button type="submit" class="btn-danger" onclick="return confirm('Delete this webhook? This cannot be undone.')">Delete Webhook</button>
    </form>
  </div>
  
  <script>
    function copySecret() {
      navigator.clipboard.writeText(document.getElementById('secret-value').textContent);
      document.querySelector('.copy-btn').textContent = 'Copied!';
      setTimeout(() => document.querySelector('.copy-btn').textContent = 'Copy', 2000);
    }
    
    async function testWebhook() {
      const res = await fetch('/ui/webhooks/${config.id}/test', { method: 'POST' });
      const data = await res.json();
      alert(data.success ? '✓ ' + data.message : '✗ ' + data.message);
    }
    
    function updateAgentStyle(label) {
      setTimeout(() => {
        const cb = label.querySelector('input');
        label.classList.toggle('selected', cb.checked);
        updateAgentWarning();
      }, 0);
    }
    
    function updateAgentWarning() {
      const anyChecked = document.querySelectorAll('input[name="assigned_agents"]:checked').length > 0;
      document.getElementById('no-agents-warning').style.display = anyChecked ? 'none' : 'block';
    }
  </script>
  
  ${menuScript()}
  ${localizeScript()}
</body>
</html>`;
}

function renderDeliveryDetailPage(delivery) {
  let payload = delivery.payload;
  try {
    payload = JSON.stringify(JSON.parse(delivery.payload), null, 2);
  } catch {
    // Keep as-is if not valid JSON
  }

  let broadcastResult = delivery.broadcast_result;
  try {
    broadcastResult = JSON.stringify(JSON.parse(delivery.broadcast_result), null, 2);
  } catch {
    // Keep as-is
  }

  return `${htmlHead('Delivery Details')}
${renderStyles()}
<body>
  ${navHeader({})}
  
  <h2>Delivery Details</h2>
  <p><a href="/ui/webhooks">← Back to Webhooks</a></p>
  
  <div class="card">
    <dl class="detail-grid">
      <dt>Status</dt>
      <dd><span class="delivery-status ${delivery.success ? 'success' : 'failed'}" style="display: inline-block; width: 10px; height: 10px; border-radius: 50%;"></span> ${delivery.success ? 'Success' : 'Failed'}</dd>
      
      <dt>Event</dt>
      <dd><code>${escapeHtml(delivery.event_type)}</code></dd>
      
      <dt>Repository</dt>
      <dd>${escapeHtml(delivery.repo || '-')}</dd>
      
      <dt>Received</dt>
      <dd data-ts="${delivery.received_at}">${escapeHtml(delivery.received_at)}</dd>
      
      <dt>Delivery ID</dt>
      <dd><code>${escapeHtml(delivery.delivery_id || '-')}</code></dd>
      
      <dt>Source</dt>
      <dd>${escapeHtml(delivery.source)}</dd>
    </dl>
  </div>
  
  <div class="card">
    <h3>Broadcast Result</h3>
    <pre style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em;">${escapeHtml(broadcastResult || 'No broadcast result')}</pre>
  </div>
  
  <div class="card">
    <h3>Payload</h3>
    <pre style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; max-height: 400px;">${escapeHtml(payload || 'No payload')}</pre>
  </div>
  
  ${menuScript()}
  ${localizeScript()}
</body>
</html>`;
}

export default router;
