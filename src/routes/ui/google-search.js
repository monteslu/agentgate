import { setAccountCredentials, deleteAccount } from '../../lib/db.js';
import { escapeHtml } from './shared.js';

export function registerRoutes(router) {
  router.post('/google_search/setup', (req, res) => {
    const { accountName, apiKey, cx } = req.body;
    if (!accountName || !apiKey || !cx) {
      return res.status(400).send('Account name, API key, and Search Engine ID (cx) required');
    }
    setAccountCredentials('google_search', accountName, { api_key: apiKey, cx });
    res.redirect('/ui');
  });

  router.post('/google_search/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('google_search', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'google_search');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${escapeHtml(acc.name)}</strong></span>
        <form method="POST" action="/ui/google_search/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${escapeHtml(acc.name)}" autocomplete="off">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/google-search.svg" alt="Google Search">
      <h3>Google Search</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Google Search Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">
          1. Get an API key from <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a><br>
          2. Create a search engine at <a href="https://programmablesearchengine.google.com/" target="_blank">Programmable Search Engine</a>
        </p>
        <form method="POST" action="/ui/google_search/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="default, work, etc." required autocomplete="off">
          <label>API Key</label>
          <input type="password" name="apiKey" placeholder="AIza..." required autocomplete="off">
          <label>Search Engine ID (cx)</label>
          <input type="text" name="cx" placeholder="abc123..." required autocomplete="off">
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'google_search';
export const displayName = 'Google Search';
