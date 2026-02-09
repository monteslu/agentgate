import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';
import { renderErrorPage } from './shared.js';

export function registerRoutes(router, baseUrl) {
  const DEFAULT_SCOPES = 'read write:statuses';

  // Simple auth: paste an access token directly (no OAuth dance)
  router.post('/mastodon/token-setup', (req, res) => {
    const { accountName, instance, accessToken } = req.body;
    if (!accountName || !instance || !accessToken) {
      return res.status(400).send('Account name, instance, and access token required');
    }

    const cleanInstance = instance.replace(/^https?:\/\//, '').replace(/\/$/, '');
    setAccountCredentials('mastodon', accountName, {
      instance: cleanInstance,
      accessToken,
      authStatus: 'success'
    });
    res.redirect('/ui');
  });

  router.post('/mastodon/setup', async (req, res) => {
    const { accountName, instance, scopes } = req.body;
    if (!accountName || !instance) {
      return res.status(400).send('Account name and instance required');
    }

    const cleanInstance = instance.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const scopeList = scopes || DEFAULT_SCOPES;

    try {
      const response = await fetch(`https://${cleanInstance}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'agentgate',
          redirect_uris: `${baseUrl}/ui/mastodon/callback`,
          scopes: scopeList,
          website: baseUrl
        })
      });

      if (!response.ok) {
        return res.status(400).send(renderErrorPage('Registration Error', `Failed to register app with ${cleanInstance}. Make sure the instance URL is correct.`));
      }

      const app = await response.json();

      setAccountCredentials('mastodon', accountName, {
        instance: cleanInstance,
        clientId: app.client_id,
        clientSecret: app.client_secret,
        scopes: scopeList
      });

      const authUrl = `https://${cleanInstance}/oauth/authorize?` +
        `client_id=${app.client_id}&response_type=code&` +
        `redirect_uri=${encodeURIComponent(`${baseUrl}/ui/mastodon/callback`)}&` +
        `scope=${encodeURIComponent(scopeList)}&state=${encodeURIComponent(`agentgate_mastodon_${accountName}`)}`;

      res.redirect(authUrl);
    } catch (err) {
      res.status(500).send(renderErrorPage('Setup Error', `Mastodon setup failed: ${err.message}`));
    }
  });

  router.get('/mastodon/callback', async (req, res) => {
    const { code, error, state } = req.query;
    const accountName = state?.replace('agentgate_mastodon_', '') || 'default';
    
    if (error) {
      const creds = getAccountCredentials('mastodon', accountName);
      if (creds) {
        setAccountCredentials('mastodon', accountName, { ...creds, authStatus: 'failed', authError: error });
      }
      return res.status(400).send(renderErrorPage('Mastodon OAuth Error', `Mastodon returned an error: ${error}`));
    }

    const creds = getAccountCredentials('mastodon', accountName);
    if (!creds) {
      return res.status(400).send(renderErrorPage('Setup Error', 'Mastodon account not found. Please try setup again.'));
    }

    try {
      const scopeList = creds.scopes || DEFAULT_SCOPES;
      
      const response = await fetch(`https://${creds.instance}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: `${baseUrl}/ui/mastodon/callback`,
          grant_type: 'authorization_code',
          code,
          scope: scopeList
        })
      });

      const tokens = await response.json();
      if (tokens.error) {
        setAccountCredentials('mastodon', accountName, { ...creds, authStatus: 'failed', authError: tokens.error });
        return res.status(400).send(renderErrorPage('Token Error', `Mastodon token exchange failed: ${tokens.error}`));
      }

      setAccountCredentials('mastodon', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        authStatus: 'success'
      });

      res.redirect('/ui');
    } catch (err) {
      setAccountCredentials('mastodon', accountName, { ...creds, authStatus: 'failed', authError: err.message });
      res.status(500).send(renderErrorPage('Connection Error', `Mastodon OAuth failed: ${err.message}`));
    }
  });

  router.post('/mastodon/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('mastodon', accountName);
    res.redirect('/ui');
  });

  router.post('/mastodon/retry', (req, res) => {
    const { accountName } = req.body;
    const creds = getAccountCredentials('mastodon', accountName);
    if (!creds || !creds.instance || !creds.clientId) {
      return res.status(400).send(renderErrorPage('Retry Error', 'Account credentials not found. Please set up the account again.'));
    }

    const scopeList = creds.scopes || DEFAULT_SCOPES;

    const authUrl = `https://${creds.instance}/oauth/authorize?` +
      `client_id=${creds.clientId}&response_type=code&` +
      `redirect_uri=${encodeURIComponent(`${baseUrl}/ui/mastodon/callback`)}&` +
      `scope=${encodeURIComponent(scopeList)}&state=${encodeURIComponent(`agentgate_mastodon_${accountName}`)}`;

    res.redirect(authUrl);
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'mastodon');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => {
      const { hasToken, hasCredentials, authStatus, instance } = acc.status || {};
      const info = instance ? `${acc.name} @${instance}` : acc.name;
      
      let statusBadge = '';
      if (hasToken) {
        statusBadge = '<span class="badge-success" style="margin-left: 8px;">✓ Connected</span>';
      } else if (authStatus === 'failed') {
        statusBadge = '<span class="badge-error" style="margin-left: 8px;">✗ Auth Failed</span>';
      } else if (hasCredentials) {
        statusBadge = '<span class="badge-warning" style="margin-left: 8px;">⏳ Pending</span>';
      }
      
      const retryBtn = (!hasToken && hasCredentials) ? `
        <form method="POST" action="/ui/mastodon/retry" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-primary">Retry Auth</button>
        </form>` : '';
      
      return `
      <div class="account-item">
        <span><strong>${info}</strong>${statusBadge}</span>
        <div style="display: flex; gap: 8px;">
          ${retryBtn}
          <form method="POST" action="/ui/mastodon/delete" style="margin:0;">
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
      <img class="service-icon" src="/public/icons/mastodon.svg" alt="Mastodon">
      <h3>Mastodon</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Mastodon Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Paste an access token from your instance's settings. Go to <strong>Preferences → Development → New Application</strong>, create an app with <code>read</code> + <code>write:statuses</code> scopes, then copy the access token.</p>
        <form method="POST" action="/ui/mastodon/token-setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="main, tech, etc." required>
          <label>Instance</label>
          <input type="text" name="instance" placeholder="fosstodon.org" required>
          <label>Access Token</label>
          <input type="password" name="accessToken" placeholder="Paste your access token" required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
        <details style="margin-top: 16px;">
          <summary style="color: #9ca3af; font-size: 13px;">Advanced: Use OAuth flow instead</summary>
          <div style="margin-top: 12px;">
            <p class="help">This will register an OAuth app and redirect you to authorize. Use this if you prefer not to create a token manually.</p>
            <form method="POST" action="/ui/mastodon/setup">
              <label>Account Name</label>
              <input type="text" name="accountName" placeholder="main, tech, etc." required>
              <label>Instance</label>
              <input type="text" name="instance" placeholder="fosstodon.org" required>
              <label>Scopes <span style="font-weight: normal; color: #9ca3af;">(space separated)</span></label>
              <input type="text" name="scopes" placeholder="read write:statuses" value="read write:statuses">
              <button type="submit" class="btn-primary">Add via OAuth</button>
            </form>
          </div>
        </details>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'mastodon';
export const displayName = 'Mastodon';
