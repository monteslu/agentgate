import {
  selectPrompt,
  inputPrompt,
  passwordPrompt,
  confirmPrompt,
  handleCancel
} from '../helpers.js';
import {
  listAccounts,
  setAccountCredentials,
  deleteAccount
} from '../../lib/db.js';

const SERVICE_TYPES = [
  { id: 'github', name: 'GitHub', icon: '🐙' },
  { id: 'bluesky', name: 'Bluesky', icon: '🦋' },
  { id: 'mastodon', name: 'Mastodon', icon: '🐘' },
  { id: 'reddit', name: 'Reddit', icon: '🤖' },
  { id: 'calendar', name: 'Calendar', icon: '📅' },
  { id: 'youtube', name: 'YouTube', icon: '▶️' },
  { id: 'fitbit', name: 'Fitbit', icon: '⌚' },
  { id: 'jira', name: 'Jira', icon: '📋' },
  { id: 'linkedin', name: 'LinkedIn', icon: '💼' }
];

export async function servicesScreen() {
  while (true) {
    try {
      const accounts = listAccounts();

      const choices = [
        ...accounts.map((a) => ({
          name: `${a.service}/${a.name}`,
          message: `${a.service} / ${a.name}`
        })),
        { name: '__add', message: '+ Add Service' },
        { name: '__back', message: '← Back' }
      ];

      const choice = await selectPrompt('Services', choices);

      if (choice === '__back') return;

      if (choice === '__add') {
        await addServiceFlow();
        continue;
      }

      const account = accounts.find((a) => `${a.service}/${a.name}` === choice);
      if (account) {
        await serviceDetail(account);
      }
    } catch (err) {
      if (handleCancel(err)) return;
      console.error('Error:', err.message);
      return;
    }
  }
}

async function addServiceFlow() {
  try {
    const serviceId = await selectPrompt(
      'Service type',
      [
        ...SERVICE_TYPES.map((s) => ({
          name: s.id,
          message: `${s.icon} ${s.name}`
        })),
        { name: '__back', message: '← Back' }
      ]
    );

    if (serviceId === '__back') return;

    const accountName = await inputPrompt('Account name (e.g. personal, work)');
    const token = await passwordPrompt('API key / token');

    const confirmed = await confirmPrompt(`Add ${serviceId}/${accountName}?`);
    if (!confirmed) return;

    setAccountCredentials(serviceId, accountName, { token });
    console.log(`\n✅ Added ${serviceId}/${accountName}\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error adding service:', err.message);
  }
}

async function serviceDetail(account) {
  try {
    const action = await selectPrompt(
      `${account.service} / ${account.name}`,
      [
        { name: 'remove', message: 'Remove' },
        { name: 'back', message: '← Back' }
      ]
    );

    if (action === 'back') return;

    if (action === 'remove') {
      const confirmed = await confirmPrompt(`Remove ${account.service}/${account.name}?`);
      if (confirmed) {
        deleteAccount(account.service, account.name);
        console.log(`\n✅ Removed ${account.service}/${account.name}\n`);
      }
    }
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
