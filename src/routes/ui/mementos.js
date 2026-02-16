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

    <h2 class="mb-16">🧠 Agent Mementos</h2>

    <!-- Stats Bar -->
    <div class="flex gap-16 mb-20 flex-wrap">
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
      <div class="ml-auto">
        <a href="/ui/mementos/export${agent || keyword ? `?agent=${encodeURIComponent(agent || '')}&keyword=${encodeURIComponent(keyword || '')}` : ''}" class="btn btn-secondary" class="inline-flex-center">
          📥 Export JSON
        </a>
      </div>
    </div>

    <!-- Filters -->
    <form method="GET" action="/ui/mementos" class="flex-center gap-12 mb-16 flex-wrap">
      <select name="agent" class="select-input">
        <option value="">All Agents</option>
        ${agents.map(a => `<option value="${escapeHtml(a)}" ${agent === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
      </select>
      <input type="text" name="keyword" placeholder="Filter by keyword..." value="${escapeHtml(keyword || '')}"
        class="select-input-wide" autocomplete="off">
      <button type="submit" class="btn btn-primary">Filter</button>
      ${agent || keyword ? '<a href="/ui/mementos" class="btn btn-secondary">Clear</a>' : ''}
    </form>

    <!-- Results -->
    <div class="card">
      ${mementos.length === 0 ? `
        <div class="text-center p-40 text-dim">
          <div class="emoji-display">🧠</div>
          <p>No mementos found${agent || keyword ? ' matching your filters' : ''}.</p>
          <p class="meta-line">Agents can store mementos via POST /api/agents/memento</p>
        </div>
      ` : `
        <table class="w-full">
          <thead>
            <tr>
              <th class="w-40">ID</th>
              <th class="w-120">Agent</th>
              <th class="w-150">Keywords</th>
              <th>Preview</th>
              <th class="w-140">Created</th>
              <th class="w-60"></th>
            </tr>
          </thead>
          <tbody>
            ${mementos.map(m => `
              <tr>
                <td class="font-mono text-dim">${m.id}</td>
                <td>
                  <div class="flex-center gap-8">
                    ${renderAvatar(m.agent_id, { size: 24 })}
                    <span class="text-sm">${escapeHtml(m.agent_id)}</span>
                  </div>
                </td>
                <td>
                  <div class="flex flex-wrap gap-4">
                    ${m.keywords.slice(0, 5).map(k => `<span class="tag">${escapeHtml(k)}</span>`).join('')}
                    ${m.keywords.length > 5 ? `<span class="tag" class="opacity-60">+${m.keywords.length - 5}</span>` : ''}
                  </div>
                </td>
                <td class="detail-mono">
                  ${escapeHtml(m.preview)}
                </td>
                <td class="text-xs">${formatDate(m.created_at)}</td>
                <td class="whitespace-nowrap">
                  <a href="/ui/mementos/${m.id}" class="btn btn-secondary" class="btn-xs">View</a>
                  <button onclick="deleteMemento(${m.id})" class="btn btn-danger" class="btn-xs ml-4">×</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <!-- Pagination -->
        <div class="flex-between mt-16" style="padding-top: 16px; border-top: 1px solid var(--border-strong);">
          <span class="text-dim text-sm">
            Showing ${parsedOffset + 1}-${parsedOffset + mementos.length} mementos
          </span>
          <div class="flex gap-8">
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

    <div class="flex-center gap-12 mb-16">
      <a href="/ui/mementos" class="btn btn-secondary">← Back</a>
      <h2 class="m-0" style="flex: 1;">Memento #${memento.id}</h2>
      <button onclick="deleteMemento(${memento.id})" class="btn btn-danger">Delete</button>
    </div>

    <div class="card" class="mb-16">
      <div class="stats-grid">
        <div>
          <div class="label-dim">Agent</div>
          <div class="flex-center gap-8">
            ${renderAvatar(memento.agent_id, { size: 28 })}
            <span>${escapeHtml(memento.agent_id)}</span>
          </div>
        </div>
        <div>
          <div class="label-dim">Created</div>
          <div>${formatDate(memento.created_at)}</div>
        </div>
        ${memento.model ? `
          <div>
            <div class="label-dim">Model</div>
            <div class="font-mono text-sm">${escapeHtml(memento.model)}</div>
          </div>
        ` : ''}
        ${memento.role ? `
          <div>
            <div class="label-dim">Role</div>
            <div>${escapeHtml(memento.role)}</div>
          </div>
        ` : ''}
      </div>

      <div class="mb-16">
        <div class="label-dim-8">Keywords</div>
        <div class="flex flex-wrap gap-6">
          ${memento.keywords.map(k => `
            <a href="/ui/mementos?keyword=${encodeURIComponent(k)}" class="tag" class="no-underline">${escapeHtml(k)}</a>
          `).join('')}
        </div>
      </div>

      <div>
        <div class="label-dim-8">Content</div>
        <pre class="output-block">${escapeHtml(memento.content)}</pre>
      </div>
    </div>
  </div>
  ${socketScript()}
  ${menuScript()}
  ${localizeScript()}
  
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
