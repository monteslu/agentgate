import {
  selectPrompt,
  confirmPrompt,
  handleCancel
} from '../helpers.js';
import {
  getMessagingMode,
  setMessagingMode,
  getSharedQueueVisibility,
  setSharedQueueVisibility,
  getAgentWithdrawEnabled,
  setAgentWithdrawEnabled
} from '../../lib/db.js';

export async function advancedScreen() {
  while (true) {
    try {
      const messagingMode = getMessagingMode();
      const sharedQueue = getSharedQueueVisibility();
      const agentWithdraw = getAgentWithdrawEnabled();

      const choices = [
        { name: 'messaging', message: `Messaging Mode [${messagingMode}]` },
        { name: 'shared-queue', message: `Shared Queue Visibility [${sharedQueue ? 'on' : 'off'}]` },
        { name: 'agent-withdraw', message: `Agent Withdraw [${agentWithdraw ? 'on' : 'off'}]` },
        { name: 'back', message: '← Back' }
      ];

      const choice = await selectPrompt('Advanced Settings', choices);

      if (choice === 'back') return;

      if (choice === 'messaging') {
        const mode = await selectPrompt(
          `Messaging Mode (current: ${messagingMode})`,
          [
            { name: 'off', message: 'Off — no inter-agent messaging' },
            { name: 'supervised', message: 'Supervised — require human approval' },
            { name: 'open', message: 'Open — deliver immediately' }
          ]
        );
        setMessagingMode(mode);
        console.log(`\n✅ Messaging mode set to "${mode}"\n`);
      }

      if (choice === 'shared-queue') {
        const enabled = await confirmPrompt(
          `${sharedQueue ? 'Disable' : 'Enable'} shared queue visibility?`
        );
        if (enabled) {
          setSharedQueueVisibility(!sharedQueue);
          console.log(`\n✅ Shared queue visibility ${!sharedQueue ? 'enabled' : 'disabled'}\n`);
        }
      }

      if (choice === 'agent-withdraw') {
        const enabled = await confirmPrompt(
          `${agentWithdraw ? 'Disable' : 'Enable'} agent withdraw?`
        );
        if (enabled) {
          setAgentWithdrawEnabled(!agentWithdraw);
          console.log(`\n✅ Agent withdraw ${!agentWithdraw ? 'enabled' : 'disabled'}\n`);
        }
      }
    } catch (err) {
      if (handleCancel(err)) return;
      console.error('Error:', err.message);
      return;
    }
  }
}
