import { Router } from 'express';
import { listMementos, getMementoById, getApiKeys, getPendingQueueCount, getPendingMessagesCount, getConfig } from '../../lib/db.js';
import {
  htmlHead,
  simpleNavHeader,
  socketScript,
  localizeScript,
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
  const agents = getApiKeys().map(k => k.name).sort();

  // Get nav counts
  const pendingQueueCount = getPendingQueueCount();
  const config = getConfig();
  const pendingMessagesCount = config.messagingMode !== 'off' ? getPendingMessagesCount() : 0;

  const html = `${htmlHead('Mementos', { includeSocket: true })}
<body>
  <div class="container">
    ${simpleNavHeader({ pendingQueueCount, pendingMessagesCount, messagingMode: config.messagingMode })}

    <h2 style="margin-bottom: 16px;">🧠 Agent Mementos</h2>

    <!-- Filters -->
    <form method="GET" action="/ui/mementos" style="display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;">
      <select name="agent" style="padding: 8px 12px; background: #1e1e1e; border: 1px solid #333; border-radius: 4px; color: #e0e0e0;">
        <option value="">All Agents</option>
        ${agents.map(a => `<option value="${escapeHtml(a)}" ${agent === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
      </select>
      <input type="text" name="keyword" placeholder="Filter by keyword..." value="${escapeHtml(keyword || '')}"
        style="padding: 8px 12px; background: #1e1e1e; border: 1px solid #333; border-radius: 4px; color: #e0e0e0; width: 200px;">
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
                <td>
                  <a href="/ui/mementos/${m.id}" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;">View</a>
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
  ${localizeScript()}
  <style>
    .tag {
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
    }
  </style>
</body>
</html>`;

  res.send(html);
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
  const config = getConfig();
  const pendingMessagesCount = config.messagingMode !== 'off' ? getPendingMessagesCount() : 0;

  const html = `${htmlHead(`Memento #${memento.id}`, { includeSocket: true })}
<body>
  <div class="container">
    ${simpleNavHeader({ pendingQueueCount, pendingMessagesCount, messagingMode: config.messagingMode })}

    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
      <a href="/ui/mementos" class="btn btn-secondary">← Back</a>
      <h2 style="margin: 0;">Memento #${memento.id}</h2>
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
  </style>
</body>
</html>`;

  res.send(html);
});

export default router;
