// Service Access Control routes
import { Router } from 'express';
import {
  listServicesWithAccess,
  listApiKeys,
  getServiceAccess,
  setServiceAccessMode,
  setServiceAgentAccess,
  setBypassAuth,
  checkBypassAuth
} from '../../lib/db.js';
import { escapeHtml, htmlHead, navHeader, socketScript, localizeScript, menuScript, renderAvatar } from './shared.js';

const router = Router();

// Access Control page
router.get('/', (req, res) => {
  const services = listServicesWithAccess();
  const agents = listApiKeys();
  res.send(renderAccessPage(services, agents));
});

// Update access mode for a service
router.post('/:service/:account/mode', (req, res) => {
  const { service, account } = req.params;
  const { mode } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');
  
  try {
    setServiceAccessMode(service, account, mode);
    if (wantsJson) {
      return res.json({ success: true, mode });
    }
    res.redirect('/ui/access');
  } catch (err) {
    if (wantsJson) {
      return res.status(400).json({ error: err.message });
    }
    res.status(400).send(err.message);
  }
});

// Toggle agent access for a service
router.post('/:service/:account/agent/:agentName', (req, res) => {
  const { service, account, agentName } = req.params;
  const { allowed, bypass_auth } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');
  
  // Update access
  setServiceAgentAccess(service, account, agentName, allowed !== 'false', bypass_auth === 'true');
  
  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/access');
});

// Toggle bypass_auth for an agent
router.post('/:service/:account/agent/:agentName/bypass', (req, res) => {
  const { service, account, agentName } = req.params;
  const { enabled } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');
  
  setBypassAuth(service, account, agentName, enabled === 'true' || enabled === true);
  
  if (wantsJson) {
    const hasBypass = checkBypassAuth(service, account, agentName);
    return res.json({ success: true, bypass_auth: hasBypass });
  }
  res.redirect('/ui/access');
});

function renderAccessPage(services, agents) {
  const renderServiceCard = (svc) => {
    const access = getServiceAccess(svc.service, svc.account_name);
    const agentRows = agents.map(agent => {
      const agentAccess = access.agents.find(a => a.name.toLowerCase() === agent.name.toLowerCase());
      const isAllowed = agentAccess ? agentAccess.allowed : (access.access_mode === 'all');
      const hasBypass = agentAccess?.bypass_auth || false;
      
      return `
        <tr class="agent-row" data-service="${escapeHtml(svc.service)}" data-account="${escapeHtml(svc.account_name)}" data-agent="${escapeHtml(agent.name)}">
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
    
    return `
      <div class="card service-card" data-service="${escapeHtml(svc.service)}" data-account="${escapeHtml(svc.account_name)}">
        <div class="service-header">
          <h3>${escapeHtml(svc.service)} / ${escapeHtml(svc.account_name)}</h3>
          <div class="flex-center gap-6">
            <select class="mode-select" data-service="${escapeHtml(svc.service)}" data-account="${escapeHtml(svc.account_name)}">
              <option value="all" ${access.access_mode === 'all' ? 'selected' : ''}>All agents</option>
              <option value="allowlist" ${access.access_mode === 'allowlist' ? 'selected' : ''}>Allowlist only</option>
              <option value="none" ${access.access_mode === 'none' ? 'selected' : ''}>No agents</option>
            </select>
            <span class="help-hint" title="All agents: every agent can access this service. Allowlist only: only agents checked below have access. No agents: nobody can access this service.">?</span>
          </div>
        </div>
        
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
      </div>
    `;
  };
  
  return `${htmlHead('Access Control', { includeSocket: true })}
  
<body>
  ${navHeader()}

  <div class="info-box">
    <h4>🔐 Service Access Control</h4>
    <p>Manage which agents can access which services, and enable queue bypass for trusted agents.</p>
    <ul>
      <li><strong>Access</strong> - Whether the agent can use this service</li>
      <li><strong>Bypass Queue</strong> - Skip approval queue and execute immediately (⚡ use with caution!)</li>
    </ul>
  </div>
  
  ${services.length === 0 ? `
    <div class="card no-services">
      <p>No services configured yet.</p>
      <p>Connect a service (GitHub, Bluesky, etc.) from the <a href="/ui">home page</a> to manage access.</p>
    </div>
  ` : services.map(renderServiceCard).join('')}
  
  <script>
    // Mode select change
    document.querySelectorAll('.mode-select').forEach(select => {
      select.addEventListener('change', async function() {
        const service = this.dataset.service;
        const account = this.dataset.account;
        const mode = this.value;
        const originalValue = this.dataset.originalMode || this.value;
        
        try {
          const res = await fetch('/ui/access/' + encodeURIComponent(service) + '/' + encodeURIComponent(account) + '/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ mode: mode })
          });
          if (!res.ok) throw new Error('Failed to update mode');
          this.dataset.originalMode = mode;
        } catch (err) {
          console.error('Failed to update mode:', err);
          this.value = originalValue; // Revert on error
        }
      });
    });
    
    // Access toggle
    document.querySelectorAll('.access-toggle').forEach(toggle => {
      toggle.addEventListener('change', async function() {
        const row = this.closest('.agent-row');
        const service = row.dataset.service;
        const account = row.dataset.account;
        const agent = row.dataset.agent;
        const allowed = this.checked;
        
        // Also get bypass status
        const bypassToggle = row.querySelector('.bypass-toggle');
        const bypass = bypassToggle ? bypassToggle.checked : false;
        
        // Enable/disable bypass toggle based on access
        if (bypassToggle) {
          bypassToggle.disabled = !allowed;
          bypassToggle.closest('.toggle').classList.toggle('disabled', !allowed);
        }
        
        try {
          await fetch('/ui/access/' + encodeURIComponent(service) + '/' + encodeURIComponent(account) + '/agent/' + encodeURIComponent(agent), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ allowed: allowed.toString(), bypass_auth: bypass.toString() })
          });
        } catch (err) {
          console.error('Failed to update access:', err);
          this.checked = !allowed; // Revert on error
        }
      });
    });
    
    // Bypass toggle
    document.querySelectorAll('.bypass-toggle').forEach(toggle => {
      toggle.addEventListener('change', async function() {
        const row = this.closest('.agent-row');
        const service = row.dataset.service;
        const account = row.dataset.account;
        const agent = row.dataset.agent;
        const enabled = this.checked;
        
        // Update badge
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
          await fetch('/ui/access/' + encodeURIComponent(service) + '/' + encodeURIComponent(account) + '/agent/' + encodeURIComponent(agent) + '/bypass', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ enabled: enabled })
          });
        } catch (err) {
          console.error('Failed to update bypass:', err);
          this.checked = !enabled; // Revert on error
        }
      });
    });
  </script>
${socketScript()}
${menuScript()}
${localizeScript()}
</body>
</html>`;
}

export default router;
