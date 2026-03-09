// Credential encryption utilities for custom service accounts (#283)
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'agentgate-credentials-v1'; // Static salt; key uniqueness comes from the secret

let _cachedKey = null;

function getEncryptionKey() {
  if (_cachedKey) return _cachedKey;
  const secret = process.env.CREDENTIALS_SECRET || process.env.AGENTGATE_SECRET;
  if (!secret) {
    throw new Error('CREDENTIALS_SECRET or AGENTGATE_SECRET environment variable must be set to use credential encryption');
  }
  _cachedKey = scryptSync(secret, SALT, KEY_LENGTH);
  return _cachedKey;
}

/**
 * Encrypt a plaintext string. Returns a hex-encoded string: iv + tag + ciphertext.
 */
export function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack as: iv (16) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('hex');
}

/**
 * Decrypt a hex-encoded string produced by encrypt().
 * Returns the original plaintext.
 */
export function decrypt(hexString) {
  const key = getEncryptionKey();
  const data = Buffer.from(hexString, 'hex');
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/**
 * Encrypt a credentials object (JSON-serializes then encrypts).
 */
export function encryptCredentials(credentials) {
  return encrypt(JSON.stringify(credentials));
}

/**
 * Decrypt a credentials string back to an object.
 */
export function decryptCredentials(encryptedHex) {
  return JSON.parse(decrypt(encryptedHex));
}
