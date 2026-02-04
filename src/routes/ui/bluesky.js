import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';

export function registerRoutes(router) {
  router.post('/bluesky/setup', (req, res) => {
    const { accountName, identifier, appPassword } = req.body;
    if (!accountName || !identifier || !appPassword) {
      return res.status(400).send('Account name, identifier, and app password required');
    }
    setAccountCredentials('bluesky', accountName, { identifier, appPassword });
    res.redirect('/ui');
  });

  router.post('/bluesky/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('bluesky', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'bluesky');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => {
      const creds = getAccountCredentials('bluesky', acc.name);
      const info = creds?.identifier ? `${acc.name} (${creds.identifier})` : acc.name;
      return `
        <div class="account-item">
          <span><strong>${info}</strong></span>
          <form method="POST" action="/ui/bluesky/delete" style="margin:0;">
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
      <img class="service-icon" src="/public/icons/bluesky.svg" alt="Bluesky">
      <h3>Bluesky</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Bluesky Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create an app password at <a href="https://bsky.app/settings/app-passwords" target="_blank">bsky.app/settings/app-passwords</a></p>
        <form method="POST" action="/ui/bluesky/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="main, alt, etc." required>
          <label>Handle (no @ symbol)</label>
          <input type="text" name="identifier" placeholder="yourname.bsky.social" required>
          <label>App Password</label>
          <input type="password" name="appPassword" placeholder="xxxx-xxxx-xxxx-xxxx" required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'bluesky';
export const displayName = 'Bluesky';
