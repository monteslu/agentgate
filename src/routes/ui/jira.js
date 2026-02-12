import { setAccountCredentials, deleteAccount, getAccountCredentials } from '../../lib/db.js';

export function registerRoutes(router, _baseUrl) {
  router.post('/jira/setup', (req, res) => {
    const { accountName, domain, email, apiToken } = req.body;
    if (!accountName || !domain || !email || !apiToken) {
      return res.status(400).send('Account name, domain, email, and API token required');
    }
    setAccountCredentials('jira', accountName, {
      domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      email,
      apiToken
    });
    res.redirect('/ui');
  });

  router.post('/jira/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('jira', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'jira');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => {
      const creds = getAccountCredentials('jira', acc.name);
      const info = creds?.domain ? `${acc.name} (${creds.domain})` : acc.name;
      return `
        <div class="account-item">
          <span><strong>${info}</strong></span>
          <form method="POST" action="/ui/jira/delete" style="margin:0;">
            <input type="hidden" name="accountName" value="${acc.name}" autocomplete="off">
            <button type="submit" class="btn-sm btn-danger">Remove</button>
          </form>
        </div>
      `;
    }).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <img class="service-icon" src="/public/icons/jira.svg" alt="Jira">
      <h3>Jira</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Jira Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Create an API token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">Atlassian Account Settings</a>.</p>
        <form method="POST" action="/ui/jira/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="work, client, etc." required autocomplete="off">
          <label>Jira Domain</label>
          <input type="text" name="domain" placeholder="yourcompany.atlassian.net" required autocomplete="off">
          <label>Email</label>
          <input type="text" name="email" placeholder="you@company.com" required autocomplete="off">
          <label>API Token</label>
          <input type="password" name="apiToken" placeholder="Your Jira API token" required autocomplete="off">
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'jira';
export const displayName = 'Jira';
