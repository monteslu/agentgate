// ==========================================
// MCP Sessions persistence - additions to db.js
// For issue #219
// ==========================================

// Add to schema initialization (in db.exec block):
`
  -- MCP Sessions (persistent across restarts)
  CREATE TABLE IF NOT EXISTS mcp_sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_mcp_sessions_agent
  ON mcp_sessions(agent_id);

  CREATE INDEX IF NOT EXISTS idx_mcp_sessions_last_seen
  ON mcp_sessions(last_seen);
`

// ==========================================
// MCP Session CRUD functions
// ==========================================

// Create or update a session in the database
export function upsertMcpSession(sessionId, agentId) {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const stmt = db.prepare(`
    INSERT INTO mcp_sessions (session_id, agent_id, created_at, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_seen = excluded.last_seen
  `);
  return stmt.run(sessionId, agentId, now, now);
}

// Update last_seen timestamp for a session
export function touchMcpSession(sessionId) {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const stmt = db.prepare(`
    UPDATE mcp_sessions SET last_seen = ? WHERE session_id = ?
  `);
  return stmt.run(now, sessionId);
}

// Get a session by ID
export function getMcpSession(sessionId) {
  const stmt = db.prepare(`
    SELECT session_id, agent_id, created_at, last_seen
    FROM mcp_sessions WHERE session_id = ?
  `);
  return stmt.get(sessionId);
}

// List all sessions (optionally filtered by agent)
export function listMcpSessions(agentId = null) {
  if (agentId) {
    const stmt = db.prepare(`
      SELECT session_id, agent_id, created_at, last_seen
      FROM mcp_sessions WHERE agent_id = ?
      ORDER BY last_seen DESC
    `);
    return stmt.all(agentId);
  }
  const stmt = db.prepare(`
    SELECT session_id, agent_id, created_at, last_seen
    FROM mcp_sessions ORDER BY last_seen DESC
  `);
  return stmt.all();
}

// Delete a session
export function deleteMcpSession(sessionId) {
  const stmt = db.prepare(`DELETE FROM mcp_sessions WHERE session_id = ?`);
  return stmt.run(sessionId);
}

// Delete all sessions for an agent
export function deleteMcpSessionsForAgent(agentId) {
  const stmt = db.prepare(`DELETE FROM mcp_sessions WHERE agent_id = ?`);
  return stmt.run(agentId);
}

// Delete stale sessions (older than TTL)
export function deleteStaleMcpSessions(ttlMs) {
  const cutoff = new Date(Date.now() - ttlMs).toISOString().replace('T', ' ').replace('Z', '');
  const stmt = db.prepare(`DELETE FROM mcp_sessions WHERE last_seen < ?`);
  return stmt.run(cutoff);
}

// Get session counts grouped by agent
export function getMcpSessionCounts() {
  const stmt = db.prepare(`
    SELECT agent_id, COUNT(*) as count
    FROM mcp_sessions
    GROUP BY agent_id
    ORDER BY count DESC
  `);
  return stmt.all();
}

// Get total session count
export function getMcpSessionCount() {
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM mcp_sessions`);
  return stmt.get().count;
}
