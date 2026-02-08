import {
  selectPrompt,
  inputPrompt,
  confirmPrompt,
  asyncAction,
  handleCancel
} from '../helpers.js';
import {
  listApiKeys,
  getApiKeyByName,
  createApiKey,
  deleteApiKey,
  regenerateApiKey
} from '../../lib/db.js';

export async function keysScreen() {
  while (true) {
    try {
      const keys = listApiKeys();

      const choices = [
        ...keys.map((k) => ({
          name: k.id,
          message: `${k.name} — ${k.api_key.slice(0, 12)}...${k.enabled ? '' : ' (disabled)'}`
        })),
        { name: '__create', message: '+ Create API Key' },
        { name: '__back', message: '← Back' }
      ];

      const choice = await selectPrompt('API Keys', choices);

      if (choice === '__back') return;

      if (choice === '__create') {
        await createKeyFlow();
        continue;
      }

      const key = keys.find((k) => k.id === choice);
      if (key) {
        await keyDetail(key);
      }
    } catch (err) {
      if (handleCancel(err)) return;
      console.error('Error:', err.message);
      return;
    }
  }
}

async function createKeyFlow() {
  try {
    const name = await inputPrompt('Agent name');

    if (!name) {
      console.log('Name is required.\n');
      return;
    }

    const existing = getApiKeyByName(name);
    if (existing) {
      console.log(`Agent "${name}" already exists.\n`);
      return;
    }

    const confirmed = await confirmPrompt(`Create API key for "${name}"?`);
    if (!confirmed) return;

    const result = await asyncAction('Creating key...', () => createApiKey(name));

    console.log(`\n✅ API key created for "${name}":`);
    console.log(`\n   ${result.api_key}\n`);
    console.log('   ⚠️  Save this key — it cannot be shown again.\n');
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error creating key:', err.message);
  }
}

async function keyDetail(key) {
  try {
    const action = await selectPrompt(
      `Key: ${key.name}`,
      [
        { name: 'regenerate', message: 'Regenerate Key' },
        { name: 'delete', message: 'Delete' },
        { name: 'back', message: '← Back' }
      ]
    );

    if (action === 'back') return;

    if (action === 'regenerate') {
      const confirmed = await confirmPrompt(`Regenerate key for "${key.name}"? Old key will stop working.`);
      if (confirmed) {
        const result = await asyncAction('Regenerating...', () => regenerateApiKey(key.id));
        console.log(`\n✅ New key for "${key.name}":`);
        console.log(`\n   ${result.api_key}\n`);
        console.log('   ⚠️  Save this key — it cannot be shown again.\n');
      }
    }

    if (action === 'delete') {
      const confirmed = await confirmPrompt(`Delete key for "${key.name}"? This cannot be undone.`);
      if (confirmed) {
        deleteApiKey(key.id);
        console.log(`\n✅ Key for "${key.name}" deleted\n`);
      }
    }
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
