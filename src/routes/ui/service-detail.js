// Service Detail page - view/edit a specific service instance
import { Router } from 'express';
import {
  getAccountById,
  deleteAccountById,
  listApiKeys,
  getServiceAccess,
  setServiceAccessMode,
  setServiceAgentAccess,
  setBypassAuth
} from '../../lib/db.js';
import { getServiceInfo } from '../../lib/serviceRegistry.js';
import { escapeHtml, renderAvatar } from './shared.js';
import { getServiceModule, services } from './services.js';
import { renderPage } from '../../lib/render.js';

const router = Router();

// GET /ui/services/add/:serviceType - Add new service instance
router.get('/add/:serviceType', (req, res) => {
  const { serviceType } = req.params;
  const serviceModule = services.find(s => s.serviceName === serviceType);

  if (!serviceModule) {
    return res.status(404).send(renderServiceTypeNotFound(res, serviceType));
  }

  const { serviceName, displayName } = serviceModule;
  const icon = getServiceIcon(serviceName);
  const formFields = getServiceFormFields(serviceName);

  renderPage(res, 'pages/service-add', {
    title: `Add ${displayName}`,
    includeSocket: true,
    displayName,
    icon,
    formFields,
    serviceRoutePrefix: serviceRoutePrefix(serviceName),
    setupAction: getServiceSetupAction(serviceName),
    escapeHtml
  });
});

// GET /ui/services/:id - Service detail page
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).send('Invalid service ID');
  }

  const account = getAccountById(id);
  if (!account) {
    return renderNotFound(res, id);
  }

  const serviceInfo = getServiceInfo(account.service);
  const serviceModule = getServiceModule(account.service);
  const agents = listApiKeys();
  const access = getServiceAccess(account.service, account.name);
  const displayName = serviceModule?.displayName || serviceInfo?.name || account.service;
  const icon = getServiceIcon(account.service);

  // Build credential fields
  const creds = account.credentials || {};
  const credFields = Object.keys(creds).map(key => {
    const value = creds[key];
    const masked = typeof value === 'string' && value.length > 8
      ? value.substring(0, 4) + '••••••••' + value.substring(value.length - 4)
      : '••••••••';
    return { key, masked };
  });

  const retryRoute = getRetryRoute(account.service);

  renderPage(res, 'pages/service-detail', {
    title: `${displayName} - ${account.name}`,
    includeSocket: true,
    account,
    agents,
    access,
    displayName,
    icon,
    credFields,
    retryRoute,
    escapeHtml,
    renderAvatar
  });
});

// POST /ui/services/:id/delete - Delete service instance
router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).send('Invalid service ID');
  }
  deleteAccountById(id);
  res.redirect('/ui');
});

// POST /ui/services/:id/access/mode - Update access mode
router.post('/:id/access/mode', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { mode } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const account = getAccountById(id);
  if (!account) {
    return wantsJson ? res.status(404).json({ error: 'Not found' }) : res.status(404).send('Not found');
  }

  try {
    setServiceAccessMode(account.service, account.name, mode);
    if (wantsJson) {
      return res.json({ success: true, mode });
    }
    res.redirect(`/ui/services/${id}`);
  } catch (err) {
    if (wantsJson) {
      return res.status(400).json({ error: err.message });
    }
    res.status(400).send(err.message);
  }
});

// POST /ui/services/:id/access/agent/:agentName - Toggle agent access
router.post('/:id/access/agent/:agentName', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { agentName } = req.params;
  const { allowed, bypass_auth } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const account = getAccountById(id);
  if (!account) {
    return wantsJson ? res.status(404).json({ error: 'Not found' }) : res.status(404).send('Not found');
  }

  setServiceAgentAccess(account.service, account.name, agentName, allowed !== 'false', bypass_auth === 'true');

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect(`/ui/services/${id}`);
});

// POST /ui/services/:id/access/agent/:agentName/bypass - Toggle bypass
router.post('/:id/access/agent/:agentName/bypass', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { agentName } = req.params;
  const { enabled } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const account = getAccountById(id);
  if (!account) {
    return wantsJson ? res.status(404).json({ error: 'Not found' }) : res.status(404).send('Not found');
  }

  setBypassAuth(account.service, account.name, agentName, enabled === 'true' || enabled === true);

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect(`/ui/services/${id}`);
});

function renderNotFound(res, id) {
  renderPage(res, 'pages/service-not-found', {
    title: 'Service Not Found',
    includeSocket: true,
    message: `The service with ID "${escapeHtml(String(id))}" does not exist.`
  });
}

function renderServiceTypeNotFound(res, serviceType) {
  renderPage(res, 'pages/service-not-found', {
    title: 'Service Not Found',
    includeSocket: true,
    message: `The service type "${escapeHtml(serviceType)}" is not available.`
  });
}

/**
 * Return the retry-auth route for OAuth services, or null for non-OAuth.
 */
function getRetryRoute(serviceName) {
  const routes = {
    youtube: '/ui/youtube/retry',
    google_calendar: '/ui/google/retry',
    fitbit: '/ui/fitbit/retry',
    linkedin: '/ui/linkedin/retry',
    reddit: '/ui/reddit/retry',
    mastodon: '/ui/mastodon/retry'
  };
  return routes[serviceName] || null;
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
    twilio: '/public/icons/twilio.svg'
  };
  return icons[service] || '/public/favicon.svg';
}

function serviceRoutePrefix(serviceName) {
  const prefixes = { google_calendar: 'google' };
  return prefixes[serviceName] || serviceName;
}

function getServiceSetupAction(serviceName) {
  const actions = { mastodon: 'token-setup' };
  return actions[serviceName] || 'setup';
}

function getServiceFormFields(serviceName) {
  const fields = {
    github: `
      <div class="form-group">
        <label>Personal Access Token</label>
        <input type="password" name="token" placeholder="ghp_xxxx or github_pat_xxxx" required autocomplete="off">
        <p class="help">Create a token at <a href="https://github.com/settings/tokens" target="_blank">github.com/settings/tokens</a></p>
      </div>`,

    bluesky: `
      <div class="form-group">
        <label>Handle (no @ symbol)</label>
        <input type="text" name="identifier" placeholder="yourname.bsky.social" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>App Password</label>
        <input type="password" name="appPassword" placeholder="xxxx-xxxx-xxxx-xxxx" required autocomplete="off">
        <p class="help">Create an app password at <a href="https://bsky.app/settings/app-passwords" target="_blank">bsky.app/settings/app-passwords</a></p>
      </div>`,

    mastodon: `
      <div class="form-group">
        <label>Instance</label>
        <input type="text" name="instance" placeholder="mastodon.social" required autocomplete="off">
        <p class="help">Just the domain, no https://</p>
      </div>
      <div class="form-group">
        <label>Access Token</label>
        <input type="password" name="accessToken" placeholder="Your access token" required autocomplete="off">
        <p class="help">Go to your instance → Preferences → Development → New Application, create an app with <code>read</code> + <code>write:statuses</code> scopes, then copy the access token</p>
      </div>`,

    reddit: `
      <div class="form-group">
        <label>Client ID</label>
        <input type="text" name="clientId" placeholder="Your app's client ID" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Client Secret</label>
        <input type="password" name="clientSecret" placeholder="Your app's client secret" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Refresh Token</label>
        <input type="password" name="refreshToken" placeholder="OAuth refresh token" required autocomplete="off">
        <p class="help">Create an app at <a href="https://www.reddit.com/prefs/apps" target="_blank">reddit.com/prefs/apps</a></p>
      </div>`,

    google_calendar: `
      <div class="form-group">
        <label>Client ID</label>
        <input type="text" name="clientId" placeholder="xxxxx.apps.googleusercontent.com" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Client Secret</label>
        <input type="password" name="clientSecret" placeholder="Your client secret" required autocomplete="off">
        <p class="help">Enable Google Calendar API at <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a></p>
      </div>`,

    youtube: `
      <div class="form-group">
        <label>Client ID</label>
        <input type="text" name="clientId" placeholder="xxxxx.apps.googleusercontent.com" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Client Secret</label>
        <input type="password" name="clientSecret" placeholder="Your client secret" required autocomplete="off">
        <p class="help">Enable YouTube Data API v3 at <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a></p>
      </div>`,

    linkedin: `
      <div class="form-group">
        <label>Access Token</label>
        <input type="password" name="accessToken" placeholder="Your LinkedIn access token" required autocomplete="off">
        <p class="help">Get a token from <a href="https://www.linkedin.com/developers/" target="_blank">LinkedIn Developers</a></p>
      </div>`,

    jira: `
      <div class="form-group">
        <label>Domain</label>
        <input type="text" name="domain" placeholder="yourcompany.atlassian.net" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" placeholder="you@company.com" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>API Token</label>
        <input type="password" name="apiToken" placeholder="Your Jira API token" required autocomplete="off">
        <p class="help">Create a token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">Atlassian API Tokens</a></p>
      </div>`,

    fitbit: `
      <div class="form-group">
        <label>Client ID</label>
        <input type="text" name="clientId" placeholder="Your Fitbit app client ID" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Client Secret</label>
        <input type="password" name="clientSecret" placeholder="Your client secret" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Refresh Token</label>
        <input type="password" name="refreshToken" placeholder="OAuth refresh token" required autocomplete="off">
        <p class="help">Create an app at <a href="https://dev.fitbit.com/apps" target="_blank">dev.fitbit.com</a></p>
      </div>`,

    brave: `
      <div class="form-group">
        <label>API Key</label>
        <input type="password" name="apiKey" placeholder="BSA..." required autocomplete="off">
        <p class="help">Get an API key from <a href="https://brave.com/search/api/" target="_blank">Brave Search API</a></p>
      </div>`,

    google_search: `
      <div class="form-group">
        <label>API Key</label>
        <input type="password" name="apiKey" placeholder="Your Google API key" required autocomplete="off">
      </div>
      <div class="form-group">
        <label>Search Engine ID (CX)</label>
        <input type="text" name="cx" placeholder="Your custom search engine ID" required autocomplete="off">
        <p class="help">Set up at <a href="https://programmablesearchengine.google.com/" target="_blank">Programmable Search Engine</a></p>
      </div>`,

    homeassistant: `
      <div class="form-group">
        <label>Host URL</label>
        <input type="text" name="host" placeholder="http://homeassistant.local:8123" required autocomplete="off">
        <p class="help">The URL of your Home Assistant instance (include port if not 80/443)</p>
      </div>
      <div class="form-group">
        <label>Long-Lived Access Token</label>
        <div style="position:relative;">
          <input type="text" name="token" id="ha-token" placeholder="eyJ..." required autocomplete="off" style="padding-right:60px;">
          <button type="button" onclick="const i=document.getElementById('ha-token');const t=i.type==='password'?'text':'password';i.type=t;this.textContent=t==='password'?'Show':'Hide';" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;background:none;cursor:pointer;color:var(--text-muted);font-size:0.85em;">Hide</button>
        </div>
        <p class="help">Create a token in Home Assistant: Profile → Security → Long-Lived Access Tokens → Create Token</p>
      </div>`,

    twilio: `
      <div class="form-group">
        <label>Account SID</label>
        <input type="text" name="accountSid" placeholder="AC..." required autocomplete="off">
        <p class="help">Find your Account SID in the <a href="https://console.twilio.com/" target="_blank">Twilio Console</a></p>
      </div>
      <div class="form-group">
        <label>Auth Token</label>
        <div style="position:relative;">
          <input type="text" name="authToken" id="twilio-token" placeholder="Your auth token" required autocomplete="off" style="padding-right:60px;">
          <button type="button" onclick="const i=document.getElementById('twilio-token');const t=i.type==='password'?'text':'password';i.type=t;this.textContent=t==='password'?'Show':'Hide';" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;background:none;cursor:pointer;color:var(--text-muted);font-size:0.85em;">Hide</button>
        </div>
        <p class="help">Find your Auth Token in the Twilio Console dashboard</p>
      </div>`
  };

  return fields[serviceName] || `
    <div class="form-group">
      <label>API Key</label>
      <input type="password" name="apiKey" placeholder="Your API key" required autocomplete="off">
    </div>`;
}

export default router;
