/**
 * Service card registration - separated to avoid circular dependencies
 * 
 * ⚠️ CIRCULAR DEPENDENCY WARNING:
 * This file imports from individual service files (github.js, bluesky.js, etc.)
 * and is imported by home.js and index.js.
 * 
 * DO NOT import from './index.js' in any service file or this file.
 * Doing so will create a circular dependency that breaks imports.
 * 
 * Import chain: services → home.js → index.js → src/index.js
 */
import * as github from './github.js';
import * as bluesky from './bluesky.js';
import * as reddit from './reddit.js';
import * as calendar from './calendar.js';
import * as youtube from './youtube.js';
import * as mastodon from './mastodon.js';
import * as linkedin from './linkedin.js';
import * as jira from './jira.js';
import * as fitbit from './fitbit.js';
import * as brave from './brave.js';
import * as googleSearch from './google-search.js';
import * as homeassistant from './homeassistant.js';

// Export all implemented services in display order
export const services = [
  github,
  bluesky,
  mastodon,
  reddit,
  calendar,
  youtube,
  fitbit,
  jira,
  linkedin,
  brave,
  googleSearch,
  homeassistant
];

// Full service catalog with categories — includes both implemented and coming-soon services
export const catalog = [
  {
    category: 'Social & Communication',
    services: [
      { id: 'bluesky', name: 'Bluesky', icon: '🦋', implemented: true },
      { id: 'mastodon', name: 'Mastodon', icon: '🐘', implemented: true },
      { id: 'linkedin', name: 'LinkedIn', icon: '💼', implemented: true },
      { id: 'reddit', name: 'Reddit', icon: '🤖', implemented: true },
      { id: 'twitter', name: 'Twitter / X', icon: '🐦', implemented: false },
      { id: 'slack', name: 'Slack', icon: '💬', implemented: false },
      { id: 'email', name: 'Email', icon: '✉️', implemented: false }
    ]
  },
  {
    category: 'Developer & Productivity',
    services: [
      { id: 'github', name: 'GitHub', icon: '🐙', implemented: true },
      { id: 'jira', name: 'Jira', icon: '📋', implemented: true },
      { id: 'calendar', name: 'Calendar', icon: '📅', implemented: true },
      { id: 'notion', name: 'Notion', icon: '📝', implemented: false }
    ]
  },
  {
    category: 'Search & Media',
    services: [
      { id: 'brave', name: 'Brave Search', icon: '🦁', implemented: true },
      { id: 'google_search', name: 'Google Search', icon: '🔍', implemented: true },
      { id: 'youtube', name: 'YouTube', icon: '▶️', implemented: true },
      { id: 'spotify', name: 'Spotify', icon: '🎵', implemented: false }
    ]
  },
  {
    category: 'Health & Finance',
    services: [
      { id: 'fitbit', name: 'Fitbit', icon: '⌚', implemented: true },
      { id: 'stripe', name: 'Stripe', icon: '💳', implemented: false }
    ]
  },
  {
    category: 'IoT & Smart Home',
    services: [
      { id: 'homeassistant', name: 'Home Assistant', icon: '🏠', implemented: true }
    ]
  }
];

// Map service id → module for quick lookup
const serviceMap = new Map(services.map(s => [s.serviceName, s]));

/**
 * Get the service module by id, or null if not implemented
 */
export function getServiceModule(serviceId) {
  return serviceMap.get(serviceId) || null;
}

// Register all service routes
export function registerAllRoutes(router, baseUrl) {
  for (const service of services) {
    service.registerRoutes(router, baseUrl);
  }
}

// Render all service cards (legacy helper — still used for "Your Services" section)
export function renderAllCards(accounts, baseUrl) {
  return services.map(service => service.renderCard(accounts, baseUrl)).join('\n');
}

/**
 * Render the catalog grid — browse available services grouped by category.
 * Services with existing accounts are marked, unimplemented ones show "coming soon".
 */
export function renderCatalog(accounts) {
  const configuredServiceIds = new Set(accounts.map(a => a.service));

  return catalog.map(cat => {
    const tiles = cat.services.map(svc => {
      const isConfigured = configuredServiceIds.has(svc.id);
      const isImplemented = svc.implemented;

      if (!isImplemented) {
        // Coming soon — disabled tile
        return `
        <div class="catalog-tile catalog-tile-disabled" title="${svc.name} — coming soon">
          <span class="catalog-tile-icon">${svc.icon}</span>
          <span class="catalog-tile-name">${svc.name}</span>
          <span class="catalog-tile-badge coming-soon">Soon</span>
        </div>`;
      }

      // Implemented service — link to its setup section
      const badge = isConfigured
        ? '<span class="catalog-tile-badge configured">✓</span>'
        : '';
      return `
        <a href="#service-${svc.id}" class="catalog-tile" onclick="openServiceCard('${svc.id}')">
          <span class="catalog-tile-icon">${svc.icon}</span>
          <span class="catalog-tile-name">${svc.name}</span>
          ${badge}
        </a>`;
    }).join('\n');

    return `
      <div class="catalog-category">
        <h4 class="catalog-category-title">${cat.category}</h4>
        <div class="catalog-grid">
          ${tiles}
        </div>
      </div>`;
  }).join('\n');
}

/**
 * Render only cards for services that have configured accounts ("Your Services").
 * Shows a simple list with Details link for each configured account.
 */
export function renderConfiguredCards(accounts) {
  // Group accounts by service
  const byService = {};
  for (const acc of accounts) {
    if (!byService[acc.service]) byService[acc.service] = [];
    byService[acc.service].push(acc);
  }

  const serviceIds = Object.keys(byService);
  if (serviceIds.length === 0) {
    return '<div class="empty-state-box">No services configured yet. Click a service below to add one.</div>';
  }

  return serviceIds.map(serviceId => {
    const svcAccounts = byService[serviceId];
    const svcModule = getServiceModule(serviceId);
    const displayName = svcModule?.displayName || serviceId;
    const icon = getServiceIcon(serviceId);

    const accountRows = svcAccounts.map(acc => {
      const retryRoute = getRetryRoute(serviceId);
      const { hasToken, hasCredentials } = acc.status || {};
      const reauthBtn = (retryRoute && hasCredentials) ? `
        <form method="POST" action="${retryRoute}" style="margin:0;">
          <input type="hidden" name="accountName" value="${escapeHtml(acc.name)}" autocomplete="off">
          <button type="submit" class="btn-sm ${hasToken ? 'btn-secondary' : 'btn-primary'}">${hasToken ? 'Re-authorize' : 'Retry Auth'}</button>
        </form>` : '';
      return `
      <div class="configured-account">
        <span class="account-name">${escapeHtml(acc.name)}</span>
        <div style="display: flex; gap: 8px;">
          ${reauthBtn}
          <a href="/ui/services/${acc.id}" class="btn-sm">Details</a>
        </div>
      </div>`;
    }).join('');

    return `
      <div class="card configured-service" id="service-${serviceId}">
        <div class="service-header">
          <img class="service-icon" src="${icon}" alt="${escapeHtml(displayName)}">
          <h3>${escapeHtml(displayName)}</h3>
        </div>
        ${accountRows}
      </div>
    `;
  }).join('\n');
}

/**
 * Get the OAuth retry/re-auth route for a service, or null if not an OAuth service.
 */
function getRetryRoute(service) {
  const routes = {
    youtube: '/ui/youtube/retry',
    google_calendar: '/ui/google/retry',
    fitbit: '/ui/fitbit/retry',
    linkedin: '/ui/linkedin/retry',
    reddit: '/ui/reddit/retry',
    mastodon: '/ui/mastodon/retry'
  };
  return routes[service] || null;
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
    google_search: '/public/icons/google-search.svg',
    homeassistant: '/public/icons/homeassistant.svg'
  };
  return icons[service] || '/public/favicon.svg';
}

function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render setup cards for all services (allows adding accounts).
 * Each card gets an id="service-{id}" anchor for catalog links.
 */
export function renderUnconfiguredCards(accounts, baseUrl) {
  return services
    .map(s => {
      const card = s.renderCard(accounts, baseUrl);
      return `<div id="service-${s.serviceName}">${card}</div>`;
    })
    .join('\n');
}
