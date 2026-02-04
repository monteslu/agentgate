import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';

export function registerRoutes(router, baseUrl) {
  router.post('/reddit/setup', (req, res) => {
    const { accountName, clientId, clientSecret } = req.body;
    if (!accountName || !clientId || !clientSecret) {
      return res.status(400).send('Account name, client ID, and secret required');
    }
    setAccountCredentials('reddit', accountName, { clientId, clientSecret });

    const redirectUri = `${baseUrl}/ui/reddit/callback`;
    const scope = 'read identity';
    const state = `agentgate_reddit_${accountName}`;

    const authUrl = 'https://www.reddit.com/api/v1/authorize?' +
      `client_id=${clientId}&response_type=code&` +
      `state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `duration=permanent&scope=${encodeURIComponent(scope)}`;

    res.redirect(authUrl);
  });

  router.get('/reddit/callback', async (req, res) => {
    const { code, error, state } = req.query;
    if (error) {
      return res.status(400).send(`Reddit OAuth error: ${error}`);
    }

    const accountName = state?.replace('agentgate_reddit_', '') || 'default';
    const creds = getAccountCredentials('reddit', accountName);
    if (!creds) {
      return res.status(400).send('Reddit account not found. Please try setup again.');
    }

    try {
      const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
      const redirectUri = `${baseUrl}/ui/reddit/callback`;

      const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri
        })
      });

      const tokens = await response.json();
      if (tokens.error) {
        return res.status(400).send(`Reddit token error: ${tokens.error}`);
      }

      setAccountCredentials('reddit', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
      });

      res.redirect('/ui');
    } catch (err) {
      res.status(500).send(`Reddit OAuth failed: ${err.message}`);
    }
  });

  router.post('/reddit/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('reddit', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'reddit');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${acc.name}</strong></span>
        <form method="POST" action="/ui/reddit/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/reddit.svg" alt="Reddit">
      <h3>Reddit</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Reddit Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create an app at <a href="https://www.reddit.com/prefs/apps" target="_blank">reddit.com/prefs/apps</a> (select "web app")</p>
        <p class="help">Redirect URI: <span class="copyable">${baseUrl}/ui/reddit/callback <button type="button" class="copy-btn" onclick="copyText('${baseUrl}/ui/reddit/callback', this)">Copy</button></span></p>
        <form method="POST" action="/ui/reddit/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="main, throwaway, etc." required>
          <label>Client ID</label>
          <input type="text" name="clientId" placeholder="Reddit client ID" required>
          <label>Client Secret</label>
          <input type="password" name="clientSecret" placeholder="Reddit client secret" required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'reddit';
export const displayName = 'Reddit';
