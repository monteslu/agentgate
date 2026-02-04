import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';

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

    const authUrl = `https://www.fitbit.com/oauth2/authorize?` +
      `client_id=${clientId}&response_type=code&` +
      `state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}`;

    res.redirect(authUrl);
  });

  router.get('/fitbit/callback', async (req, res) => {
    const { code, error, state } = req.query;
    if (error) {
      return res.status(400).send(`Fitbit OAuth error: ${error}`);
    }

    const accountName = state?.replace('agentgate_fitbit_', '') || 'default';
    const creds = getAccountCredentials('fitbit', accountName);
    if (!creds) {
      return res.status(400).send('Fitbit account not found. Please try setup again.');
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
        return res.status(400).send(`Fitbit token error: ${tokens.errors[0]?.message || 'Unknown error'}`);
      }

      setAccountCredentials('fitbit', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        userId: tokens.user_id,
        expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
      });

      res.redirect('/ui');
    } catch (err) {
      res.status(500).send(`Fitbit OAuth failed: ${err.message}`);
    }
  });

  router.post('/fitbit/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('fitbit', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'fitbit');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${acc.name}</strong></span>
        <form method="POST" action="/ui/fitbit/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
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
