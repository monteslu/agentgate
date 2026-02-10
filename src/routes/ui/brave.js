import { setAccountCredentials, deleteAccount } from '../../lib/db.js';
import { escapeHtml } from './shared.js';

export function registerRoutes(router) {
  router.post('/brave/setup', (req, res) => {
    const { accountName, api_key } = req.body;
    if (!accountName || !api_key) {
      return res.status(400).send('Account name and API key required');
    }
    setAccountCredentials('brave', accountName, { api_key });
    res.redirect('/ui');
  });

  router.post('/brave/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('brave', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'brave');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${escapeHtml(acc.name)}</strong></span>
        <form method="POST" action="/ui/brave/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${escapeHtml(acc.name)}">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/brave.svg" alt="Brave Search">
      <h3>Brave Search</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Brave Search Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Get an API key at <a href="https://brave.com/search/api/" target="_blank">brave.com/search/api</a></p>
        <form method="POST" action="/ui/brave/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="default, work, etc." required>
          <label>API Key</label>
          <input type="password" name="api_key" placeholder="BSA..." required>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'brave';
export const displayName = 'Brave Search';
