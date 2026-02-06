import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { stemmer } from 'stemmer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDbPath = join(__dirname, 'test-memento.db');

// Helper to normalize keywords (matching db.js logic)
function normalizeKeyword(keyword) {
  const normalized = keyword.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  if (!normalized) return null;
  return stemmer(normalized);
}

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

describe('Memento Functions', () => {
  let db;

  beforeAll(() => {
    // Create test database with memento schema
    db = new Database(testDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS mementos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        model TEXT,
        role TEXT,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memento_keywords (
        memento_id INTEGER REFERENCES mementos(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        PRIMARY KEY (memento_id, keyword)
      );

      CREATE INDEX IF NOT EXISTS idx_memento_keyword ON memento_keywords(keyword);
      CREATE INDEX IF NOT EXISTS idx_memento_agent ON mementos(agent_id);
      CREATE INDEX IF NOT EXISTS idx_memento_created ON mementos(created_at);
    `);
  });

  afterAll(() => {
    db.close();
  });

  describe('Keyword Stemming', () => {
    it('should stem plural words', () => {
      expect(normalizeKeyword('games')).toBe(normalizeKeyword('game'));
      expect(normalizeKeyword('running')).toBe(normalizeKeyword('run'));
    });

    it('should normalize case and special characters', () => {
      expect(normalizeKeyword('Game-Project')).toBe(normalizeKeyword('game-project'));
      expect(normalizeKeyword('Hello World!')).toBe(normalizeKeyword('helloworld'));
    });

    it('should return null for empty keywords', () => {
      expect(normalizeKeyword('')).toBeNull();
      expect(normalizeKeyword('   ')).toBeNull();
      expect(normalizeKeyword('!!!')).toBeNull();
    });
  });

  describe('Memento Storage', () => {
    it('should store a memento with keywords', () => {
      const content = 'This is a test memento about game development.';
      const keywords = ['game', 'development', 'test'];
      const agentId = 'TestAgent';

      // Insert memento
      const result = db.prepare(`
        INSERT INTO mementos (agent_id, content)
        VALUES (?, ?)
      `).run(agentId, content);

      const mementoId = result.lastInsertRowid;

      // Insert keywords
      const insertKeyword = db.prepare(`
        INSERT OR IGNORE INTO memento_keywords (memento_id, keyword)
        VALUES (?, ?)
      `);

      for (const keyword of keywords) {
        insertKeyword.run(mementoId, normalizeKeyword(keyword));
      }

      // Verify memento
      const memento = db.prepare('SELECT * FROM mementos WHERE id = ?').get(mementoId);
      expect(memento.agent_id).toBe(agentId);
      expect(memento.content).toBe(content);

      // Verify keywords
      const storedKeywords = db.prepare('SELECT keyword FROM memento_keywords WHERE memento_id = ?')
        .all(mementoId)
        .map(r => r.keyword);
      expect(storedKeywords.length).toBe(3);
    });

    it('should store memento with model and role', () => {
      const result = db.prepare(`
        INSERT INTO mementos (agent_id, model, role, content)
        VALUES (?, ?, ?, ?)
      `).run('TestAgent', 'claude-3-opus', 'strategist', 'Important decision');

      const memento = db.prepare('SELECT * FROM mementos WHERE id = ?').get(result.lastInsertRowid);
      expect(memento.model).toBe('claude-3-opus');
      expect(memento.role).toBe('strategist');
    });
  });

  describe('Memento Search', () => {
    beforeAll(() => {
      // Create several mementos for search tests
      const mementos = [
        { agent: 'Agent1', content: 'Project planning meeting notes', keywords: ['project', 'planning', 'meeting'] },
        { agent: 'Agent1', content: 'Code review for snake game', keywords: ['code', 'review', 'snake', 'game'] },
        { agent: 'Agent1', content: 'Bug fix in game engine', keywords: ['bug', 'game', 'engine'] },
        { agent: 'Agent2', content: 'Different agent memento', keywords: ['different', 'agent'] }
      ];

      const insertMemento = db.prepare('INSERT INTO mementos (agent_id, content) VALUES (?, ?)');
      const insertKeyword = db.prepare('INSERT OR IGNORE INTO memento_keywords (memento_id, keyword) VALUES (?, ?)');

      for (const m of mementos) {
        const result = insertMemento.run(m.agent, m.content);
        for (const k of m.keywords) {
          insertKeyword.run(result.lastInsertRowid, normalizeKeyword(k));
        }
      }
    });

    it('should find mementos by keyword', () => {
      const keyword = normalizeKeyword('game');
      const results = db.prepare(`
        SELECT DISTINCT m.*
        FROM mementos m
        JOIN memento_keywords mk ON m.id = mk.memento_id
        WHERE m.agent_id = ? AND mk.keyword = ?
      `).all('Agent1', keyword);

      expect(results.length).toBe(2); // Both game-related mementos
    });

    it('should find mementos by multiple keywords (OR)', () => {
      const keywords = ['game', 'project'].map(k => normalizeKeyword(k));
      const placeholders = keywords.map(() => '?').join(', ');

      const results = db.prepare(`
        SELECT DISTINCT m.*, COUNT(DISTINCT mk.keyword) as match_count
        FROM mementos m
        JOIN memento_keywords mk ON m.id = mk.memento_id
        WHERE m.agent_id = ? AND mk.keyword IN (${placeholders})
        GROUP BY m.id
        ORDER BY match_count DESC
      `).all('Agent1', ...keywords);

      expect(results.length).toBe(3); // All Agent1 mementos except 'meeting' only
    });

    it('should only return mementos for the requesting agent', () => {
      const keyword = normalizeKeyword('agent');
      const results = db.prepare(`
        SELECT DISTINCT m.*
        FROM mementos m
        JOIN memento_keywords mk ON m.id = mk.memento_id
        WHERE m.agent_id = ? AND mk.keyword = ?
      `).all('Agent1', keyword);

      expect(results.length).toBe(0); // Agent1 has no 'agent' keyword
    });
  });

  describe('Memento Retrieval', () => {
    it('should get recent mementos for an agent', () => {
      const results = db.prepare(`
        SELECT id, agent_id, SUBSTR(content, 1, 50) as preview, created_at
        FROM mementos
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT 2
      `).all('Agent1');

      expect(results.length).toBe(2);
      expect(results[0].agent_id).toBe('Agent1');
    });

    it('should get all keywords for an agent', () => {
      const results = db.prepare(`
        SELECT DISTINCT mk.keyword
        FROM memento_keywords mk
        JOIN mementos m ON mk.memento_id = m.id
        WHERE m.agent_id = ?
        ORDER BY mk.keyword
      `).all('Agent1');

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Memento Deletion', () => {
    it('should cascade delete keywords when memento is deleted', () => {
      // Create a memento with keywords
      const result = db.prepare('INSERT INTO mementos (agent_id, content) VALUES (?, ?)').run('DeleteTest', 'To be deleted');
      const mementoId = result.lastInsertRowid;

      db.prepare('INSERT INTO memento_keywords (memento_id, keyword) VALUES (?, ?)').run(mementoId, 'deletetest');

      // Verify keyword exists
      let keyword = db.prepare('SELECT * FROM memento_keywords WHERE memento_id = ?').get(mementoId);
      expect(keyword).toBeTruthy();

      // Delete memento
      db.prepare('DELETE FROM mementos WHERE id = ?').run(mementoId);

      // Verify keyword was cascade deleted
      keyword = db.prepare('SELECT * FROM memento_keywords WHERE memento_id = ?').get(mementoId);
      expect(keyword).toBeUndefined();
    });
  });
});
