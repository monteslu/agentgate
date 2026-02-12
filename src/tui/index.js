#!/usr/bin/env node

import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { hasAdminPassword, setAdminPassword } from '../lib/db.js';
import { KeysScreen } from './screens/keys.js';
import { ServicesScreen } from './screens/services.js';
import { SettingsScreen } from './screens/settings.js';
import { TunnelScreen } from './screens/tunnel.js';

const e = React.createElement;

const BANNER_LINES = [
  '    _                    _    ____       _       ',
  '   / \\   __ _  ___ _ __ | |_ / ___| __ _| |_ ___ ',
  '  / _ \\ / _` |/ _ \\ \'_ \\| __| |  _ / _` | __/ _ \\',
  ' / ___ \\ (_| |  __/ | | | |_| |_| | (_| | ||  __/',
  '/_/   \\_\\__, |\\___|_| |_|\\__|\\____|\\__,_|\\__\\___|',
  '        |___/                                     '
];

// ─── Reusable Components ────────────────────────────────────────

function Banner() {
  return e(Box, { flexDirection: 'column', marginBottom: 1 },
    ...BANNER_LINES.map((line, i) =>
      e(Text, { key: i, color: 'cyan' }, line)
    ),
    e(Text, { color: 'gray' }, '  🔒 Secure gateway for AI agents')
  );
}

export function MenuList({ items, selectedIndex }) {
  return e(Box, { flexDirection: 'column' },
    ...items.map((item, i) =>
      e(Text, {
        key: item.name || i,
        color: i === selectedIndex ? 'cyan' : undefined,
        bold: i === selectedIndex
      },
      i === selectedIndex ? '❯ ' : '  ',
      item.message || item.name
      )
    )
  );
}

export function StatusLine({ label, value, color }) {
  return e(Text, null,
    e(Text, { color: 'gray' }, '  • '),
    e(Text, { bold: true }, label, ': '),
    e(Text, { color: color || 'white' }, value)
  );
}

export function TextInput({ label, value, onChange, onSubmit, masked }) {
  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
    } else if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
    } else if (key.escape) {
      onSubmit(null);
    } else if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  });

  const display = masked ? '*'.repeat(value.length) : value;

  return e(Box, null,
    e(Text, { color: 'cyan' }, label, ': '),
    e(Text, null, display),
    e(Text, { color: 'gray' }, '█')
  );
}

export function Message({ text, color }) {
  return e(Text, { color: color || 'green' }, text);
}

// ─── Password Screen ────────────────────────────────────────────

function PasswordScreen({ onBack }) {
  const [step, setStep] = useState('init');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState(null);
  const [wantsChange, setWantsChange] = useState(false);

  useEffect(() => {
    const hasPw = hasAdminPassword();
    if (hasPw && !wantsChange) {
      setStep('has_password');
    } else {
      setStep('enter');
    }
  }, [wantsChange]);

  useInput((input, key) => {
    if (step === 'has_password') {
      if (input === 'y' || input === 'Y') {
        setWantsChange(true);
      } else if (input === 'n' || input === 'N' || key.escape) {
        onBack();
      }
    }
  });

  if (step === 'has_password') {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'green' }, '  Admin password is set ✅'),
      e(Text, null, ''),
      e(Text, null, '  Change admin password? (y/n)')
    );
  }

  if (step === 'enter') {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(TextInput, {
        label: 'New admin password',
        value: password,
        masked: true,
        onChange: setPassword,
        onSubmit: (val) => {
          if (val === null) { onBack(); return; }
          if (!val) { setMessage('Password cannot be empty.'); return; }
          setStep('confirm');
        }
      }),
      message ? e(Text, { color: 'red' }, '  ', message) : null
    );
  }

  if (step === 'confirm') {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'gray' }, '  Password entered (',  password.length, ' chars)'),
      e(TextInput, {
        label: 'Confirm password',
        value: confirm,
        masked: true,
        onChange: setConfirm,
        onSubmit: async (val) => {
          if (val === null) { onBack(); return; }
          if (val !== password) {
            setMessage('Passwords do not match.');
            setConfirm('');
            setStep('enter');
            setPassword('');
            return;
          }
          try {
            await setAdminPassword(password);
            setMessage('✅ Admin password set');
            setStep('done');
          } catch (err) {
            setMessage('Error: ' + err.message);
            setStep('done');
          }
        }
      }),
      message ? e(Text, { color: 'red' }, '  ', message) : null
    );
  }

  if (step === 'done') {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'green' }, '  ', message),
      e(Text, { color: 'gray' }, '  Press any key to go back')
    );
  }

  return null;
}

// ─── Main App ───────────────────────────────────────────────────

const MENU_ITEMS = [
  { name: 'password', message: '🔑 Admin Password' },
  { name: 'keys', message: '🗝  API Keys (Agents)' },
  { name: 'services', message: '🔌 Services' },
  { name: 'tunnel', message: '🌐 Remote Access (Tunnel)' },
  { name: 'settings', message: '⚙  Settings' },
  { name: 'exit', message: '🚪 Exit' }
];

function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState('menu');
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (screen !== 'menu') return;

    if (key.upArrow || input === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex(i => Math.min(MENU_ITEMS.length - 1, i + 1));
    } else if (key.return) {
      const item = MENU_ITEMS[selectedIndex];
      if (item.name === 'exit') {
        exit();
        return;
      }
      setScreen(item.name);
    } else if (input === 'q') {
      exit();
    }
  });

  const goBack = () => setScreen('menu');

  if (screen === 'password') {
    return e(PasswordScreen, { onBack: goBack });
  }
  if (screen === 'keys') {
    return e(KeysScreen, { onBack: goBack });
  }
  if (screen === 'services') {
    return e(ServicesScreen, { onBack: goBack });
  }
  if (screen === 'settings') {
    return e(SettingsScreen, { onBack: goBack });
  }
  if (screen === 'tunnel') {
    return e(TunnelScreen, { onBack: goBack });
  }

  return e(Box, { flexDirection: 'column' },
    e(Banner),
    e(Box, { flexDirection: 'column', paddingLeft: 2 },
      e(Text, { bold: true, color: 'yellow' }, 'Setup'),
      e(Text, null, ''),
      e(MenuList, { items: MENU_ITEMS, selectedIndex }),
      e(Text, null, ''),
      e(Text, { color: 'gray' }, '  ↑↓/jk navigate • enter select • q quit')
    )
  );
}

render(e(App));
