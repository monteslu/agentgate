import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';
import { renderErrorPage } from './shared.js';

export function registerRoutes(router, baseUrl) {
  router.post('/fitbit/setup', (req, res) => {
    const { accountName, clientId, clientSecret } = req.body;
    if (!accountName || !clientId || !clientSecret) {
      return res.status(400).send('Account name, client ID, and secret required');
    }
    setAccountCredentials('fitbit', accountName, { clientId, clientSecret });

    const redirectUri = `${baseUrl}/ui/fitbit/callback`;
    const scope = 'activity heartrate location nutrition oxygen_saturation profile respiratory_rate settings sleep social temperature weight';
    const state = `agentgate_fitbit_${accountName}`;

    const authUrl = 'https://www.fitbit.com/oauth2/authorize?' +
      `client_id=${clientId}&response_type=code&` +
      `state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}`;

    res.redirect(authUrl);
  });

  router.get('/fitbit/callback', async (req, res) => {
    const { code, error, state } = req.query;
    const accountName = state?.replace('agentgate_fitbit_', '') || 'default';
    
    if (error) {
      const creds = getAccountCredentials('fitbit', accountName);
      if (creds) {
        setAccountCredentials('fitbit', accountName, { ...creds, authStatus: 'failed', authError: error });
      }
      return res.status(400).send(renderErrorPage('Fitbit OAuth Error', `Fitbit returned an error: ${error}`));
    }

    const creds = getAccountCredentials('fitbit', accountName);
    if (!creds) {
      return res.status(400).send(renderErrorPage('Setup Error', 'Fitbit account not found. Please try setup again.'));
    }

    try {
      const redirectUri = `${baseUrl}/ui/fitbit/callback`;
      const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

      const response = await fetch('https://api.fitbit.com/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`
        },
        body: new URLSearchParams({
          client_id: creds.clientId,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri
        })
      });

      const tokens = await response.json();
      if (tokens.errors) {
        setAccountCredentials('fitbit', accountName, { ...creds, authStatus: 'failed', authError: tokens.errors[0]?.message || 'Unknown error' });
        return res.status(400).send(renderErrorPage('Token Error', `Fitbit token exchange failed: ${tokens.errors[0]?.message || 'Unknown error'}`));
      }

      setAccountCredentials('fitbit', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        userId: tokens.user_id,
        expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000,
        authStatus: 'success'
      });

      res.redirect('/ui');
    } catch (err) {
      setAccountCredentials('fitbit', accountName, { ...creds, authStatus: 'failed', authError: err.message });
      res.status(500).send(renderErrorPage('Connection Error', `Fitbit OAuth failed: ${err.message}`));
    }
  });

  router.post('/fitbit/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('fitbit', accountName);
    res.redirect('/ui');
  });

  router.post('/fitbit/retry', (req, res) => {
    const { accountName } = req.body;
    const creds = getAccountCredentials('fitbit', accountName);
    if (!creds || !creds.clientId || !creds.clientSecret) {
      return res.status(400).send(renderErrorPage('Retry Error', 'Account credentials not found. Please set up the account again.'));
    }

    const redirectUri = `${baseUrl}/ui/fitbit/callback`;
    const scope = 'activity heartrate location nutrition oxygen_saturation profile respiratory_rate settings sleep social temperature weight';
    const state = `agentgate_fitbit_${accountName}`;

    const authUrl = 'https://www.fitbit.com/oauth2/authorize?' +
      `client_id=${creds.clientId}&response_type=code&` +
      `state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}`;

    res.redirect(authUrl);
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'fitbit');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => {
      const { hasToken, hasCredentials, authStatus } = acc.status || {};
      
      let statusBadge = '';
      if (hasToken) {
        statusBadge = '<span class="badge-success" style="margin-left: 8px;">✓ Connected</span>';
      } else if (authStatus === 'failed') {
        statusBadge = '<span class="badge-error" style="margin-left: 8px;">✗ Auth Failed</span>';
      } else if (hasCredentials) {
        statusBadge = '<span class="badge-warning" style="margin-left: 8px;">⏳ Pending</span>';
      }
      
      const retryBtn = (!hasToken && hasCredentials) ? `
        <form method="POST" action="/ui/fitbit/retry" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-primary">Retry Auth</button>
        </form>` : '';
      
      return `
      <div class="account-item">
        <span><strong>${acc.name}</strong>${statusBadge}</span>
        <div style="display: flex; gap: 8px;">
          ${retryBtn}
          <form method="POST" action="/ui/fitbit/delete" style="margin:0;">
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
      <img class="service-icon" src="/public/icons/fitbit.svg" alt="Fitbit">
      <h3>Fitbit</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Fitbit Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create an app at <a href="https://dev.fitbit.com/apps/new" target="_blank">Fitbit Developer</a>. Set OAuth 2.0 Application Type to "Personal".</p>
        <p class="help">Redirect URI: <span class="copyable">${baseUrl}/ui/fitbit/callback <button type="button" class="copy-btn" onclick="copyText('${baseUrl}/ui/fitbit/callback', this)">Copy</button></span></p>
        <form method="POST" action="/ui/fitbit/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="personal, etc." required>
          <label>Client ID (OAuth 2.0 Client ID)</label>
          <input type="text" name="clientId" placeholder="Fitbit client ID" required>
          <label>Client Secret</label>
          <input type="password" name="clientSecret" placeholder="Fitbit client secret" required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'fitbit';
export const displayName = 'Fitbit';
