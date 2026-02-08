// Tunnel configuration screen for TUI
// Supports hsync (Node-native) and Cloudflare Tunnel (cloudflared binary)

import { selectPrompt, inputPrompt, passwordPrompt, confirmPrompt, asyncAction, handleCancel } from '../helpers.js';
import { getSetting, setSetting } from '../../lib/db.js';
import { hasCloudflared } from '../../lib/cloudflareManager.js';

function getCurrentConfig() {
  return {
    hsync: getSetting('hsync') || { enabled: false },
    cloudflare: getSetting('cloudflare_tunnel') || { enabled: false }
  };
}

function showCurrentStatus(config) {
  console.log('\n  Current tunnel configuration:');
  if (config.hsync?.enabled) {
    console.log(`  ✅ hsync — ${config.hsync.url || 'configured'}`);
  } else if (config.cloudflare?.enabled) {
    console.log('  ✅ Cloudflare Tunnel — configured');
  } else {
    console.log('  ⚠  No tunnel configured — AgentGate is only accessible locally');
  }
  console.log();
}

async function hsyncConfigScreen(current) {
  try {
    const url = await inputPrompt('hsync server URL (wss://...)', {
      initial: current?.url || ''
    });

    const token = await passwordPrompt('hsync secret (leave empty for none)');

    const config = {
      enabled: true,
      url,
      token: token || undefined
    };

    setSetting('hsync', config);
    // Disable cloudflare if switching
    const cf = getSetting('cloudflare_tunnel');
    if (cf?.enabled) {
      setSetting('cloudflare_tunnel', { ...cf, enabled: false });
    }

    console.log('\n✅ hsync configuration saved\n');
    return config;
  } catch (err) {
    if (handleCancel(err)) return null;
    throw err;
  }
}

async function cloudflareConfigScreen() {
  try {
    if (!hasCloudflared()) {
      console.log('\n  ⚠  cloudflared binary not found in PATH');
      console.log('  Install it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
      console.log('  Docker users: cloudflared is included in the agentgate image.\n');
      const cont = await confirmPrompt('Continue anyway? (configure now, install later)');
      if (!cont) return null;
    }

    const token = await passwordPrompt('Cloudflare Tunnel token');
    if (!token) {
      console.log('Token cannot be empty.\n');
      return null;
    }

    const config = {
      enabled: true,
      token
    };

    setSetting('cloudflare_tunnel', config);
    // Disable hsync if switching
    const hsync = getSetting('hsync');
    if (hsync?.enabled) {
      setSetting('hsync', { ...hsync, enabled: false });
    }

    console.log('\n✅ Cloudflare Tunnel configuration saved\n');
    return config;
  } catch (err) {
    if (handleCancel(err)) return null;
    throw err;
  }
}

async function testConnectionScreen() {
  const hsync = getSetting('hsync');
  const cf = getSetting('cloudflare_tunnel');

  if (!hsync?.enabled && !cf?.enabled) {
    console.log('\n  No tunnel configured — nothing to test.\n');
    return;
  }

  const tunnelType = hsync?.enabled ? 'hsync' : 'Cloudflare Tunnel';
  console.log(`\n  Testing ${tunnelType} connection...`);
  console.log('  Note: The tunnel must be running for this test to work.\n');

  const publicUrl = await inputPrompt('Public URL to test (e.g. https://your-tunnel.example.com)');

  try {
    await asyncAction(`Testing ${publicUrl}/health`, async () => {
      const start = Date.now();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 10000)
      );
      const res = await Promise.race([
        fetch(`${publicUrl}/health`),
        timeoutPromise
      ]);
      const latency = Date.now() - start;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`  ✅ Connected — ${latency}ms`);
    });
  } catch (err) {
    if (err.message === 'timeout') {
      console.log('  ❌ Timeout — tunnel may not be running\n');
    } else {
      console.log(`  ❌ Failed: ${err.message}\n`);
    }
  }
}

async function disableTunnel() {
  const hsync = getSetting('hsync');
  const cf = getSetting('cloudflare_tunnel');

  if (hsync?.enabled) {
    setSetting('hsync', { ...hsync, enabled: false });
  }
  if (cf?.enabled) {
    setSetting('cloudflare_tunnel', { ...cf, enabled: false });
  }
  console.log('\n✅ Tunnel disabled\n');
}

export async function tunnelScreen() {
  try {
    const config = getCurrentConfig();
    showCurrentStatus(config);

    const choice = await selectPrompt('Remote Access', [
      { name: 'hsync', message: 'Configure hsync (Node-native tunnel)' },
      { name: 'cloudflare', message: 'Configure Cloudflare Tunnel' },
      { name: 'test', message: 'Test connection' },
      { name: 'disable', message: 'Disable tunnel' },
      { name: 'back', message: '← Back' }
    ]);

    if (choice === 'back') return;

    if (choice === 'hsync') {
      await hsyncConfigScreen(config.hsync);
    } else if (choice === 'cloudflare') {
      await cloudflareConfigScreen();
    } else if (choice === 'test') {
      await testConnectionScreen();
    } else if (choice === 'disable') {
      await disableTunnel();
    }
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
