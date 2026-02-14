/**
 * WebSocket frame utilities for raw socket handling.
 * Shared across channel endpoints to avoid code duplication.
 */

/**
 * Create a WebSocket text frame from a message string
 * @param {string} message - JSON string to send
 * @returns {Buffer} WebSocket frame
 */
export function createWebSocketFrame(message) {
  const payload = Buffer.from(message, 'utf8');
  const length = payload.length;
  
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Parse WebSocket frames from a buffer
 * @param {Buffer} buffer - Raw data buffer
 * @returns {{ messages: Array<{opcode: number, payload: Buffer}>, remainder: Buffer }}
 */
export function parseWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;

    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    // eslint-disable-next-line no-unused-vars
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (buffer.length - offset < 4) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 10) break;
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const totalFrameLength = headerLength + maskLength + payloadLength;
    if (buffer.length - offset < totalFrameLength) break;

    let maskKey = null;
    if (masked) {
      maskKey = buffer.slice(offset + headerLength, offset + headerLength + 4);
    }

    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.slice(payloadStart, payloadStart + payloadLength));

    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    offset += totalFrameLength;
    messages.push({ opcode, payload });
  }

  return { messages, remainder: buffer.slice(offset) };
}

/**
 * Create a WebSocket close frame
 * @param {number} code - Close code (1000 = normal)
 * @returns {Buffer} Close frame
 */
export function createCloseFrame(code = 1000) {
  const frame = Buffer.alloc(4);
  frame[0] = 0x88; // FIN + close opcode
  frame[1] = 2;    // Payload length
  frame.writeUInt16BE(code, 2);
  return frame;
}

/**
 * Create a WebSocket ping frame
 * @returns {Buffer} Ping frame
 */
export function createPingFrame() {
  const frame = Buffer.alloc(2);
  frame[0] = 0x89; // FIN + ping opcode
  frame[1] = 0;    // No payload
  return frame;
}

/**
 * Create a WebSocket pong frame
 * @param {Buffer} [payload] - Optional payload to echo back
 * @returns {Buffer} Pong frame
 */
export function createPongFrame(payload = null) {
  if (!payload || payload.length === 0) {
    const frame = Buffer.alloc(2);
    frame[0] = 0x8a; // FIN + pong opcode
    frame[1] = 0;
    return frame;
  }
  
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x8a;
    header[1] = length;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x8a;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  }
  return Buffer.concat([header, payload]);
}

// WebSocket opcodes
export const WS_OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
};
