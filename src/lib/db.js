import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import bcrypt from 'bcrypt';

// Data directory: AGENTGATE_DATA_DIR env var, or ~/.agentgate/
const dataDir = process.env.AGENTGATE_DATA_DIR || join(homedir(), '.agentgate');
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'data.db');

const db = new Database(dbPath);

// Initialize other tables first
db.exec(`
  CREATE TABLE IF NOT EXISTS service_accounts (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    name TEXT NOT NULL,
    credentials TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service, name)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS write_queue (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    account_name TEXT NOT NULL,
    requests TEXT NOT NULL,
    comment TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    results TEXT,
    submitted_by TEXT,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,
    completed_at TEXT,
    notified INTEGER DEFAULT 0,
    notified_at TEXT,
    notify_error TEXT
  );
`);

// Migrate write_queue table to add notification columns
try {
  const queueInfo = db.prepare('PRAGMA table_info(write_queue)').all();
  const hasNotified = queueInfo.some(col => col.name === 'notified');

  if (queueInfo.length > 0 && !hasNotified) {
    console.log('Migrating write_queue table to add notification columns...');
    db.exec(`
      ALTER TABLE write_queue ADD COLUMN notified INTEGER DEFAULT 0;
      ALTER TABLE write_queue ADD COLUMN notified_at TEXT;
      ALTER TABLE write_queue ADD COLUMN notify_error TEXT;
    `);
    console.log('Migration complete.');
  }
} catch (err) {
  // Columns might already exist or table doesn't exist yet
  if (!err.message.includes('duplicate column')) {
    console.error('Error migrating write_queue:', err.message);
  }
}

// Initialize api_keys table with migration support for old schema
// Old schema had: id, name, key, created_at
// New schema has: id, name, key_prefix, key_hash, created_at
try {
  const tableInfo = db.prepare('PRAGMA table_info(api_keys)').all();

  if (tableInfo.length === 0) {
    // Table doesn't exist, create with new schema
    db.exec(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else {
    const hasOldSchema = tableInfo.some(col => col.name === 'key') && !tableInfo.some(col => col.name === 'key_hash');

    if (hasOldSchema) {
      console.log('Migrating api_keys table to new schema...');
      console.log('NOTE: Old API keys cannot be migrated (bcrypt is one-way) and will be removed.');
      console.log('Please create new API keys after migration.');

      db.exec(`
        DROP TABLE api_keys;
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('Migration complete.');
    }
    // else: table exists with new schema, nothing to do
  }
} catch (err) {
  console.error('Error initializing api_keys table:', err.message);
}

// API Keys
export async function createApiKey(name) {
  const id = nanoid();
  const key = `rms_${nanoid(32)}`;
  const keyPrefix = key.substring(0, 8) + '...' + key.substring(key.length - 4);
  const keyHash = await bcrypt.hash(key, 10);
  db.prepare('INSERT INTO api_keys (id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)').run(id, name, keyPrefix, keyHash);
  return { id, name, key, keyPrefix }; // Return full key only at creation
}

export function listApiKeys() {
  return db.prepare('SELECT id, name, key_prefix, created_at FROM api_keys').all();
}

export function deleteApiKey(id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export async function validateApiKey(key) {
  // Must check all keys since we can't look up by hash directly
  const allKeys = db.prepare('SELECT * FROM api_keys').all();
  for (const row of allKeys) {
    const match = await bcrypt.compare(key, row.key_hash);
    if (match) {
      return { id: row.id, name: row.name };
    }
  }
  return null;
}

// Service Accounts
export function setAccountCredentials(service, name, credentials) {
  const id = nanoid();
  const json = JSON.stringify(credentials);
  db.prepare(`
    INSERT INTO service_accounts (id, service, name, credentials)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(service, name) DO UPDATE SET
      credentials = excluded.credentials,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, service, name, json);
}

export function getAccountCredentials(service, name) {
  const row = db.prepare('SELECT credentials FROM service_accounts WHERE service = ? AND name = ?').get(service, name);
  return row ? JSON.parse(row.credentials) : null;
}

export function listAccounts(service) {
  if (service) {
    return db.prepare('SELECT id, service, name, created_at, updated_at FROM service_accounts WHERE service = ?').all(service);
  }
  return db.prepare('SELECT id, service, name, created_at, updated_at FROM service_accounts ORDER BY service, name').all();
}

export function deleteAccount(service, name) {
  return db.prepare('DELETE FROM service_accounts WHERE service = ? AND name = ?').run(service, name);
}

export function deleteAccountById(id) {
  return db.prepare('DELETE FROM service_accounts WHERE id = ?').run(id);
}

// Get all accounts grouped by service (for /api/readme)
export function getAccountsByService() {
  const rows = db.prepare('SELECT service, name FROM service_accounts ORDER BY service, name').all();
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.service]) {
      grouped[row.service] = [];
    }
    grouped[row.service].push(row.name);
  }
  return grouped;
}

// Settings (for things like hsync config)
export function setSetting(key, value) {
  const json = JSON.stringify(value);
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, json);
}

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

export function deleteSetting(key) {
  return db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// Admin Password
export async function setAdminPassword(password) {
  const hash = await bcrypt.hash(password, 10);
  setSetting('admin_password', hash);
}

export async function verifyAdminPassword(password) {
  const hash = getSetting('admin_password');
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

export function hasAdminPassword() {
  return getSetting('admin_password') !== null;
}

// Cookie secret (generated once, persisted)
export function getCookieSecret() {
  let secret = getSetting('cookie_secret');
  if (!secret) {
    secret = nanoid(64);
    setSetting('cookie_secret', secret);
  }
  return secret;
}

// Write Queue
export function createQueueEntry(service, accountName, requests, comment, submittedBy) {
  const id = nanoid();
  db.prepare(`
    INSERT INTO write_queue (id, service, account_name, requests, comment, submitted_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, service, accountName, JSON.stringify(requests), comment || null, submittedBy);
  return { id, status: 'pending' };
}

export function getQueueEntry(id) {
  const row = db.prepare('SELECT * FROM write_queue WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    requests: JSON.parse(row.requests),
    results: row.results ? JSON.parse(row.results) : null,
    notified: Boolean(row.notified)
  };
}

export function listQueueEntries(status) {
  let rows;
  if (status) {
    rows = db.prepare('SELECT * FROM write_queue WHERE status = ? ORDER BY submitted_at DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM write_queue ORDER BY submitted_at DESC').all();
  }
  return rows.map(row => ({
    ...row,
    requests: JSON.parse(row.requests),
    results: row.results ? JSON.parse(row.results) : null,
    notified: Boolean(row.notified)
  }));
}

export function updateQueueNotification(id, success, error = null) {
  if (success) {
    db.prepare(`
      UPDATE write_queue
      SET notified = 1, notified_at = CURRENT_TIMESTAMP, notify_error = NULL
      WHERE id = ?
    `).run(id);
  } else {
    db.prepare(`
      UPDATE write_queue
      SET notified = 0, notify_error = ?
      WHERE id = ?
    `).run(error, id);
  }
}

export function listUnnotifiedEntries() {
  const rows = db.prepare(`
    SELECT * FROM write_queue
    WHERE status IN ('completed', 'failed', 'rejected')
      AND notified = 0
    ORDER BY completed_at DESC
  `).all();
  return rows.map(row => ({
    ...row,
    requests: JSON.parse(row.requests),
    results: row.results ? JSON.parse(row.results) : null,
    notified: false
  }));
}

export function updateQueueStatus(id, status, extra = {}) {
  const updates = ['status = ?'];
  const values = [status];

  if (extra.rejection_reason !== undefined) {
    updates.push('rejection_reason = ?');
    values.push(extra.rejection_reason);
  }
  if (extra.results !== undefined) {
    updates.push('results = ?');
    values.push(JSON.stringify(extra.results));
  }
  if (status === 'approved' || status === 'rejected') {
    updates.push('reviewed_at = CURRENT_TIMESTAMP');
  }
  if (status === 'completed' || status === 'failed') {
    updates.push('completed_at = CURRENT_TIMESTAMP');
  }

  values.push(id);
  db.prepare(`UPDATE write_queue SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function clearQueueByStatus(status) {
  if (status === 'all') {
    return db.prepare("DELETE FROM write_queue WHERE status IN ('completed', 'failed', 'rejected')").run();
  }
  return db.prepare('DELETE FROM write_queue WHERE status = ?').run(status);
}

export function deleteQueueEntry(id) {
  return db.prepare('DELETE FROM write_queue WHERE id = ?').run(id);
}

// Legacy alias
export function clearCompletedQueue() {
  return clearQueueByStatus('all');
}

export function getPendingQueueCount() {
  const row = db.prepare("SELECT COUNT(*) as count FROM write_queue WHERE status = 'pending'").get();
  return row.count;
}

export function getQueueCounts() {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM write_queue GROUP BY status').all();
  const counts = { all: 0, pending: 0, completed: 0, failed: 0, rejected: 0 };
  for (const row of rows) {
    counts[row.status] = row.count;
    counts.all += row.count;
  }
  return counts;
}

// List queue entries by submitter (for agent's own submissions)
// Returns summary info only - no full request bodies or results
export function listQueueEntriesBySubmitter(submittedBy, service = null, accountName = null) {
  let sql = `
    SELECT id, service, account_name, comment, status, rejection_reason,
           submitted_at, reviewed_at, completed_at
    FROM write_queue
    WHERE submitted_by = ?
  `;
  const params = [submittedBy];

  if (service) {
    sql += ' AND service = ?';
    params.push(service);
  }
  if (accountName) {
    sql += ' AND account_name = ?';
    params.push(accountName);
  }

  sql += ' ORDER BY submitted_at DESC';

  return db.prepare(sql).all(params);
}

export default db;
