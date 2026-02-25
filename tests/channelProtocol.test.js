/**
 * Tests for src/lib/channelProtocol.js
 *
 * Jest globals — do NOT import from vitest.
 */

import {
  ENVELOPE_TYPES,
  VALID_TYPES,
  SERVER_TYPES,
  PLUGIN_TYPES,
  WAKE_MODES,
  generateId,
  validateEnvelope,
  validateMessage,
  validateWake,
  validateAgent,
  createConnected,
  createMessage,
  createWake,
  createAgentEnvelope,
  createAck,
  createError,
  createChunk,
  createDone,
  createPing,
  createPong
} from '../src/lib/channelProtocol.js';

// ── Constants ───────────────────────────────────────────────────────────────

describe('ENVELOPE_TYPES', () => {
  it('has all expected types', () => {
    expect(ENVELOPE_TYPES.CONNECTED).toBe('connected');
    expect(ENVELOPE_TYPES.MESSAGE).toBe('message');
    expect(ENVELOPE_TYPES.WAKE).toBe('wake');
    expect(ENVELOPE_TYPES.AGENT).toBe('agent');
    expect(ENVELOPE_TYPES.REPLY).toBe('reply');
    expect(ENVELOPE_TYPES.CHUNK).toBe('chunk');
    expect(ENVELOPE_TYPES.DONE).toBe('done');
    expect(ENVELOPE_TYPES.ACK).toBe('ack');
    expect(ENVELOPE_TYPES.ERROR).toBe('error');
    expect(ENVELOPE_TYPES.PING).toBe('ping');
    expect(ENVELOPE_TYPES.PONG).toBe('pong');
    expect(ENVELOPE_TYPES.TYPING).toBe('typing');
    expect(ENVELOPE_TYPES.HUMAN_CONNECTED).toBe('human_connected');
    expect(ENVELOPE_TYPES.HUMAN_DISCONNECTED).toBe('human_disconnected');
  });

  it('VALID_TYPES contains all enum values', () => {
    for (const val of Object.values(ENVELOPE_TYPES)) {
      expect(VALID_TYPES.has(val)).toBe(true);
    }
  });

  it('SERVER_TYPES and PLUGIN_TYPES are subsets of VALID_TYPES', () => {
    for (const t of SERVER_TYPES) expect(VALID_TYPES.has(t)).toBe(true);
    for (const t of PLUGIN_TYPES) expect(VALID_TYPES.has(t)).toBe(true);
  });
});

describe('WAKE_MODES', () => {
  it('has now and next-heartbeat', () => {
    expect(WAKE_MODES.NOW).toBe('now');
    expect(WAKE_MODES.NEXT_HEARTBEAT).toBe('next-heartbeat');
  });
});

// ── ID generation ───────────────────────────────────────────────────────────

describe('generateId', () => {
  it('generates prefixed ids', () => {
    const id = generateId('wake');
    expect(id).toMatch(/^wake_/);
    expect(id.length).toBeGreaterThan(5);
  });

  it('defaults to msg prefix', () => {
    expect(generateId()).toMatch(/^msg_/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('validateEnvelope', () => {
  it('rejects null', () => {
    expect(validateEnvelope(null).valid).toBe(false);
  });

  it('rejects missing type', () => {
    expect(validateEnvelope({}).valid).toBe(false);
  });

  it('rejects unknown type', () => {
    expect(validateEnvelope({ type: 'bogus' }).valid).toBe(false);
  });

  it('accepts valid types', () => {
    expect(validateEnvelope({ type: 'ping' }).valid).toBe(true);
    expect(validateEnvelope({ type: 'message', text: 'hi' }).valid).toBe(true);
  });
});

describe('validateMessage', () => {
  it('rejects non-message type', () => {
    expect(validateMessage({ type: 'ping' }).valid).toBe(false);
  });

  it('rejects missing text', () => {
    expect(validateMessage({ type: 'message' }).valid).toBe(false);
  });

  it('accepts valid message', () => {
    expect(validateMessage({ type: 'message', text: 'hello' }).valid).toBe(true);
  });
});

describe('validateWake', () => {
  it('rejects missing text', () => {
    expect(validateWake({ type: 'wake' }).valid).toBe(false);
  });

  it('rejects invalid mode', () => {
    expect(validateWake({ type: 'wake', text: 'hi', mode: 'bad' }).valid).toBe(false);
  });

  it('accepts valid wake', () => {
    expect(validateWake({ type: 'wake', text: 'go', mode: 'now' }).valid).toBe(true);
  });

  it('accepts wake without mode', () => {
    expect(validateWake({ type: 'wake', text: 'go' }).valid).toBe(true);
  });
});

describe('validateAgent', () => {
  it('rejects missing message', () => {
    expect(validateAgent({ type: 'agent' }).valid).toBe(false);
  });

  it('accepts valid agent', () => {
    expect(validateAgent({ type: 'agent', message: 'do stuff' }).valid).toBe(true);
  });
});

// ── Factories ───────────────────────────────────────────────────────────────

describe('createConnected', () => {
  it('builds connected envelope', () => {
    const msg = createConnected('ch_1', ['h1', 'h2']);
    expect(msg.type).toBe('connected');
    expect(msg.channelId).toBe('ch_1');
    expect(msg.humans).toEqual(['h1', 'h2']);
  });

  it('defaults humans to empty array', () => {
    expect(createConnected('ch_1').humans).toEqual([]);
  });
});

describe('createMessage', () => {
  it('generates id and timestamp', () => {
    const msg = createMessage({ from: 'human', text: 'hi' });
    expect(msg.type).toBe('message');
    expect(msg.id).toMatch(/^msg_/);
    expect(msg.text).toBe('hi');
    expect(msg.timestamp).toBeDefined();
  });

  it('uses provided id', () => {
    const msg = createMessage({ text: 'hi', id: 'custom_1' });
    expect(msg.id).toBe('custom_1');
  });

  it('omits connId when not provided', () => {
    const msg = createMessage({ text: 'hi' });
    expect(msg).not.toHaveProperty('connId');
  });
});

describe('createWake', () => {
  it('builds wake envelope', () => {
    const msg = createWake({ text: 'event', mode: 'next-heartbeat' });
    expect(msg.type).toBe('wake');
    expect(msg.text).toBe('event');
    expect(msg.mode).toBe('next-heartbeat');
    expect(msg.id).toMatch(/^wake_/);
  });
});

describe('createAgentEnvelope', () => {
  it('builds agent envelope with optional fields', () => {
    const msg = createAgentEnvelope({
      message: 'do it',
      name: 'test',
      model: 'gpt-4',
      deliver: true
    });
    expect(msg.type).toBe('agent');
    expect(msg.message).toBe('do it');
    expect(msg.name).toBe('test');
    expect(msg.model).toBe('gpt-4');
    expect(msg.deliver).toBe(true);
  });
});

describe('createAck', () => {
  it('builds ack', () => {
    const msg = createAck('wake_1', 'dispatched', 'conn_1');
    expect(msg).toEqual({ type: 'ack', id: 'wake_1', status: 'dispatched', connId: 'conn_1' });
  });
});

describe('createError', () => {
  it('builds error with optional fields', () => {
    const msg = createError('boom', 'msg_1');
    expect(msg.type).toBe('error');
    expect(msg.error).toBe('boom');
    expect(msg.messageId).toBe('msg_1');
    expect(msg).not.toHaveProperty('connId');
  });
});

describe('createChunk', () => {
  it('builds chunk', () => {
    const msg = createChunk('r1', 'partial');
    expect(msg).toEqual({ type: 'chunk', id: 'r1', text: 'partial' });
  });
});

describe('createDone', () => {
  it('builds done without text', () => {
    const msg = createDone('r1');
    expect(msg).toEqual({ type: 'done', id: 'r1' });
  });

  it('includes text when provided', () => {
    const msg = createDone('r1', 'final');
    expect(msg.text).toBe('final');
  });
});

describe('createPing / createPong', () => {
  it('creates ping', () => {
    expect(createPing()).toEqual({ type: 'ping' });
  });

  it('creates pong', () => {
    expect(createPong()).toEqual({ type: 'pong' });
  });
});
