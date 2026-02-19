import { setAccountCredentials, deleteAccount } from '../../lib/db.js';
import { escapeHtml } from './shared.js';

export function registerRoutes(router) {
  router.post('/twilio/setup', (req, res) => {
    const { accountName, accountSid, authToken } = req.body;
    if (!accountName || !accountSid || !authToken) {
      return res.status(400).send('Account name, Account SID, and Auth Token required');
    }
    setAccountCredentials('twilio', accountName, { accountSid, authToken });
    res.redirect('/ui');
  });

  router.post('/twilio/delete', (req, res) => {
    const { accountName } = req.body;
    deleteAccount('twilio', accountName);
    res.redirect('/ui');
  });
}

export function renderCard(accounts, _baseUrl) {
  const serviceAccounts = accounts.filter(a => a.service === 'twilio');

  const renderAccounts = () => {
    if (serviceAccounts.length === 0) return '';
    return serviceAccounts.map(acc => `
      <div class="account-item">
        <span><strong>${escapeHtml(acc.name)}</strong></span>
        <form method="POST" action="/ui/twilio/delete" style="margin:0;">
          <input type="hidden" name="accountName" value="${escapeHtml(acc.name)}" autocomplete="off">
          <button type="submit" class="btn-sm btn-danger">Remove</button>
        </form>
      </div>
    `).join('');
  };

  return `
  <div class="card">
    <div class="service-header">
      <span class="service-icon" style="font-size:2em;">📱</span>
      <h3>Twilio</h3>
    </div>
    ${renderAccounts()}
    <details>
      <summary>Add Twilio Account</summary>
      <div style="margin-top: 15px;">
        <p class="help">Find your Account SID and Auth Token in the <a href="https://console.twilio.com/" target="_blank">Twilio Console</a></p>
        <form method="POST" action="/ui/twilio/setup">
          <label>Account Name</label>
          <input type="text" name="accountName" placeholder="main, production, etc." required autocomplete="off">
          <label>Account SID</label>
          <input type="text" name="accountSid" placeholder="AC..." required autocomplete="off">
          <label>Auth Token</label>
          <div style="position:relative;">
            <input type="text" name="authToken" id="twilio-token-card" placeholder="Your auth token" required autocomplete="off" style="padding-right:60px;">
            <button type="button" onclick="const i=document.getElementById('twilio-token-card');const t=i.type==='password'?'text':'password';i.type=t;this.textContent=t==='password'?'Show':'Hide';" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;background:none;cursor:pointer;color:var(--text-muted);font-size:0.85em;">Hide</button>
          </div>
          <button type="submit" class="btn-primary">Add Account</button>
        </form>
      </div>
    </details>
  </div>`;
}

export const serviceName = 'twilio';
export const displayName = 'Twilio';
