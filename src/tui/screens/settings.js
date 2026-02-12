// Settings screen for TUI
import { term, selectPrompt, handleCancel } from '../helpers.js';
import { getMessagingMode, setMessagingMode, getSharedQueueVisibility, setSharedQueueVisibility, getAgentWithdrawEnabled, setSetting } from '../../lib/db.js';

function showSettings() {
  const messaging = getMessagingMode();
  const sharedQueue = getSharedQueueVisibility();
  const withdraw = getAgentWithdrawEnabled();

  term('\n  ').bold('Current Settings:')('\n');
  term(`  • Messaging mode: ${messaging}\n`);
  term(`  • Shared queue visibility: ${sharedQueue ? 'on' : 'off'}\n`);
  term(`  • Agent withdraw: ${withdraw ? 'on' : 'off'}\n\n`);
}

async function messagingModeScreen() {
  try {
    const current = getMessagingMode();
    const choice = await selectPrompt(`Messaging mode (current: ${current})`, [
      { name: 'off', message: 'Off — agents cannot message each other' },
      { name: 'supervised', message: 'Supervised — messages need human approval' },
      { name: 'open', message: 'Open — messages delivered immediately' },
      { name: 'back', message: '← Back' }
    ]);

    if (choice === 'back') return;
    setMessagingMode(choice);
    term.green(`\n  ✅ Messaging mode set to "${choice}"\n\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    term.red(`  Error: ${err.message}\n`);
  }
}

export async function settingsScreen() {
  try {
    while (true) {
      showSettings();

      const choice = await selectPrompt('Settings', [
        { name: 'messaging', message: 'Messaging mode' },
        { name: 'queue', message: 'Toggle shared queue visibility' },
        { name: 'withdraw', message: 'Toggle agent withdraw' },
        { name: 'back', message: '← Back' }
      ]);

      if (choice === 'back') return;
      if (choice === 'messaging') await messagingModeScreen();
      if (choice === 'queue') {
        const current = getSharedQueueVisibility();
        setSharedQueueVisibility(!current);
        term.green(`\n  ✅ Shared queue visibility: ${!current ? 'on' : 'off'}\n\n`);
      }
      if (choice === 'withdraw') {
        const current = getAgentWithdrawEnabled();
        setSetting('agent_withdraw_enabled', !current);
        term.green(`\n  ✅ Agent withdraw: ${!current ? 'on' : 'off'}\n\n`);
      }
    }
  } catch (err) {
    if (handleCancel(err)) return;
    term.red(`  Error: ${err.message}\n`);
  }
}
