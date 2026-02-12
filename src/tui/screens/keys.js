// API Key management screen for TUI
import { term, selectPrompt, inputPrompt, confirmPrompt, handleCancel } from '../helpers.js';
import { listApiKeys, createApiKey, deleteApiKey, setAgentEnabled } from '../../lib/db.js';

function showKeys(keys) {
  if (keys.length === 0) {
    term('\n  No API keys configured.\n\n');
    return;
  }
  term('\n  ').bold('API Keys:')('\n');
  for (const k of keys) {
    const status = k.enabled === 0 ? ' (disabled)' : '';
    const webhook = k.webhook_url ? ' 🔔' : '';
    term(`  • ${k.name} [${k.key_prefix}...]${status}${webhook}\n`);
  }
  term('\n');
}

async function createKeyScreen() {
  try {
    const name = await inputPrompt('Agent name', {
      validate: (v) => v.trim() ? true : 'Name required'
    });
    if (!name.trim()) return;

    const result = await createApiKey(name.trim());
    term.green(`\n  ✅ API key created for "${name.trim()}"\n`);
    term.yellow("\n  ⚠️  Save this key — it won't be shown again:\n\n");
    term.bold(`  ${result.key}\n\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    if (err.message?.includes('UNIQUE')) {
      term.red('\n  ❌ An agent with that name already exists.\n\n');
    } else {
      term.red(`  Error: ${err.message}\n`);
    }
  }
}

async function deleteKeyScreen(keys) {
  try {
    if (keys.length === 0) {
      term('\n  No keys to delete.\n\n');
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
    term.green(`\n  ✅ "${agent.name}" deleted\n\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    term.red(`  Error: ${err.message}\n`);
  }
}

async function toggleKeyScreen(keys) {
  try {
    if (keys.length === 0) {
      term('\n  No keys to toggle.\n\n');
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
    term.green(`\n  ✅ "${agent.name}" ${newState ? 'enabled' : 'disabled'}\n\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    term.red(`  Error: ${err.message}\n`);
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
    term.red(`  Error: ${err.message}\n`);
  }
}
