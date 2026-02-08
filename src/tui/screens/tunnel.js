// Tunnel configuration screen for TUI
// Supports hsync (Node-native) and Cloudflare Tunnel (cloudflared binary)

import { selectPrompt, inputPrompt, passwordPrompt, asyncAction, handleCancel } from '../helpers.js';
import { getSetting, setSetting } from '../../lib/db.js';
import { connectHsync, disconnectHsync, getHsyncUrl } from '../../lib/hsyncManager.js';
import { hasCloudflared, startCloudflared, stopCloudflared } from '../../lib/cloudflareManager.js';

const PORT = process.env.PORT || 3050;

async function testLocal() {
  try {
    await asyncAction('Testing local AgentGate...', async () => {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
    return true;
  } catch {
    console.log('  AgentGate does not appear to be running locally.\n');
    return false;
  }
}

async function testPublicUrl(url) {
  try {
    await asyncAction(`Testing ${url}/health`, async () => {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 10000)
      );
      const res = await Promise.race([
        fetch(`${url}/health`),
        timeoutPromise
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
    return true;
  } catch (err) {
    if (err.message === 'timeout') {
      console.log('  ❌ Timeout — tunnel may not be connected\n');
    } else {
      console.log(`  ❌ Failed: ${err.message}\n`);
    }
    return false;
  }
}

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
    const url = await inputPrompt('hsync server URL', {
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
      stopCloudflared();
    }

    console.log('\n✅ hsync configuration saved\n');

    // Connect immediately
    await asyncAction('Connecting hsync...', async () => {
      await disconnectHsync();
      await connectHsync(PORT);
    });

    // Auto-test through the public URL
    const publicUrl = getHsyncUrl() || url;
    if (publicUrl) {
      await testPublicUrl(publicUrl);
    }

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
      console.log('  Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
      console.log('  Docker users: cloudflared is included in the agentgate image.\n');
      return null;
    }

    console.log('\n  Note: Cloudflare Tunnels require your own domain on Cloudflare.');
    console.log('  You need a public hostname configured in the Cloudflare dashboard.\n');

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
      await disconnectHsync();
    }

    console.log('\n✅ Cloudflare Tunnel configuration saved\n');

    // Start immediately
    await asyncAction('Starting cloudflared...', async () => {
      startCloudflared();
      // Give it a moment to connect
      await new Promise(resolve => setTimeout(resolve, 3000));
    });

    const publicUrl = await inputPrompt('Public hostname to test (e.g. https://agentgate.yourdomain.com)');
    if (publicUrl) {
      await testPublicUrl(publicUrl);
    }

    return config;
  } catch (err) {
    if (handleCancel(err)) return null;
    throw err;
  }
}

async function disableTunnel() {
  const hsync = getSetting('hsync');
  const cf = getSetting('cloudflare_tunnel');

  if (hsync?.enabled) {
    setSetting('hsync', { ...hsync, enabled: false });
    await disconnectHsync();
  }
  if (cf?.enabled) {
    setSetting('cloudflare_tunnel', { ...cf, enabled: false });
    stopCloudflared();
  }
  console.log('\n✅ Tunnel disabled\n');
}

export async function tunnelScreen() {
  try {
    const config = getCurrentConfig();
    showCurrentStatus(config);

    // Quick local health check first
    await testLocal();

    const choices = [
      { name: 'hsync', message: 'Configure hsync' },
      { name: 'cloudflare', message: 'Configure Cloudflare Tunnel' }
    ];

    // Add test option if a tunnel is configured
    if (config.hsync?.enabled || config.cloudflare?.enabled) {
      choices.push({ name: 'test', message: 'Test connection' });
    }

    choices.push({ name: 'disable', message: 'Disable tunnel' });
    choices.push({ name: 'back', message: 'Back' });

    const choice = await selectPrompt('Remote Access', choices);

    if (choice === 'back') return;

    if (choice === 'hsync') {
      await hsyncConfigScreen(config.hsync);
    } else if (choice === 'cloudflare') {
      await cloudflareConfigScreen();
    } else if (choice === 'test') {
      const url = config.hsync?.enabled ? (getHsyncUrl() || config.hsync.url) : null;
      if (url) {
        await testPublicUrl(url);
      } else {
        const manualUrl = await inputPrompt('Public URL to test');
        if (manualUrl) await testPublicUrl(manualUrl);
      }
    } else if (choice === 'disable') {
      await disableTunnel();
    }
  } catch (err) {
    if (handleCancel(err)) return;
    console.error('Error:', err.message);
  }
}
