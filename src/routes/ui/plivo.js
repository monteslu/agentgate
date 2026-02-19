import { setAccountCredentials, deleteAccount } from '../../lib/db.js';
import { escapeHtml } from './shared.js';

export function registerRoutes(router) {
  router.post('/plivo/setup', (req, res) => {
    const { accountName, authId, authToken } = req.body;
    if (!accountName || !authId || !authToken) {
      return res.status(400).send('Account name, Auth ID, and Auth Token required');
    }
    setAccountCredentials('plivo', accountName, { authId, authToken });
    res.redirect('/ui');
  });

  router.post('/plivo/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('plivo', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'plivo');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${escapeHtml(acc.name)}</strong></span>
        <form method="POST" action="/ui/plivo/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${escapeHtml(acc.name)}" autocomplete="off">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/plivo.svg" alt="Plivo">
      <h3>Plivo</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Plivo Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Get your Auth ID and Auth Token from the <a href="https://console.plivo.com/dashboard/" target="_blank">Plivo Console</a></p>
        <form method="POST" action="/ui/plivo/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="default, work, etc." required autocomplete="off">
          <label>Auth ID</label>
          <input type="text" name="authId" placeholder="Your Plivo Auth ID" required autocomplete="off">
          <label>Auth Token</label>
          <input type="password" name="authToken" placeholder="Your Plivo Auth Token" required autocomplete="off">
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'plivo';
export const displayName = 'Plivo';
