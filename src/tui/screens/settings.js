// Settings screen for TUI
import { selectPrompt, handleCancel } from '../helpers.js';
import { getMessagingMode, setMessagingMode, getSharedQueueVisibility, setSharedQueueVisibility, getAgentWithdrawEnabled, setSetting } from '../../lib/db.js';

function showSettings() {
  const messaging = getMessagingMode();
  const sharedQueue = getSharedQueueVisibility();
  const withdraw = getAgentWithdrawEnabled();

  console.log('\n  Current Settings:');
  console.log(`  • Messaging mode: ${messaging}`);
  console.log(`  • Shared queue visibility: ${sharedQueue ? 'on' : 'off'}`);
  console.log(`  • Agent withdraw: ${withdraw ? 'on' : 'off'}`);
  console.log();
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
    console.log(`\n✅ Messaging mode set to "${choice}"\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}

async function toggleSetting(label, getter, setter) {
  try {
    const current = getter();
    const newValue = !current;
    setter(newValue);
    console.log(`\n✅ ${label}: ${newValue ? 'on' : 'off'}\n`);
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
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
        await toggleSetting('Shared queue visibility', getSharedQueueVisibility, setSharedQueueVisibility);
      }
      if (choice === 'withdraw') {
        const current = getAgentWithdrawEnabled();
        setSetting('agent_withdraw_enabled', !current);
        console.log(`\n✅ Agent withdraw: ${!current ? 'on' : 'off'}\n`);
      }
    }
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
