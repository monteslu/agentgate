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

// Export all services in display order
export const services = [
  github,
  bluesky,
  mastodon,
  reddit,
  calendar,
  youtube,
  fitbit,
  jira,
  linkedin
];

// Register all service routes
export function registerAllRoutes(router, baseUrl) {
  for (const service of services) {
    service.registerRoutes(router, baseUrl);
  }
}

// Render all service cards
export function renderAllCards(accounts, baseUrl) {
  return services.map(service => service.renderCard(accounts, baseUrl)).join('\n');
}
