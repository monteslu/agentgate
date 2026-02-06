import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';
import { renderErrorPage } from './shared.js';

export function registerRoutes(router, baseUrl) {
  const DEFAULT_SCOPES = 'openid profile email w_member_social';

  router.post('/linkedin/setup', (req, res) => {
    const { accountName, clientId, clientSecret, scopes } = req.body;
    if (!accountName || !clientId || !clientSecret) {
      return res.status(400).send('Account name, client ID, and secret required');
    }
    
    // Use provided scopes or default, normalize comma/space separated to space separated
    const scopeList = (scopes || DEFAULT_SCOPES).split(/[,\s]+/).filter(s => s).join(' ');
    
    setAccountCredentials('linkedin', accountName, { clientId, clientSecret, scopes: scopeList });

    const redirectUri = `${baseUrl}/ui/linkedin/callback`;
    const state = `agentgate_linkedin_${accountName}`;

    const authUrl = 'https://www.linkedin.com/oauth/v2/authorization?' +
      `response_type=code&client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scopeList)}&state=${encodeURIComponent(state)}`;

    res.redirect(authUrl);
  });

  router.get('/linkedin/callback', async (req, res) => {
    const { code, error, error_description, state } = req.query;
    const accountName = state?.replace('agentgate_linkedin_', '') || 'default';
    
    if (error) {
      const creds = getAccountCredentials('linkedin', accountName);
      if (creds) {
        setAccountCredentials('linkedin', accountName, { ...creds, authStatus: 'failed', authError: `${error}${error_description ? ` - ${error_description}` : ''}` });
      }
      return res.status(400).send(renderErrorPage('LinkedIn OAuth Error', `LinkedIn returned an error: ${error}${error_description ? ` - ${error_description}` : ''}`));
    }

    const creds = getAccountCredentials('linkedin', accountName);
    if (!creds) {
      return res.status(400).send(renderErrorPage('Setup Error', 'LinkedIn account not found. Please try setup again.'));
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
        setAccountCredentials('linkedin', accountName, { ...creds, authStatus: 'failed', authError: `${tokens.error}${tokens.error_description ? ` - ${tokens.error_description}` : ''}` });
        return res.status(400).send(renderErrorPage('Token Error', `LinkedIn token exchange failed: ${tokens.error}${tokens.error_description ? ` - ${tokens.error_description}` : ''}`));
      }

      setAccountCredentials('linkedin', accountName, {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000,
        authStatus: 'success'
      });

      res.redirect('/ui');
    } catch (err) {
      setAccountCredentials('linkedin', accountName, { ...creds, authStatus: 'failed', authError: err.message });
      res.status(500).send(renderErrorPage('Connection Error', `LinkedIn OAuth failed: ${err.message}`));
    }
  });

  router.post('/linkedin/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('linkedin', accountName);
    res.redirect('/ui');
  });

  router.post('/linkedin/retry', (req, res) => {
    const { accountName } = req.body;
    const creds = getAccountCredentials('linkedin', accountName);
    if (!creds || !creds.clientId || !creds.clientSecret) {
      return res.status(400).send(renderErrorPage('Retry Error', 'Account credentials not found. Please set up the account again.'));
    }

    const redirectUri = `${baseUrl}/ui/linkedin/callback`;
    const scopeList = creds.scopes || 'openid profile email w_member_social';
    const state = `agentgate_linkedin_${accountName}`;

    const authUrl = 'https://www.linkedin.com/oauth/v2/authorization?' +
      `response_type=code&client_id=${creds.clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scopeList)}&state=${encodeURIComponent(state)}`;

    res.redirect(authUrl);
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'linkedin');

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
        <form method="POST" action="/ui/linkedin/retry" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-primary">Retry Auth</button>
        </form>` : '';
      
      return `
      <div class="account-item">
        <span><strong>${acc.name}</strong>${statusBadge}</span>
        <div style="display: flex; gap: 8px;">
          ${retryBtn}
          <form method="POST" action="/ui/linkedin/delete" style="margin:0;">
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
      <img class="service-icon" src="/public/icons/linkedin.svg" alt="LinkedIn">
      <h3>LinkedIn</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add LinkedIn Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create an app at <a href="https://www.linkedin.com/developers/apps" target="_blank">LinkedIn Developers</a>. Request both "Share on LinkedIn" AND "Sign In with LinkedIn using OpenID Connect" products.</p>
        <p class="help">Redirect URL: <span class="copyable">${baseUrl}/ui/linkedin/callback <button type="button" class="copy-btn" onclick="copyText('${baseUrl}/ui/linkedin/callback', this)">Copy</button></span></p>
        <form method="POST" action="/ui/linkedin/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="personal, business, etc." required>
          <label>Client ID</label>
          <input type="text" name="clientId" placeholder="LinkedIn client ID" required>
          <label>Client Secret</label>
          <input type="password" name="clientSecret" placeholder="LinkedIn client secret" required>
          <label>Scopes <span style="font-weight: normal; color: #9ca3af;">(comma or space separated)</span></label>
          <input type="text" name="scopes" placeholder="openid profile email w_member_social" value="openid profile email w_member_social">
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'linkedin';
export const displayName = 'LinkedIn';
