// Service Detail page - view/edit a specific service instance
import { Router } from 'express';
import {
  getAccountById,
  deleteAccountById,
  listApiKeys,
  getServiceAccess,
  setServiceAccessMode,
  setServiceAgentAccess,
  setBypassAuth
} from '../../lib/db.js';
import { getServiceInfo } from '../../lib/serviceRegistry.js';
import { escapeHtml, htmlHead, navHeader, socketScript, localizeScript, menuScript, renderAvatar } from './shared.js';
import { getServiceModule, services } from './services.js';

const router = Router();

// GET /ui/services/add/:serviceType - Add new service instance
router.get('/add/:serviceType', (req, res) => {
  const { serviceType } = req.params;
  const serviceModule = services.find(s => s.serviceName === serviceType);

  if (!serviceModule) {
    return res.status(404).send(renderServiceTypeNotFound(serviceType));
  }

  res.send(renderAddService(serviceModule));
});

// GET /ui/services/:id - Service detail page
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).send('Invalid service ID');
  }

  const account = getAccountById(id);
  if (!account) {
    return res.status(404).send(renderNotFound(id));
  }

  const serviceInfo = getServiceInfo(account.service);
  const serviceModule = getServiceModule(account.service);
  const agents = listApiKeys();
  const access = getServiceAccess(account.service, account.name);

  res.send(renderServiceDetail({
    account,
    serviceInfo,
    serviceModule,
    agents,
    access
  }));
});

// POST /ui/services/:id/delete - Delete service instance
router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).send('Invalid service ID');
  }
  deleteAccountById(id);
  res.redirect('/ui');
});

// POST /ui/services/:id/access/mode - Update access mode
router.post('/:id/access/mode', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { mode } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const account = getAccountById(id);
  if (!account) {
    return wantsJson ? res.status(404).json({ error: 'Not found' }) : res.status(404).send('Not found');
  }

  try {
    setServiceAccessMode(account.service, account.name, mode);
    if (wantsJson) {
      return res.json({ success: true, mode });
    }
    res.redirect(`/ui/services/${id}`);
  } catch (err) {
    if (wantsJson) {
      return res.status(400).json({ error: err.message });
    }
    res.status(400).send(err.message);
  }
});

// POST /ui/services/:id/access/agent/:agentName - Toggle agent access
router.post('/:id/access/agent/:agentName', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { agentName } = req.params;
  const { allowed, bypass_auth } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const account = getAccountById(id);
  if (!account) {
    return wantsJson ? res.status(404).json({ error: 'Not found' }) : res.status(404).send('Not found');
  }

  setServiceAgentAccess(account.service, account.name, agentName, allowed !== 'false', bypass_auth === 'true');

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect(`/ui/services/${id}`);
});

// POST /ui/services/:id/access/agent/:agentName/bypass - Toggle bypass
router.post('/:id/access/agent/:agentName/bypass', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { agentName } = req.params;
  const { enabled } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const account = getAccountById(id);
  if (!account) {
    return wantsJson ? res.status(404).json({ error: 'Not found' }) : res.status(404).send('Not found');
  }

  setBypassAuth(account.service, account.name, agentName, enabled === 'true' || enabled === true);

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect(`/ui/services/${id}`);
});

function renderNotFound(id) {
  return `${htmlHead('Service Not Found', { includeSocket: true })}
<body>
  ${navHeader()}
  <div class="card" style="text-align: center; padding: 40px;">
    <h2>Service Not Found</h2>
    <p style="color: #9ca3af;">The service with ID "${escapeHtml(String(id))}" does not exist.</p>
    <a href="/ui" class="btn-primary" style="display: inline-block; margin-top: 16px;">Back to Services</a>
  </div>
  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
</body>
</html>`;
}

function renderServiceDetail({ account, serviceInfo, serviceModule, agents, access }) {
  const displayName = serviceModule?.displayName || serviceInfo?.name || account.service;
  const icon = getServiceIcon(account.service);

  // Render access control table
  const agentRows = agents.map(agent => {
    const agentAccess = access.agents.find(a => a.name.toLowerCase() === agent.name.toLowerCase());
    const isAllowed = agentAccess ? agentAccess.allowed : (access.access_mode === 'all');
    const hasBypass = agentAccess?.bypass_auth || false;

    return `
      <tr class="agent-row" data-agent="${escapeHtml(agent.name)}">
        <td>
          <div class="agent-with-avatar">
            ${renderAvatar(agent.name, { size: 28 })}
            <span>${escapeHtml(agent.name)}</span>
          </div>
        </td>
        <td>
          <label class="toggle">
            <input type="checkbox" class="access-toggle" ${isAllowed ? 'checked' : ''} autocomplete="off">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td>
          <label class="toggle ${!isAllowed ? 'disabled' : ''}">
            <input type="checkbox" class="bypass-toggle" ${hasBypass ? 'checked' : ''} ${!isAllowed ? 'disabled' : ''} autocomplete="off">
            <span class="toggle-slider bypass"></span>
          </label>
          ${hasBypass ? '<span class="bypass-badge">⚡ Bypass</span>' : ''}
        </td>
      </tr>
    `;
  }).join('');

  // Render credential fields (masked)
  const creds = account.credentials || {};
  const credFields = Object.keys(creds).map(key => {
    const value = creds[key];
    const masked = typeof value === 'string' && value.length > 8
      ? value.substring(0, 4) + '••••••••' + value.substring(value.length - 4)
      : '••••••••';
    return `
      <div class="cred-field">
        <span class="cred-label">${escapeHtml(key)}</span>
        <span class="cred-value">${escapeHtml(masked)}</span>
      </div>
    `;
  }).join('');

  return `${htmlHead(`${displayName} - ${account.name}`, { includeSocket: true })}
<style>
  .service-detail-header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 24px;
  }
  .service-detail-header img {
    width: 48px;
    height: 48px;
  }
  .service-detail-header h2 {
    margin: 0;
    flex: 1;
  }
  .service-detail-header .account-name {
    color: #9ca3af;
    font-weight: normal;
  }

  .section { margin-bottom: 32px; }
  .section h3 { margin: 0 0 16px 0; color: #e5e7eb; }

  .cred-field {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid rgba(255,255,255,0.1);
  }
  .cred-field:last-child { border-bottom: none; }
  .cred-label { color: #9ca3af; font-size: 13px; text-transform: capitalize; }
  .cred-value { font-family: monospace; color: #6b7280; }

  .access-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .access-header h3 { margin: 0; }

  .mode-select {
    padding: 8px 12px;
    border-radius: 6px;
    background: rgba(0,0,0,0.3);
    border: 1px solid rgba(255,255,255,0.15);
    color: #f3f4f6;
    cursor: pointer;
  }
  .mode-select:focus { border-color: #6366f1; outline: none; }

  .access-table { width: 100%; border-collapse: collapse; }
  .access-table th, .access-table td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .access-table th { font-weight: 600; color: #9ca3af; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; }

  .agent-with-avatar { display: flex; align-items: center; gap: 10px; }

  .toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
  .toggle.disabled { opacity: 0.5; pointer-events: none; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #374151; transition: 0.3s; border-radius: 24px; }
  .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%; }
  .toggle input:checked + .toggle-slider { background-color: #10b981; }
  .toggle input:checked + .toggle-slider.bypass { background-color: #f59e0b; }
  .toggle input:checked + .toggle-slider:before { transform: translateX(20px); }

  .bypass-badge { font-size: 11px; background: rgba(245, 158, 11, 0.2); color: #fbbf24; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }

  .danger-zone {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    padding: 20px;
  }
  .danger-zone h3 { color: #f87171; margin: 0 0 8px 0; }
  .danger-zone p { color: #9ca3af; margin: 0 0 16px 0; font-size: 14px; }

  .no-agents { text-align: center; padding: 24px; color: #6b7280; }
</style>
<body>
  ${navHeader()}

  <div class="service-detail-header">
    <img src="${icon}" alt="${escapeHtml(displayName)}">
    <h2>${escapeHtml(displayName)} <span class="account-name">/ ${escapeHtml(account.name)}</span></h2>
    <a href="/ui" class="btn-secondary">← Back to Services</a>
  </div>

  <div class="section">
    <div class="card">
      <h3>Credentials</h3>
      <p class="help">Stored credentials for this service instance.</p>
      ${credFields || '<p class="help">No credentials stored.</p>'}
    </div>
  </div>

  <div class="section">
    <div class="card">
      <div class="access-header">
        <h3>Access Control</h3>
        <div style="display:flex;align-items:center;gap:6px;">
          <select class="mode-select" id="access-mode">
            <option value="all" ${access.access_mode === 'all' ? 'selected' : ''}>All agents</option>
            <option value="allowlist" ${access.access_mode === 'allowlist' ? 'selected' : ''}>Allowlist only</option>
            <option value="none" ${access.access_mode === 'none' ? 'selected' : ''}>No agents</option>
          </select>
          <span class="help-hint" title="All agents: every agent can access this service. Allowlist only: only agents checked below have access. No agents: nobody can access this service.">?</span>
        </div>
      </div>
      <p class="help">Control which agents can access this service and whether they can bypass the approval queue.</p>

      ${agents.length === 0 ? `
        <div class="no-agents">
          <p>No agents configured yet.</p>
          <p><a href="/ui/keys">Create an agent</a> to manage access.</p>
        </div>
      ` : `
        <table class="access-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Access</th>
              <th>Bypass Queue <span class="help-hint" title="CAUTION: When enabled, this agent's write requests (POST/PUT/DELETE) execute immediately without admin approval. Only enable for agents you fully trust with unsupervised access.">?</span></th>
            </tr>
          </thead>
          <tbody>
            ${agentRows}
          </tbody>
        </table>
      `}
    </div>
  </div>

  <div class="section">
    <div class="danger-zone">
      <h3>Danger Zone</h3>
      <p>Removing this service will delete all stored credentials. This cannot be undone.</p>
      <form method="POST" action="/ui/services/${account.id}/delete" onsubmit="return confirm('Are you sure you want to remove ${escapeHtml(displayName)} / ${escapeHtml(account.name)}? This cannot be undone.');">
        <button type="submit" class="btn-danger">Remove ${escapeHtml(displayName)} / ${escapeHtml(account.name)}</button>
      </form>
    </div>
  </div>

  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
  <script>
    const serviceId = ${JSON.stringify(account.id)};

    // Mode select change
    document.getElementById('access-mode').addEventListener('change', async function() {
      const mode = this.value;
      try {
        const res = await fetch('/ui/services/' + serviceId + '/access/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ mode })
        });
        if (!res.ok) throw new Error('Failed to update');
      } catch (err) {
        console.error('Failed to update mode:', err);
        alert('Failed to update access mode');
      }
    });

    // Access toggles
    document.querySelectorAll('.access-toggle').forEach(toggle => {
      toggle.addEventListener('change', async function() {
        const row = this.closest('.agent-row');
        const agent = row.dataset.agent;
        const allowed = this.checked;
        const bypassToggle = row.querySelector('.bypass-toggle');
        const bypass = bypassToggle ? bypassToggle.checked : false;

        if (bypassToggle) {
          bypassToggle.disabled = !allowed;
          bypassToggle.closest('.toggle').classList.toggle('disabled', !allowed);
        }

        try {
          await fetch('/ui/services/' + serviceId + '/access/agent/' + encodeURIComponent(agent), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ allowed: allowed.toString(), bypass_auth: bypass.toString() })
          });
        } catch (err) {
          console.error('Failed to update access:', err);
          this.checked = !allowed;
        }
      });
    });

    // Bypass toggles
    document.querySelectorAll('.bypass-toggle').forEach(toggle => {
      toggle.addEventListener('change', async function() {
        const row = this.closest('.agent-row');
        const agent = row.dataset.agent;
        const enabled = this.checked;

        const badge = row.querySelector('.bypass-badge');
        if (enabled && !badge) {
          const td = this.closest('td');
          const span = document.createElement('span');
          span.className = 'bypass-badge';
          span.textContent = '⚡ Bypass';
          td.appendChild(span);
        } else if (!enabled && badge) {
          badge.remove();
        }

        try {
          await fetch('/ui/services/' + serviceId + '/access/agent/' + encodeURIComponent(agent) + '/bypass', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ enabled })
          });
        } catch (err) {
          console.error('Failed to update bypass:', err);
          this.checked = !enabled;
        }
      });
    });
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

function renderServiceTypeNotFound(serviceType) {
  return `${htmlHead('Service Not Found', { includeSocket: true })}
<body>
  ${navHeader()}
  <div class="card" style="text-align: center; padding: 40px;">
    <h2>Service Not Found</h2>
    <p style="color: #9ca3af;">The service type "${escapeHtml(serviceType)}" is not available.</p>
    <a href="/ui" class="btn-primary" style="display: inline-block; margin-top: 16px;">Back to Services</a>
  </div>
  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
</body>
</html>`;
}

function renderAddService(serviceModule) {
  const { serviceName, displayName } = serviceModule;
  const icon = getServiceIcon(serviceName);

  // Get form fields based on service type
  const formFields = getServiceFormFields(serviceName);

  return `${htmlHead(`Add ${displayName}`, { includeSocket: true })}
<style>
  .add-service-header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 24px;
  }
  .add-service-header img {
    width: 48px;
    height: 48px;
  }
  .add-service-header h2 {
    margin: 0;
    flex: 1;
  }
  .form-group {
    margin-bottom: 16px;
  }
  .form-group label {
    display: block;
    margin-bottom: 6px;
    color: #d1d5db;
    font-weight: 500;
  }
  .form-group input {
    width: 100%;
    padding: 10px 12px;
    background: rgba(0,0,0,0.3);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    color: #f3f4f6;
    font-size: 14px;
    box-sizing: border-box;
  }
  .form-group input:focus {
    border-color: #6366f1;
    outline: none;
  }
  .form-group .help {
    margin-top: 6px;
    font-size: 0.85em;
    color: #6b7280;
  }
  .form-actions {
    display: flex;
    gap: 12px;
    margin-top: 24px;
  }
</style>
<body>
  ${navHeader()}

  <div class="add-service-header">
    <img src="${icon}" alt="${escapeHtml(displayName)}">
    <h2>Add ${escapeHtml(displayName)} Account</h2>
  </div>

  <div class="card">
    <form method="POST" action="/ui/${serviceName}/setup">
      <div class="form-group">
        <label>Account Name</label>
        <input type="text" name="accountName" placeholder="personal, work, etc." required autocomplete="off">
        <p class="help">A friendly name to identify this account</p>
      </div>

      ${formFields}

      <div class="form-actions">
        <button type="submit" class="btn-primary">Add Account</button>
        <a href="/ui" class="btn-secondary">Cancel</a>
      </div>
    </form>
  </div>

  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
</body>
</html>`;
}

function getServiceFormFields(serviceName) {
  const fields = {
    github: `
      <div class="form-group">
        <label>Personal Access Token</label>
        <input type="password" name="token" placeholder="ghp_xxxx or github_pat_xxxx" required autocomplete="off">
        <p class="help">Create a token at <a href="https://github.com/settings/tokens" target="_blank">github.com/settings/tokens</a></p>
      </div>`,

    bluesky: `
      <div class="form-group">
        <label>Handle (no @ symbol)</label>
        <input type="text" name="identifier" placeholder="yourname.bsky.social" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>App Password</label>
        <input type="password" name="appPassword" placeholder="xxxx-xxxx-xxxx-xxxx" required autocomplete="off">
        <p class="help">Create an app password at <a href="https://bsky.app/settings/app-passwords" target="_blank">bsky.app/settings/app-passwords</a></p>
      </div>`,

    mastodon: `
      <div class="form-group">
        <label>Instance URL</label>
        <input type="text" name="instanceUrl" placeholder="https://mastodon.social" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Access Token</label>
        <input type="password" name="accessToken" placeholder="Your access token" required autocomplete="off">
        <p class="help">Get a token from your instance's Development settings</p>
      </div>`,

    reddit: `
      <div class="form-group">
        <label>Client ID</label>
        <input type="text" name="clientId" placeholder="Your app's client ID" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Client Secret</label>
        <input type="password" name="clientSecret" placeholder="Your app's client secret" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Refresh Token</label>
        <input type="password" name="refreshToken" placeholder="OAuth refresh token" required autocomplete="off">
        <p class="help">Create an app at <a href="https://www.reddit.com/prefs/apps" target="_blank">reddit.com/prefs/apps</a></p>
      </div>`,

    google_calendar: `
      <div class="form-group">
        <label>Client ID</label>
        <input type="text" name="clientId" placeholder="xxxxx.apps.googleusercontent.com" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Client Secret</label>
        <input type="password" name="clientSecret" placeholder="Your client secret" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Refresh Token</label>
        <input type="password" name="refreshToken" placeholder="OAuth refresh token" required autocomplete="off">
        <p class="help">Set up OAuth at <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a></p>
      </div>`,

    youtube: `
      <div class="form-group">
        <label>API Key</label>
        <input type="password" name="apiKey" placeholder="Your YouTube API key" required autocomplete="off">
        <p class="help">Get an API key from <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a></p>
      </div>`,

    linkedin: `
      <div class="form-group">
        <label>Access Token</label>
        <input type="password" name="accessToken" placeholder="Your LinkedIn access token" required autocomplete="off">
        <p class="help">Get a token from <a href="https://www.linkedin.com/developers/" target="_blank">LinkedIn Developers</a></p>
      </div>`,

    jira: `
      <div class="form-group">
        <label>Domain</label>
        <input type="text" name="domain" placeholder="yourcompany.atlassian.net" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" placeholder="you@company.com" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>API Token</label>
        <input type="password" name="apiToken" placeholder="Your Jira API token" required autocomplete="off">
        <p class="help">Create a token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">Atlassian API Tokens</a></p>
      </div>`,

    fitbit: `
      <div class="form-group">
        <label>Client ID</label>
        <input type="text" name="clientId" placeholder="Your Fitbit app client ID" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Client Secret</label>
        <input type="password" name="clientSecret" placeholder="Your client secret" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Refresh Token</label>
        <input type="password" name="refreshToken" placeholder="OAuth refresh token" required autocomplete="off">
        <p class="help">Create an app at <a href="https://dev.fitbit.com/apps" target="_blank">dev.fitbit.com</a></p>
      </div>`,

    brave: `
      <div class="form-group">
        <label>API Key</label>
        <input type="password" name="apiKey" placeholder="BSA..." required autocomplete="off">
        <p class="help">Get an API key from <a href="https://brave.com/search/api/" target="_blank">Brave Search API</a></p>
      </div>`,

    google_search: `
      <div class="form-group">
        <label>API Key</label>
        <input type="password" name="apiKey" placeholder="Your Google API key" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Search Engine ID (CX)</label>
        <input type="text" name="cx" placeholder="Your custom search engine ID" required autocomplete="off">
        <p class="help">Set up at <a href="https://programmablesearchengine.google.com/" target="_blank">Programmable Search Engine</a></p>
      </div>`
  };

  return fields[serviceName] || `
    <div class="form-group">
      <label>API Key</label>
      <input type="password" name="apiKey" placeholder="Your API key" required autocomplete="off">
    </div>`;
}

export default router;
