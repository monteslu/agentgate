// API Key management screen for TUI
import { selectPrompt, inputPrompt, confirmPrompt, handleCancel } from '../helpers.js';
import { listApiKeys, createApiKey, deleteApiKey, setAgentEnabled } from '../../lib/db.js';

function showKeys(keys) {
  if (keys.length === 0) {
    console.log('\n  No API keys configured.\n');
    return;
  }
  console.log('\n  API Keys:');
  for (const k of keys) {
    const status = k.enabled === 0 ? ' (disabled)' : '';
    const webhook = k.webhook_url ? ' 🔔' : '';
    console.log(`  • ${k.name} [${k.key_prefix}...]${status}${webhook}`);
  }
  console.log();
}

async function createKeyScreen() {
  try {
    const name = await inputPrompt('Agent name', {
      validate: (v) => v.trim() ? true : 'Name required'
    });
    if (!name.trim()) return;

    const result = await createApiKey(name.trim());
    console.log(`\n✅ API key created for "${name.trim()}"`);
    console.log("\n  ⚠️  Save this key — it won't be shown again:\n");
    console.log(`  ${result.key}\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    if (err.message?.includes('UNIQUE')) {
      console.log('\n  ❌ An agent with that name already exists.\n');
    } else {
      console.error('Error:', err.message);
    }
  }
}

async function deleteKeyScreen(keys) {
  try {
    if (keys.length === 0) {
      console.log('\n  No keys to delete.\n');
      return;
    }

    const choices = keys.map(k => ({
      name: k.id,
      message: `${k.name} [${k.key_prefix}...]`
    }));
    choices.push({ name: 'back', message: '← Back' });

    const id = await selectPrompt('Delete which agent?', choices);
    if (id === 'back') return;

    const agent = keys.find(k => k.id === id);
    const confirmed = await confirmPrompt(`Delete "${agent.name}" and all related data?`);
    if (!confirmed) return;

    deleteApiKey(id);
    console.log(`\n✅ "${agent.name}" deleted\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}

async function toggleKeyScreen(keys) {
  try {
    if (keys.length === 0) {
      console.log('\n  No keys to toggle.\n');
      return;
    }

    const choices = keys.map(k => ({
      name: k.id,
      message: `${k.name} — currently ${k.enabled === 0 ? 'DISABLED' : 'enabled'}`
    }));
    choices.push({ name: 'back', message: '← Back' });

    const id = await selectPrompt('Toggle which agent?', choices);
    if (id === 'back') return;

    const agent = keys.find(k => k.id === id);
    const newState = agent.enabled === 0 ? 1 : 0;
    setAgentEnabled(id, newState);
    console.log(`\n✅ "${agent.name}" ${newState ? 'enabled' : 'disabled'}\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}

export async function keysScreen() {
  try {
    while (true) {
      const keys = listApiKeys();
      showKeys(keys);

      const choice = await selectPrompt('API Keys', [
        { name: 'create', message: 'Create new API key' },
        { name: 'toggle', message: 'Enable/disable agent' },
        { name: 'delete', message: 'Delete agent' },
        { name: 'back', message: '← Back' }
      ]);

      if (choice === 'back') return;
      if (choice === 'create') await createKeyScreen();
      if (choice === 'toggle') await toggleKeyScreen(keys);
      if (choice === 'delete') await deleteKeyScreen(keys);
    }
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
