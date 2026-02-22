import { serviceInfo as githubInfo, readService as githubRead } from '../routes/github.js';
import { serviceInfo as blueskyInfo, readService as blueskyRead } from '../routes/bluesky.js';
import { serviceInfo as redditInfo, readService as redditRead } from '../routes/reddit.js';
import { serviceInfo as calendarInfo, readService as calendarRead } from '../routes/calendar.js';
import { serviceInfo as mastodonInfo, readService as mastodonRead } from '../routes/mastodon.js';
import { serviceInfo as linkedinInfo, readService as linkedinRead } from '../routes/linkedin.js';
import { serviceInfo as youtubeInfo, readService as youtubeRead } from '../routes/youtube.js';
import { serviceInfo as jiraInfo, readService as jiraRead } from '../routes/jira.js';
import { serviceInfo as fitbitInfo, readService as fitbitRead } from '../routes/fitbit.js';
import { serviceInfo as braveInfo, readService as braveRead } from '../routes/brave.js';
import { serviceInfo as googleSearchInfo, readService as googleSearchRead } from '../routes/google-search.js';
import { serviceInfo as homeassistantInfo, readService as homeassistantRead } from '../routes/homeassistant.js';

// Aggregate service metadata from all routes
const SERVICE_REGISTRY = {
  [githubInfo.key]: githubInfo,
  [blueskyInfo.key]: blueskyInfo,
  [mastodonInfo.key]: mastodonInfo,
  [redditInfo.key]: redditInfo,
  [calendarInfo.key]: calendarInfo,
  [youtubeInfo.key]: youtubeInfo,
  [linkedinInfo.key]: linkedinInfo,
  [jiraInfo.key]: jiraInfo,
  [fitbitInfo.key]: fitbitInfo,
  [braveInfo.key]: braveInfo,
  [googleSearchInfo.key]: googleSearchInfo,
  [homeassistantInfo.key]: homeassistantInfo
};

// Reserved route prefixes that plugins must not shadow
const RESERVED_PATHS = new Set([
  'queue', 'agents', 'services', 'llm', 'skill',
  'agent_start_here', 'readme'
]);

/**
 * Check if a service key would collide with built-in services or reserved paths
 * @param {string} key - Service key to check
 * @returns {{ collision: boolean, reason: string }}
 */
export function checkNameCollision(key) {
  if (SERVICE_REGISTRY[key]) {
    return { collision: true, reason: `Collides with built-in service: ${key}` };
  }
  if (RESERVED_PATHS.has(key)) {
    return { collision: true, reason: `Collides with reserved API path: /api/${key}` };
  }
  return { collision: false, reason: '' };
}

/**
 * Get service info by key
 * @param {string} key - Service key (e.g., 'github', 'bluesky')
 * @returns {object|null} Service info object or null if not found
 */
export function getServiceInfo(key) {
  return SERVICE_REGISTRY[key] || null;
}

// Aggregate readService functions from all routes
export const SERVICE_READERS = {
  [githubInfo.key]: githubRead,
  [blueskyInfo.key]: blueskyRead,
  [mastodonInfo.key]: mastodonRead,
  [redditInfo.key]: redditRead,
  [calendarInfo.key]: calendarRead,
  [calendarInfo.dbKey]: calendarRead, // alias: google_calendar -> calendar
  [youtubeInfo.key]: youtubeRead,
  [linkedinInfo.key]: linkedinRead,
  [jiraInfo.key]: jiraRead,
  [fitbitInfo.key]: fitbitRead,
  [braveInfo.key]: braveRead,
  [googleSearchInfo.key]: googleSearchRead,
  [homeassistantInfo.key]: homeassistantRead
};

// Category mapping for MCP tool registration
export const SERVICE_CATEGORIES = {
  search:   { name: 'Search',   description: 'Web, news, and image search', services: ['brave', 'google_search'], hasWrite: false },
  social:   { name: 'Social',   description: 'Social networks — posts, profiles, timelines', services: ['bluesky', 'mastodon', 'reddit', 'linkedin'], hasWrite: true },
  code:     { name: 'Code',     description: 'Code repos, issues, PRs, projects', services: ['github', 'jira'], hasWrite: true },
  personal: { name: 'Personal', description: 'Health, calendar, and media', services: ['fitbit', 'calendar', 'google_calendar', 'youtube'], hasWrite: true },
  iot:      { name: 'IoT',      description: 'Smart home and IoT devices', services: ['homeassistant'], hasWrite: true },
  plugins:  { name: 'Plugins',  description: 'User-installed custom service plugins', services: [], hasWrite: true }
};

/**
 * Get the category name for a given service key
 * @param {string} serviceKey - Service key (e.g., 'github', 'brave')
 * @returns {string|null} Category name or null if not categorized
 */
export function getServiceCategory(serviceKey) {
  for (const [cat, info] of Object.entries(SERVICE_CATEGORIES)) {
    if (info.services.includes(serviceKey)) return cat;
  }
  return null;
}

/**
 * Register a plugin service dynamically after initial load.
 * Throws if the plugin name collides with a built-in service or reserved path.
 * @param {string} key - Service key (plugin name)
 * @param {object} info - serviceInfo object
 * @param {Function|null} readFn - readService function for MCP
 */
export function registerPlugin(key, info, readFn) {
  const { collision, reason } = checkNameCollision(key);
  if (collision) {
    throw new Error(`Plugin "${key}" cannot be registered: ${reason}`);
  }

  SERVICE_REGISTRY[key] = info;
  if (readFn) {
    SERVICE_READERS[key] = readFn;
  }
  // Add to plugins category
  if (!SERVICE_CATEGORIES.plugins.services.includes(key)) {
    SERVICE_CATEGORIES.plugins.services.push(key);
  }
  console.log(`Registered plugin service: ${key}`);
}

export default SERVICE_REGISTRY;
