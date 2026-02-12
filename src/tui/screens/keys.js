// API Key management screen — ink version
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { listApiKeys, createApiKey, deleteApiKey, setAgentEnabled } from '../../lib/db.js';
import { MenuList, TextInput } from '../index.js';

const e = React.createElement;

function KeyList({ keys }) {
  if (keys.length === 0) {
    return e(Text, { color: 'gray' }, '  No API keys configured.');
  }
  return e(Box, { flexDirection: 'column' },
    e(Text, { bold: true }, '  API Keys:'),
    ...keys.map(k =>
      e(Text, { key: k.id },
        e(Text, { color: k.enabled === 0 ? 'red' : 'green' }, '  • '),
        e(Text, { color: k.enabled === 0 ? 'gray' : 'white' },
          k.name, ' [', k.key_prefix, '...]'
        ),
        k.enabled === 0 ? e(Text, { color: 'red' }, ' (disabled)') : null,
        k.webhook_url ? e(Text, null, ' 🔔') : null
      )
    )
  );
}

function CreateKeyScreen({ onDone }) {
  const [name, setName] = useState('');
  const [result, setResult] = useState(null);

  useInput((_input, key) => {
    if (result && (key.return || key.escape)) {
      onDone();
    }
  });

  if (result) {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'green' }, '✅ API key created for "', result.name, '"'),
      e(Text, null, ''),
      e(Text, { color: 'yellow' }, '  ⚠️  Save this key — it won\'t be shown again:'),
      e(Text, null, ''),
      e(Text, { bold: true }, '  ', result.key),
      e(Text, null, ''),
      e(Text, { color: 'gray' }, '  Press enter to continue')
    );
  }

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(TextInput, {
      label: 'Agent name',
      value: name,
      onChange: setName,
      onSubmit: (val) => {
        if (val === null || !val.trim()) { onDone(); return; }
        try {
          const res = createApiKey(val.trim());
          setResult({ name: val.trim(), key: res.key });
        } catch (err) {
          if (err.message?.includes('UNIQUE')) {
            setResult({ name: val.trim(), key: '❌ An agent with that name already exists.' });
          } else {
            onDone();
          }
        }
      }
    })
  );
}

function ToggleKeyScreen({ keys, onDone }) {
  const [selected, setSelected] = useState(0);
  const items = [
    ...keys.map(k => ({
      name: k.id,
      message: `${k.name} — currently ${k.enabled === 0 ? 'DISABLED' : 'enabled'}`
    })),
    { name: 'back', message: '← Back' }
  ];

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setSelected(i => Math.max(0, i - 1));
    } else if (key.downArrow || input === 'j') {
      setSelected(i => Math.min(items.length - 1, i + 1));
    } else if (key.return) {
      const item = items[selected];
      if (item.name === 'back') { onDone(); return; }
      const agent = keys.find(k => k.id === item.name);
      if (agent) {
        setAgentEnabled(agent.id, agent.enabled === 0 ? 1 : 0);
      }
      onDone();
    } else if (key.escape) {
      onDone();
    }
  });

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(Text, { bold: true, color: 'yellow' }, 'Toggle which agent?'),
    e(Text, null, ''),
    e(MenuList, { items, selectedIndex: selected })
  );
}

function DeleteKeyScreen({ keys, onDone }) {
  const [selected, setSelected] = useState(0);
  const [confirming, setConfirming] = useState(null);
  const items = [
    ...keys.map(k => ({
      name: k.id,
      message: `${k.name} [${k.key_prefix}...]`
    })),
    { name: 'back', message: '← Back' }
  ];

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y' || input === 'Y') {
        deleteApiKey(confirming.id);
        onDone();
      } else {
        onDone();
      }
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelected(i => Math.max(0, i - 1));
    } else if (key.downArrow || input === 'j') {
      setSelected(i => Math.min(items.length - 1, i + 1));
    } else if (key.return) {
      const item = items[selected];
      if (item.name === 'back') { onDone(); return; }
      const agent = keys.find(k => k.id === item.name);
      if (agent) setConfirming(agent);
    } else if (key.escape) {
      onDone();
    }
  });

  if (confirming) {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'red' }, 'Delete "', confirming.name, '" and all related data? (y/n)')
    );
  }

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(Text, { bold: true, color: 'yellow' }, 'Delete which agent?'),
    e(Text, null, ''),
    e(MenuList, { items, selectedIndex: selected })
  );
}

export function KeysScreen({ onBack }) {
  const [sub, setSub] = useState('menu');
  const [selected, setSelected] = useState(0);
  const keys = listApiKeys();

  const menuItems = [
    { name: 'create', message: 'Create new API key' },
    { name: 'toggle', message: 'Enable/disable agent' },
    { name: 'delete', message: 'Delete agent' },
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
      setSub(item.name);
    } else if (key.escape) {
      onBack();
    }
  });

  const goMenu = () => { setSub('menu'); setSelected(0); };

  if (sub === 'create') return e(CreateKeyScreen, { onDone: goMenu });
  if (sub === 'toggle') return e(ToggleKeyScreen, { keys, onDone: goMenu });
  if (sub === 'delete') return e(DeleteKeyScreen, { keys, onDone: goMenu });

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(KeyList, { keys }),
    e(Text, null, ''),
    e(Text, { bold: true, color: 'yellow' }, 'API Keys'),
    e(Text, null, ''),
    e(MenuList, { items: menuItems, selectedIndex: selected }),
    e(Text, null, ''),
    e(Text, { color: 'gray' }, '  ↑↓/jk navigate • enter select • esc back')
  );
}
