import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs';
import bcrypt from 'bcrypt';
import { stemmer } from 'stemmer';

// Data directory: AGENTGATE_DATA_DIR env var, or ~/.agentgate/
const dataDir = process.env.AGENTGATE_DATA_DIR || join(homedir(), '.agentgate');
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'data.db');

// Avatars directory
const avatarsDir = join(dataDir, 'avatars');
mkdirSync(avatarsDir, { recursive: true });

// Supported avatar image extensions
const AVATAR_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

// Get the avatars directory path
export function getAvatarsDir() {
  return avatarsDir;
}

// Check if an avatar exists for an agent and return the filename if found
export function getAvatarFilename(agentName) {
  if (!agentName) return null;
  const safeName = agentName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  for (const ext of AVATAR_EXTENSIONS) {
    const filename = `${safeName}${ext}`;
    if (existsSync(join(avatarsDir, filename))) {
      return filename;
    }
  }
  return null;
}

// Delete avatar for an agent (removes any matching avatar file)
export function deleteAgentAvatar(agentName) {
  if (!agentName) return false;
  const safeName = agentName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  let deleted = false;
  for (const ext of AVATAR_EXTENSIONS) {
    const filepath = join(avatarsDir, `${safeName}${ext}`);
    if (existsSync(filepath)) {
      try {
        unlinkSync(filepath);
        deleted = true;
        console.log(`Deleted avatar: ${filepath}`);
      } catch (err) {
        console.error(`Failed to delete avatar ${filepath}:`, err.message);
      }
    }
  }
  return deleted;
}

// List all avatar files
export function listAvatars() {
  try {
    const files = readdirSync(avatarsDir);
    return files.filter(f => AVATAR_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext)));
  } catch {
    return [];
  }
}

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

  CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,
    delivered_at TEXT,
    read_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_messages_recipient
  ON agent_messages(to_agent, status);

  -- Mementos table (append-only agent memory storage)
  CREATE TABLE IF NOT EXISTS mementos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    model TEXT,
    role TEXT,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Keywords junction table (normalized, stemmed)
  CREATE TABLE IF NOT EXISTS memento_keywords (
    memento_id INTEGER REFERENCES mementos(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    PRIMARY KEY (memento_id, keyword)
  );

  CREATE INDEX IF NOT EXISTS idx_memento_keyword ON memento_keywords(keyword);
  CREATE INDEX IF NOT EXISTS idx_memento_agent ON mementos(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memento_created ON mementos(created_at);
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
// Schema evolution:
// v1: id, name, key, created_at
// v2: id, name, key_prefix, key_hash, created_at
// v3: + webhook_url, webhook_token (for agent configurations)
try {
  const tableInfo = db.prepare('PRAGMA table_info(api_keys)').all();

  if (tableInfo.length === 0) {
    // Table doesn't exist, create with latest schema
    db.exec(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        webhook_url TEXT,
        webhook_token TEXT,
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
          name TEXT NOT NULL UNIQUE,
          key_prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          webhook_url TEXT,
          webhook_token TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('Migration complete.');
    } else {
      // Check if we need to add webhook columns (v2 -> v3 migration)
      const hasWebhookUrl = tableInfo.some(col => col.name === 'webhook_url');
      if (!hasWebhookUrl) {
        console.log('Adding webhook columns to api_keys table...');
        db.exec(`
          ALTER TABLE api_keys ADD COLUMN webhook_url TEXT;
          ALTER TABLE api_keys ADD COLUMN webhook_token TEXT;
        `);
        console.log('Webhook columns added.');
      }
    }
  }
} catch (err) {
  console.error('Error initializing api_keys table:', err.message);
}

// API Keys

// Check if an agent name already exists (case-insensitive)
export function agentNameExists(name) {
  const result = db.prepare('SELECT id FROM api_keys WHERE LOWER(name) = LOWER(?)').get(name);
  return !!result;
}

export async function createApiKey(name) {
  // Check for duplicate names (case-insensitive)
  if (agentNameExists(name)) {
    throw new Error(`An agent with name "${name}" already exists (names are case-insensitive)`);
  }

  const id = nanoid();
  const key = `rms_${nanoid(32)}`;
  const keyPrefix = key.substring(0, 8) + '...' + key.substring(key.length - 4);
  const keyHash = await bcrypt.hash(key, 10);
  db.prepare('INSERT INTO api_keys (id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)').run(id, name, keyPrefix, keyHash);
  return { id, name, key, keyPrefix }; // Return full key only at creation
}

export function listApiKeys() {
  return db.prepare('SELECT id, name, key_prefix, webhook_url, webhook_token, created_at FROM api_keys').all();
}

export function getApiKeyByName(name) {
  // Case-insensitive lookup
  return db.prepare('SELECT id, name, key_prefix, webhook_url, webhook_token, created_at FROM api_keys WHERE LOWER(name) = LOWER(?)').get(name);
}

export function getApiKeyById(id) {
  return db.prepare('SELECT id, name, key_prefix, webhook_url, webhook_token, created_at FROM api_keys WHERE id = ?').get(id);
}

export function deleteApiKey(id) {
  // Get the agent name before deleting so we can clean up the avatar
  const agent = getApiKeyById(id);
  if (agent?.name) {
    deleteAgentAvatar(agent.name);
  }
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export function updateAgentWebhook(id, webhookUrl, webhookToken) {
  return db.prepare('UPDATE api_keys SET webhook_url = ?, webhook_token = ? WHERE id = ?').run(webhookUrl || null, webhookToken || null, id);
}

export async function validateApiKey(key) {
  // Must check all keys since we can't look up by hash directly
  const allKeys = db.prepare('SELECT * FROM api_keys').all();
  for (const row of allKeys) {
    const match = await bcrypt.compare(key, row.key_hash);
    if (match) {
      return { id: row.id, name: row.name, webhookUrl: row.webhook_url, webhookToken: row.webhook_token };
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
  let rows;
  if (service) {
    rows = db.prepare('SELECT id, service, name, credentials, created_at, updated_at FROM service_accounts WHERE service = ?').all(service);
  } else {
    rows = db.prepare('SELECT id, service, name, credentials, created_at, updated_at FROM service_accounts ORDER BY service, name').all();
  }
  // Parse credentials and extract ONLY safe display fields (no secrets!)
  return rows.map(row => {
    const creds = row.credentials ? JSON.parse(row.credentials) : null;
    return {
      id: row.id,
      service: row.service,
      name: row.name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      // Safe display-only fields (no clientSecret, accessToken, refreshToken!)
      status: {
        hasCredentials: !!(creds?.clientId || creds?.clientSecret),
        hasToken: !!creds?.accessToken,
        authStatus: creds?.authStatus || null,
        authError: creds?.authError || null,
        instance: creds?.instance || null  // For mastodon display
      }
    };
  });
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
    return db.prepare("DELETE FROM write_queue WHERE status IN ('completed', 'failed', 'rejected', 'withdrawn')").run();
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
  const counts = { all: 0, pending: 0, completed: 0, failed: 0, rejected: 0, withdrawn: 0 };
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

// Agent Messaging

// Get messaging mode: 'off', 'supervised', 'open'
export function getMessagingMode() {
  const setting = getSetting('agent_messaging');
  return setting?.mode || 'off';
}

export function setMessagingMode(mode) {
  if (!['off', 'supervised', 'open'].includes(mode)) {
    throw new Error('Invalid messaging mode');
  }
  setSetting('agent_messaging', { mode });
}

export function createAgentMessage(fromAgent, toAgent, message) {
  const id = nanoid();
  const mode = getMessagingMode();

  if (mode === 'off') {
    throw new Error('Agent messaging is disabled');
  }

  // In open mode, messages are delivered immediately
  const status = mode === 'open' ? 'delivered' : 'pending';
  const deliveredAt = mode === 'open' ? new Date().toISOString() : null;

  db.prepare(`
    INSERT INTO agent_messages (id, from_agent, to_agent, message, status, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, fromAgent, toAgent, message, status, deliveredAt);

  return { id, status };
}

export function getAgentMessage(id) {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
}

// Get messages for a specific agent (recipient)
export function getMessagesForAgent(agentName, unreadOnly = false) {
  let sql = `
    SELECT * FROM agent_messages
    WHERE to_agent = ? AND status = 'delivered'
  `;
  if (unreadOnly) {
    sql += ' AND read_at IS NULL';
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(agentName);
}

// Mark message as read
export function markMessageRead(id, agentName) {
  return db.prepare(`
    UPDATE agent_messages
    SET read_at = CURRENT_TIMESTAMP
    WHERE id = ? AND to_agent = ? AND read_at IS NULL
  `).run(id, agentName);
}

// Admin: list pending messages (for supervised mode)
export function listPendingMessages() {
  return db.prepare(`
    SELECT * FROM agent_messages
    WHERE status = 'pending'
    ORDER BY created_at DESC
  `).all();
}

// Admin: approve message
export function approveAgentMessage(id) {
  return db.prepare(`
    UPDATE agent_messages
    SET status = 'delivered', reviewed_at = CURRENT_TIMESTAMP, delivered_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
  `).run(id);
}

// Admin: reject message
export function rejectAgentMessage(id, reason) {
  return db.prepare(`
    UPDATE agent_messages
    SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, rejection_reason = ?
    WHERE id = ? AND status = 'pending'
  `).run(reason || 'No reason provided', id);
}

// Admin: list all messages (for UI)
export function listAgentMessages(status = null) {
  if (status) {
    return db.prepare('SELECT * FROM agent_messages WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC').all();
}

// Admin: delete message
export function deleteAgentMessage(id) {
  return db.prepare('DELETE FROM agent_messages WHERE id = ?').run(id);
}

// Admin: clear messages by status
export function clearAgentMessagesByStatus(status) {
  if (status === 'all') {
    return db.prepare("DELETE FROM agent_messages WHERE status IN ('delivered', 'rejected')").run();
  }
  return db.prepare('DELETE FROM agent_messages WHERE status = ?').run(status);
}

// Get counts for message queue
export function getMessageCounts() {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM agent_messages GROUP BY status').all();
  const counts = { all: 0, pending: 0, delivered: 0, rejected: 0 };
  for (const row of rows) {
    counts[row.status] = row.count;
    counts.all += row.count;
  }
  return counts;
}

export default db;

// Shared Queue Visibility helpers
export function getSharedQueueVisibility() {
  return getSetting('shared_queue_visibility') === true;
}

export function setSharedQueueVisibility(enabled) {
  setSetting('shared_queue_visibility', enabled);
}

// List all queue entries (for shared visibility mode)
export function listAllQueueEntries(service = null, accountName = null) {
  let sql = 'SELECT * FROM write_queue';
  const params = [];
  
  if (service && accountName) {
    sql += ' WHERE service = ? AND account_name = ?';
    params.push(service, accountName);
  } else if (service) {
    sql += ' WHERE service = ?';
    params.push(service);
  }
  
  sql += ' ORDER BY submitted_at DESC';
  
  const rows = db.prepare(sql).all(...params);
  return rows.map(row => ({
    ...row,
    requests: JSON.parse(row.requests),
    results: row.results ? JSON.parse(row.results) : null,
    notified: Boolean(row.notified)
  }));
}

// Agent Withdraw helpers
export function getAgentWithdrawEnabled() {
  return getSetting('agent_withdraw_enabled') === true;
}

export function setAgentWithdrawEnabled(enabled) {
  setSetting('agent_withdraw_enabled', enabled);
}

// ============================================
// Webhook Secrets (for signature verification)
// ============================================

export function getWebhookSecret(service) {
  const setting = getSetting(`webhook_secret_${service}`);
  return setting || null;
}

export function setWebhookSecret(service, secret) {
  setSetting(`webhook_secret_${service}`, secret);
}

export function deleteWebhookSecret(service) {
  return deleteSetting(`webhook_secret_${service}`);
}

export function listWebhookSecrets() {
  // Get all settings that start with webhook_secret_
  const rows = db.prepare("SELECT key, updated_at FROM settings WHERE key LIKE 'webhook_secret_%'").all();
  return rows.map(row => ({
    service: row.key.replace('webhook_secret_', ''),
    updated_at: row.updated_at
  }));
}

// Memento helpers

// Max content length (roughly 3K tokens ≈ 12KB characters)
const MEMENTO_MAX_CONTENT_LENGTH = 12 * 1024;

// Normalize and stem a keyword
export function normalizeKeyword(keyword) {
  // Lowercase, trim, remove special characters except hyphens
  const normalized = keyword.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  if (!normalized) return null;
  // Apply Porter stemming
  return stemmer(normalized);
}

// Create a memento
export function createMemento(agentId, content, keywords, options = {}) {
  if (!content || content.trim().length === 0) {
    throw new Error('Memento content cannot be empty');
  }

  if (content.length > MEMENTO_MAX_CONTENT_LENGTH) {
    throw new Error(`Memento content too long. Maximum ${MEMENTO_MAX_CONTENT_LENGTH} characters allowed.`);
  }

  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    throw new Error('Memento must have at least one keyword');
  }

  if (keywords.length > 10) {
    throw new Error('Memento cannot have more than 10 keywords');
  }

  const { model, role } = options;

  // Normalize and stem keywords, filter out empty ones
  const normalizedKeywords = keywords
    .map(k => normalizeKeyword(k))
    .filter(k => k !== null);

  if (normalizedKeywords.length === 0) {
    throw new Error('No valid keywords provided after normalization');
  }

  // Insert memento
  const result = db.prepare(`
    INSERT INTO mementos (agent_id, model, role, content)
    VALUES (?, ?, ?, ?)
  `).run(agentId, model || null, role || null, content);

  const mementoId = result.lastInsertRowid;

  // Insert keywords
  const insertKeyword = db.prepare(`
    INSERT OR IGNORE INTO memento_keywords (memento_id, keyword)
    VALUES (?, ?)
  `);

  for (const keyword of normalizedKeywords) {
    insertKeyword.run(mementoId, keyword);
  }

  return {
    id: mementoId,
    agent_id: agentId,
    keywords: normalizedKeywords,
    created_at: new Date().toISOString()
  };
}

// Get all keywords for an agent
export function getMementoKeywords(agentId) {
  const rows = db.prepare(`
    SELECT DISTINCT mk.keyword
    FROM memento_keywords mk
    JOIN mementos m ON mk.memento_id = m.id
    WHERE m.agent_id = ?
    ORDER BY mk.keyword
  `).all(agentId);

  return rows.map(r => r.keyword);
}

// Search mementos by keywords (returns metadata only)
export function searchMementos(agentId, keywords, options = {}) {
  const { limit = 20 } = options;

  // Normalize search keywords
  const normalizedKeywords = keywords
    .map(k => normalizeKeyword(k))
    .filter(k => k !== null);

  if (normalizedKeywords.length === 0) {
    return [];
  }

  // Find mementos that have ANY of the keywords (OR search)
  // Rank by number of matching keywords
  const placeholders = normalizedKeywords.map(() => '?').join(', ');

  const rows = db.prepare(`
    SELECT 
      m.id,
      m.agent_id,
      m.model,
      m.role,
      m.created_at,
      COUNT(DISTINCT mk.keyword) as match_count,
      SUBSTR(m.content, 1, 200) as preview
    FROM mementos m
    JOIN memento_keywords mk ON m.id = mk.memento_id
    WHERE m.agent_id = ? AND mk.keyword IN (${placeholders})
    GROUP BY m.id
    ORDER BY match_count DESC, m.created_at DESC
    LIMIT ?
  `).all(agentId, ...normalizedKeywords, limit);

  // Get all keywords for each memento
  const getKeywords = db.prepare(`
    SELECT keyword FROM memento_keywords WHERE memento_id = ?
  `);

  return rows.map(row => ({
    id: row.id,
    agent_id: row.agent_id,
    model: row.model,
    role: row.role,
    keywords: getKeywords.all(row.id).map(k => k.keyword),
    created_at: row.created_at,
    preview: row.preview + (row.preview.length > 200 ? '...' : ''),
    match_count: row.match_count
  }));
}

// Get recent mementos (metadata only)
export function getRecentMementos(agentId, limit = 5) {
  const rows = db.prepare(`
    SELECT id, agent_id, model, role, created_at, SUBSTR(content, 1, 200) as preview
    FROM mementos
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(agentId, limit);

  const getKeywords = db.prepare(`
    SELECT keyword FROM memento_keywords WHERE memento_id = ?
  `);

  return rows.map(row => ({
    id: row.id,
    agent_id: row.agent_id,
    model: row.model,
    role: row.role,
    keywords: getKeywords.all(row.id).map(k => k.keyword),
    created_at: row.created_at,
    preview: row.preview + (row.preview.length > 200 ? '...' : '')
  }));
}

// Fetch full memento content by IDs
export function getMementosById(agentId, ids) {
  if (!ids || ids.length === 0) return [];

  // Sanitize IDs (must be integers)
  const sanitizedIds = ids.filter(id => Number.isInteger(Number(id))).map(Number);
  if (sanitizedIds.length === 0) return [];

  const placeholders = sanitizedIds.map(() => '?').join(', ');

  const rows = db.prepare(`
    SELECT id, agent_id, model, role, content, created_at
    FROM mementos
    WHERE agent_id = ? AND id IN (${placeholders})
    ORDER BY created_at DESC
  `).all(agentId, ...sanitizedIds);

  const getKeywords = db.prepare(`
    SELECT keyword FROM memento_keywords WHERE memento_id = ?
  `);

  return rows.map(row => ({
    id: row.id,
    agent_id: row.agent_id,
    model: row.model,
    role: row.role,
    keywords: getKeywords.all(row.id).map(k => k.keyword),
    content: row.content,
    created_at: row.created_at
  }));
}

// Admin: list all mementos (with optional filters)
export function listMementos(options = {}) {
  const { agentId, keyword, limit = 50, offset = 0 } = options;

  let sql = `
    SELECT m.id, m.agent_id, m.model, m.role, m.created_at, SUBSTR(m.content, 1, 200) as preview
    FROM mementos m
  `;
  const params = [];

  const conditions = [];

  if (agentId) {
    conditions.push('m.agent_id = ?');
    params.push(agentId);
  }

  if (keyword) {
    const normalizedKeyword = normalizeKeyword(keyword);
    if (normalizedKeyword) {
      sql = `
        SELECT DISTINCT m.id, m.agent_id, m.model, m.role, m.created_at, SUBSTR(m.content, 1, 200) as preview
        FROM mementos m
        JOIN memento_keywords mk ON m.id = mk.memento_id
      `;
      conditions.push('mk.keyword = ?');
      params.push(normalizedKeyword);
    }
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);

  const getKeywords = db.prepare(`
    SELECT keyword FROM memento_keywords WHERE memento_id = ?
  `);

  return rows.map(row => ({
    id: row.id,
    agent_id: row.agent_id,
    model: row.model,
    role: row.role,
    keywords: getKeywords.all(row.id).map(k => k.keyword),
    created_at: row.created_at,
    preview: row.preview + (row.preview.length > 200 ? '...' : '')
  }));
}

// Admin: get memento by ID (full content, any agent)
export function getMementoById(id) {
  const row = db.prepare(`
    SELECT id, agent_id, model, role, content, created_at
    FROM mementos
    WHERE id = ?
  `).get(id);

  if (!row) return null;

  const keywords = db.prepare(`
    SELECT keyword FROM memento_keywords WHERE memento_id = ?
  `).all(id).map(k => k.keyword);

  return { ...row, keywords };
}

// Admin: delete memento
export function deleteMemento(id) {
  // Keywords will be cascade deleted due to foreign key
  return db.prepare('DELETE FROM mementos WHERE id = ?').run(id);
}

// Get memento counts
export function getMementoCounts() {
  const total = db.prepare('SELECT COUNT(*) as count FROM mementos').get();
  const byAgent = db.prepare(`
    SELECT agent_id, COUNT(*) as count
    FROM mementos
    GROUP BY agent_id
    ORDER BY count DESC
  `).all();

  return {
    total: total.count,
    byAgent: byAgent.reduce((acc, row) => {
      acc[row.agent_id] = row.count;
      return acc;
    }, {})
  };
}

// Get all unique agents that have mementos
export function getMementoAgents() {
  return db.prepare(`
    SELECT DISTINCT agent_id FROM mementos ORDER BY agent_id
  `).all().map(r => r.agent_id);
}
