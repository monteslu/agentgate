// ==========================================
// Integration: Add MCP sessions to agent/keys detail page
// Modify src/routes/ui/keys.js
// For issue #219
// ==========================================

// Add to imports:
import { listMcpSessions, deleteMcpSession, deleteMcpSessionsForAgent } from '../../lib/db.js';
import { getActiveSessionsInfo, killSession, killAgentSessions } from '../mcp.js';

// ==========================================
// Add these routes to keys.js router
// ==========================================

// Get sessions for a specific agent
router.get('/:agentId/sessions', (req, res) => {
  const { agentId } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');
  
  // Get sessions from both memory and DB for this agent
  const memorySessions = getActiveSessionsInfo().filter(s => s.agent_id === agentId);
  const dbSessions = listMcpSessions(agentId);
  
  // Merge: memory takes precedence
  const memoryIds = new Set(memorySessions.map(s => s.session_id));
  const mergedSessions = [...memorySessions];
  
  for (const dbSession of dbSessions) {
    if (!memoryIds.has(dbSession.session_id)) {
      mergedSessions.push({
        ...dbSession,
        in_memory: false,
        recreated: false
      });
    }
  }
  
  // Sort by last_seen descending
  mergedSessions.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
  
  if (wantsJson) {
    return res.json({ agent: agentId, sessions: mergedSessions, count: mergedSessions.length });
  }
  
  // For non-JSON, redirect to agent detail page with sessions tab
  res.redirect(`/ui/keys/${encodeURIComponent(agentId)}#sessions`);
});

// Kill a specific session for an agent
router.post('/:agentId/sessions/:sessionId/kill', (req, res) => {
  const { agentId, sessionId } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');
  
  try {
    const result = killSession(sessionId);
    
    if (wantsJson) {
      return res.json(result);
    }
    res.redirect(`/ui/keys/${encodeURIComponent(agentId)}#sessions`);
  } catch (error) {
    if (wantsJson) {
      return res.status(500).json({ error: error.message });
    }
    res.redirect(`/ui/keys/${encodeURIComponent(agentId)}?error=${encodeURIComponent(error.message)}`);
  }
});

// Kill all sessions for an agent
router.post('/:agentId/sessions/kill-all', (req, res) => {
  const { agentId } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');
  
  try {
    const result = killAgentSessions(agentId);
    
    if (wantsJson) {
      return res.json(result);
    }
    res.redirect(`/ui/keys/${encodeURIComponent(agentId)}#sessions`);
  } catch (error) {
    if (wantsJson) {
      return res.status(500).json({ error: error.message });
    }
    res.redirect(`/ui/keys/${encodeURIComponent(agentId)}?error=${encodeURIComponent(error.message)}`);
  }
});

// ==========================================
// Add sessions section to agent detail page
// In the renderAgentDetailPage function, add this section:
// ==========================================

function renderSessionsSection(agentId, sessions) {
  if (sessions.length === 0) {
    return `
      <div class="card">
        <h3>MCP Sessions</h3>
        <p class="help">No active MCP sessions for this agent.</p>
      </div>
    `;
  }

  const sessionRows = sessions.map(session => {
    const isActive = session.in_memory;
    const statusClass = isActive ? 'active' : 'persisted';
    const statusText = isActive ? (session.recreated ? 'Recreated' : 'Active') : 'Persisted';
    
    return `
      <tr data-session-id="${escapeHtml(session.session_id)}">
        <td><code title="${escapeHtml(session.session_id)}">${escapeHtml(session.session_id.substring(0, 12))}...</code></td>
        <td><span class="session-status ${statusClass}">${statusText}</span></td>
        <td class="time-cell">${formatDate(session.last_seen)}</td>
        <td class="time-cell">${formatDate(session.created_at)}</td>
        <td>
          <button type="button" class="btn-sm btn-danger" 
            onclick="killAgentSession('${escapeHtml(agentId)}', '${escapeHtml(session.session_id)}')">
            Kill
          </button>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="card" id="sessions">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0;">MCP Sessions (${sessions.length})</h3>
        ${sessions.length > 1 ? `
          <button type="button" class="btn-sm btn-danger" 
            onclick="killAllAgentSessions('${escapeHtml(agentId)}')">
            Kill All
          </button>
        ` : ''}
      </div>
      
      <table class="sessions-table">
        <thead>
          <tr>
            <th>Session ID</th>
            <th>Status</th>
            <th>Last Seen</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${sessionRows}
        </tbody>
      </table>
    </div>
    
    <style>
      .sessions-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      .sessions-table th { text-align: left; padding: 10px 12px; background: rgba(0,0,0,0.2); color: var(--gray-400); font-size: 12px; text-transform: uppercase; }
      .sessions-table td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
      .session-status { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
      .session-status.active { background: rgba(34, 197, 94, 0.15); color: #34d399; }
      .session-status.persisted { background: rgba(156, 163, 175, 0.15); color: #9ca3af; }
    </style>
    
    <script>
      async function killAgentSession(agentId, sessionId) {
        if (!confirm('Kill this session?')) return;
        try {
          const res = await fetch('/ui/keys/' + encodeURIComponent(agentId) + '/sessions/' + encodeURIComponent(sessionId) + '/kill', {
            method: 'POST',
            headers: { 'Accept': 'application/json' }
          });
          const data = await res.json();
          if (data.success) {
            document.querySelector('[data-session-id="' + sessionId + '"]')?.remove();
            // Update count in header
            const header = document.querySelector('#sessions h3');
            if (header) {
              const remaining = document.querySelectorAll('#sessions tbody tr').length;
              header.textContent = 'MCP Sessions (' + remaining + ')';
            }
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      }
      
      async function killAllAgentSessions(agentId) {
        if (!confirm('Kill ALL sessions for ' + agentId + '?')) return;
        try {
          const res = await fetch('/ui/keys/' + encodeURIComponent(agentId) + '/sessions/kill-all', {
            method: 'POST',
            headers: { 'Accept': 'application/json' }
          });
          const data = await res.json();
          if (data.success) {
            location.reload();
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      }
    </script>
  `;
}

// ==========================================
// Modify the agent detail page route to include sessions
// In the GET /:agentId route handler:
// ==========================================

// Add this to fetch sessions for the agent:
const memorySessions = getActiveSessionsInfo().filter(s => s.agent_id === agentId);
const dbSessions = listMcpSessions(agentId);
const memoryIds = new Set(memorySessions.map(s => s.session_id));
const sessions = [...memorySessions];
for (const dbSession of dbSessions) {
  if (!memoryIds.has(dbSession.session_id)) {
    sessions.push({ ...dbSession, in_memory: false, recreated: false });
  }
}
sessions.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

// Then add to the page render:
// ${renderSessionsSection(agent.name, sessions)}
