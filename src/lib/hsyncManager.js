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

    const client = await createConnection(options);

    // createConnection returns immediately before MQTT is established.
    // Wait for the actual connection (or error/timeout).
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('hsync connection timed out'));
      }, 15000);

      if (client.status === 'connected') {
        clearTimeout(timeout);
        resolve();
        return;
      }

      client.on('connected', () => {
        clearTimeout(timeout);
        resolve();
      });

      client.on('connect_error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    currentConnection = client;
    currentUrl = config.url;
    console.log(`hsync connected: ${currentUrl}`);
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
      if (typeof currentConnection.endClient === 'function') {
        currentConnection.endClient(true);
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
  return currentConnection !== null && currentConnection.status === 'connected';
}
