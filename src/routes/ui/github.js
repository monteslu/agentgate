import { setAccountCredentials, deleteAccount } from '../../lib/db.js';

export function registerRoutes(router) {
  router.post('/github/setup', (req, res) => {
    const { accountName, token } = req.body;
    if (!accountName || !token) {
      return res.status(400).send('Account name and personal access token required');
    }
    setAccountCredentials('github', accountName, { token });
    res.redirect('/ui');
  });

  router.post('/github/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('github', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'github');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${acc.name}</strong></span>
        <form method="POST" action="/ui/github/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${acc.name}">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/github.svg" alt="GitHub">
      <h3>GitHub</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add GitHub Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create a token at <a href="https://github.com/settings/tokens" target="_blank">github.com/settings/tokens</a></p>
        <form method="POST" action="/ui/github/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="personal, work, etc." required>
          <label>Personal Access Token</label>
          <input type="password" name="token" placeholder="ghp_xxxx or github_pat_xxxx" required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'github';
export const displayName = 'GitHub';
