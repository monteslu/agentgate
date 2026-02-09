# Memento Enhancements Plan

## Problem

Keyword-based retrieval requires agents to remember what keywords they used when saving. This is a chicken-and-egg problem - you need to know what you saved to find it.

## Solution: Full-Text Search

Add content search alongside existing keyword system. Keywords remain useful for explicit tagging; FTS adds "search the actual content" when you don't remember tags.

## Implementation

### 1. Create FTS5 Virtual Table

```sql
-- Mirror of mementos content for full-text search
CREATE VIRTUAL TABLE mementos_fts USING fts5(
  content,
  content='mementos',
  content_rowid='id'
);

-- Keep FTS in sync with mementos table
CREATE TRIGGER mementos_ai AFTER INSERT ON mementos BEGIN
  INSERT INTO mementos_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER mementos_ad AFTER DELETE ON mementos BEGIN
  INSERT INTO mementos_fts(mementos_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
```

### 2. Isolate Search Logic

Create `src/lib/mementoSearch.js`:

```javascript
// SQLite FTS5 implementation
// Swap this file for Postgres tsvector implementation later

export function searchMementoContent(agentName, query, options = {}) {
  const { limit = 10 } = options;

  return db.prepare(`
    SELECT m.id, m.agent_id, m.keywords, m.created_at,
           snippet(mementos_fts, 0, '<b>', '</b>', '...', 32) as snippet,
           bm25(mementos_fts) as rank
    FROM mementos_fts
    JOIN mementos m ON m.id = mementos_fts.rowid
    WHERE mementos_fts MATCH ?
      AND LOWER(m.agent_id) = LOWER(?)
    ORDER BY rank
    LIMIT ?
  `).all(query, agentName, limit);
}
```

### 3. Update Memento Service

In `src/services/mementoService.js`, add:

```javascript
import { searchMementoContent } from '../lib/mementoSearch.js';

export function searchMementosByContent(agentName, query, limit = 10) {
  if (!query || query.trim().length < 2) {
    throw new Error('Search query must be at least 2 characters');
  }
  return searchMementoContent(agentName, query.trim(), { limit });
}
```

### 4. Add MCP Action

Update `mementos` tool in `src/routes/mcp.js`:

```javascript
inputSchema: {
  action: z.enum(['save', 'search', 'search_content', 'keywords', 'recent', 'get_by_ids']),
  // ... existing fields
  query: z.string().optional().describe('Full-text search query (for search_content action)')
}

// In handler:
case 'search_content': {
  const results = searchMementosByContent(agentName, args.query, args.limit || 10);
  return toolResponse({ results });
}
```

### 5. Add REST Endpoint

In `src/routes/memento.js`:

```javascript
router.get('/search', (req, res) => {
  const { q, limit } = req.query;
  const results = searchMementosByContent(req.apiKeyName, q, limit);
  res.json({ results });
});
```

## API Changes

### MCP

```javascript
// Existing keyword search (unchanged)
mementos({ action: 'search', keywords: ['project', 'decision'] })

// New content search
mementos({ action: 'search_content', query: 'authentication flow' })
```

### REST

```
GET /api/agents/memento/search?q=authentication+flow&limit=10
```

## Future: Postgres Adapter

When Postgres support is needed:

1. Create `src/lib/adapters/postgres/mementoSearch.js`:

```javascript
export function searchMementoContent(agentName, query, options = {}) {
  const { limit = 10 } = options;

  return pool.query(`
    SELECT id, agent_id, keywords, created_at,
           ts_headline('english', content, plainto_tsquery($1)) as snippet,
           ts_rank(to_tsvector('english', content), plainto_tsquery($1)) as rank
    FROM mementos
    WHERE to_tsvector('english', content) @@ plainto_tsquery($1)
      AND LOWER(agent_id) = LOWER($2)
    ORDER BY rank DESC
    LIMIT $3
  `, [query, agentName, limit]);
}
```

2. Use environment/config to select adapter:

```javascript
// src/lib/mementoSearch.js
const adapter = process.env.DB_TYPE === 'postgres'
  ? await import('./adapters/postgres/mementoSearch.js')
  : await import('./adapters/sqlite/mementoSearch.js');

export const searchMementoContent = adapter.searchMementoContent;
```

## Migration

For existing mementos, rebuild FTS index:

```sql
INSERT INTO mementos_fts(mementos_fts) VALUES('rebuild');
```

## Not In Scope (Future Considerations)

- **Vector/semantic search** - Would require embedding model, more infrastructure
- **Auto-tagging** - Extract keywords automatically from content
- **Conversation auto-save** - Automatically save session summaries

These could layer on top of FTS later.
