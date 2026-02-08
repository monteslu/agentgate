// Tunnel configuration — stub for Luthien to implement
// See issue #157 for details on tunnel type select, config, and test flows

import { selectPrompt, handleCancel } from '../helpers.js';

export async function tunnelScreen() {
  try {
    console.log('\n🚧 Remote Access (Tunnel) configuration is coming soon.\n');

    await selectPrompt('Tunnel', [
      { name: 'back', message: '← Back' }
    ]);
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
