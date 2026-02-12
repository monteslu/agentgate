// Service account setup screen — ink version
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { setAccountCredentials, deleteAccount, listAccounts } from '../../lib/db.js';
import { MenuList, TextInput } from '../helpers.js';

const e = React.createElement;

const TUI_SERVICES = [
  {
    id: 'github',
    name: 'GitHub',
    fields: [
      { name: 'token', label: 'Personal Access Token', masked: true, help: 'Create at https://github.com/settings/tokens' }
    ]
  },
  {
    id: 'bluesky',
    name: 'Bluesky',
    fields: [
      { name: 'identifier', label: 'Handle (e.g. user.bsky.social)', masked: false },
      { name: 'password', label: 'App Password', masked: true, help: 'Create at https://bsky.app/settings/app-passwords' }
    ]
  },
  {
    id: 'mastodon',
    name: 'Mastodon',
    fields: [
      { name: 'instance', label: 'Instance (e.g. fosstodon.org)', masked: false },
      { name: 'accessToken', label: 'Access Token', masked: true, help: 'Create at {instance}/settings/applications' }
    ]
  },
  {
    id: 'jira',
    name: 'Jira',
    fields: [
      { name: 'domain', label: 'Jira Domain (e.g. yourcompany.atlassian.net)', masked: false },
      { name: 'email', label: 'Email', masked: false },
      { name: 'apiToken', label: 'API Token', masked: true, help: 'Create at https://id.atlassian.com/manage-profile/security/api-tokens' }
    ]
  }
];

function AccountList({ accounts }) {
  if (accounts.length === 0) {
    return e(Text, { color: 'gray' }, '  No service accounts configured.');
  }
  return e(Box, { flexDirection: 'column' },
    e(Text, { bold: true }, '  Service Accounts:'),
    ...accounts.map((acc, i) =>
      e(Text, { key: i, color: 'green' }, '  • ', acc.service, '/', acc.name)
    )
  );
}

function AddServiceScreen({ onDone }) {
  const [step, setStep] = useState('pick');
  const [selected, setSelected] = useState(0);
  const [service, setService] = useState(null);
  const [accountName, setAccountName] = useState('');
  const [fieldIndex, setFieldIndex] = useState(0);
  const [fieldValue, setFieldValue] = useState('');
  const [creds, setCreds] = useState({});

  const serviceChoices = [
    ...TUI_SERVICES.map(s => ({ name: s.id, message: s.name })),
    { name: 'back', message: '← Back' }
  ];

  useInput((input, key) => {
    if (step !== 'pick') return;
    if (key.upArrow || input === 'k') {
      setSelected(i => Math.max(0, i - 1));
    } else if (key.downArrow || input === 'j') {
      setSelected(i => Math.min(serviceChoices.length - 1, i + 1));
    } else if (key.return) {
      const item = serviceChoices[selected];
      if (item.name === 'back') { onDone(); return; }
      setService(TUI_SERVICES.find(s => s.id === item.name));
      setStep('name');
    } else if (key.escape) {
      onDone();
    }
  });

  if (step === 'pick') {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { bold: true, color: 'yellow' }, 'Add service'),
      e(Text, null, ''),
      e(MenuList, { items: serviceChoices, selectedIndex: selected })
    );
  }

  if (step === 'name') {
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'cyan' }, '  Adding: ', service.name),
      e(TextInput, {
        label: 'Account name (e.g. personal, work)',
        value: accountName,
        onChange: setAccountName,
        onSubmit: (val) => {
          if (val === null || !val.trim()) { onDone(); return; }
          setAccountName(val.trim());
          setStep('fields');
        }
      })
    );
  }

  if (step === 'fields') {
    const field = service.fields[fieldIndex];
    return e(Box, { flexDirection: 'column', padding: 1 },
      e(Text, { color: 'cyan' }, '  ', service.name, ' / ', accountName),
      field.help ? e(Text, { color: 'gray' }, '  ℹ  ', field.help) : null,
      e(TextInput, {
        label: field.label,
        value: fieldValue,
        masked: field.masked,
        onChange: setFieldValue,
        onSubmit: (val) => {
          if (val === null) { onDone(); return; }
          if (!val) return;
          const newCreds = { ...creds, [field.name]: val };
          setCreds(newCreds);
          setFieldValue('');
          if (fieldIndex + 1 < service.fields.length) {
            setFieldIndex(fieldIndex + 1);
          } else {
            // Save
            if (service.id === 'mastodon') {
              newCreds.authStatus = 'success';
              newCreds.instance = newCreds.instance.replace(/^https?:\/\//, '').replace(/\/$/, '');
            }
            setAccountCredentials(service.id, accountName, newCreds);
            setStep('done');
          }
        }
      })
    );
  }

  if (step === 'done') {
    return e(DoneMessage, {
      text: `✅ ${service.name} account "${accountName}" added`,
      onDone
    });
  }

  return null;
}

function DoneMessage({ text, onDone }) {
  useInput((_input, key) => {
    if (key.return || key.escape) onDone();
  });
  return e(Box, { flexDirection: 'column', padding: 1 },
    e(Text, { color: 'green' }, '  ', text),
    e(Text, { color: 'gray' }, '  Press enter to continue')
  );
}

function RemoveServiceScreen({ accounts, onDone }) {
  const [selected, setSelected] = useState(0);
  const [confirming, setConfirming] = useState(null);

  const items = [
    ...accounts.map(a => ({
      name: `${a.service}::${a.name}`,
      message: `${a.service}/${a.name}`
    })),
    { name: 'back', message: '← Back' }
  ];

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y' || input === 'Y') {
        const [svc, name] = confirming.split('::');
        deleteAccount(svc, name);
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
      setConfirming(item.name);
    } else if (key.escape) {
      onDone();
    }
  });

  if (confirming) {
    const [svc, name] = confirming.split('::');
    return e(Box, { padding: 1 },
      e(Text, { color: 'red' }, 'Remove ', svc, '/', name, '? (y/n)')
    );
  }

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(Text, { bold: true, color: 'yellow' }, 'Remove which account?'),
    e(Text, null, ''),
    e(MenuList, { items, selectedIndex: selected })
  );
}

export function ServicesScreen({ onBack }) {
  const [sub, setSub] = useState('menu');
  const [selected, setSelected] = useState(0);
  const accounts = listAccounts();

  const menuItems = [
    { name: 'add', message: 'Add service account' },
    { name: 'remove', message: 'Remove service account' },
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

  if (sub === 'add') return e(AddServiceScreen, { onDone: goMenu });
  if (sub === 'remove') return e(RemoveServiceScreen, { accounts, onDone: goMenu });

  return e(Box, { flexDirection: 'column', padding: 1 },
    e(AccountList, { accounts }),
    e(Text, null, ''),
    e(Text, { bold: true, color: 'yellow' }, 'Services'),
    e(Text, null, ''),
    e(MenuList, { items: menuItems, selectedIndex: selected }),
    e(Text, null, ''),
    e(Text, { color: 'gray' }, '  ↑↓/jk navigate • enter select • esc back')
  );
}
