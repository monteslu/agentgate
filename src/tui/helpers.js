// Ink TUI helper utilities & shared components
import React from 'react';
import { Box, Text, useInput } from 'ink';
import InkTextInput from 'ink-text-input';

const e = React.createElement;

/**
 * handleCancel - kept for backward compatibility in case any code references it.
 * In the ink version, cancellation is handled via useInput 'q'/escape.
 */
export function handleCancel(err) {
  if (err === '' || err?.message === '' || err?.code === 'ERR_USE_AFTER_CLOSE') {
    return true;
  }
  return false;
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
  useInput((_input, key) => {
    if (key.escape) {
      onSubmit(null);
    }
  });

  return e(Box, null,
    e(Text, { color: 'cyan' }, label, ': '),
    e(InkTextInput, {
      value,
      onChange,
      onSubmit,
      mask: masked ? '*' : undefined
    })
  );
}

export function Message({ text, color }) {
  return e(Text, { color: color || 'green' }, text);
}
