import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';

export function registerRoutes(router, baseUrl) {
  router.post('/linkedin/setup', (req, res) => {
    const { accountName, clientId, clientSecret } = req.body;
    if (!accountName || !clientId || !clientSecret) {
      return res.status(400).send('Account name, client ID, and secret required');
    }
    setAccountCredentials('linkedin', accountName, { clientId, clientSecret });

    const redirectUri = `${baseUrl}/ui/linkedin/callback`;
    const scope = 'openid profile email r_liteprofile';
    const state = `agentgate_linkedin_${accountName}`;

    const authUrl = `https://www.linkedin.com/oauth/v2/authorization?` +
      `response_type=code&client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;

    res.redirect(authUrl);
  });

  router.get('/linkedin/callback', async (req, res) => {
    const { code, error, error_description, state } = req.query;
    if (error) {
      return res.status(400).send(`LinkedIn OAuth error: ${error} - ${error_description}`);
    }

    const accountName = state?.replace('agentgate_linkedin_', '') || 'default';
    const creds = getAccountCredentials('linkedin', accountName);
    if (!creds) {
      return res.status(400).send('LinkedIn account not found. Please try setup again.');
    }

    try {
      const redirectUri = `${baseUrl}/ui/linkedin/callback`;

      const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: creds.clientId,
          client_secret: creds.clientSecret
        })
      });

      const tokens = await response.json();
      if (tokens.error) {
        return res.status(400).send(`LinkedIn token error: ${tokens.error} - ${tokens.error_description}`);
      }

      setAccountCredentials('linkedin', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
      });

      res.redirect('/ui');
    } catch (err) {
      res.status(500).send(`LinkedIn OAuth failed: ${err.message}`);
    }
  });

  router.post('/linkedin/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('linkedin', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'linkedin');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${acc.name}</strong></span>
        <form method="POST" action="/ui/linkedin/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/linkedin.svg" alt="LinkedIn">
      <h3>LinkedIn</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add LinkedIn Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create an app at <a href="https://www.linkedin.com/developers/apps" target="_blank">LinkedIn Developers</a>. Request "Sign In with LinkedIn using OpenID Connect" product.</p>
        <p class="help">Redirect URL: <span class="copyable">${baseUrl}/ui/linkedin/callback <button type="button" class="copy-btn" onclick="copyText('${baseUrl}/ui/linkedin/callback', this)">Copy</button></span></p>
        <form method="POST" action="/ui/linkedin/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="personal, business, etc." required>
          <label>Client ID</label>
          <input type="text" name="clientId" placeholder="LinkedIn client ID" required>
          <label>Client Secret</label>
          <input type="password" name="clientSecret" placeholder="LinkedIn client secret" required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'linkedin';
export const displayName = 'LinkedIn';
