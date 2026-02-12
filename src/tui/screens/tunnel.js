// Tunnel configuration screen — ink version
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getSetting, setSetting } from '../../lib/db.js';
import { connectHsync, disconnectHsync, getHsyncUrl } from '../../lib/hsyncManager.js';
import { hasCloudflared, startCloudflared, stopCloudflared } from '../../lib/cloudflareManager.js';
import { MenuList, TextInput } from '../helpers.js';

const e = React.createElement;
const PORT = process.env.PORT || 3050;

function TunnelStatus() {
  const hsync = getSetting('hsync') || { enabled: false };
  const cf = getSetting('cloudflare_tunnel') || { enabled: false };

  let status;
  if (hsync?.enabled) {
    status = e(Text, { color: 'green' }, '  ✅ hsync — ', hsync.url || 'configured');
  } else if (cf?.enabled) {
    status = e(Text, { color: 'green' }, '  ✅ Cloudflare Tunnel — configured');
  } else {
    status = e(Text, { color: 'yellow' }, '  ⚠  No tunnel configured — local only');
  }

  return e(Box, { flexDirection: 'column' },
    e(Text, { bold: true }, '  Tunnel Configuration:'),
    status
  );
}

function HsyncConfigScreen({ onDone }) {
  const [step, setStep] = useState('url');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState(null);

  useInput((_input, key) => {
    if (status && (key.return || key.escape)) {
      onDone();
    }
  });

  if (status) {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: status.startsWith('✅') ? 'green' : 'red' }, '  ', status),
      e(Text, { color: 'gray' }, '  Press enter to continue')
    );
  }

  if (step === 'url') {
    const current = getSetting('hsync');
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(TextInput, {
        label: 'hsync server URL',
        value: url || (current?.url || ''),
        onChange: setUrl,
        onSubmit: (val) => {
          if (val === null) { onDone(); return; }
          setUrl(val);
          setStep('token');
        }
      })
    );
  }

  if (step === 'token') {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'gray' }, '  URL: ', url),
      e(TextInput, {
        label: 'hsync secret (leave empty for none)',
        value: token,
        masked: true,
        onChange: setToken,
        onSubmit: async (val) => {
          if (val === null) { onDone(); return; }
          const config = { enabled: true, url, token: val || undefined };
          setSetting('hsync', config);
          const cf = getSetting('cloudflare_tunnel');
          if (cf?.enabled) {
            setSetting('cloudflare_tunnel', { ...cf, enabled: false });
            stopCloudflared();
          }
          try {
            await disconnectHsync();
            await connectHsync(PORT);
            const publicUrl = getHsyncUrl() || url;
            setStatus(`✅ hsync configured and connected — ${publicUrl}`);
          } catch (err) {
            setStatus(`✅ hsync configuration saved (connect error: ${err.message})`);
          }
        }
      })
    );
  }

  return null;
}

function CloudflareConfigScreen({ onDone }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState(null);

  useInput((_input, key) => {
    if (status && (key.return || key.escape)) {
      onDone();
    }
  });

  if (!hasCloudflared()) {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'yellow' }, '  ⚠  cloudflared binary not found in PATH'),
      e(Text, { color: 'gray' }, '  Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'),
      e(Text, null, ''),
      e(Text, { color: 'gray' }, '  Press any key to go back')
    );
  }

  if (status) {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'green' }, '  ', status),
      e(Text, { color: 'gray' }, '  Press enter to continue')
    );
  }

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(Text, { color: 'gray' }, '  Note: Cloudflare Tunnels require your own domain on Cloudflare.'),
    e(TextInput, {
      label: 'Cloudflare Tunnel token',
      value: token,
      masked: true,
      onChange: setToken,
      onSubmit: async (val) => {
        if (val === null || !val) { onDone(); return; }
        const config = { enabled: true, token: val };
        setSetting('cloudflare_tunnel', config);
        const hsync = getSetting('hsync');
        if (hsync?.enabled) {
          setSetting('hsync', { ...hsync, enabled: false });
          await disconnectHsync();
        }
        startCloudflared();
        setStatus('✅ Cloudflare Tunnel configuration saved and started');
      }
    })
  );
}

export function TunnelScreen({ onBack }) {
  const [sub, setSub] = useState('menu');
  const [selected, setSelected] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  const hsync = getSetting('hsync') || { enabled: false };
  const cf = getSetting('cloudflare_tunnel') || { enabled: false };
  const hasTunnel = hsync?.enabled || cf?.enabled;

  const menuItems = [
    { name: 'hsync', message: 'Configure hsync' },
    { name: 'cloudflare', message: 'Configure Cloudflare Tunnel' },
    ...(hasTunnel ? [{ name: 'disable', message: 'Disable tunnel' }] : []),
    { name: 'back', message: '← Back' }
  ];

  useInput((input, key) => {
    if (sub !== 'menu') return;
    if (key.upArrow || input === 'k') {
      setSelected(i => Math.max(0, i - 1));
    } else if (key.downArrow || input === 'j') {
      setSelected(i => Math.min(menuItems.length - 1, i + 1));
    } else if (key.return) {
      const item = menuItems[selected];
      if (item.name === 'back') { onBack(); return; }
      if (item.name === 'disable') {
        const h = getSetting('hsync');
        const c = getSetting('cloudflare_tunnel');
        if (h?.enabled || c?.enabled) {
          (async () => {
            if (h?.enabled) { setSetting('hsync', { ...h, enabled: false }); await disconnectHsync(); }
            if (c?.enabled) { setSetting('cloudflare_tunnel', { ...c, enabled: false }); stopCloudflared(); }
            setRefreshKey(k => k + 1);
          })();
        }
        return;
      }
      setSub(item.name);
    } else if (key.escape) {
      onBack();
    }
  });

  const goMenu = () => { setSub('menu'); setSelected(0); };

  if (sub === 'hsync') return e(HsyncConfigScreen, { onDone: goMenu });
  if (sub === 'cloudflare') return e(CloudflareConfigScreen, { onDone: goMenu });

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(TunnelStatus, { key: refreshKey }),
    e(Text, null, ''),
    e(Text, { bold: true, color: 'yellow' }, 'Remote Access'),
    e(Text, null, ''),
    e(MenuList, { items: menuItems, selectedIndex: selected }),
    e(Text, null, ''),
    e(Text, { color: 'gray' }, '  ↑↓/jk navigate • enter select • esc back')
  );
}
