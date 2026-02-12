import { Router } from 'express';
import { listMementos, getMementoById, deleteMemento, getMementoCounts, listApiKeys, getPendingQueueCount, listPendingMessages, getMessagingMode } from '../../lib/db.js';
import {
  htmlHead,
  simpleNavHeader,
  socketScript,
  localizeScript,
  menuScript,
  escapeHtml,
  formatDate,
  renderAvatar
} from './shared.js';

const router = Router();

// GET /ui/mementos - Admin mementos list
router.get('/', (req, res) => {
  const { agent, keyword, limit = '50', offset = '0' } = req.query;
  const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);
  const parsedOffset = parseInt(offset, 10) || 0;

  const mementos = listMementos({
    agentId: agent || undefined,
    keyword: keyword || undefined,
    limit: parsedLimit,
    offset: parsedOffset
  });

  // Get all agents for filter dropdown
  const agents = listApiKeys().map(k => k.name).sort();
  
  // Get stats for dashboard
  const counts = getMementoCounts();

  // Get nav counts
  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = messagingMode !== 'off' ? listPendingMessages().length : 0;

  const html = `${htmlHead('Mementos', { includeSocket: true })}
<body>
  <div class="container">
    ${simpleNavHeader({ pendingQueueCount, pendingMessagesCount, messagingMode })}

    <h2 style="margin-bottom: 16px;">🧠 Agent Mementos</h2>

    <!-- Stats Bar -->
    <div style="display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap;">
      <div class="stat-card">
        <div class="stat-value">${counts.total || 0}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${counts.byAgent?.length || agents.length}</div>
        <div class="stat-label">Agents</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${counts.last24h || 0}</div>
        <div class="stat-label">Last 24h</div>
      </div>
      <div style="margin-left: auto;">
        <a href="/ui/mementos/export${agent || keyword ? `?agent=${encodeURIComponent(agent || '')}&keyword=${encodeURIComponent(keyword || '')}` : ''}" class="btn btn-secondary" style="display: inline-flex; align-items: center; gap: 6px;">
          📥 Export JSON
        </a>
      </div>
    </div>

    <!-- Filters -->
    <form method="GET" action="/ui/mementos" style="display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;">
      <select name="agent" style="padding: 8px 12px; background: #1e1e1e; border: 1px solid #333; border-radius: 4px; color: #e0e0e0;">
        <option value="">All Agents</option>
        ${agents.map(a => `<option value="${escapeHtml(a)}" ${agent === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
      </select>
      <input type="text" name="keyword" placeholder="Filter by keyword..." value="${escapeHtml(keyword || '')}"
        style="padding: 8px 12px; background: #1e1e1e; border: 1px solid #333; border-radius: 4px; color: #e0e0e0; width: 200px;" autocomplete="off">
      <button type="submit" class="btn btn-primary">Filter</button>
      ${agent || keyword ? '<a href="/ui/mementos" class="btn btn-secondary">Clear</a>' : ''}
    </form>

    <!-- Results -->
    <div class="card">
      ${mementos.length === 0 ? `
        <div style="text-align: center; padding: 40px; color: #6b7280;">
          <div style="font-size: 48px; margin-bottom: 16px;">🧠</div>
          <p>No mementos found${agent || keyword ? ' matching your filters' : ''}.</p>
          <p style="font-size: 12px; margin-top: 8px;">Agents can store mementos via POST /api/agents/memento</p>
        </div>
      ` : `
        <table style="width: 100%;">
          <thead>
            <tr>
              <th style="width: 40px;">ID</th>
              <th style="width: 120px;">Agent</th>
              <th style="width: 150px;">Keywords</th>
              <th>Preview</th>
              <th style="width: 140px;">Created</th>
              <th style="width: 60px;"></th>
            </tr>
          </thead>
          <tbody>
            ${mementos.map(m => `
              <tr>
                <td style="font-family: monospace; color: #6b7280;">${m.id}</td>
                <td>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    ${renderAvatar(m.agent_id, { size: 24 })}
                    <span style="font-size: 13px;">${escapeHtml(m.agent_id)}</span>
                  </div>
                </td>
                <td>
                  <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                    ${m.keywords.slice(0, 5).map(k => `<span class="tag">${escapeHtml(k)}</span>`).join('')}
                    ${m.keywords.length > 5 ? `<span class="tag" style="opacity: 0.6;">+${m.keywords.length - 5}</span>` : ''}
                  </div>
                </td>
                <td style="font-size: 13px; color: #9ca3af; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  ${escapeHtml(m.preview)}
                </td>
                <td style="font-size: 12px;">${formatDate(m.created_at)}</td>
                <td style="white-space: nowrap;">
                  <a href="/ui/mementos/${m.id}" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;">View</a>
                  <button onclick="deleteMemento(${m.id})" class="btn btn-danger" style="padding: 4px 8px; font-size: 12px; margin-left: 4px;">×</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <!-- Pagination -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding-top: 16px; border-top: 1px solid #333;">
          <span style="color: #6b7280; font-size: 13px;">
            Showing ${parsedOffset + 1}-${parsedOffset + mementos.length} mementos
          </span>
          <div style="display: flex; gap: 8px;">
            ${parsedOffset > 0 ? `
              <a href="/ui/mementos?${new URLSearchParams({ ...(agent && { agent }), ...(keyword && { keyword }), limit: parsedLimit, offset: Math.max(0, parsedOffset - parsedLimit) })}" class="btn btn-secondary">← Previous</a>
            ` : ''}
            ${mementos.length === parsedLimit ? `
              <a href="/ui/mementos?${new URLSearchParams({ ...(agent && { agent }), ...(keyword && { keyword }), limit: parsedLimit, offset: parsedOffset + parsedLimit })}" class="btn btn-secondary">Next →</a>
            ` : ''}
          </div>
        </div>
      `}
    </div>
  </div>
  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
  <style>
    .tag {
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
    }
    .stat-card {
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 8px;
      padding: 12px 20px;
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: #818cf8;
    }
    .stat-label {
      font-size: 11px;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.2);
    }
  </style>
  <script>
    async function deleteMemento(id) {
      if (!confirm('Delete this memento? This cannot be undone.')) return;
      try {
        const res = await fetch('/ui/mementos/' + id + '/delete', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// GET /ui/mementos/export - Export mementos as JSON
router.get('/export', (req, res) => {
  const { agent, keyword } = req.query;
  const mementos = listMementos({
    agentId: agent || undefined,
    keyword: keyword || undefined,
    limit: 10000
  });
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="mementos-export.json"');
  res.json(mementos);
});

// POST /ui/mementos/:id/delete - Delete a memento
router.post('/:id/delete', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');
  
  const memento = getMementoById(parseInt(id, 10));
  if (!memento) {
    return wantsJson
      ? res.status(404).json({ error: 'Memento not found' })
      : res.status(404).send('Memento not found');
  }
  
  deleteMemento(parseInt(id, 10));
  
  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/mementos');
});

// GET /ui/mementos/:id - View single memento
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const memento = getMementoById(parseInt(id, 10));

  if (!memento) {
    return res.status(404).send(`${htmlHead('Memento Not Found')}
<body>
  <div class="container">
    <h1>Memento Not Found</h1>
    <p>No memento with ID ${escapeHtml(id)} exists.</p>
    <a href="/ui/mementos" class="btn btn-primary">← Back to Mementos</a>
  </div>
</body>
</html>`);
  }

  // Get nav counts
  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = messagingMode !== 'off' ? listPendingMessages().length : 0;

  const html = `${htmlHead(`Memento #${memento.id}`, { includeSocket: true })}
<body>
  <div class="container">
    ${simpleNavHeader({ pendingQueueCount, pendingMessagesCount, messagingMode })}

    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
      <a href="/ui/mementos" class="btn btn-secondary">← Back</a>
      <h2 style="margin: 0; flex: 1;">Memento #${memento.id}</h2>
      <button onclick="deleteMemento(${memento.id})" class="btn btn-danger">Delete</button>
    </div>

    <div class="card" style="margin-bottom: 16px;">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 16px;">
        <div>
          <div style="color: #6b7280; font-size: 12px; margin-bottom: 4px;">Agent</div>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderAvatar(memento.agent_id, { size: 28 })}
            <span>${escapeHtml(memento.agent_id)}</span>
          </div>
        </div>
        <div>
          <div style="color: #6b7280; font-size: 12px; margin-bottom: 4px;">Created</div>
          <div>${formatDate(memento.created_at)}</div>
        </div>
        ${memento.model ? `
          <div>
            <div style="color: #6b7280; font-size: 12px; margin-bottom: 4px;">Model</div>
            <div style="font-family: monospace; font-size: 13px;">${escapeHtml(memento.model)}</div>
          </div>
        ` : ''}
        ${memento.role ? `
          <div>
            <div style="color: #6b7280; font-size: 12px; margin-bottom: 4px;">Role</div>
            <div>${escapeHtml(memento.role)}</div>
          </div>
        ` : ''}
      </div>

      <div style="margin-bottom: 16px;">
        <div style="color: #6b7280; font-size: 12px; margin-bottom: 8px;">Keywords</div>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
          ${memento.keywords.map(k => `
            <a href="/ui/mementos?keyword=${encodeURIComponent(k)}" class="tag" style="text-decoration: none;">${escapeHtml(k)}</a>
          `).join('')}
        </div>
      </div>

      <div>
        <div style="color: #6b7280; font-size: 12px; margin-bottom: 8px;">Content</div>
        <pre style="background: #0d0d0d; padding: 16px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; font-size: 13px; line-height: 1.5;">${escapeHtml(memento.content)}</pre>
      </div>
    </div>
  </div>
  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
  <style>
    .tag {
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
    }
    .tag:hover {
      background: rgba(99, 102, 241, 0.3);
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.2);
    }
  </style>
  <script>
    async function deleteMemento(id) {
      if (!confirm('Delete this memento? This cannot be undone.')) return;
      try {
        const res = await fetch('/ui/mementos/' + id + '/delete', {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
          window.location.href = '/ui/mementos';
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  </script>
</body>
</html>`;

  res.send(html);
});

export default router;
