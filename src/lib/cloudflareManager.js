import { spawn, execSync } from 'child_process';
import { getSetting } from './db.js';

let cloudflaredProcess = null;

export function hasCloudflared() {
  try {
    execSync('which cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function startCloudflared() {
  const config = getSetting('cloudflare_tunnel');
  if (!config?.enabled || !config?.token) {
    return null;
  }

  if (!hasCloudflared()) {
    console.log('cloudflared binary not found — skipping Cloudflare Tunnel');
    return null;
  }

  stopCloudflared();

  try {
    // Pass token via env var to avoid exposing it in ps aux
    cloudflaredProcess = spawn('cloudflared', [
      'tunnel', '--no-autoupdate', 'run'
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TUNNEL_TOKEN: config.token }
    });

    cloudflaredProcess.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[cloudflared] ${line}`);
    });

    cloudflaredProcess.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[cloudflared] ${line}`);
    });

    cloudflaredProcess.on('exit', (code) => {
      console.log(`cloudflared exited with code ${code}`);
      cloudflaredProcess = null;
    });

    console.log('Cloudflare Tunnel starting...');
    return cloudflaredProcess;
  } catch (err) {
    console.error('Failed to start cloudflared:', err.message);
    cloudflaredProcess = null;
    return null;
  }
}

export function stopCloudflared() {
  if (cloudflaredProcess) {
    try {
      cloudflaredProcess.kill('SIGTERM');
    } catch {
      // Kill errors are non-fatal
    }
    cloudflaredProcess = null;
  }
}

export function isCloudflaredRunning() {
  return cloudflaredProcess !== null;
}
