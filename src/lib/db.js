import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '../../data.db');

const db = new Database(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

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
    completed_at TEXT
  );
`);

// API Keys
export function createApiKey(name) {
  const id = nanoid();
  const key = `rms_${nanoid(32)}`;
  db.prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)').run(id, name, key);
  return { id, name, key };
}

export function listApiKeys() {
  return db.prepare('SELECT id, name, key, created_at FROM api_keys').all();
}

export function deleteApiKey(id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export function validateApiKey(key) {
  return db.prepare('SELECT * FROM api_keys WHERE key = ?').get(key);
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
    results: row.results ? JSON.parse(row.results) : null
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
    results: row.results ? JSON.parse(row.results) : null
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
  return db.prepare("DELETE FROM write_queue WHERE status = ?").run(status);
}

export function deleteQueueEntry(id) {
  return db.prepare("DELETE FROM write_queue WHERE id = ?").run(id);
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
  const rows = db.prepare("SELECT status, COUNT(*) as count FROM write_queue GROUP BY status").all();
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
