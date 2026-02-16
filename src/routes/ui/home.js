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
  `;
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

  <div class="card">
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

  return `${htmlHead('Services', { includeSocket: true })}
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
