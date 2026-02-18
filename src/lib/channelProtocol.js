/**
 * Channel WebSocket Protocol — constants, validation, and message factories.
 *
 * See docs/channel-ws-protocol.md for the full specification.
 */

import { nanoid } from 'nanoid';

// ── Envelope types ──────────────────────────────────────────────────────────

export const ENVELOPE_TYPES = {
  // Server → Plugin (inbound to plugin)
  CONNECTED: 'connected',
  MESSAGE: 'message',
  WAKE: 'wake',
  AGENT: 'agent',
  HUMAN_CONNECTED: 'human_connected',
  HUMAN_DISCONNECTED: 'human_disconnected',

  // Plugin → Server (outbound from plugin)
  REPLY: 'reply',
  CHUNK: 'chunk',
  DONE: 'done',
  ACK: 'ack',
  ERROR: 'error',
  TYPING: 'typing',

  // Bidirectional keepalive
  PING: 'ping',
  PONG: 'pong'
};

/** All valid type strings */
export const VALID_TYPES = new Set(Object.values(ENVELOPE_TYPES));

/** Types the server sends to the plugin */
export const SERVER_TYPES = new Set([
  ENVELOPE_TYPES.CONNECTED,
  ENVELOPE_TYPES.MESSAGE,
  ENVELOPE_TYPES.WAKE,
  ENVELOPE_TYPES.AGENT,
  ENVELOPE_TYPES.HUMAN_CONNECTED,
  ENVELOPE_TYPES.HUMAN_DISCONNECTED,
  ENVELOPE_TYPES.PING,
  ENVELOPE_TYPES.PONG
]);

/** Types the plugin sends to the server */
export const PLUGIN_TYPES = new Set([
  ENVELOPE_TYPES.MESSAGE,
  ENVELOPE_TYPES.CHUNK,
  ENVELOPE_TYPES.DONE,
  ENVELOPE_TYPES.ACK,
  ENVELOPE_TYPES.ERROR,
  ENVELOPE_TYPES.TYPING,
  ENVELOPE_TYPES.PING,
  ENVELOPE_TYPES.PONG
]);

// ── Wake modes ──────────────────────────────────────────────────────────────

export const WAKE_MODES = {
  NOW: 'now',
  NEXT_HEARTBEAT: 'next-heartbeat'
};

// ── ID generation ───────────────────────────────────────────────────────────

export function generateId(prefix = 'msg') {
  return `${prefix}_${nanoid(12)}`;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate that an envelope has a valid type field.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, error: 'Envelope must be a non-null object' };
  }
  if (!envelope.type || typeof envelope.type !== 'string') {
    return { valid: false, error: 'Envelope must have a string type field' };
  }
  if (!VALID_TYPES.has(envelope.type)) {
    return { valid: false, error: `Unknown envelope type: ${envelope.type}` };
  }
  return { valid: true };
}

/**
 * Validate a message envelope (inbound chat).
 */
export function validateMessage(envelope) {
  const base = validateEnvelope(envelope);
  if (!base.valid) return base;
  if (envelope.type !== ENVELOPE_TYPES.MESSAGE) {
    return { valid: false, error: 'Expected type "message"' };
  }
  if (!envelope.text || typeof envelope.text !== 'string') {
    return { valid: false, error: 'Message must have a string text field' };
  }
  return { valid: true };
}

/**
 * Validate a wake envelope.
 */
export function validateWake(envelope) {
  const base = validateEnvelope(envelope);
  if (!base.valid) return base;
  if (envelope.type !== ENVELOPE_TYPES.WAKE) {
    return { valid: false, error: 'Expected type "wake"' };
  }
  if (!envelope.text || typeof envelope.text !== 'string') {
    return { valid: false, error: 'Wake must have a string text field' };
  }
  if (envelope.mode && envelope.mode !== WAKE_MODES.NOW && envelope.mode !== WAKE_MODES.NEXT_HEARTBEAT) {
    return { valid: false, error: `Invalid wake mode: ${envelope.mode}` };
  }
  return { valid: true };
}

/**
 * Validate an agent envelope.
 */
export function validateAgent(envelope) {
  const base = validateEnvelope(envelope);
  if (!base.valid) return base;
  if (envelope.type !== ENVELOPE_TYPES.AGENT) {
    return { valid: false, error: 'Expected type "agent"' };
  }
  if (!envelope.message || typeof envelope.message !== 'string') {
    return { valid: false, error: 'Agent must have a string message field' };
  }
  return { valid: true };
}

// ── Message factories ───────────────────────────────────────────────────────

/**
 * Create a `connected` envelope.
 */
export function createConnected(channelId, humans = []) {
  return {
    type: ENVELOPE_TYPES.CONNECTED,
    channelId,
    humans
  };
}

/**
 * Create a `message` envelope (server → plugin).
 */
export function createMessage({ from, text, id, timestamp, connId } = {}) {
  return {
    type: ENVELOPE_TYPES.MESSAGE,
    id: id || generateId('msg'),
    from: from || 'human',
    text,
    timestamp: timestamp || new Date().toISOString(),
    ...(connId ? { connId } : {})
  };
}

/**
 * Create a `wake` envelope (server → plugin).
 */
export function createWake({ text, id, mode, connId } = {}) {
  return {
    type: ENVELOPE_TYPES.WAKE,
    id: id || generateId('wake'),
    text,
    mode: mode || WAKE_MODES.NOW,
    ...(connId ? { connId } : {})
  };
}

/**
 * Create an `agent` envelope (server → plugin).
 */
export function createAgentEnvelope({ message, id, connId, name, deliver, channel, to, model, thinking, timeoutSeconds } = {}) {
  const env = {
    type: ENVELOPE_TYPES.AGENT,
    id: id || generateId('agent'),
    message
  };
  if (connId) env.connId = connId;
  if (name) env.name = name;
  if (deliver !== undefined) env.deliver = deliver;
  if (channel) env.channel = channel;
  if (to) env.to = to;
  if (model) env.model = model;
  if (thinking) env.thinking = thinking;
  if (timeoutSeconds) env.timeoutSeconds = timeoutSeconds;
  return env;
}

/**
 * Create an `ack` envelope (plugin → server).
 */
export function createAck(id, status = 'dispatched', connId) {
  const env = { type: ENVELOPE_TYPES.ACK, id, status };
  if (connId) env.connId = connId;
  return env;
}

/**
 * Create an `error` envelope (plugin → server).
 */
export function createError(error, messageId, connId) {
  const env = { type: ENVELOPE_TYPES.ERROR, error };
  if (messageId) env.messageId = messageId;
  if (connId) env.connId = connId;
  return env;
}

/**
 * Create a `chunk` envelope (plugin → server).
 */
export function createChunk(id, text, connId) {
  const env = { type: ENVELOPE_TYPES.CHUNK, id, text };
  if (connId) env.connId = connId;
  return env;
}

/**
 * Create a `done` envelope (plugin → server).
 */
export function createDone(id, text, connId) {
  const env = { type: ENVELOPE_TYPES.DONE, id };
  if (text) env.text = text;
  if (connId) env.connId = connId;
  return env;
}

/**
 * Create a `ping` or `pong` envelope.
 */
export function createPing() {
  return { type: ENVELOPE_TYPES.PING };
}

export function createPong() {
  return { type: ENVELOPE_TYPES.PONG };
}

export default {
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
};
