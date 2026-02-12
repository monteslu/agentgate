#!/usr/bin/env node

import { term, selectPrompt, passwordPrompt, confirmPrompt, handleCancel } from './helpers.js';
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
      term.green('  Admin password is set ✅\n\n');
      const change = await confirmPrompt('Change admin password?');
      if (!change) return;
    }

    const password = await passwordPrompt('New admin password');
    if (!password) {
      term('  Password cannot be empty.\n\n');
      return;
    }

    const confirm = await passwordPrompt('Confirm password');
    if (password !== confirm) {
      term.red('  Passwords do not match.\n\n');
      return;
    }

    await setAdminPassword(password);
    term.green('\n  ✅ Admin password set\n\n');
  } catch (err) {
    if (handleCancel(err)) return;
    term.red(`  Error: ${err.message}\n`);
  }
}

async function main() {
  term.bold.cyan(BANNER);
  term('  🔒 Secure gateway for AI agents\n');

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
        term('\n  Goodbye!\n\n');
        term.processExit(0);
      }

      if (choice === 'password') await adminPasswordScreen();
      if (choice === 'keys') await keysScreen();
      if (choice === 'services') await servicesScreen();
      if (choice === 'tunnel') await tunnelScreen();
      if (choice === 'settings') await settingsScreen();
    } catch (err) {
      if (handleCancel(err)) {
        term('\n  Goodbye!\n\n');
        term.processExit(0);
      }
      term.red(`  Error: ${err.message}\n`);
    }
  }
}

main();
