import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';

export function registerRoutes(router, baseUrl) {
  router.post('/mastodon/setup', async (req, res) => {
    const { accountName, instance } = req.body;
    if (!accountName || !instance) {
      return res.status(400).send('Account name and instance required');
    }

    const cleanInstance = instance.replace(/^https?:\/\//, '').replace(/\/$/, '');

    try {
      const response = await fetch(`https://${cleanInstance}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'agentgate',
          redirect_uris: `${baseUrl}/ui/mastodon/callback`,
          scopes: 'read',
          website: baseUrl
        })
      });

      if (!response.ok) {
        return res.status(400).send(`Failed to register app with ${cleanInstance}`);
      }

      const app = await response.json();

      setAccountCredentials('mastodon', accountName, {
        instance: cleanInstance,
        clientId: app.client_id,
        clientSecret: app.client_secret
      });

      const authUrl = `https://${cleanInstance}/oauth/authorize?` +
        `client_id=${app.client_id}&response_type=code&` +
        `redirect_uri=${encodeURIComponent(`${baseUrl}/ui/mastodon/callback`)}&` +
        `scope=read&state=${encodeURIComponent(`agentgate_mastodon_${accountName}`)}`;

      res.redirect(authUrl);
    } catch (err) {
      res.status(500).send(`Mastodon setup failed: ${err.message}`);
    }
  });

  router.get('/mastodon/callback', async (req, res) => {
    const { code, error, state } = req.query;
    if (error) {
      return res.status(400).send(`Mastodon OAuth error: ${error}`);
    }

    const accountName = state?.replace('agentgate_mastodon_', '') || 'default';
    const creds = getAccountCredentials('mastodon', accountName);
    if (!creds) {
      return res.status(400).send('Mastodon account not found. Please try setup again.');
    }

    try {
      const response = await fetch(`https://${creds.instance}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: `${baseUrl}/ui/mastodon/callback`,
          grant_type: 'authorization_code',
          code,
          scope: 'read'
        })
      });

      const tokens = await response.json();
      if (tokens.error) {
        return res.status(400).send(`Mastodon token error: ${tokens.error}`);
      }

      setAccountCredentials('mastodon', accountName, {
        ...creds,
        accessToken: tokens.access_token
      });

      res.redirect('/ui');
    } catch (err) {
      res.status(500).send(`Mastodon OAuth failed: ${err.message}`);
    }
  });

  router.post('/mastodon/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('mastodon', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'mastodon');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => {
      const creds = getAccountCredentials('mastodon', acc.name);
      const info = creds?.instance ? `${acc.name} @${creds.instance}` : acc.name;
      return `
        <div class="account-item">
          <span><strong>${info}</strong></span>
          <form method="POST" action="/ui/mastodon/delete" style="margin:0;">
            <input type="hidden" name="accountName" value="${acc.name}">
            <button type="submit" class="btn-sm btn-danger">Remove</button>
          </form>
        </div>
      `;
    }).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/mastodon.svg" alt="Mastodon">
      <h3>Mastodon</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Mastodon Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Enter your Mastodon instance (e.g., fosstodon.org, mastodon.social)</p>
        <form method="POST" action="/ui/mastodon/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="main, tech, etc." required>
          <label>Instance</label>
          <input type="text" name="instance" placeholder="fosstodon.org" required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'mastodon';
export const displayName = 'Mastodon';
