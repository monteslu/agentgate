// Home page route - renders the main dashboard
import { Router } from 'express';
import {
  listAccounts, getSetting,
  getPendingQueueCount, getMessagingMode, listPendingMessages,
  getSharedQueueVisibility, getAgentWithdrawEnabled
} from '../../lib/db.js';
import { getHsyncUrl, isHsyncConnected } from '../../lib/hsyncManager.js';
import { registerAllRoutes, renderCatalog, renderConfiguredCards, renderUnconfiguredCards } from './services.js';
import { PORT, BASE_URL } from './shared.js';

const router = Router();

// Home page route
router.get('/', (req, res) => {
  const accounts = listAccounts();
  const hsyncConfig = getSetting('hsync');
  const hsyncUrl = getHsyncUrl();
  const hsyncConnected = isHsyncConnected();
  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = listPendingMessages().length;
  const sharedQueueVisibility = getSharedQueueVisibility();
  const agentWithdrawEnabled = getAgentWithdrawEnabled();

  res.send(renderPage(accounts, { hsyncConfig, hsyncUrl, hsyncConnected, pendingQueueCount, messagingMode, pendingMessagesCount, sharedQueueVisibility, agentWithdrawEnabled }));
});

// Register all OAuth service routes (github, bluesky, reddit, etc.)
registerAllRoutes(router, BASE_URL);

// ============================================================================
// Render Functions - Each handles a specific section of the page
// ============================================================================

/**
 * Render the <head> section with title, styles, and scripts
 */
function renderHead() {
  return `
  <title>agentgate - Admin</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    /* ===== Services Catalog Styles ===== */
    .catalog-category { margin-bottom: 10px; }
    .catalog-category-title {
      margin: 0 0 6px 0;
      font-size: 0.8em;
      color: #9ca3af;
      font-weight: 600;
    }
    .catalog-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .catalog-tile {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      text-decoration: none;
      color: #f3f4f6;
      transition: background 0.15s, border-color 0.15s;
      cursor: pointer;
      white-space: nowrap;
    }
    .catalog-tile:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(129,140,248,0.4);
    }
    .catalog-tile-disabled {
      opacity: 0.45;
      cursor: default;
      pointer-events: none;
    }
    .catalog-tile-icon { font-size: 16px; }
    .catalog-tile-name { font-size: 0.8em; font-weight: 500; }
    .catalog-tile-badge {
      font-size: 0.6em;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
    }
    .catalog-tile-badge.configured {
      background: rgba(16,185,129,0.15);
      color: #34d399;
    }
    .catalog-tile-badge.coming-soon {
      background: rgba(156,163,175,0.15);
      color: #9ca3af;
    }
    .services-section { margin-top: 20px; }
    .services-section h3 {
      color: #9ca3af;
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 10px;
    }
  </style>
  <script>
    function copyText(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    // Open and scroll to a service card's <details> element
    function openServiceCard(serviceId) {
      const el = document.getElementById('service-' + serviceId);
      if (!el) return;
      const details = el.querySelector('details');
      if (details) details.open = true;
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }

    // Real-time updates via Socket.io
    document.addEventListener('DOMContentLoaded', function() {
      const socket = io();

      socket.on('counts', function(data) {
        // Update queue badge
        const queueBadge = document.getElementById('queue-badge');
        if (queueBadge) {
          if (data.queue.pending > 0) {
            queueBadge.textContent = data.queue.pending;
            queueBadge.style.display = '';
          } else {
            queueBadge.style.display = 'none';
          }
        }

        // Update messages badge
        const msgBadge = document.getElementById('messages-badge');
        if (msgBadge) {
          if (data.messages.pending > 0) {
            msgBadge.textContent = data.messages.pending;
            msgBadge.style.display = '';
          } else {
            msgBadge.style.display = 'none';
          }
        }

        // Show/hide messages nav based on messaging mode
        const msgNav = document.getElementById('messages-nav');
        if (msgNav) {
          msgNav.style.display = data.messagingEnabled ? '' : 'none';
        }
      });

      socket.on('connect', function() {
        console.log('Socket.io connected for real-time updates');
      });

      // Localize UTC dates to browser timezone
      document.querySelectorAll('.utc-date').forEach(function(el) {
        const utc = el.dataset.utc;
        if (utc) {
          el.textContent = new Date(utc).toLocaleString();
        }
      });
      // Localize title attributes with UTC dates
      document.querySelectorAll('.utc-title').forEach(function(el) {
        const utc = el.dataset.utc;
        if (utc) {
          el.title = 'Notified at ' + new Date(utc).toLocaleString();
        }
      });
    });
  </script>`;
}

/**
 * Render the header with logo, title, and navigation
 */
function renderHeader({ pendingQueueCount, messagingMode, pendingMessagesCount }) {
  return `
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <img src="/public/favicon.svg" alt="agentgate" style="height: 64px;">
      <h1 style="margin: 0;">agentgate</h1>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/keys" class="nav-btn nav-btn-default">Agents</a>
      <a href="/ui/queue" class="nav-btn nav-btn-default" style="position: relative;">
        Write Queue
        <span id="queue-badge" class="badge" ${pendingQueueCount > 0 ? '' : 'style="display:none"'}>${pendingQueueCount}</span>
      </a>
      <a href="/ui/messages" id="messages-nav" class="nav-btn nav-btn-default" style="position: relative;${messagingMode === 'off' ? ' display:none;' : ''}">
        Messages
        <span id="messages-badge" class="badge" ${pendingMessagesCount > 0 ? '' : 'style="display:none"'}>${pendingMessagesCount}</span>
      </a>
      <div class="nav-divider"></div>
      <a href="/ui#settings" class="nav-btn nav-btn-default" title="Settings" >⚙️</a>
      <form method="POST" action="/ui/logout" style="margin: 0;">
        <button type="submit" class="nav-btn nav-btn-default" style="color: #f87171;">Logout</button>
      </form>
    </div>
  </div>
  <p>API gateway for agents with human-in-the-loop write approval.</p>
  <p class="help">API pattern: <code>/api/{service}/{accountName}/...</code></p>`;
}

/**
 * Render the services section — catalog picker + configured services
 */
function renderServices(accounts) {
  const hasConfigured = accounts.length > 0;

  return `
  <h2>Services</h2>

  <!-- ===== Add a Service — Catalog Picker ===== -->
  <div class="card">
    <details>
      <summary style="font-weight: 600; font-size: 1.05em;">➕ Add a Service</summary>
      <div style="margin-top: 16px;">
        <p class="help" style="margin-bottom: 14px;">Browse available services. Click one to start setup.</p>
        ${renderCatalog(accounts)}
      </div>
    </details>
  </div>

  <!-- ===== Your Services — Configured accounts ===== -->
  ${hasConfigured ? `
  <div class="services-section">
    <h3>🔗 Your Services</h3>
    ${renderConfiguredCards(accounts, BASE_URL)}
  </div>` : ''}

  <!-- ===== Available to Set Up — Unconfigured implemented services ===== -->
  <div class="services-section">
    <h3>⚙️ Set Up</h3>
    ${renderUnconfiguredCards(accounts, BASE_URL)}
  </div>`;
}

/**
 * Render the usage documentation section
 */
function renderUsage() {
  return `
  <h2>Usage</h2>
  <div class="card">
    <p>Make requests with your API key in the Authorization header:</p>
    <pre>
# Read requests (immediate)
curl -H "Authorization: Bearer rms_your_key_here" \\
  http://localhost:${PORT}/api/github/personal/users/octocat

# Write requests (queued for approval)
curl -X POST http://localhost:${PORT}/api/queue/github/personal/submit \\
  -H "Authorization: Bearer rms_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"requests":[{"method":"POST","path":"/repos/owner/repo/issues","body":{"title":"Bug"}}],"comment":"Creating issue"}'
    </pre>
  </div>`;
}

/**
 * Render the messaging configuration section
 */
function renderMessagingSection({ messagingMode, pendingMessagesCount }) {
  return `
  <div class="card">
    <details ${messagingMode !== 'off' ? 'open' : ''}>
      <summary>Agent Messaging ${messagingMode !== 'off' ? `<span class="status configured">${messagingMode}</span>` : ''}</summary>
      <div style="margin-top: 16px;">
        <p class="help">Allow agents to send messages to each other. Messages can require human approval (supervised) or be delivered immediately (open).</p>
        <form method="POST" action="/ui/messaging/mode" style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
          <label style="display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
            <input type="radio" name="mode" value="off" ${messagingMode === 'off' ? 'checked' : ''}>
            <span>Off</span>
          </label>
          <label style="display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
            <input type="radio" name="mode" value="supervised" ${messagingMode === 'supervised' ? 'checked' : ''}>
            <span>Supervised</span>
          </label>
          <label style="display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
            <input type="radio" name="mode" value="open" ${messagingMode === 'open' ? 'checked' : ''}>
            <span>Open</span>
          </label>
          <button type="submit" class="btn-primary btn-sm">Save</button>
        </form>
        ${messagingMode === 'supervised' && pendingMessagesCount > 0 ? `
          <p style="margin-top: 12px;"><a href="/ui/messages" style="color: #818cf8;">${pendingMessagesCount} pending message${pendingMessagesCount > 1 ? 's' : ''} awaiting approval →</a></p>
        ` : ''}
      </div>
    </details>
  </div>`;
}

/**
 * Render the hsync remote access configuration section
 */
function renderHsyncSection({ hsyncConfig, hsyncUrl, hsyncConnected }) {
  const enabledContent = `
          <p>URL: <strong>${hsyncConfig?.url}</strong></p>
          ${hsyncUrl ? `<p>Public URL: <span class="copyable">${hsyncUrl} <button type="button" class="copy-btn" onclick="copyText('${hsyncUrl}', this)">Copy</button></span></p>` : '<p class="help">Connecting... (refresh page to see URL)</p>'}
          <form method="POST" action="/ui/hsync/delete">
            <button type="submit" class="btn-danger">Disable</button>
          </form>`;

  const disabledContent = `
          <p class="help">Optional: Use <a href="https://hsync.tech" target="_blank">hsync</a> to expose this gateway to remote agents without opening ports.</p>
          <form method="POST" action="/ui/hsync/setup">
            <label>URL</label>
            <input type="text" name="url" placeholder="https://yourname.hsync.tech" required>
            <label>Token (optional)</label>
            <input type="password" name="token" placeholder="Token if required">
            <button type="submit" class="btn-primary">Enable hsync</button>
          </form>`;

  const statusBadge = hsyncConnected
    ? '<span class="status configured">Connected</span>'
    : hsyncConfig?.enabled
      ? '<span class="status not-configured">Disconnected</span>'
      : '';

  return `
  <div class="card">
    <details ${hsyncConfig?.enabled ? 'open' : ''}>
      <summary>hsync (Remote Access) ${statusBadge}</summary>
      <div style="margin-top: 16px;">
        ${hsyncConfig?.enabled ? enabledContent : disabledContent}
      </div>
    </details>
  </div>`;
}

/**
 * Render the queue settings configuration section
 */
function renderQueueSettingsSection({ sharedQueueVisibility, agentWithdrawEnabled }) {
  return `
  <div class="card">
    <details ${sharedQueueVisibility || agentWithdrawEnabled ? 'open' : ''}>
      <summary>Queue Settings ${sharedQueueVisibility || agentWithdrawEnabled ? '<span class="status configured">Configured</span>' : ''}</summary>
      <div style="margin-top: 16px;">
        <p class="help">Configure how agents interact with the write queue.</p>
        
        <div style="margin-bottom: 16px; padding: 16px; background: rgba(0,0,0,0.2); border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div>
              <strong style="color: #f3f4f6;">Shared Queue Visibility</strong>
              <p class="help" style="margin: 4px 0 0 0;">When enabled, agents can see ALL queue items, not just their own.</p>
            </div>
            <form method="POST" action="/ui/queue/settings/shared-visibility" style="margin: 0;">
              <input type="hidden" name="enabled" value="${sharedQueueVisibility ? 'false' : 'true'}">
              <button type="submit" class="btn-sm ${sharedQueueVisibility ? 'btn-danger' : 'btn-primary'}">${sharedQueueVisibility ? 'Disable' : 'Enable'}</button>
            </form>
          </div>
        </div>

        <div style="padding: 16px; background: rgba(0,0,0,0.2); border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div>
              <strong style="color: #f3f4f6;">Agent Withdraw</strong>
              <p class="help" style="margin: 4px 0 0 0;">Allow agents to withdraw their own pending queue submissions.</p>
            </div>
            <form method="POST" action="/ui/queue/settings/agent-withdraw" style="margin: 0;">
              <input type="hidden" name="enabled" value="${agentWithdrawEnabled ? 'false' : 'true'}">
              <button type="submit" class="btn-sm ${agentWithdrawEnabled ? 'btn-danger' : 'btn-primary'}">${agentWithdrawEnabled ? 'Disable' : 'Enable'}</button>
            </form>
          </div>
        </div>
      </div>
    </details>
  </div>`;
}

/**
 * Render the advanced section containing all configuration options
 */
function renderAdvanced(options) {
  return `
  <h2>Advanced</h2>
  ${renderMessagingSection(options)}
  ${renderHsyncSection(options)}
  ${renderQueueSettingsSection(options)}`;
}

/**
 * Render the complete page by composing all sections
 */
function renderPage(accounts, options) {
  return `<!DOCTYPE html>
<html>
<head>${renderHead()}</head>
<body>
  ${renderHeader(options)}
  ${renderServices(accounts)}
  ${renderUsage()}
  ${renderAdvanced(options)}
</body>
</html>`;
}


export default router;
