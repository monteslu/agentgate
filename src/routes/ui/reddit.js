import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';
import { renderErrorPage } from './shared.js';

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
    const accountName = state?.replace('agentgate_reddit_', '') || 'default';
    
    if (error) {
      const creds = getAccountCredentials('reddit', accountName);
      if (creds) {
        setAccountCredentials('reddit', accountName, { ...creds, authStatus: 'failed', authError: error });
      }
      return res.status(400).send(renderErrorPage('Reddit OAuth Error', `Reddit returned an error: ${error}`));
    }

    const creds = getAccountCredentials('reddit', accountName);
    if (!creds) {
      return res.status(400).send(renderErrorPage('Setup Error', 'Reddit account not found. Please try setup again.'));
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
        setAccountCredentials('reddit', accountName, { ...creds, authStatus: 'failed', authError: tokens.error });
        return res.status(400).send(renderErrorPage('Token Error', `Reddit token exchange failed: ${tokens.error}`));
      }

      setAccountCredentials('reddit', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000,
        authStatus: 'success'
      });

      res.redirect('/ui');
    } catch (err) {
      setAccountCredentials('reddit', accountName, { ...creds, authStatus: 'failed', authError: err.message });
      res.status(500).send(renderErrorPage('Connection Error', `Reddit OAuth failed: ${err.message}`));
    }
  });

  router.post('/reddit/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('reddit', accountName);
    res.redirect('/ui');
  });

  router.post('/reddit/retry', (req, res) => {
    const { accountName } = req.body;
    const creds = getAccountCredentials('reddit', accountName);
    if (!creds || !creds.clientId || !creds.clientSecret) {
      return res.status(400).send(renderErrorPage('Retry Error', 'Account credentials not found. Please set up the account again.'));
    }

    const redirectUri = `${baseUrl}/ui/reddit/callback`;
    const scope = 'read identity';
    const state = `agentgate_reddit_${accountName}`;

    const authUrl = 'https://www.reddit.com/api/v1/authorize?' +
      `client_id=${creds.clientId}&response_type=code&` +
      `state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `duration=permanent&scope=${encodeURIComponent(scope)}`;

    res.redirect(authUrl);
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'reddit');

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
        <form method="POST" action="/ui/reddit/retry" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}" autocomplete="off">
          <button type="submit" class="btn-sm btn-primary">Retry Auth</button>
        </form>` : '';
      
      return `
      <div class="account-item">
        <span><strong>${acc.name}</strong>${statusBadge}</span>
        <div style="display: flex; gap: 8px;">
          ${retryBtn}
          <form method="POST" action="/ui/reddit/delete" style="margin:0;">
            <input type="hidden" name="accountName" value="${acc.name}" autocomplete="off">
            <button type="submit" class="btn-sm btn-danger">Remove</button>
          </form>
        </div>
      </div>`;
    }).join('');
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
          <input type="text" name="accountName" placeholder="main, throwaway, etc." required autocomplete="off">
          <label>Client ID</label>
          <input type="text" name="clientId" placeholder="Reddit client ID" required autocomplete="off">
          <label>Client Secret</label>
          <input type="password" name="clientSecret" placeholder="Reddit client secret" required autocomplete="off">
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'reddit';
export const displayName = 'Reddit';
