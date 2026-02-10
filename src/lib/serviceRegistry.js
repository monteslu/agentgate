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
  [googleSearchInfo.key]: googleSearchInfo
};

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
  [googleSearchInfo.key]: googleSearchRead
};

// Category mapping for MCP tool registration
export const SERVICE_CATEGORIES = {
  search:   { name: 'Search',   description: 'Web, news, and image search', services: ['brave', 'google_search'], hasWrite: false },
  social:   { name: 'Social',   description: 'Social networks — posts, profiles, timelines', services: ['bluesky', 'mastodon', 'reddit', 'linkedin'], hasWrite: true },
  code:     { name: 'Code',     description: 'Code repos, issues, PRs, projects', services: ['github', 'jira'], hasWrite: true },
  personal: { name: 'Personal', description: 'Health, calendar, and media', services: ['fitbit', 'calendar', 'google_calendar', 'youtube'], hasWrite: true }
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

export default SERVICE_REGISTRY;
