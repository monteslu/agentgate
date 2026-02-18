import { setAccountCredentials, deleteAccount } from '../../lib/db.js';
import { escapeHtml } from './shared.js';

export function registerRoutes(router) {
  router.post('/homeassistant/setup', (req, res) => {
    const { accountName, host, token } = req.body;
    if (!accountName || !host || !token) {
      return res.status(400).send('Account name, host URL, and access token required');
    }
    // Normalize host: strip trailing slash
    const normalizedHost = host.replace(/\/+$/, '');
    setAccountCredentials('homeassistant', accountName, { host: normalizedHost, token });
    res.redirect('/ui');
  });

  router.post('/homeassistant/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('homeassistant', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'homeassistant');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${escapeHtml(acc.name)}</strong></span>
        <form method="POST" action="/ui/homeassistant/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${escapeHtml(acc.name)}" autocomplete="off">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/homeassistant.svg" alt="Home Assistant">
      <h3>Home Assistant</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Home Assistant Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create a long-lived access token in Home Assistant: Profile → Security → Long-Lived Access Tokens → Create Token</p>
        <form method="POST" action="/ui/homeassistant/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="home, office, etc." required autocomplete="off">
          <label>Host URL</label>
          <input type="text" name="host" placeholder="http://homeassistant.local:8123" required autocomplete="off">
          <label>Long-Lived Access Token</label>
          <input type="password" name="token" placeholder="eyJ..." required autocomplete="off">
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'homeassistant';
export const displayName = 'Home Assistant';
