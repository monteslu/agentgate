// Service account setup screen for TUI
import { selectPrompt, inputPrompt, passwordPrompt, handleCancel, confirmPrompt } from '../helpers.js';
import { setAccountCredentials, deleteAccount, listAccounts } from '../../lib/db.js';

// Services that support simple token/key auth in TUI
const TUI_SERVICES = [
  {
    id: 'github',
    name: 'GitHub',
    fields: [
      { name: 'token', label: 'Personal Access Token', masked: true, help: 'Create at https://github.com/settings/tokens' }
    ]
  },
  {
    id: 'bluesky',
    name: 'Bluesky',
    fields: [
      { name: 'identifier', label: 'Handle (e.g. user.bsky.social)', masked: false },
      { name: 'password', label: 'App Password', masked: true, help: 'Create at https://bsky.app/settings/app-passwords' }
    ]
  },
  {
    id: 'mastodon',
    name: 'Mastodon',
    fields: [
      { name: 'instance', label: 'Instance (e.g. fosstodon.org)', masked: false },
      { name: 'accessToken', label: 'Access Token', masked: true, help: 'Create at {instance}/settings/applications' }
    ]
  },
  {
    id: 'jira',
    name: 'Jira',
    fields: [
      { name: 'domain', label: 'Jira Domain (e.g. yourcompany.atlassian.net)', masked: false },
      { name: 'email', label: 'Email', masked: false },
      { name: 'apiToken', label: 'API Token', masked: true, help: 'Create at https://id.atlassian.com/manage-profile/security/api-tokens' }
    ]
  }
];

function showAccounts() {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.log('\n  No service accounts configured.\n');
    return accounts;
  }
  console.log('\n  Service Accounts:');
  for (const acc of accounts) {
    console.log(`  • ${acc.service}/${acc.name}`);
  }
  console.log();
  return accounts;
}

async function addServiceScreen() {
  try {
    const choices = TUI_SERVICES.map(s => ({
      name: s.id,
      message: s.name
    }));
    choices.push({ name: 'back', message: '← Back' });

    const serviceId = await selectPrompt('Add service', choices);
    if (serviceId === 'back') return;

    const service = TUI_SERVICES.find(s => s.id === serviceId);

    const accountName = await inputPrompt('Account name (e.g. personal, work)', {
      validate: (v) => v.trim() ? true : 'Name required'
    });
    if (!accountName.trim()) return;

    const creds = {};
    for (const field of service.fields) {
      if (field.help) {
        console.log(`  ℹ  ${field.help}`);
      }
      if (field.masked) {
        creds[field.name] = await passwordPrompt(field.label);
      } else {
        creds[field.name] = await inputPrompt(field.label);
      }
      if (!creds[field.name]) {
        console.log(`  ${field.label} cannot be empty.\n`);
        return;
      }
    }

    // Mastodon needs authStatus set
    if (serviceId === 'mastodon') {
      creds.authStatus = 'success';
      creds.instance = creds.instance.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }

    setAccountCredentials(serviceId, accountName.trim(), creds);
    console.log(`\n✅ ${service.name} account "${accountName.trim()}" added\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}

async function removeServiceScreen(accounts) {
  try {
    if (accounts.length === 0) {
      console.log('\n  No accounts to remove.\n');
      return;
    }

    const choices = accounts.map(a => ({
      name: `${a.service}::${a.name}`,
      message: `${a.service}/${a.name}`
    }));
    choices.push({ name: 'back', message: '← Back' });

    const selected = await selectPrompt('Remove which account?', choices);
    if (selected === 'back') return;

    const [service, name] = selected.split('::');
    const confirmed = await confirmPrompt(`Remove ${service}/${name}?`);
    if (!confirmed) return;

    deleteAccount(service, name);
    console.log(`\n✅ ${service}/${name} removed\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}

export async function servicesScreen() {
  try {
    while (true) {
      const accounts = showAccounts();

      const choices = [
        { name: 'add', message: 'Add service account' },
        { name: 'remove', message: 'Remove service account' },
        { name: 'back', message: '← Back' }
      ];

      const choice = await selectPrompt('Services', choices);
      if (choice === 'back') return;
      if (choice === 'add') await addServiceScreen();
      if (choice === 'remove') await removeServiceScreen(accounts);
    }
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
