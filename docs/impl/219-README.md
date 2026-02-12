# Issue #219 Implementation: Persistent MCP Sessions

## Overview
This implementation adds persistent MCP sessions with admin UI management.

## Files Created/Modified

### 1. `src/lib/db.js` (additions)
See `db-additions.js` - adds:
- `mcp_sessions` table schema
- CRUD functions: `upsertMcpSession`, `touchMcpSession`, `getMcpSession`, `listMcpSessions`, `deleteMcpSession`, `deleteMcpSessionsForAgent`, `deleteStaleMcpSessions`
- Stats functions: `getMcpSessionCounts`, `getMcpSessionCount`

### 2. `src/routes/mcp.js` (modifications)
See `mcp-changes.js` - adds:
- Session persistence on creation
- `last_seen` updates on each request
- **Lazy session recreation** - when a request comes with a session ID that's in DB but not in memory, recreate the transport/server
- Session cleanup from both memory and DB
- Export functions for admin UI: `getActiveSessionsInfo`, `killSession`, `killAgentSessions`

### 3. `src/routes/ui/keys.js` (modifications)
See `keys-sessions-integration.js` - adds sessions to per-agent detail page:
- Sessions section on agent detail page (`/ui/keys/:agentName#sessions`)
- Routes: `GET /:agentName/sessions`, `POST /:agentName/sessions/:sessionId/kill`, `POST /:agentName/sessions/kill-all`
- Shows session ID, status (Active/Recreated/Persisted), timestamps
- Kill individual sessions or all for the agent

### 5. `tests/mcp-sessions.test.js` (new file)
See `mcp-sessions.test.js` - tests for:
- Session CRUD operations
- Filtering by agent
- Stale session cleanup
- Session counts

## How It Works

### Persistence Flow
1. On session init → `upsertMcpSession(sessionId, agentName)` 
2. On each request → `touchMcpSession(sessionId)` (updates `last_seen`)
3. On session close → `deleteMcpSession(sessionId)`

### Lazy Recreation Flow
1. Request comes in with `MCP-Session-Id` header
2. Check `activeSessions` Map (memory)
3. If not in memory, check `mcp_sessions` table (DB)
4. If in DB: recreate transport/server, add to memory, handle request
5. Client continues working without reconnecting

### Cleanup
- Every 60s: clean stale sessions from memory AND DB (older than SESSION_TTL_MS)

## UI Features
- `/ui/sessions` - Main sessions dashboard
- `/ui/sessions?agent=AgentName` - Filter by agent
- Kill buttons for individual sessions and per-agent batch kill
- Shows session status (Active/Recreated/Persisted)

## Testing
```bash
npm test -- tests/mcp-sessions.test.js
npm run lint
```
