import { serviceInfo as githubInfo } from '../routes/github.js';
import { serviceInfo as blueskyInfo } from '../routes/bluesky.js';
import { serviceInfo as redditInfo } from '../routes/reddit.js';
import { serviceInfo as calendarInfo } from '../routes/calendar.js';
import { serviceInfo as mastodonInfo } from '../routes/mastodon.js';
import { serviceInfo as linkedinInfo } from '../routes/linkedin.js';
import { serviceInfo as youtubeInfo } from '../routes/youtube.js';
import { serviceInfo as jiraInfo } from '../routes/jira.js';
import { serviceInfo as fitbitInfo } from '../routes/fitbit.js';
import { serviceInfo as braveInfo } from '../routes/brave.js';
import { serviceInfo as googleSearchInfo } from '../routes/google-search.js';

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

export default SERVICE_REGISTRY;
