import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDbPath = join(__dirname, 'test.db');

// Clean up test db before/after tests
beforeAll(() => {
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
});

afterAll(() => {
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
});

describe('Database Functions', () => {
  let db;

  beforeAll(() => {
    // Create test database with same schema
    db = new Database(testDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS service_access (
        service TEXT NOT NULL,
        account_name TEXT NOT NULL,
        access_mode TEXT NOT NULL DEFAULT 'all',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (service, account_name)
      );

      CREATE TABLE IF NOT EXISTS service_agent_access (
        service TEXT NOT NULL,
        account_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        allowed INTEGER NOT NULL DEFAULT 1,
        bypass_auth INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (service, account_name, agent_name)
      );
    `);
  });

  afterAll(() => {
    db.close();
  });

  describe('Settings', () => {
    it('should store and retrieve settings', () => {
      const value = { test: 'value', nested: { data: 123 } };
      db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `).run('test_setting', JSON.stringify(value));

      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('test_setting');
      expect(JSON.parse(row.value)).toEqual(value);
    });

    it('should update existing settings', () => {
      db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value
      `).run('test_setting', JSON.stringify({ updated: true }));

      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('test_setting');
      expect(JSON.parse(row.value)).toEqual({ updated: true });
    });
  });

  describe('Service Accounts', () => {
    it('should store service credentials', () => {
      const creds = { token: 'test_token', extra: 'data' };
      db.prepare(`
        INSERT INTO service_accounts (id, service, name, credentials)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(service, name) DO UPDATE SET
          credentials = excluded.credentials,
          updated_at = CURRENT_TIMESTAMP
      `).run('test_id', 'github', 'personal', JSON.stringify(creds));

      const row = db.prepare('SELECT credentials FROM service_accounts WHERE service = ? AND name = ?')
        .get('github', 'personal');
      expect(JSON.parse(row.credentials)).toEqual(creds);
    });

    it('should list accounts by service', () => {
      db.prepare(`
        INSERT INTO service_accounts (id, service, name, credentials)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(service, name) DO UPDATE SET credentials = excluded.credentials
      `).run('test_id2', 'github', 'work', JSON.stringify({ token: 'work_token' }));

      const rows = db.prepare('SELECT * FROM service_accounts WHERE service = ?').all('github');
      expect(rows.length).toBe(2);
    });
  });

  describe('Write Queue', () => {
    it('should create queue entries', () => {
      const requests = [{ method: 'POST', path: '/test', body: { data: 1 } }];
      db.prepare(`
        INSERT INTO write_queue (id, service, account_name, requests, comment, submitted_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('queue_1', 'github', 'personal', JSON.stringify(requests), 'Test comment', 'test_agent');

      const row = db.prepare('SELECT * FROM write_queue WHERE id = ?').get('queue_1');
      expect(row.status).toBe('pending');
      expect(row.comment).toBe('Test comment');
      expect(JSON.parse(row.requests)).toEqual(requests);
    });

    it('should update queue status', () => {
      db.prepare('UPDATE write_queue SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('approved', 'queue_1');

      const row = db.prepare('SELECT status, reviewed_at FROM write_queue WHERE id = ?').get('queue_1');
      expect(row.status).toBe('approved');
      expect(row.reviewed_at).toBeTruthy();
    });

    it('should count queue by status', () => {
      // Add more entries
      db.prepare(`
        INSERT INTO write_queue (id, service, account_name, requests, status, submitted_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('queue_2', 'github', 'personal', '[]', 'pending', 'agent1');

      db.prepare(`
        INSERT INTO write_queue (id, service, account_name, requests, status, submitted_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('queue_3', 'github', 'personal', '[]', 'completed', 'agent1');

      const rows = db.prepare('SELECT status, COUNT(*) as count FROM write_queue GROUP BY status').all();
      const counts = {};
      for (const row of rows) {
        counts[row.status] = row.count;
      }

      expect(counts.pending).toBe(1);
      expect(counts.approved).toBe(1);
      expect(counts.completed).toBe(1);
    });
  });

  describe('Service Access Control', () => {
    it('should deny explicitly disabled agent even in "all" mode', async () => {
      const { 
        checkServiceAccess, 
        setServiceAccessMode, 
        setServiceAgentAccess 
      } = await import('../src/lib/db.js');
      
      // Set up access_mode = 'all' (default)
      setServiceAccessMode('github', 'testaccount_deny', 'all');

      // Explicitly deny an agent
      setServiceAgentAccess('github', 'testaccount_deny', 'blocked_agent', false);
      
      const result = checkServiceAccess('github', 'testaccount_deny', 'blocked_agent');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('explicitly_denied');
    });

    it('should allow non-denied agents in "all" mode', async () => {
      const { 
        checkServiceAccess, 
        setServiceAccessMode 
      } = await import('../src/lib/db.js');
      
      setServiceAccessMode('github', 'testaccount_allow', 'all');
      
      const result = checkServiceAccess('github', 'testaccount_allow', 'allowed_agent');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('all');
    });
  });
});
