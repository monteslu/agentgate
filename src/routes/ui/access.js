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
              <input type="checkbox" class="access-toggle" ${isAllowed ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </td>
          <td>
            <label class="toggle ${!isAllowed ? 'disabled' : ''}">
              <input type="checkbox" class="bypass-toggle" ${hasBypass ? 'checked' : ''} ${!isAllowed ? 'disabled' : ''}>
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
          <select class="mode-select" data-service="${escapeHtml(svc.service)}" data-account="${escapeHtml(svc.account_name)}">
            <option value="all" ${access.access_mode === 'all' ? 'selected' : ''}>All agents</option>
            <option value="allowlist" ${access.access_mode === 'allowlist' ? 'selected' : ''}>Allowlist only</option>
            <option value="none" ${access.access_mode === 'none' ? 'selected' : ''}>No agents</option>
          </select>
        </div>
        
        <table class="access-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Access</th>
              <th>Bypass Queue</th>
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
  <style>
    .service-card { margin-bottom: 24px; }
    .service-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .service-header h3 { margin: 0; }
    .mode-select { padding: 8px 12px; border-radius: 6px; background: #1f2937; border: 1px solid #374151; color: #f3f4f6; cursor: pointer; }
    .mode-select:focus { border-color: #6366f1; outline: none; }
    
    .access-table { width: 100%; border-collapse: collapse; }
    .access-table th, .access-table td { padding: 12px; text-align: left; border-bottom: 1px solid #374151; }
    .access-table th { font-weight: 600; color: #9ca3af; font-size: 14px; }
    
    .agent-with-avatar { display: flex; align-items: center; gap: 10px; }
    
    /* Toggle switch */
    .toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
    .toggle.disabled { opacity: 0.5; pointer-events: none; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #374151; transition: 0.3s; border-radius: 24px; }
    .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%; }
    .toggle input:checked + .toggle-slider { background-color: #10b981; }
    .toggle input:checked + .toggle-slider.bypass { background-color: #f59e0b; }
    .toggle input:checked + .toggle-slider:before { transform: translateX(20px); }
    
    .bypass-badge { font-size: 11px; background: rgba(245, 158, 11, 0.2); color: #fbbf24; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
    
    .no-services { text-align: center; padding: 40px; color: #9ca3af; }
    
    .info-box { background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .info-box h4 { margin: 0 0 8px 0; color: #60a5fa; }
    .info-box p { margin: 0; color: #9ca3af; font-size: 14px; }
    .info-box ul { margin: 8px 0 0 0; padding-left: 20px; color: #9ca3af; font-size: 14px; }
  </style>
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
