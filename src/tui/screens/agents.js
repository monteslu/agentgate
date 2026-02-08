import {
  selectPrompt,
  inputPrompt,
  confirmPrompt,
  handleCancel
} from '../helpers.js';
import {
  listApiKeys,
  deleteApiKey,
  updateAgentWebhook
} from '../../lib/db.js';

export async function agentsScreen() {
  while (true) {
    try {
      const agents = listApiKeys();

      const choices = [
        ...agents.map((a) => ({
          name: a.id,
          message: `${a.name}${a.enabled ? '' : ' (disabled)'}${a.webhook_url ? ' 🔔' : ''}`
        })),
        { name: '__back', message: '← Back' }
      ];

      const choice = await selectPrompt('Agents', choices);

      if (choice === '__back') return;

      const agent = agents.find((a) => a.id === choice);
      if (agent) {
        await agentDetail(agent);
      }
    } catch (err) {
      if (handleCancel(err)) return;
      console.error('Error:', err.message);
      return;
    }
  }
}

async function agentDetail(agent) {
  try {
    console.log(`\n  Name: ${agent.name}`);
    console.log(`  Enabled: ${agent.enabled ? 'Yes' : 'No'}`);
    console.log(`  Webhook: ${agent.webhook_url || 'None'}`);
    console.log(`  Key: ${agent.api_key.slice(0, 8)}...`);

    const action = await selectPrompt(
      `Agent: ${agent.name}`,
      [
        { name: 'webhook', message: 'Set Webhook URL' },
        { name: 'remove', message: 'Delete Agent' },
        { name: 'back', message: '← Back' }
      ]
    );

    if (action === 'back') return;

    if (action === 'webhook') {
      const url = await inputPrompt('Webhook URL (blank to clear)', {
        initial: agent.webhook_url || ''
      });
      const token = await inputPrompt('Webhook token (optional)', {
        initial: agent.webhook_token || ''
      });
      updateAgentWebhook(agent.id, url || null, token || null);
      console.log('\n✅ Webhook updated\n');
    }

    if (action === 'remove') {
      const confirmed = await confirmPrompt(`Delete agent "${agent.name}"? This cannot be undone.`);
      if (confirmed) {
        deleteApiKey(agent.id);
        console.log(`\n✅ Agent "${agent.name}" deleted\n`);
      }
    }
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
