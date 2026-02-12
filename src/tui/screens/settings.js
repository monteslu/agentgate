// Settings screen — ink version
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getMessagingMode, setMessagingMode, getSharedQueueVisibility, setSharedQueueVisibility, getAgentWithdrawEnabled, setSetting } from '../../lib/db.js';
import { MenuList } from '../index.js';

const e = React.createElement;

function CurrentSettings() {
  const messaging = getMessagingMode();
  const sharedQueue = getSharedQueueVisibility();
  const withdraw = getAgentWithdrawEnabled();

  return e(Box, { flexDirection: 'column' },
    e(Text, { bold: true }, '  Current Settings:'),
    e(Text, null,
      e(Text, { color: 'gray' }, '  • '),
      e(Text, { bold: true }, 'Messaging mode: '),
      e(Text, { color: messaging === 'off' ? 'red' : messaging === 'open' ? 'green' : 'yellow' }, messaging)
    ),
    e(Text, null,
      e(Text, { color: 'gray' }, '  • '),
      e(Text, { bold: true }, 'Shared queue visibility: '),
      e(Text, { color: sharedQueue ? 'green' : 'red' }, sharedQueue ? 'on' : 'off')
    ),
    e(Text, null,
      e(Text, { color: 'gray' }, '  • '),
      e(Text, { bold: true }, 'Agent withdraw: '),
      e(Text, { color: withdraw ? 'green' : 'red' }, withdraw ? 'on' : 'off')
    )
  );
}

function MessagingModeScreen({ onDone }) {
  const [selected, setSelected] = useState(0);
  const current = getMessagingMode();

  const items = [
    { name: 'off', message: 'Off — agents cannot message each other' },
    { name: 'supervised', message: 'Supervised — messages need human approval' },
    { name: 'open', message: 'Open — messages delivered immediately' },
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
      setMessagingMode(item.name);
      onDone();
    } else if (key.escape) {
      onDone();
    }
  });

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(Text, { bold: true, color: 'yellow' }, 'Messaging mode (current: ', current, ')'),
    e(Text, null, ''),
    e(MenuList, { items, selectedIndex: selected })
  );
}

export function SettingsScreen({ onBack }) {
  const [sub, setSub] = useState('menu');
  const [selected, setSelected] = useState(0);

  const menuItems = [
    { name: 'messaging', message: 'Messaging mode' },
    { name: 'queue', message: 'Toggle shared queue visibility' },
    { name: 'withdraw', message: 'Toggle agent withdraw' },
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
      if (item.name === 'queue') {
        const current = getSharedQueueVisibility();
        setSharedQueueVisibility(!current);
        // Force re-render by toggling sub
        setSub('_refresh');
        setTimeout(() => setSub('menu'), 0);
        return;
      }
      if (item.name === 'withdraw') {
        const current = getAgentWithdrawEnabled();
        setSetting('agent_withdraw_enabled', !current);
        setSub('_refresh');
        setTimeout(() => setSub('menu'), 0);
        return;
      }
      setSub(item.name);
    } else if (key.escape) {
      onBack();
    }
  });

  const goMenu = () => { setSub('menu'); setSelected(0); };

  if (sub === 'messaging') return e(MessagingModeScreen, { onDone: goMenu });

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(CurrentSettings),
    e(Text, null, ''),
    e(Text, { bold: true, color: 'yellow' }, 'Settings'),
    e(Text, null, ''),
    e(MenuList, { items: menuItems, selectedIndex: selected }),
    e(Text, null, ''),
    e(Text, { color: 'gray' }, '  ↑↓/jk navigate • enter select • esc back')
  );
}
