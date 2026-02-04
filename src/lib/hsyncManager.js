import { createConnection } from 'hsync';
import { getSetting } from './db.js';

let currentConnection = null;
let currentUrl = null;

export async function connectHsync(port) {
  const config = getSetting('hsync');
  if (!config?.enabled) {
    return null;
  }

  // Disconnect existing connection first
  await disconnectHsync();

  try {
    const options = {
      port,
      hsyncServer: config.url,
      hsyncSecret: config.token || undefined
    };

    currentConnection = await createConnection(options);
    currentUrl = currentConnection.publicUrl || currentConnection.url || config.url || null;
    console.log(`hsync connected: ${currentUrl || 'connected'}`);
    return currentConnection;
  } catch (err) {
    console.error('hsync connection failed:', err.message);
    currentConnection = null;
    currentUrl = null;
    return null;
  }
}

export async function disconnectHsync() {
  if (currentConnection) {
    try {
      if (typeof currentConnection.close === 'function') {
        await currentConnection.close();
      } else if (typeof currentConnection.disconnect === 'function') {
        await currentConnection.disconnect();
      }
    } catch {
      // Disconnect errors are non-fatal
    }
    currentConnection = null;
    currentUrl = null;
  }
}

export function getHsyncUrl() {
  return currentUrl;
}

export function isHsyncConnected() {
  return currentConnection !== null;
}
