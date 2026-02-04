import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';

export function registerRoutes(router, baseUrl) {
  router.post('/youtube/setup', (req, res) => {
    const { accountName, clientId, clientSecret } = req.body;
    if (!accountName || !clientId || !clientSecret) {
      return res.status(400).send('Account name, client ID, and secret required');
    }
    setAccountCredentials('youtube', accountName, { clientId, clientSecret });

    const redirectUri = `${baseUrl}/ui/youtube/callback`;
    const scope = 'https://www.googleapis.com/auth/youtube.readonly';
    const state = `agentgate_youtube_${accountName}`;

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${clientId}&response_type=code&` +
      `state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

    res.redirect(authUrl);
  });

  router.get('/youtube/callback', async (req, res) => {
    const { code, error, state } = req.query;
    if (error) {
      return res.status(400).send(`YouTube OAuth error: ${error}`);
    }

    const accountName = state?.replace('agentgate_youtube_', '') || 'default';
    const creds = getAccountCredentials('youtube', accountName);
    if (!creds) {
      return res.status(400).send('YouTube account not found. Please try setup again.');
    }

    try {
      const redirectUri = `${baseUrl}/ui/youtube/callback`;

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
        return res.status(400).send(`YouTube token error: ${tokens.error}`);
      }

      setAccountCredentials('youtube', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000
      });

      res.redirect('/ui');
    } catch (err) {
      res.status(500).send(`YouTube OAuth failed: ${err.message}`);
    }
  });

  router.post('/youtube/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('youtube', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'youtube');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${acc.name}</strong></span>
        <form method="POST" action="/ui/youtube/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/youtube.svg" alt="YouTube">
      <h3>YouTube</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add YouTube Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Use the same Google Cloud Console project. Enable the YouTube Data API v3.</p>
        <p class="help">Redirect URI: <span class="copyable">${baseUrl}/ui/youtube/callback <button type="button" class="copy-btn" onclick="copyText('${baseUrl}/ui/youtube/callback', this)">Copy</button></span></p>
        <form method="POST" action="/ui/youtube/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="main, brand, etc." required>
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

export const serviceName = 'youtube';
export const displayName = 'YouTube';
