#!/usr/bin/env node

import { selectPrompt, handleCancel } from './helpers.js';
import { servicesScreen } from './screens/services.js';
import { agentsScreen } from './screens/agents.js';
import { keysScreen } from './screens/keys.js';
import { tunnelScreen } from './screens/tunnel.js';
import { advancedScreen } from './screens/advanced.js';

const MENU_CHOICES = [
  { name: 'services', message: 'Services' },
  { name: 'agents', message: 'Agents' },
  { name: 'keys', message: 'API Keys' },
  { name: 'tunnel', message: 'Remote Access (Tunnel)' },
  { name: 'advanced', message: 'Advanced' },
  { name: 'exit', message: 'Exit' }
];

const screens = {
  services: servicesScreen,
  agents: agentsScreen,
  keys: keysScreen,
  tunnel: tunnelScreen,
  advanced: advancedScreen
};

const BANNER = `
    _                    _    ____       _       
   / \\   __ _  ___ _ __ | |_ / ___| __ _| |_ ___ 
  / _ \\ / _\` |/ _ \\ '_ \\| __| |  _ / _\` | __/ _ \\
 / ___ \\ (_| |  __/ | | | |_| |_| | (_| | ||  __/
/_/   \\_\\__, |\\___|_| |_|\\__|\\____|\\__,_|\\__\\___|
        |___/                                     
`;

async function main() {
  console.log(BANNER);
  console.log('  🔒 Secure gateway for AI agents\n');

  while (true) {
    try {
      const choice = await selectPrompt('Main Menu', MENU_CHOICES);

      if (choice === 'exit') {
        console.log('Goodbye!\n');
        process.exit(0);
      }

      const screen = screens[choice];
      if (screen) {
        await screen();
      }
    } catch (err) {
      if (handleCancel(err)) {
        console.log('\nGoodbye!\n');
        process.exit(0);
      }
      console.error('Error:', err.message);
    }
  }
}

main();
