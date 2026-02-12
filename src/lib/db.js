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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    notify_error TEXT,
    auto_approved INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  -- Service-level access control
  CREATE TABLE IF NOT EXISTS service_access (
    service TEXT NOT NULL,
    account_name TEXT NOT NULL,
    access_mode TEXT DEFAULT 'all',  -- 'all' | 'allowlist' | 'denylist'
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (service, account_name)
  );

  CREATE TABLE IF NOT EXISTS service_agent_access (
    service TEXT NOT NULL,
    account_name TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    allowed BOOLEAN DEFAULT 1,
    bypass_auth BOOLEAN DEFAULT 0,
    PRIMARY KEY (service, account_name, agent_name)
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

  -- Broadcast history
  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    total_recipients INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS broadcast_recipients (
    broadcast_id INTEGER NOT NULL,
    to_agent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    delivered_at TEXT,
    error_message TEXT,
    PRIMARY KEY (broadcast_id, to_agent),
    FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id)
  );

  CREATE TABLE IF NOT EXISTS queue_warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_queue_warnings_queue
  ON queue_warnings(queue_id);

  CREATE INDEX IF NOT EXISTS idx_broadcasts_from
  ON broadcasts(from_agent, created_at DESC);

  -- LLM Providers (credential vault)
  CREATE TABLE IF NOT EXISTS llm_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    provider_type TEXT NOT NULL,
    api_key TEXT NOT NULL,
    base_url TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Agent → LLM model mapping
  CREATE TABLE IF NOT EXISTS llm_agent_models (
    agent_name TEXT NOT NULL,
    provider_id INTEGER NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (agent_name, provider_id, model_id)
  );

  CREATE INDEX IF NOT EXISTS idx_llm_agent_default
  ON llm_agent_models(agent_name, is_default);

  -- Webhook configuration table (for managing inbound webhooks)
  CREATE TABLE IF NOT EXISTS webhook_configs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    secret TEXT,
    events TEXT,
    enabled INTEGER DEFAULT 1,
    -- Security: Agent assignment (JSON array of agent IDs, null = all agents)
    assigned_agents TEXT,
    -- Security: IP allowlist for generic webhooks (JSON array of CIDRs)
    ip_allowlist TEXT,
    -- Security: Max payload size in bytes (default 1MB)
    max_payload_size INTEGER DEFAULT 1048576,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Webhook delivery history (audit log)
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    config_id TEXT REFERENCES webhook_configs(id) ON DELETE SET NULL,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    delivery_id TEXT,
    repo TEXT,
    payload TEXT,
    success INTEGER DEFAULT 1,
    broadcast_result TEXT,
    received_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_config
  ON webhook_deliveries(config_id, received_at DESC);

  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_time
  ON webhook_deliveries(received_at DESC);

  -- Replay protection: unique delivery IDs per source
  CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_delivery_dedup
  ON webhook_deliveries(source, delivery_id) WHERE delivery_id IS NOT NULL;
`);

// ============================================
// Migration: TEXT PK → INTEGER PK AUTOINCREMENT
// ============================================
try {
  const wqInfo = db.prepare('PRAGMA table_info(write_queue)').all();
  const wqIdCol = wqInfo.find(c => c.name === 'id');
  if (wqIdCol && wqIdCol.type === 'TEXT') {
    console.log('Migrating TEXT primary keys to INTEGER AUTOINCREMENT...');
    db.transaction(() => {
      // 1. write_queue (has FK from queue_warnings)
      db.exec('ALTER TABLE write_queue RENAME TO write_queue_old');
      db.exec(`CREATE TABLE write_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      )`);
      db.exec(`INSERT INTO write_queue (service, account_name, requests, comment, status, rejection_reason, results, submitted_by, submitted_at, reviewed_at, completed_at, notified, notified_at, notify_error)
        SELECT service, account_name, requests, comment, status, rejection_reason, results, submitted_by, submitted_at, reviewed_at, completed_at, notified, notified_at, notify_error FROM write_queue_old`);
      // Migrate queue_warnings FK references
      const oldWarnings = db.prepare('SELECT qw.*, wqo.rowid as old_rowid FROM queue_warnings qw LEFT JOIN write_queue_old wqo ON qw.queue_id = wqo.id').all();
      db.exec('DELETE FROM queue_warnings');
      // Build old_text_id -> new_int_id mapping
      const idMap = db.prepare('SELECT wo.id as old_id, wn.id as new_id FROM write_queue_old wo JOIN write_queue wn ON wo.service = wn.service AND wo.account_name = wn.account_name AND wo.submitted_at = wn.submitted_at AND wo.requests = wn.requests').all();
      const wqMap = new Map(idMap.map(r => [r.old_id, r.new_id]));
      const insertWarning = db.prepare('INSERT INTO queue_warnings (agent_id, message, created_at, queue_id) VALUES (?, ?, ?, ?)');
      for (const w of oldWarnings) {
        const newQueueId = wqMap.get(w.queue_id);
        if (newQueueId !== undefined && newQueueId !== null) {
          insertWarning.run(w.agent_id, w.message, w.created_at, newQueueId);
        }
      }
      db.exec('DROP TABLE write_queue_old');

      // 2. agent_messages
      db.exec('ALTER TABLE agent_messages RENAME TO agent_messages_old');
      db.exec(`CREATE TABLE agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        rejection_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TEXT,
        delivered_at TEXT,
        read_at TEXT
      )`);
      db.exec(`INSERT INTO agent_messages (from_agent, to_agent, message, status, rejection_reason, created_at, reviewed_at, delivered_at, read_at)
        SELECT from_agent, to_agent, message, status, rejection_reason, created_at, reviewed_at, delivered_at, read_at FROM agent_messages_old`);
      db.exec('DROP TABLE agent_messages_old');

      // 3. broadcasts (has FK from broadcast_recipients)
      db.exec('ALTER TABLE broadcasts RENAME TO broadcasts_old');
      db.exec(`CREATE TABLE broadcasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        total_recipients INTEGER DEFAULT 0,
        delivered_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0
      )`);
      db.exec(`INSERT INTO broadcasts (from_agent, message, created_at, total_recipients, delivered_count, failed_count)
        SELECT from_agent, message, created_at, total_recipients, delivered_count, failed_count FROM broadcasts_old`);
      // Migrate broadcast_recipients
      const bIdMap = db.prepare('SELECT bo.id as old_id, bn.id as new_id FROM broadcasts_old bo JOIN broadcasts bn ON bo.from_agent = bn.from_agent AND bo.created_at = bn.created_at AND bo.message = bn.message').all();
      const bMap = new Map(bIdMap.map(r => [r.old_id, r.new_id]));
      const oldRecipients = db.prepare('SELECT * FROM broadcast_recipients').all();
      db.exec('DELETE FROM broadcast_recipients');
      // Recreate broadcast_recipients with INTEGER FK
      db.exec('DROP TABLE broadcast_recipients');
      db.exec(`CREATE TABLE broadcast_recipients (
        broadcast_id INTEGER NOT NULL,
        to_agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        delivered_at TEXT,
        error_message TEXT,
        PRIMARY KEY (broadcast_id, to_agent),
        FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id)
      )`);
      const insertRecip = db.prepare('INSERT INTO broadcast_recipients (broadcast_id, to_agent, status, delivered_at, error_message) VALUES (?, ?, ?, ?, ?)');
      for (const r of oldRecipients) {
        const newBId = bMap.get(r.broadcast_id);
        if (newBId !== undefined && newBId !== null) {
          insertRecip.run(newBId, r.to_agent, r.status, r.delivered_at, r.error_message);
        }
      }
      db.exec('DROP TABLE broadcasts_old');

      // 4. service_accounts
      db.exec('ALTER TABLE service_accounts RENAME TO service_accounts_old');
      db.exec(`CREATE TABLE service_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        name TEXT NOT NULL,
        credentials TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(service, name)
      )`);
      db.exec(`INSERT INTO service_accounts (service, name, credentials, created_at, updated_at)
        SELECT service, name, credentials, created_at, updated_at FROM service_accounts_old`);
      db.exec('DROP TABLE service_accounts_old');

      // Recreate queue_warnings with INTEGER queue_id type
      db.exec('ALTER TABLE queue_warnings RENAME TO queue_warnings_old');
      db.exec(`CREATE TABLE queue_warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`INSERT INTO queue_warnings (queue_id, agent_id, message, created_at)
        SELECT queue_id, agent_id, message, created_at FROM queue_warnings_old`);
      db.exec('DROP TABLE queue_warnings_old');
      db.exec('CREATE INDEX IF NOT EXISTS idx_queue_warnings_queue ON queue_warnings(queue_id)');
    })();
    // Recreate indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_messages_recipient ON agent_messages(to_agent, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_broadcasts_from ON broadcasts(from_agent, created_at DESC)');
    console.log('TEXT → INTEGER PK migration complete.');
  }
} catch (err) {
  console.error('Error during TEXT→INTEGER PK migration:', err.message);
  throw err;
}

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

// Migrate write_queue table to add auto_approved column
try {
  const queueInfo2 = db.prepare('PRAGMA table_info(write_queue)').all();
  const hasAutoApproved = queueInfo2.some(col => col.name === 'auto_approved');

  if (queueInfo2.length > 0 && !hasAutoApproved) {
    console.log('Migrating write_queue table to add auto_approved column...');
    db.exec('ALTER TABLE write_queue ADD COLUMN auto_approved INTEGER DEFAULT 0;');
    console.log('Migration complete.');
  }
} catch (err) {
  if (!err.message.includes('duplicate column')) {
    console.error('Error migrating write_queue auto_approved:', err.message);
  }
}

// Migrate write_queue table to add reaction_emoji column
try {
  const queueInfo3 = db.prepare('PRAGMA table_info(write_queue)').all();
  const hasReactionEmoji = queueInfo3.some(col => col.name === 'reaction_emoji');

  if (queueInfo3.length > 0 && !hasReactionEmoji) {
    console.log('Migrating write_queue table to add reaction_emoji column...');
    db.exec('ALTER TABLE write_queue ADD COLUMN reaction_emoji TEXT;');
    console.log('Migration complete.');
  }
} catch (err) {
  if (!err.message.includes('duplicate column')) {
    console.error('Error migrating write_queue reaction_emoji:', err.message);
  }
}

// Migrate agent_messages table to add reply_to_id column (for reply tracking)
try {
  const msgInfo = db.prepare('PRAGMA table_info(agent_messages)').all();
  const hasReplyTo = msgInfo.some(col => col.name === 'reply_to_id');

  if (msgInfo.length > 0 && !hasReplyTo) {
    console.log('Migrating agent_messages table to add reply_to_id column...');
    db.exec('ALTER TABLE agent_messages ADD COLUMN reply_to_id INTEGER REFERENCES agent_messages(id);');
    console.log('Migration complete.');
  }
} catch (err) {
  if (!err.message.includes('duplicate column')) {
    console.error('Error migrating agent_messages reply_to_id:', err.message);
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
        enabled INTEGER DEFAULT 1,
        gateway_proxy_enabled INTEGER DEFAULT 0,
        gateway_proxy_id TEXT,
        gateway_proxy_url TEXT,
        bio TEXT,
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
      // Run each migration in its own try/catch so one failure doesn't skip the rest
      const migrations = [
        {
          name: 'webhook columns (v2 -> v3)',
          check: () => !tableInfo.some(col => col.name === 'webhook_url'),
          run: () => db.exec(`
            ALTER TABLE api_keys ADD COLUMN webhook_url TEXT;
            ALTER TABLE api_keys ADD COLUMN webhook_token TEXT;
          `)
        },
        {
          name: 'enabled column',
          check: () => !tableInfo.some(col => col.name === 'enabled'),
          run: () => db.exec('ALTER TABLE api_keys ADD COLUMN enabled INTEGER DEFAULT 1;')
        },
        {
          name: 'gateway proxy columns',
          check: () => !tableInfo.some(col => col.name === 'gateway_proxy_enabled'),
          run: () => db.exec(`
            ALTER TABLE api_keys ADD COLUMN gateway_proxy_enabled INTEGER DEFAULT 0;
            ALTER TABLE api_keys ADD COLUMN gateway_proxy_id TEXT;
            ALTER TABLE api_keys ADD COLUMN gateway_proxy_url TEXT;
          `)
        },
        {
          name: 'bio column',
          check: () => !tableInfo.some(col => col.name === 'bio'),
          run: () => db.exec('ALTER TABLE api_keys ADD COLUMN bio TEXT;')
        },
        {
          name: 'raw_results column',
          check: () => !tableInfo.some(col => col.name === 'raw_results'),
          run: () => db.exec('ALTER TABLE api_keys ADD COLUMN raw_results INTEGER DEFAULT 0;')
        },
        {
          name: 'channel columns',
          check: () => !tableInfo.some(col => col.name === 'channel_enabled'),
          run: () => db.exec(`
            ALTER TABLE api_keys ADD COLUMN channel_enabled INTEGER DEFAULT 0;
            ALTER TABLE api_keys ADD COLUMN channel_id TEXT;
            ALTER TABLE api_keys ADD COLUMN channel_key_hash TEXT;
            ALTER TABLE api_keys ADD COLUMN channel_last_connected TEXT;
          `)
        }
      ];

      for (const migration of migrations) {
        try {
          if (migration.check()) {
            console.log(`Adding ${migration.name} to api_keys table...`);
            migration.run();
            console.log(`${migration.name} added.`);
          }
        } catch (err) {
          console.error(`Error adding ${migration.name} to api_keys:`, err.message);
        }
      }
    }
  }
} catch (err) {
  console.error('Error initializing api_keys table:', err.message);
}

// Migrate service_agent_access to add bypass_auth column if missing
try {
  const agentAccessInfo = db.prepare('PRAGMA table_info(service_agent_access)').all();
  const hasBypassAuth = agentAccessInfo.some(col => col.name === 'bypass_auth');

  if (agentAccessInfo.length > 0 && !hasBypassAuth) {
    console.log('Migrating service_agent_access table to add bypass_auth column...');
    db.exec('ALTER TABLE service_agent_access ADD COLUMN bypass_auth BOOLEAN DEFAULT 0;');
    console.log('Migration complete.');
  }
} catch (err) {
  if (!err.message.includes('duplicate column')) {
    console.error('Error migrating service_agent_access:', err.message);
  }
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

export async function regenerateApiKey(id) {
  const existing = getApiKeyById(id);
  if (!existing) {
    throw new Error('Agent not found');
  }

  const key = `rms_${nanoid(32)}`;
  const keyPrefix = key.substring(0, 8) + '...' + key.substring(key.length - 4);
  const keyHash = await bcrypt.hash(key, 10);

  db.prepare('UPDATE api_keys SET key_prefix = ?, key_hash = ? WHERE id = ?')
    .run(keyPrefix, keyHash, id);

  return { id, name: existing.name, key, keyPrefix };
}

export function listApiKeys() {
  return db.prepare('SELECT id, name, key_prefix, webhook_url, webhook_token, enabled, gateway_proxy_enabled, gateway_proxy_id, gateway_proxy_url, bio, raw_results, created_at FROM api_keys').all();
}

export function getApiKeyByName(name) {
  // Case-insensitive lookup
  return db.prepare('SELECT id, name, key_prefix, webhook_url, webhook_token, enabled, gateway_proxy_enabled, gateway_proxy_id, gateway_proxy_url, bio, raw_results, created_at FROM api_keys WHERE LOWER(name) = LOWER(?)').get(name);
}

export function getApiKeyById(id) {
  return db.prepare('SELECT id, name, key_prefix, webhook_url, webhook_token, enabled, gateway_proxy_enabled, gateway_proxy_id, gateway_proxy_url, bio, raw_results, created_at FROM api_keys WHERE id = ?').get(id);
}

// Get counts of all data associated with an agent (for delete warning)
export function getAgentDataCounts(agentName) {
  const nameLower = agentName.toLowerCase();
  return {
    messages: db.prepare('SELECT COUNT(*) as count FROM agent_messages WHERE LOWER(from_agent) = ? OR LOWER(to_agent) = ?').get(nameLower, nameLower)?.count || 0,
    queueEntries: db.prepare('SELECT COUNT(*) as count FROM write_queue WHERE LOWER(submitted_by) = ?').get(nameLower)?.count || 0,
    mementos: db.prepare('SELECT COUNT(*) as count FROM mementos WHERE LOWER(agent_id) = ?').get(nameLower)?.count || 0,
    broadcasts: db.prepare('SELECT COUNT(*) as count FROM broadcasts WHERE LOWER(from_agent) = ?').get(nameLower)?.count || 0,
    broadcastRecipients: db.prepare('SELECT COUNT(*) as count FROM broadcast_recipients WHERE LOWER(to_agent) = ?').get(nameLower)?.count || 0,
    warnings: db.prepare('SELECT COUNT(*) as count FROM queue_warnings WHERE LOWER(agent_id) = ?').get(nameLower)?.count || 0,
    serviceAccess: db.prepare('SELECT COUNT(*) as count FROM service_agent_access WHERE LOWER(agent_name) = ?').get(nameLower)?.count || 0
  };
}

// Cascade delete all data associated with an agent
export function cascadeDeleteAgentData(agentName) {
  const nameLower = agentName.toLowerCase();
  const deleteAll = db.transaction(() => {
    db.prepare('DELETE FROM agent_messages WHERE LOWER(from_agent) = ? OR LOWER(to_agent) = ?').run(nameLower, nameLower);
    db.prepare('DELETE FROM write_queue WHERE LOWER(submitted_by) = ?').run(nameLower);
    // Mementos cascade deletes memento_keywords via FK
    db.prepare('DELETE FROM mementos WHERE LOWER(agent_id) = ?').run(nameLower);
    // Delete broadcast recipients first, then broadcasts
    db.prepare('DELETE FROM broadcast_recipients WHERE LOWER(to_agent) = ?').run(nameLower);
    const broadcastIds = db.prepare('SELECT id FROM broadcasts WHERE LOWER(from_agent) = ?').all(nameLower);
    for (const b of broadcastIds) {
      db.prepare('DELETE FROM broadcast_recipients WHERE broadcast_id = ?').run(b.id);
    }
    db.prepare('DELETE FROM broadcasts WHERE LOWER(from_agent) = ?').run(nameLower);
    db.prepare('DELETE FROM queue_warnings WHERE LOWER(agent_id) = ?').run(nameLower);
    db.prepare('DELETE FROM service_agent_access WHERE LOWER(agent_name) = ?').run(nameLower);
  });
  deleteAll();
}

export function deleteApiKey(id) {
  // Get the agent name before deleting so we can clean up the avatar and related data
  const agent = getApiKeyById(id);
  if (agent?.name) {
    cascadeDeleteAgentData(agent.name);
    deleteAgentAvatar(agent.name);
  }
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export function updateAgentWebhook(id, webhookUrl, webhookToken) {
  return db.prepare('UPDATE api_keys SET webhook_url = ?, webhook_token = ? WHERE id = ?').run(webhookUrl || null, webhookToken || null, id);
}

export function setAgentEnabled(id, enabled) {
  return db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function setAgentRawResults(id, enabled) {
  return db.prepare('UPDATE api_keys SET raw_results = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function updateAgentBio(id, bio) {
  return db.prepare('UPDATE api_keys SET bio = ? WHERE id = ?').run(bio || null, id);
}

// Gateway proxy functions
export function getGatewayProxy(proxyId) {
  return db.prepare(
    'SELECT id, name, gateway_proxy_enabled, gateway_proxy_id, gateway_proxy_url FROM api_keys WHERE gateway_proxy_id = ?'
  ).get(proxyId);
}

export function updateGatewayProxy(id, enabled, proxyUrl) {
  const agent = db.prepare('SELECT gateway_proxy_id FROM api_keys WHERE id = ?').get(id);
  const proxyId = agent?.gateway_proxy_id || nanoid(32);
  return db.prepare(
    'UPDATE api_keys SET gateway_proxy_enabled = ?, gateway_proxy_id = ?, gateway_proxy_url = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, proxyId, proxyUrl || null, id);
}

export function regenerateProxyId(id) {
  const proxyId = nanoid(32);
  db.prepare('UPDATE api_keys SET gateway_proxy_id = ? WHERE id = ?').run(proxyId, id);
  return proxyId;
}

export function disableGatewayProxy(id) {
  return db.prepare(
    'UPDATE api_keys SET gateway_proxy_enabled = 0 WHERE id = ?'
  ).run(id);
}

// ============================================
// Channel WebSocket Proxy (filtered gateway access)
// ============================================

export function getChannel(channelId) {
  return db.prepare(
    'SELECT id, name, channel_enabled, channel_id, channel_key_hash, gateway_proxy_url FROM api_keys WHERE channel_id = ?'
  ).get(channelId);
}

export function getChannelByAgentId(agentId) {
  return db.prepare(
    'SELECT id, name, channel_enabled, channel_id, channel_key_hash, gateway_proxy_url FROM api_keys WHERE id = ?'
  ).get(agentId);
}

export async function updateChannel(id, enabled, channelKey) {
  const channelId = enabled ? nanoid(32) : null;
  const keyHash = channelKey ? await bcrypt.hash(channelKey, 10) : null;
  db.prepare(
    'UPDATE api_keys SET channel_enabled = ?, channel_id = ?, channel_key_hash = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, channelId, keyHash, id);
  return { channelId, keyHash };
}

export function disableChannel(id) {
  db.prepare(
    'UPDATE api_keys SET channel_enabled = 0 WHERE id = ?'
  ).run(id);
}

export function markChannelConnected(id) {
  db.prepare(
    'UPDATE api_keys SET channel_last_connected = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(id);
}

export function listChannels() {
  return db.prepare(
    'SELECT id, name, channel_enabled, channel_id, channel_last_connected FROM api_keys WHERE channel_id IS NOT NULL'
  ).all();
}


export function listGatewayProxies() {
  return db.prepare(
    'SELECT id, name, gateway_proxy_enabled, gateway_proxy_id, gateway_proxy_url FROM api_keys WHERE gateway_proxy_id IS NOT NULL'
  ).all();
}


export async function validateApiKey(key) {
  // Must check all keys since we can't look up by hash directly
  const allKeys = db.prepare('SELECT * FROM api_keys').all();
  for (const row of allKeys) {
    const match = await bcrypt.compare(key, row.key_hash);
    if (match) {
      return { id: row.id, name: row.name, webhookUrl: row.webhook_url, webhookToken: row.webhook_token, enabled: row.enabled !== 0, raw_results: !!row.raw_results };
    }
  }
  return null;
}

// Service Accounts
export function setAccountCredentials(service, name, credentials) {
  const json = JSON.stringify(credentials);
  db.prepare(`
    INSERT INTO service_accounts (service, name, credentials)
    VALUES (?, ?, ?)
    ON CONFLICT(service, name) DO UPDATE SET
      credentials = excluded.credentials,
      updated_at = CURRENT_TIMESTAMP
  `).run(service, name, json);
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

export function getAccountById(id) {
  const row = db.prepare('SELECT id, service, name, credentials, created_at, updated_at FROM service_accounts WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    service: row.service,
    name: row.name,
    credentials: row.credentials ? JSON.parse(row.credentials) : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// Get all accounts grouped by service (for /api/agent_start_here)
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
  const result = db.prepare(`
    INSERT INTO write_queue (service, account_name, requests, comment, submitted_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(service, accountName, JSON.stringify(requests), comment || null, submittedBy);
  return { id: Number(result.lastInsertRowid), status: 'pending' };
}

export function markAutoApproved(id) {
  db.prepare('UPDATE write_queue SET auto_approved = 1 WHERE id = ?').run(id);
}

export function getQueueEntry(id) {
  const row = db.prepare('SELECT * FROM write_queue WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    requests: JSON.parse(row.requests),
    results: row.results ? JSON.parse(row.results) : null,
    notified: Boolean(row.notified),
    auto_approved: Boolean(row.auto_approved)
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
    notified: Boolean(row.notified),
    auto_approved: Boolean(row.auto_approved)
  }));
}

export function listAutoApprovedEntries() {
  const rows = db.prepare('SELECT * FROM write_queue WHERE auto_approved = 1 ORDER BY submitted_at DESC').all();
  return rows.map(row => ({
    ...row,
    requests: JSON.parse(row.requests),
    results: row.results ? JSON.parse(row.results) : null,
    notified: Boolean(row.notified),
    auto_approved: true
  }));
}

export function getAutoApprovedCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM write_queue WHERE auto_approved = 1').get();
  return row.count;
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
    notified: false,
    auto_approved: Boolean(row.auto_approved)
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
  if (extra.reaction_emoji !== undefined) {
    updates.push('reaction_emoji = ?');
    values.push(extra.reaction_emoji || null);
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

export function createAgentMessage(fromAgent, toAgent, message, { replyToId = null } = {}) {
  const mode = getMessagingMode();

  if (mode === 'off') {
    throw new Error('Agent messaging is disabled');
  }

  // In open mode, messages are delivered immediately
  const status = mode === 'open' ? 'delivered' : 'pending';
  const deliveredAt = mode === 'open' ? new Date().toISOString() : null;

  const result = db.prepare(`
    INSERT INTO agent_messages (from_agent, to_agent, message, status, delivered_at, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(fromAgent, toAgent, message, status, deliveredAt, replyToId);

  return { id: Number(result.lastInsertRowid), status, isReply: !!replyToId };
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

// ============================================
// Queue Warnings (Peer Review)
// ============================================

export function addQueueWarning(queueId, agentId, message) {
  const result = db.prepare(`
    INSERT INTO queue_warnings (queue_id, agent_id, message)
    VALUES (?, ?, ?)
  `).run(queueId, agentId, message);
  return result.lastInsertRowid;
}

export function getQueueWarnings(queueId) {
  return db.prepare(`
    SELECT * FROM queue_warnings
    WHERE queue_id = ?
    ORDER BY created_at ASC
  `).all(queueId);
}

export function getQueueWarningCount(queueId) {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM queue_warnings WHERE queue_id = ?
  `).get(queueId);
  return row?.count || 0;
}

export function deleteQueueWarnings(queueId) {
  return db.prepare('DELETE FROM queue_warnings WHERE queue_id = ?').run(queueId);
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

// Webhook Configuration Management
// =================================

function parseWebhookConfig(row) {
  if (!row) return null;
  return {
    ...row,
    events: row.events ? JSON.parse(row.events) : [],
    enabled: row.enabled === 1,
    assignedAgents: row.assigned_agents ? JSON.parse(row.assigned_agents) : null,
    ipAllowlist: row.ip_allowlist ? JSON.parse(row.ip_allowlist) : null,
    maxPayloadSize: row.max_payload_size || 1048576
  };
}

export function listWebhookConfigs() {
  const rows = db.prepare('SELECT * FROM webhook_configs ORDER BY created_at DESC').all();
  return rows.map(parseWebhookConfig);
}

export function getWebhookConfig(id) {
  const row = db.prepare('SELECT * FROM webhook_configs WHERE id = ?').get(id);
  return parseWebhookConfig(row);
}

export function getWebhookConfigBySource(source) {
  const row = db.prepare('SELECT * FROM webhook_configs WHERE source = ? AND enabled = 1').get(source);
  return parseWebhookConfig(row);
}

export function createWebhookConfig({ source, name, secret, events, enabled, assignedAgents, ipAllowlist, maxPayloadSize }) {
  const id = nanoid();
  const eventsJson = JSON.stringify(events || []);
  const agentsJson = assignedAgents ? JSON.stringify(assignedAgents) : null;
  const ipJson = ipAllowlist ? JSON.stringify(ipAllowlist) : null;
  db.prepare(`
    INSERT INTO webhook_configs (id, source, name, secret, events, enabled, assigned_agents, ip_allowlist, max_payload_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, source, name, secret || null, eventsJson, enabled ? 1 : 0, agentsJson, ipJson, maxPayloadSize || 1048576);
  return { id, source, name, secret, events: events || [], enabled: !!enabled, assignedAgents: assignedAgents || null, ipAllowlist: ipAllowlist || null, maxPayloadSize: maxPayloadSize || 1048576 };
}

export function updateWebhookConfig(id, updates) {
  const fields = [];
  const values = [];
  
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.secret !== undefined) {
    fields.push('secret = ?');
    values.push(updates.secret);
  }
  if (updates.events !== undefined) {
    fields.push('events = ?');
    values.push(JSON.stringify(updates.events));
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.assignedAgents !== undefined) {
    fields.push('assigned_agents = ?');
    values.push(updates.assignedAgents ? JSON.stringify(updates.assignedAgents) : null);
  }
  if (updates.ipAllowlist !== undefined) {
    fields.push('ip_allowlist = ?');
    values.push(updates.ipAllowlist ? JSON.stringify(updates.ipAllowlist) : null);
  }
  if (updates.maxPayloadSize !== undefined) {
    fields.push('max_payload_size = ?');
    values.push(updates.maxPayloadSize);
  }
  
  if (fields.length === 0) return;
  
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  
  db.prepare(`UPDATE webhook_configs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteWebhookConfig(id) {
  db.prepare('DELETE FROM webhook_configs WHERE id = ?').run(id);
}

// Webhook Delivery Logging
// ========================

export function logWebhookDelivery({ configId, source, eventType, deliveryId, repo, payload, success, broadcastResult }) {
  const id = nanoid();
  db.prepare(`
    INSERT INTO webhook_deliveries (id, config_id, source, event_type, delivery_id, repo, payload, success, broadcast_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    configId || null,
    source,
    eventType,
    deliveryId || null,
    repo || null,
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    success ? 1 : 0,
    typeof broadcastResult === 'string' ? broadcastResult : JSON.stringify(broadcastResult)
  );
  return id;
}

export function listWebhookDeliveries(limit = 50, configId = null) {
  let query = 'SELECT * FROM webhook_deliveries';
  const params = [];
  
  if (configId) {
    query += ' WHERE config_id = ?';
    params.push(configId);
  }
  
  query += ' ORDER BY received_at DESC LIMIT ?';
  params.push(limit);
  
  return db.prepare(query).all(...params).map(row => ({
    ...row,
    success: row.success === 1
  }));
}

export function getWebhookDelivery(id) {
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    success: row.success === 1
  };
}

export function clearWebhookDeliveries(configId = null) {
  if (configId) {
    db.prepare('DELETE FROM webhook_deliveries WHERE config_id = ?').run(configId);
  } else {
    db.prepare('DELETE FROM webhook_deliveries').run();
  }
}

/**
 * Check if a delivery ID has already been processed (replay protection)
 * Returns true if this is a duplicate delivery
 */
export function isWebhookDeliveryDuplicate(source, deliveryId) {
  if (!deliveryId) return false;
  const existing = db.prepare('SELECT id FROM webhook_deliveries WHERE source = ? AND delivery_id = ?').get(source, deliveryId);
  return !!existing;
}

/**
 * Prune old webhook deliveries (log TTL)
 * @param {number} maxAgeDays - Delete deliveries older than this many days (default 30)
 * @returns {number} Number of deleted records
 */
export function pruneWebhookDeliveries(maxAgeDays = 30) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?').run(cutoff);
  return result.changes;
}

/**
 * Get webhook delivery log TTL setting (in days)
 */
export function getWebhookLogTTL() {
  const setting = getSetting('webhook_log_ttl_days');
  return setting ? parseInt(setting, 10) : 30; // Default 30 days
}

/**
 * Set webhook delivery log TTL (in days)
 */
export function setWebhookLogTTL(days) {
  setSetting('webhook_log_ttl_days', String(days));
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
    conditions.push('LOWER(m.agent_id) = LOWER(?)');
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

// ============================================
// Service Access Control
// ============================================

// Get access config for a service/account
export function getServiceAccess(service, accountName) {
  const row = db.prepare(`
    SELECT access_mode, updated_at FROM service_access
    WHERE service = ? AND account_name = ?
  `).get(service, accountName);

  const agents = db.prepare(`
    SELECT agent_name, allowed, bypass_auth FROM service_agent_access
    WHERE service = ? AND account_name = ?
  `).all(service, accountName);

  return {
    service,
    account_name: accountName,
    access_mode: row?.access_mode || 'all',
    updated_at: row?.updated_at || null,
    agents: agents.map(a => ({ name: a.agent_name, allowed: !!a.allowed, bypass_auth: !!a.bypass_auth }))
  };
}

// Set access mode for a service/account
export function setServiceAccessMode(service, accountName, mode) {
  if (!['all', 'allowlist', 'denylist'].includes(mode)) {
    throw new Error('Invalid access mode. Must be: all, allowlist, or denylist');
  }
  db.prepare(`
    INSERT INTO service_access (service, account_name, access_mode, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(service, account_name) DO UPDATE SET
      access_mode = excluded.access_mode,
      updated_at = CURRENT_TIMESTAMP
  `).run(service, accountName, mode);
}

// Add or update agent access for a service/account
export function setServiceAgentAccess(service, accountName, agentName, allowed, bypassAuth = false) {
  db.prepare(`
    INSERT INTO service_agent_access (service, account_name, agent_name, allowed, bypass_auth)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(service, account_name, agent_name) DO UPDATE SET
      allowed = excluded.allowed,
      bypass_auth = excluded.bypass_auth
  `).run(service, accountName, agentName, allowed ? 1 : 0, bypassAuth ? 1 : 0);
}

// Remove agent from service access list
export function removeServiceAgentAccess(service, accountName, agentName) {
  return db.prepare(`
    DELETE FROM service_agent_access
    WHERE service = ? AND account_name = ? AND agent_name = ?
  `).run(service, accountName, agentName);
}

// Bulk set agents for a service/account (replaces existing list)
export function setServiceAgents(service, accountName, agents) {
  const deleteStmt = db.prepare(`
    DELETE FROM service_agent_access WHERE service = ? AND account_name = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO service_agent_access (service, account_name, agent_name, allowed, bypass_auth)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    deleteStmt.run(service, accountName);
    for (const agent of agents) {
      insertStmt.run(service, accountName, agent.name, agent.allowed ? 1 : 0, agent.bypass_auth ? 1 : 0);
    }
  })();
}

// Check if an agent has access to a service/account
export function checkServiceAccess(service, accountName, agentName) {
  const access = getServiceAccess(service, accountName);

  // Find agent in the list
  const agentEntry = access.agents.find(
    a => a.name.toLowerCase() === agentName.toLowerCase()
  );

  // Default mode: all agents have access UNLESS explicitly denied
  if (access.access_mode === 'all') {
    if (agentEntry && !agentEntry.allowed) {
      return { allowed: false, reason: 'explicitly_denied' };
    }
    return { allowed: true, reason: 'all' };
  }

  if (access.access_mode === 'allowlist') {
    // Only listed agents (with allowed=true) can access
    if (agentEntry && agentEntry.allowed) {
      return { allowed: true, reason: 'allowlist' };
    }
    return { allowed: false, reason: 'not_in_allowlist' };
  }

  if (access.access_mode === 'denylist') {
    // All agents EXCEPT those in list (with allowed=false) can access
    if (agentEntry && !agentEntry.allowed) {
      return { allowed: false, reason: 'in_denylist' };
    }
    return { allowed: true, reason: 'not_in_denylist' };
  }

  // Fallback (shouldn't happen)
  return { allowed: true, reason: 'default' };
}

// Check if an agent has bypass_auth enabled for a service/account
export function checkBypassAuth(service, accountName, agentName) {
  const row = db.prepare(`
    SELECT bypass_auth FROM service_agent_access
    WHERE service = ? AND account_name = ? AND LOWER(agent_name) = LOWER(?)
  `).get(service, accountName, agentName);
  
  return row?.bypass_auth === 1;
}

// Set bypass_auth for an agent on a service/account
export function setBypassAuth(service, accountName, agentName, enabled) {
  // First check if the agent entry exists
  const existing = db.prepare(`
    SELECT 1 FROM service_agent_access
    WHERE service = ? AND account_name = ? AND LOWER(agent_name) = LOWER(?)
  `).get(service, accountName, agentName);
  
  if (existing) {
    // Update existing entry
    db.prepare(`
      UPDATE service_agent_access
      SET bypass_auth = ?
      WHERE service = ? AND account_name = ? AND LOWER(agent_name) = LOWER(?)
    `).run(enabled ? 1 : 0, service, accountName, agentName);
  } else {
    // Create new entry with default allowed=true
    db.prepare(`
      INSERT INTO service_agent_access (service, account_name, agent_name, allowed, bypass_auth)
      VALUES (?, ?, ?, 1, ?)
    `).run(service, accountName, agentName, enabled ? 1 : 0);
  }
}

// Get all services with their access config (for admin UI)
export function listServicesWithAccess() {
  // Get all configured service accounts
  const accounts = db.prepare(`
    SELECT DISTINCT service, name as account_name FROM service_accounts ORDER BY service, name
  `).all();

  // Get all access configs
  const accessConfigs = db.prepare(`
    SELECT service, account_name, access_mode FROM service_access
  `).all();

  // Get agent counts per service/account
  const agentCounts = db.prepare(`
    SELECT service, account_name, COUNT(*) as count
    FROM service_agent_access
    GROUP BY service, account_name
  `).all();

  const accessMap = new Map();
  for (const cfg of accessConfigs) {
    accessMap.set(`${cfg.service}:${cfg.account_name}`, cfg.access_mode);
  }

  const countMap = new Map();
  for (const cnt of agentCounts) {
    countMap.set(`${cnt.service}:${cnt.account_name}`, cnt.count);
  }

  return accounts.map(acc => {
    const key = `${acc.service}:${acc.account_name}`;
    const mode = accessMap.get(key) || 'all';
    const agentCount = countMap.get(key) || 0;
    return {
      service: acc.service,
      account_name: acc.account_name,
      access_mode: mode,
      agent_count: agentCount
    };
  });
}

/**
 * Get all service accounts that an agent has access to
 * Returns array of { id, service, account_name, bypass_auth }
 * Optimized: fetches all data in 3 queries instead of N+1
 */
export function getAgentServiceAccess(agentName) {
  // Get all service accounts
  const accounts = db.prepare(`
    SELECT id, service, name as account_name FROM service_accounts ORDER BY service, name
  `).all();

  // Get all access modes in one query
  const accessModes = db.prepare(`
    SELECT service, account_name, access_mode FROM service_access
  `).all();
  const modeMap = new Map();
  for (const row of accessModes) {
    modeMap.set(`${row.service}:${row.account_name}`, row.access_mode);
  }

  // Get all agent access entries for this agent in one query (case-insensitive)
  const agentEntries = db.prepare(`
    SELECT service, account_name, allowed, bypass_auth FROM service_agent_access
    WHERE LOWER(agent_name) = LOWER(?)
  `).all(agentName);
  const agentMap = new Map();
  for (const row of agentEntries) {
    agentMap.set(`${row.service}:${row.account_name}`, row);
  }

  // Process in memory
  const result = [];
  for (const acc of accounts) {
    const key = `${acc.service}:${acc.account_name}`;
    const accessMode = modeMap.get(key) || 'all';
    const agentEntry = agentMap.get(key);

    // Check access based on mode
    let allowed = false;
    if (accessMode === 'all') {
      // All allowed unless explicitly denied
      allowed = !agentEntry || agentEntry.allowed !== 0;
    } else if (accessMode === 'allowlist') {
      // Only allowed if explicitly in list with allowed=true
      allowed = agentEntry && agentEntry.allowed === 1;
    } else if (accessMode === 'denylist') {
      // Allowed unless explicitly in list with allowed=false
      allowed = !agentEntry || agentEntry.allowed !== 0;
    } else if (accessMode === 'none') {
      allowed = false;
    }

    if (allowed) {
      result.push({
        id: acc.id,
        service: acc.service,
        account_name: acc.account_name,
        bypass_auth: agentEntry?.bypass_auth === 1
      });
    }
  }
  return result;
}


// ============================================
// Broadcast History
// ============================================

export function createBroadcast(fromAgent, message, recipientCount) {
  const result = db.prepare(`
    INSERT INTO broadcasts (from_agent, message, total_recipients)
    VALUES (?, ?, ?)
  `).run(fromAgent, message, recipientCount);
  return Number(result.lastInsertRowid);
}

export function addBroadcastRecipient(broadcastId, toAgent, status, errorMessage = null) {
  db.prepare(`
    INSERT INTO broadcast_recipients (broadcast_id, to_agent, status, delivered_at, error_message)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    broadcastId,
    toAgent,
    status,
    status === 'delivered' ? new Date().toISOString() : null,
    errorMessage
  );
  
  // Update counts
  if (status === 'delivered') {
    db.prepare('UPDATE broadcasts SET delivered_count = delivered_count + 1 WHERE id = ?').run(broadcastId);
  } else if (status === 'failed') {
    db.prepare('UPDATE broadcasts SET failed_count = failed_count + 1 WHERE id = ?').run(broadcastId);
  }
}

export function getBroadcast(id) {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return null;
  
  const recipients = db.prepare(`
    SELECT to_agent, status, delivered_at, error_message
    FROM broadcast_recipients
    WHERE broadcast_id = ?
  `).all(id);
  
  return { ...broadcast, recipients };
}

export function listBroadcasts(limit = 50) {
  return db.prepare(`
    SELECT * FROM broadcasts
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

export function listBroadcastsWithRecipients(limit = 50) {
  const broadcasts = listBroadcasts(limit);
  return broadcasts.map(b => {
    const recipients = db.prepare(`
      SELECT to_agent, status, delivered_at, error_message
      FROM broadcast_recipients
      WHERE broadcast_id = ?
    `).all(b.id);
    return { ...b, recipients };
  });
}

export function deleteBroadcast(id) {
  // Delete recipients first (foreign key constraint)
  db.prepare('DELETE FROM broadcast_recipients WHERE broadcast_id = ?').run(id);
  return db.prepare('DELETE FROM broadcasts WHERE id = ?').run(id);
}

export function clearBroadcasts() {
  db.prepare('DELETE FROM broadcast_recipients').run();
  return db.prepare('DELETE FROM broadcasts').run();
}

// ============================================
// LLM Providers
// ============================================

export function createLlmProvider(name, providerType, apiKey, baseUrl = null) {
  const result = db.prepare(`
    INSERT INTO llm_providers (name, provider_type, api_key, base_url)
    VALUES (?, ?, ?, ?)
  `).run(name, providerType, apiKey, baseUrl || null);
  return { id: Number(result.lastInsertRowid), name, provider_type: providerType };
}

export function getLlmProvider(id) {
  return db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id);
}

export function getLlmProviderByName(name) {
  return db.prepare('SELECT * FROM llm_providers WHERE name = ?').get(name);
}

export function listLlmProviders() {
  return db.prepare('SELECT id, name, provider_type, base_url, enabled, created_at, updated_at FROM llm_providers ORDER BY name').all();
}

export function updateLlmProvider(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    if (['name', 'provider_type', 'api_key', 'base_url', 'enabled'].includes(key)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return;
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  db.prepare(`UPDATE llm_providers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteLlmProvider(id) {
  return db.prepare('DELETE FROM llm_providers WHERE id = ?').run(id);
}

// ============================================
// LLM Agent Model Assignments
// ============================================

// Get the default LLM config for an agent
export function getAgentLlmConfig(agentName) {
  // First try agent-specific default
  const agentConfig = db.prepare(`
    SELECT lam.*, lp.name as provider_name, lp.provider_type, lp.api_key, lp.base_url, lp.enabled
    FROM llm_agent_models lam
    JOIN llm_providers lp ON lam.provider_id = lp.id
    WHERE LOWER(lam.agent_name) = LOWER(?) AND lam.is_default = 1
  `).get(agentName);
  if (agentConfig) return agentConfig;

  // Fallback: check for a wildcard default ('*')
  const wildcard = db.prepare(`
    SELECT lam.*, lp.name as provider_name, lp.provider_type, lp.api_key, lp.base_url, lp.enabled
    FROM llm_agent_models lam
    JOIN llm_providers lp ON lam.provider_id = lp.id
    WHERE lam.agent_name = '*' AND lam.is_default = 1
  `).get();
  return wildcard || null;
}

// List all models available to an agent
export function listAgentModels(agentName) {
  // Agent-specific models + wildcard models
  return db.prepare(`
    SELECT lam.model_id, lam.is_default, lp.name as provider_name, lp.provider_type, lp.id as provider_id
    FROM llm_agent_models lam
    JOIN llm_providers lp ON lam.provider_id = lp.id
    WHERE (LOWER(lam.agent_name) = LOWER(?) OR lam.agent_name = '*') AND lp.enabled = 1
    ORDER BY lam.is_default DESC, lam.model_id
  `).all(agentName);
}

// Assign a model to an agent
export function setAgentLlmModel(agentName, providerId, modelId, isDefault = false) {
  // If setting as default, clear other defaults for this agent
  if (isDefault) {
    db.prepare('UPDATE llm_agent_models SET is_default = 0 WHERE LOWER(agent_name) = LOWER(?)').run(agentName);
  }
  db.prepare(`
    INSERT INTO llm_agent_models (agent_name, provider_id, model_id, is_default)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_name, provider_id, model_id) DO UPDATE SET
      is_default = excluded.is_default
  `).run(agentName, providerId, modelId, isDefault ? 1 : 0);
}

// Remove a model assignment
export function removeAgentLlmModel(agentName, providerId, modelId) {
  return db.prepare('DELETE FROM llm_agent_models WHERE LOWER(agent_name) = LOWER(?) AND provider_id = ? AND model_id = ?')
    .run(agentName, providerId, modelId);
}

// List all agent model assignments (for admin)
export function listAllAgentLlmModels() {
  return db.prepare(`
    SELECT lam.*, lp.name as provider_name, lp.provider_type
    FROM llm_agent_models lam
    JOIN llm_providers lp ON lam.provider_id = lp.id
    ORDER BY lam.agent_name, lam.model_id
  `).all();
}

