// Tunnel configuration screen for TUI
import { term, selectPrompt, inputPrompt, passwordPrompt, asyncAction, handleCancel } from '../helpers.js';
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
    term('  AgentGate does not appear to be running locally.\n\n');
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
      term.red('  ❌ Timeout — tunnel may not be connected\n\n');
    } else {
      term.red(`  ❌ Failed: ${err.message}\n\n`);
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
  term('\n  ').bold('Current tunnel configuration:')('\n');
  if (config.hsync?.enabled) {
    term.green(`  ✅ hsync — ${config.hsync.url || 'configured'}\n`);
  } else if (config.cloudflare?.enabled) {
    term.green('  ✅ Cloudflare Tunnel — configured\n');
  } else {
    term.yellow('  ⚠  No tunnel configured — AgentGate is only accessible locally\n');
  }
  term('\n');
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
    const cf = getSetting('cloudflare_tunnel');
    if (cf?.enabled) {
      setSetting('cloudflare_tunnel', { ...cf, enabled: false });
      stopCloudflared();
    }

    term.green('\n  ✅ hsync configuration saved\n\n');

    await asyncAction('Connecting hsync...', async () => {
      await disconnectHsync();
      await connectHsync(PORT);
    });

    const publicUrl = getHsyncUrl() || url;
    if (publicUrl) {
      await testPublicUrl(publicUrl);
    }

    term.yellow('  ⚠  Restart your AgentGate server to apply tunnel changes.\n\n');

    return config;
  } catch (err) {
    if (handleCancel(err)) return null;
    throw err;
  }
}

async function cloudflareConfigScreen() {
  try {
    if (!hasCloudflared()) {
      term.yellow('\n  ⚠  cloudflared binary not found in PATH\n');
      term('  Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n');
      term('  Docker users: cloudflared is included in the agentgate image.\n\n');
      return null;
    }

    term('\n  Note: Cloudflare Tunnels require your own domain on Cloudflare.\n');
    term('  You need a public hostname configured in the Cloudflare dashboard.\n\n');

    const token = await passwordPrompt('Cloudflare Tunnel token');
    if (!token) {
      term('  Token cannot be empty.\n\n');
      return null;
    }

    const config = {
      enabled: true,
      token
    };

    setSetting('cloudflare_tunnel', config);
    const hsync = getSetting('hsync');
    if (hsync?.enabled) {
      setSetting('hsync', { ...hsync, enabled: false });
      await disconnectHsync();
    }

    term.green('\n  ✅ Cloudflare Tunnel configuration saved\n\n');

    await asyncAction('Starting cloudflared...', async () => {
      startCloudflared();
      await new Promise(resolve => setTimeout(resolve, 3000));
    });

    const publicUrl = await inputPrompt('Public hostname to test (e.g. https://agentgate.yourdomain.com)');
    if (publicUrl) {
      await testPublicUrl(publicUrl);
    }

    term.yellow('  ⚠  Restart your AgentGate server to apply tunnel changes.\n\n');

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
  term.green('\n  ✅ Tunnel disabled\n');
  term.yellow('  ⚠  Restart your AgentGate server to apply tunnel changes.\n\n');
}

export async function tunnelScreen() {
  try {
    const config = getCurrentConfig();
    showCurrentStatus(config);

    await testLocal();

    const choices = [
      { name: 'hsync', message: 'Configure hsync' },
      { name: 'cloudflare', message: 'Configure Cloudflare Tunnel' }
    ];

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
    term.red(`  Error: ${err.message}\n`);
  }
}
