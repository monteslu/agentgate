// ==========================================
// MCP route changes for session persistence
// For issue #219
// ==========================================

// Add imports at top:
import {
  upsertMcpSession,
  touchMcpSession,
  getMcpSession,
  deleteMcpSession,
  deleteStaleMcpSessions
} from '../lib/db.js';

// ==========================================
// Modified session cleanup - also cleans DB
// ==========================================

// Periodic cleanup of stale sessions (replace existing setInterval)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      console.log(`Cleaning up stale MCP session: ${sessionId}`);
      session.transport.close().catch(() => {});
      activeSessions.delete(sessionId);
      deleteMcpSession(sessionId); // Also remove from DB
    }
  }
  // Clean stale sessions from DB that might not be in memory
  deleteStaleMcpSessions(SESSION_TTL_MS);
}, 60 * 1000);

// ==========================================
// Helper: Recreate session from DB
// ==========================================

function recreateSession(sessionId, agentId) {
  console.log(`Recreating MCP session from DB: ${sessionId} for ${agentId}`);
  
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId, // Use existing session ID
    onsessioninitialized: () => {
      // Session already exists, just restore to memory
    }
  });

  transport.onclose = () => {
    activeSessions.delete(sessionId);
    deleteMcpSession(sessionId);
  };

  // Manually set the session ID since we're recreating
  transport._sessionId = sessionId;

  const server = createMCPServer(agentId);
  
  // Store in memory
  activeSessions.set(sessionId, { 
    transport, 
    server, 
    agentId, 
    lastSeen: Date.now(),
    recreated: true 
  });

  // Update DB timestamp
  touchMcpSession(sessionId);

  return { transport, server };
}

// ==========================================
// Modified POST handler with lazy recreation
// ==========================================

export function createMCPPostHandler() {
  return async (req, res) => {
    const agentId = req.apiKeyInfo?.name;
    if (!agentId) {
      return res.status(401).json({ error: 'API key authentication required' });
    }

    const sessionId = req.headers['mcp-session-id'];

    try {
      if (sessionId) {
        // Existing session — check memory first, then DB
        let session = activeSessions.get(sessionId);
        
        if (!session) {
          // Not in memory — check DB for lazy recreation
          const dbSession = getMcpSession(sessionId);
          
          if (dbSession) {
            // Verify agent ownership
            if (dbSession.agent_id !== agentId) {
              return res.status(403).json({ error: 'Session belongs to different agent' });
            }
            
            // Recreate the session
            const { transport, server } = recreateSession(sessionId, agentId);
            session = activeSessions.get(sessionId);
            
            // Need to connect server to transport
            await server.connect(transport);
          }
        }
        
        if (!session) {
          return res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session not found or expired' },
            id: null
          });
        }

        if (agentId !== session.agentId) {
          return res.status(403).json({ error: 'Session belongs to different agent' });
        }

        session.lastSeen = Date.now();
        touchMcpSession(sessionId); // Update DB timestamp
        await session.transport.handleRequest(req, res, req.body);
        
      } else if (isInitializeRequest(req.body)) {
        // New session initialization
        if (activeSessions.size >= MAX_SESSIONS) {
          console.warn(`MCP session limit reached (${MAX_SESSIONS}), rejecting new connection`);
          return res.status(503).json({ error: 'Too many active sessions' });
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            activeSessions.set(sid, { transport, server, agentId, lastSeen: Date.now() });
            upsertMcpSession(sid, agentId); // Persist to DB
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            activeSessions.delete(sid);
            deleteMcpSession(sid); // Remove from DB
          }
        };

        const server = createMCPServer(agentId);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null
        });
      }
    } catch (error) {
      console.error('[MCP] Error in POST handler:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  };
}

// ==========================================
// Modified DELETE handler
// ==========================================

export function createMCPDeleteHandler() {
  return async (req, res) => {
    const agentId = req.apiKeyInfo?.name;
    if (!agentId) {
      return res.status(401).json({ error: 'API key authentication required' });
    }

    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing MCP-Session-Id header' });
    }

    // Check memory first
    let session = activeSessions.get(sessionId);
    
    // If not in memory, check DB
    if (!session) {
      const dbSession = getMcpSession(sessionId);
      if (dbSession) {
        if (dbSession.agent_id !== agentId) {
          return res.status(403).json({ error: 'Session belongs to different agent' });
        }
        // Just delete from DB, no transport to close
        deleteMcpSession(sessionId);
        return res.json({ success: true, message: 'Session terminated' });
      }
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (agentId !== session.agentId) {
      return res.status(403).json({ error: 'Session belongs to different agent' });
    }

    try {
      await session.transport.handleRequest(req, res);
      // Transport.onclose will handle cleanup
    } catch (error) {
      console.error('[MCP] Error handling session termination:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error processing session termination' });
      }
    }
  };
}

// ==========================================
// Export active sessions info for admin UI
// ==========================================

export function getActiveSessionsInfo() {
  const sessions = [];
  for (const [sessionId, session] of activeSessions) {
    sessions.push({
      session_id: sessionId,
      agent_id: session.agentId,
      last_seen: new Date(session.lastSeen).toISOString(),
      in_memory: true,
      recreated: session.recreated || false
    });
  }
  return sessions;
}

export function killSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.transport.close().catch(() => {});
    activeSessions.delete(sessionId);
  }
  deleteMcpSession(sessionId);
  return { success: true };
}

export function killAgentSessions(agentId) {
  let count = 0;
  for (const [sessionId, session] of activeSessions) {
    if (session.agentId === agentId) {
      session.transport.close().catch(() => {});
      activeSessions.delete(sessionId);
      count++;
    }
  }
  const dbResult = deleteMcpSessionsForAgent(agentId);
  return { success: true, killed: count + (dbResult.changes || 0) };
}
