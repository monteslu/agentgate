#!/usr/bin/env node

import { selectPrompt, passwordPrompt, confirmPrompt, handleCancel } from './helpers.js';
import { tunnelScreen } from './screens/tunnel.js';
import { keysScreen } from './screens/keys.js';
import { servicesScreen } from './screens/services.js';
import { settingsScreen } from './screens/settings.js';
import { hasAdminPassword, setAdminPassword } from '../lib/db.js';

const BANNER = `
    _                    _    ____       _       
   / \\   __ _  ___ _ __ | |_ / ___| __ _| |_ ___ 
  / _ \\ / _\` |/ _ \\ '_ \\| __| |  _ / _\` | __/ _ \\
 / ___ \\ (_| |  __/ | | | |_| |_| | (_| | ||  __/
/_/   \\_\\__, |\\___|_| |_|\\__|\\____|\\__,_|\\__\\___|
        |___/                                     
`;

async function adminPasswordScreen() {
  try {
    const hasPassword = hasAdminPassword();
    if (hasPassword) {
      console.log('  Admin password is set ✅\n');
      const change = await confirmPrompt('Change admin password?');
      if (!change) return;
    }

    const password = await passwordPrompt('New admin password');
    if (!password) {
      console.log('Password cannot be empty.\n');
      return;
    }

    const confirm = await passwordPrompt('Confirm password');
    if (password !== confirm) {
      console.log('Passwords do not match.\n');
      return;
    }

    await setAdminPassword(password);
    console.log('\n✅ Admin password set\n');
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}

async function main() {
  console.log(BANNER);
  console.log('  🔒 Secure gateway for AI agents\n');

  while (true) {
    try {
      const choice = await selectPrompt('Setup', [
        { name: 'password', message: 'Admin Password' },
        { name: 'keys', message: 'API Keys (Agents)' },
        { name: 'services', message: 'Services' },
        { name: 'tunnel', message: 'Remote Access (Tunnel)' },
        { name: 'settings', message: 'Settings' },
        { name: 'exit', message: 'Exit' }
      ]);

      if (choice === 'exit') {
        console.log('Goodbye!\n');
        process.exit(0);
      }

      if (choice === 'password') await adminPasswordScreen();
      if (choice === 'keys') await keysScreen();
      if (choice === 'services') await servicesScreen();
      if (choice === 'tunnel') await tunnelScreen();
      if (choice === 'settings') await settingsScreen();
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
