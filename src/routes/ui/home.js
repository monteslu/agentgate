// Home page route - renders the main dashboard
import { Router } from 'express';
import {
  listAccounts,
  getPendingQueueCount, getMessagingMode, listPendingMessages
} from '../../lib/db.js';
import { registerAllRoutes, services, getServiceModule } from './services.js';
import { PORT, BASE_URL, htmlHead, navHeader, menuScript, socketScript, localizeScript, copyScript } from './shared.js';

const router = Router();

// Home page route
router.get('/', (req, res) => {
  const accounts = listAccounts();
  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = listPendingMessages().length;

  res.send(renderPage(accounts, { pendingQueueCount, messagingMode, pendingMessagesCount }));
});

// Register all OAuth service routes (github, bluesky, reddit, etc.)
registerAllRoutes(router, BASE_URL);

// ============================================================================
// Render Functions - Each handles a specific section of the page
// ============================================================================

/**
 * Render inline styles for the services page
 */
function renderServicesStyles() {
  return `
  <style>
    /* ===== Services List Styles ===== */
    .services-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .services-header h2 { margin: 0; }

    .service-row {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      margin-bottom: 8px;
      gap: 14px;
    }
    .service-row:hover {
      background: rgba(255,255,255,0.05);
      border-color: rgba(255,255,255,0.12);
    }
    .service-row img {
      width: 28px;
      height: 28px;
      flex-shrink: 0;
    }
    .service-row .service-type {
      color: #9ca3af;
      font-size: 0.9em;
      min-width: 100px;
    }
    .service-row .account-name {
      flex: 1;
      color: #e5e7eb;
      font-weight: 500;
    }
    .service-row .btn-sm {
      padding: 6px 14px;
      font-size: 0.85em;
      background: rgba(99,102,241,0.2);
      color: #a5b4fc;
      border: 1px solid rgba(99,102,241,0.4);
      border-radius: 5px;
      text-decoration: none;
      cursor: pointer;
    }
    .service-row .btn-sm:hover {
      background: rgba(99,102,241,0.3);
      border-color: rgba(99,102,241,0.6);
    }

    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: #6b7280;
    }

    /* Add Service Modal/Dropdown */
    .add-service-dropdown {
      position: relative;
      display: inline-block;
    }
    .add-service-menu {
      display: none;
      position: absolute;
      right: 0;
      top: 100%;
      margin-top: 8px;
      background: #1f2937;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      padding: 8px;
      min-width: 200px;
      z-index: 100;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    }
    .add-service-menu.show { display: block; }
    .add-service-menu a {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      color: #e5e7eb;
      text-decoration: none;
      border-radius: 6px;
    }
    .add-service-menu a:hover {
      background: rgba(99,102,241,0.2);
    }
    .add-service-menu img {
      width: 20px;
      height: 20px;
    }
  </style>`;
}

/**
 * Get icon path for a service
 */
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

/**
 * Render the services section — simple flat list
 */
function renderServices(accounts) {
  // Build service menu items
  const serviceMenuItems = services.map(s => {
    const icon = getServiceIcon(s.serviceName);
    return `<a href="/ui/services/add/${s.serviceName}"><img src="${icon}" alt="">${s.displayName}</a>`;
  }).join('');

  // Render account rows
  const accountRows = accounts.length === 0
    ? '<div class="empty-state">No services configured yet. Click "Add Service" to get started.</div>'
    : accounts.map(acc => {
      const svcModule = getServiceModule(acc.service);
      const displayName = svcModule?.displayName || acc.service;
      const icon = getServiceIcon(acc.service);
      return `
          <div class="service-row">
            <img src="${icon}" alt="${displayName}">
            <span class="service-type">${displayName}</span>
            <span class="account-name">${escapeHtml(acc.name)}</span>
            <a href="/ui/services/${acc.id}" class="btn-sm">Details</a>
          </div>`;
    }).join('');

  return `
  <div class="services-header">
    <h2>Services</h2>
    <div class="add-service-dropdown">
      <button class="btn-primary" onclick="toggleAddMenu(event)">+ Add Service</button>
      <div class="add-service-menu" id="add-service-menu">
        ${serviceMenuItems}
      </div>
    </div>
  </div>

  <div class="card" style="padding: 0; overflow: hidden;">
    ${accountRows}
  </div>

  <script>
    function toggleAddMenu(e) {
      e.stopPropagation();
      document.getElementById('add-service-menu').classList.toggle('show');
    }
    document.addEventListener('click', () => {
      document.getElementById('add-service-menu').classList.remove('show');
    });
  </script>`;
}

function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
 * Render the complete page by composing all sections
 */
function renderPage(accounts, options) {
  const { pendingQueueCount, messagingMode, pendingMessagesCount } = options;

  return `<!DOCTYPE html>
<html>
${htmlHead('Services', { includeSocket: true })}
${renderServicesStyles()}
<body>
  ${navHeader({ pendingQueueCount, pendingMessagesCount, messagingMode })}

  <p>API gateway for agents with human-in-the-loop write approval.</p>
  <p class="help">API pattern: <code>/api/{service}/{accountName}/...</code></p>

  ${renderServices(accounts)}
  ${renderUsage()}

  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
  ${copyScript()}
</body>
</html>`;
}


export default router;
