import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';
import { renderErrorPage } from './shared.js';

export function registerRoutes(router, baseUrl) {
  router.post('/google/setup', (req, res) => {
    const { accountName, clientId, clientSecret } = req.body;
    if (!accountName || !clientId || !clientSecret) {
      return res.status(400).send('Account name, client ID, and secret required');
    }
    setAccountCredentials('google_calendar', accountName, { clientId, clientSecret });

    const redirectUri = `${baseUrl}/ui/google/callback`;
    const scope = 'https://www.googleapis.com/auth/calendar.readonly';
    const state = `agentgate_google_${accountName}`;

    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      `client_id=${clientId}&response_type=code&` +
      `state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

    res.redirect(authUrl);
  });

  router.get('/google/callback', async (req, res) => {
    const { code, error, state } = req.query;
    const accountName = state?.replace('agentgate_google_', '') || 'default';
    
    if (error) {
      // Mark auth as failed so user can retry
      const creds = getAccountCredentials('google_calendar', accountName);
      if (creds) {
        setAccountCredentials('google_calendar', accountName, { ...creds, authStatus: 'failed', authError: error });
      }
      return res.status(400).send(renderErrorPage('Google OAuth Error', `Google returned an error: ${error}`));
    }

    const creds = getAccountCredentials('google_calendar', accountName);
    if (!creds) {
      return res.status(400).send(renderErrorPage('Setup Error', 'Google Calendar account not found. Please try setup again.'));
    }

    try {
      const redirectUri = `${baseUrl}/ui/google/callback`;

      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri
        })
      });

      const tokens = await response.json();
      if (tokens.error) {
        setAccountCredentials('google_calendar', accountName, { ...creds, authStatus: 'failed', authError: tokens.error });
        return res.status(400).send(renderErrorPage('Token Error', `Google token exchange failed: ${tokens.error}`));
      }

      setAccountCredentials('google_calendar', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000,
        authStatus: 'success'
      });

      res.redirect('/ui');
    } catch (err) {
      setAccountCredentials('google_calendar', accountName, { ...creds, authStatus: 'failed', authError: err.message });
      res.status(500).send(renderErrorPage('Connection Error', `Google OAuth failed: ${err.message}`));
    }
  });

  router.post('/google/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('google_calendar', accountName);
    res.redirect('/ui');
  });

  // Retry OAuth for failed/pending accounts
  router.post('/google/retry', (req, res) => {
    const { accountName } = req.body;
    const creds = getAccountCredentials('google_calendar', accountName);
    if (!creds || !creds.clientId || !creds.clientSecret) {
      return res.status(400).send(renderErrorPage('Retry Error', 'Account credentials not found. Please set up the account again.'));
    }

    const redirectUri = `${baseUrl}/ui/google/callback`;
    const scope = 'https://www.googleapis.com/auth/calendar.readonly';
    const state = `agentgate_google_${accountName}`;

    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      `client_id=${creds.clientId}&response_type=code&` +
      `state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

    res.redirect(authUrl);
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'google_calendar');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => {
      const { hasToken, hasCredentials, authStatus } = acc.status || {};
      const isFailed = authStatus === 'failed' || (!hasToken && hasCredentials);
      
      let statusBadge = '';
      if (hasToken) {
        statusBadge = '<span class="badge-success" style="margin-left: 8px;">✓ Connected</span>';
      } else if (authStatus === 'failed') {
        statusBadge = '<span class="badge-error" style="margin-left: 8px;">✗ Auth Failed</span>';
      } else if (hasCredentials) {
        statusBadge = '<span class="badge-warning" style="margin-left: 8px;">⏳ Pending</span>';
      }
      
      const retryBtn = (!hasToken && hasCredentials) ? `
        <form method="POST" action="/ui/google/retry" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-primary">Retry Auth</button>
        </form>` : '';
      
      return `
      <div class="account-item">
        <span><strong>${acc.name}</strong>${statusBadge}</span>
        <div style="display: flex; gap: 8px;">
          ${retryBtn}
          <form method="POST" action="/ui/google/delete" style="margin:0;">
            <input type="hidden" name="accountName" value="${acc.name}">
            <button type="submit" class="btn-sm btn-danger">Remove</button>
          </form>
        </div>
      </div>`;
    }).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/google-calendar.svg" alt="Google Calendar">
      <h3>Google Calendar</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Google Calendar Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create OAuth credentials at <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a>. Enable the Calendar API.</p>
        <p class="help">Redirect URI: <span class="copyable">${baseUrl}/ui/google/callback <button type="button" class="copy-btn" onclick="copyText('${baseUrl}/ui/google/callback', this)">Copy</button></span></p>
        <form method="POST" action="/ui/google/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="personal, work, etc." required>
          <label>Client ID</label>
          <input type="text" name="clientId" placeholder="xxxxxxxx.apps.googleusercontent.com" required>
          <label>Client Secret</label>
          <input type="password" name="clientSecret" placeholder="Google client secret" required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'google_calendar';
export const displayName = 'Google Calendar';
