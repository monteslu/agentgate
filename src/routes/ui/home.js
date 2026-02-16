// Home page route - renders the main dashboard
import { Router } from 'express';
import {
  listAccounts,
  getPendingQueueCount, getMessagingMode, listPendingMessages
} from '../../lib/db.js';
import { registerAllRoutes, services, getServiceModule } from './services.js';
import { PORT, BASE_URL, escapeHtml } from './shared.js';
import { renderPage } from '../../lib/render.js';

const router = Router();

const SERVICE_ICONS = {
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

function getServiceIcon(service) {
  return SERVICE_ICONS[service] || '/public/favicon.svg';
}

// Home page route
router.get('/', (req, res) => {
  const accounts = listAccounts().map(acc => {
    const svcModule = getServiceModule(acc.service);
    return {
      ...acc,
      name: escapeHtml(acc.name),
      displayName: svcModule?.displayName || acc.service
    };
  });
  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = listPendingMessages().length;

  renderPage(res, 'pages/home', {
    title: 'Services',
    includeSocket: true,
    pendingQueueCount,
    pendingMessagesCount,
    messagingMode,
    accounts,
    services,
    getServiceIcon,
    port: PORT
  });
});

// Register all OAuth service routes (github, bluesky, reddit, etc.)
registerAllRoutes(router, BASE_URL);

export default router;
