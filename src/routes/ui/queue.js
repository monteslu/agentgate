// Queue routes - write queue management
import { Router } from 'express';
import {
  listQueueEntries, getQueueEntry, updateQueueStatus,
  clearQueueByStatus, deleteQueueEntry, getQueueCounts,
  getQueueWarnings
} from '../../lib/db.js';
import { executeQueueEntry } from '../../lib/queueExecutor.js';
import { notifyAgentQueueStatus } from '../../lib/agentNotifier.js';
import { emitCountUpdate, emitEvent } from '../../lib/socketManager.js';
import { escapeHtml, renderMarkdownLinks, statusBadge, formatDate, simpleNavHeader, socketScript, localizeScript, renderAvatar } from './shared.js';

const router = Router();

// Write Queue Management
router.get('/', (req, res) => {
  const filter = req.query.filter || 'all';
  let entries;
  if (filter === 'all') {
    entries = listQueueEntries();
  } else {
    entries = listQueueEntries(filter);
  }
  const counts = getQueueCounts();
  res.send(renderQueuePage(entries, filter, counts));
});

router.post('/:id/approve', async (req, res) => {
  const { id } = req.params;
  const entry = getQueueEntry(id);
  const wantsJson = req.headers.accept?.includes('application/json');

  if (!entry) {
    return wantsJson
      ? res.status(404).json({ error: 'Queue entry not found' })
      : res.status(404).send('Queue entry not found');
  }

  if (entry.status !== 'pending') {
    return wantsJson
      ? res.status(400).json({ error: 'Can only approve pending requests' })
      : res.status(400).send('Can only approve pending requests');
  }

  updateQueueStatus(id, 'approved');

  try {
    await executeQueueEntry(entry);
  } catch (err) {
    updateQueueStatus(id, 'failed', { results: [{ error: err.message }] });
  }

  const updated = getQueueEntry(id);
  const counts = getQueueCounts();

  emitCountUpdate();
  emitEvent('queueItemUpdate', {
    id,
    type: 'status_changed',
    status: updated.status,
    entry: updated
  });

  if (wantsJson) {
    return res.json({ success: true, entry: updated, counts });
  }
  res.redirect('/ui/queue');
});

router.post('/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const entry = getQueueEntry(id);
  if (!entry) {
    return wantsJson
      ? res.status(404).json({ error: 'Queue entry not found' })
      : res.status(404).send('Queue entry not found');
  }

  if (entry.status !== 'pending') {
    return wantsJson
      ? res.status(400).json({ error: 'Can only reject pending requests' })
      : res.status(400).send('Can only reject pending requests');
  }

  updateQueueStatus(id, 'rejected', { rejection_reason: reason || 'No reason provided' });

  const updated = getQueueEntry(id);
  notifyAgentQueueStatus(updated).catch(err => {
    console.error('[agentNotifier] Failed to notify agent:', err.message);
  });

  const counts = getQueueCounts();
  emitCountUpdate();
  emitEvent('queueItemUpdate', {
    id,
    type: 'status_changed',
    status: updated.status,
    entry: updated
  });

  if (wantsJson) {
    return res.json({ success: true, entry: updated, counts });
  }
  res.redirect('/ui/queue');
});

router.post('/clear', (req, res) => {
  const wantsJson = req.headers.accept?.includes('application/json');
  const { status } = req.body;

  const allowedStatuses = ['completed', 'failed', 'rejected', 'withdrawn', 'all'];
  if (status && !allowedStatuses.includes(status)) {
    return wantsJson
      ? res.status(400).json({ error: 'Invalid status' })
      : res.status(400).send('Invalid status');
  }

  clearQueueByStatus(status || 'all');
  const counts = getQueueCounts();
  emitCountUpdate();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/queue');
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const entry = getQueueEntry(id);
  if (!entry) {
    return wantsJson
      ? res.status(404).json({ error: 'Queue entry not found' })
      : res.status(404).send('Queue entry not found');
  }

  deleteQueueEntry(id);
  const counts = getQueueCounts();
  emitCountUpdate();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/queue');
});

router.post('/:id/notify', async (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');
  const entry = getQueueEntry(id);

  if (!entry) {
    return wantsJson
      ? res.status(404).json({ success: false, error: 'Entry not found' })
      : res.status(404).send('Entry not found');
  }

  // Actually send the notification (this was missing!)
  const result = await notifyAgentQueueStatus(entry);

  if (wantsJson) {
    return res.json({ success: result.success, error: result.error });
  }
  res.redirect('/ui/queue');
});

// Render function
function renderQueuePage(entries, filter, counts = {}) {
  const renderEntry = (entry) => {
    const requestsSummary = entry.requests.map((r) =>
      `<div class="request-item"><code>${r.method}</code> <span>${escapeHtml(r.path)}</span></div>`
    ).join('');

    // Get warnings for this entry
    const warnings = getQueueWarnings(entry.id);
    const warningCount = warnings.length;
    const warningBadge = warningCount > 0
      ? `<span class="warning-badge" title="${warningCount} warning${warningCount > 1 ? 's' : ''}">⚠️ ${warningCount}</span>`
      : '';

    let warningsSection = '';
    if (warningCount > 0) {
      const warningItems = warnings.map(w => `
        <div class="warning-item">
          <div class="warning-header">
            ${renderAvatar(w.agent_id, { size: 18 })}
            <strong>${escapeHtml(w.agent_id)}</strong>
            <span class="warning-time">${formatDate(w.created_at)}</span>
          </div>
          <div class="warning-message">${escapeHtml(w.message)}</div>
        </div>
      `).join('');
      
      warningsSection = `
        <div class="warnings-section">
          <div class="warnings-header">⚠️ Warnings (${warningCount})</div>
          ${warningItems}
        </div>
      `;
    }

    let actions = '';
    if (entry.status === 'pending') {
      actions = `
        <div class="queue-actions" id="actions-${entry.id}">
          <button type="button" class="btn-primary btn-sm" onclick="approveEntry('${entry.id}')">Approve</button>
          <input type="text" id="reason-${entry.id}" placeholder="Rejection reason (optional)" class="reject-input">
          <button type="button" class="btn-danger btn-sm" onclick="rejectEntry('${entry.id}')">Reject</button>
        </div>
      `;
    }

    let resultSection = '';
    if (entry.results) {
      resultSection = `
        <details style="margin-top: 12px;">
          <summary>Results (${entry.results.length})</summary>
          <pre style="margin-top: 8px; font-size: 12px;">${escapeHtml(JSON.stringify(entry.results, null, 2))}</pre>
        </details>
      `;
    }

    if (entry.rejection_reason) {
      resultSection = `
        <div class="rejection-reason">
          <strong>Rejection reason:</strong> ${escapeHtml(entry.rejection_reason)}
        </div>
      `;
    }

    let notificationSection = '';
    if (['completed', 'failed', 'rejected', 'withdrawn'].includes(entry.status)) {
      const notifyStatus = entry.notified
        ? `<span class="notify-status notify-sent" title="Notified at ${entry.notified_at || ''}">✓ Notified</span>`
        : entry.notify_error
          ? `<span class="notify-status notify-failed" title="${escapeHtml(entry.notify_error)}">⚠ Notify failed</span>`
          : '<span class="notify-status notify-pending">— Not notified</span>';

      const retryBtn = !entry.notified
        ? `<button type="button" class="btn-sm btn-link" onclick="retryNotify('${entry.id}')" id="retry-${entry.id}">Retry</button>`
        : '';

      notificationSection = `
        <div class="notification-status" id="notify-status-${entry.id}">
          ${notifyStatus} ${retryBtn}
        </div>
      `;
    }

    return `
      <div class="card queue-entry" id="entry-${entry.id}" data-status="${entry.status}" data-notified="${entry.notified ? '1' : '0'}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
          <div class="entry-header">
            <strong>${entry.service}</strong> / ${entry.account_name}
            <span class="status-badge">${statusBadge(entry.status)}</span>
            ${warningBadge}
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="help" style="margin: 0;">${formatDate(entry.submitted_at)}</span>
            <button type="button" class="delete-btn" onclick="deleteEntry('${entry.id}')" title="Delete">&times;</button>
          </div>
        </div>

        ${entry.comment ? `<p class="agent-comment"><strong>Agent says:</strong> ${renderMarkdownLinks(entry.comment)}</p>` : ''}

        <div class="help" style="margin-bottom: 8px;">Submitted by: <span class="agent-with-avatar">${renderAvatar(entry.submitted_by, { size: 20 })}<code>${escapeHtml(entry.submitted_by || 'unknown')}</code></span></div>

        <div class="requests-list">
          ${requestsSummary}
        </div>

        <details style="margin-top: 12px;">
          <summary>Request Details</summary>
          <pre style="margin-top: 8px; font-size: 12px;">${escapeHtml(JSON.stringify(entry.requests, null, 2))}</pre>
        </details>

        ${resultSection}
        ${warningsSection}
        ${notificationSection}
        ${actions}
      </div>
    `;
  };

  const filters = ['all', 'pending', 'completed', 'failed', 'rejected', 'withdrawn'];
  const filterLinks = filters.map(f =>
    `<a href="/ui/queue?filter=${f}" class="filter-link ${filter === f ? 'active' : ''}">${f}${counts[f] > 0 ? ` (${counts[f]})` : ''}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Write Queue</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    .filter-bar { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; align-items: center; }
    .filter-link { padding: 10px 20px; border-radius: 25px; text-decoration: none; background: rgba(255, 255, 255, 0.05); color: var(--gray-400); font-weight: 600; font-size: 13px; border: 1px solid rgba(255, 255, 255, 0.1); transition: all 0.3s ease; }
    .filter-link:hover { background: rgba(255, 255, 255, 0.1); color: var(--gray-200); border-color: rgba(255, 255, 255, 0.2); }
    .filter-link.active { background: linear-gradient(135deg, var(--primary) 0%, #8b5cf6 100%); color: white; border-color: transparent; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4); }
    .queue-entry { margin-bottom: 20px; }
    .request-item { padding: 12px 16px; background: rgba(0, 0, 0, 0.2); border-radius: 8px; margin: 6px 0; font-size: 14px; border: 1px solid rgba(255, 255, 255, 0.05); display: flex; align-items: center; gap: 12px; }
    .request-item code { background: rgba(99, 102, 241, 0.2); padding: 4px 10px; border-radius: 6px; font-weight: 700; color: var(--primary-light); border: 1px solid rgba(99, 102, 241, 0.3); font-size: 12px; }
    .request-item span { color: var(--gray-300); }
    .queue-actions { margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .back-link { color: #818cf8; text-decoration: none; font-weight: 600; transition: color 0.2s ease; }
    .back-link:hover { color: #ffffff; }
    .delete-btn { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; font-size: 18px; cursor: pointer; padding: 4px 10px; line-height: 1; font-weight: bold; border-radius: 6px; transition: all 0.2s ease; }
    .delete-btn:hover { background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.4); }
    .clear-section { margin-left: auto; display: flex; gap: 10px; }
    .entry-header { display: flex; align-items: center; gap: 12px; }
    .entry-header strong { color: #f3f4f6; font-size: 16px; }
    .reject-input { width: 240px; padding: 10px 14px; margin: 0; font-size: 13px; background: rgba(15, 15, 25, 0.6); border: 2px solid rgba(239, 68, 68, 0.2); border-radius: 8px; color: #f3f4f6; }
    .reject-input:focus { outline: none; border-color: #f87171; box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.15); }
    .reject-input::placeholder { color: #6b7280; }
    .agent-comment { margin: 0 0 16px 0; padding: 16px; background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%); border-radius: 10px; border-left: 4px solid #6366f1; color: #e5e7eb; }
    .agent-comment strong { color: #818cf8; }
    .agent-comment a { color: #818cf8; }
    .rejection-reason { margin-top: 16px; padding: 16px; background: rgba(239, 68, 68, 0.1); border-radius: 10px; border-left: 4px solid #f87171; color: #e5e7eb; }
    .rejection-reason strong { color: #f87171; }
    .empty-state { text-align: center; padding: 60px 40px; }
    .empty-state p { color: #6b7280; margin: 0; font-size: 16px; }
    .notification-status { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; gap: 12px; font-size: 13px; }
    .notify-status { padding: 4px 10px; border-radius: 6px; font-weight: 500; }
    .notify-sent { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .notify-failed { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .notify-pending { background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3); }
    .btn-link { background: none; border: none; color: #818cf8; cursor: pointer; text-decoration: underline; padding: 4px 8px; font-size: 13px; }
    .btn-link:hover { color: #a5b4fc; }
    .warning-badge { background: rgba(245, 158, 11, 0.2); color: #fbbf24; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; border: 1px solid rgba(245, 158, 11, 0.3); }
    .warnings-section { margin-top: 16px; padding: 16px; background: rgba(245, 158, 11, 0.08); border-radius: 10px; border: 1px solid rgba(245, 158, 11, 0.2); }
    .warnings-header { color: #fbbf24; font-weight: 600; margin-bottom: 12px; font-size: 14px; }
    .warning-item { padding: 12px; background: rgba(0, 0, 0, 0.2); border-radius: 8px; margin-bottom: 8px; border-left: 3px solid #f59e0b; }
    .warning-item:last-child { margin-bottom: 0; }
    .warning-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; }
    .warning-header strong { color: #fbbf24; }
    .warning-time { color: #6b7280; font-size: 12px; margin-left: auto; }
    .warning-message { color: #e5e7eb; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  ${simpleNavHeader()}
  <h2 style="margin-top: 0;">Write Queue</h2>
  <p>Review and approve write requests from agents.</p>

  <div class="filter-bar" id="filter-bar">
    ${filterLinks}
    <div class="clear-section">
      ${filter === 'completed' && counts.completed > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'completed\')">Clear Completed</button>' : ''}
      ${filter === 'failed' && counts.failed > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'failed\')">Clear Failed</button>' : ''}
      ${filter === 'rejected' && counts.rejected > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'rejected\')">Clear Rejected</button>' : ''}
      ${filter === 'all' && (counts.completed > 0 || counts.failed > 0 || counts.rejected > 0) ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'all\')">Clear All Non-Pending</button>' : ''}
      <a href="/ui/queue/export?format=json" class="btn-sm" style="text-decoration: none;">Export JSON</a>
      <a href="/ui/queue/export?format=csv" class="btn-sm" style="text-decoration: none;">Export CSV</a>
    </div>
  </div>

  <div id="entries-container">
  ${entries.length === 0 ? `
    <div class="card empty-state">
      <p>No ${filter === 'all' ? '' : filter + ' '}requests in queue</p>
    </div>
  ` : entries.map(renderEntry).join('')}
  </div>

  <script>
    function escapeHtml(str) {
      if (typeof str !== 'string') str = JSON.stringify(str, null, 2);
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const statusColors = {
      pending: 'background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);',
      approved: 'background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);',
      executing: 'background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);',
      completed: 'background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);',
      failed: 'background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);',
      rejected: 'background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3);',
      withdrawn: 'background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3);'
    };

    function renderStatusBadge(status) {
      return '<span class="status" style="' + (statusColors[status] || '') + '">' + status + '</span>';
    }

    function updateFilterCounts(counts) {
      const filterBar = document.getElementById('filter-bar');
      if (!filterBar) return;
      const links = filterBar.querySelectorAll('.filter-link');
      links.forEach(link => {
        const href = link.getAttribute('href');
        const match = href.match(/filter=(\\w+)/);
        if (match) {
          const f = match[1];
          const count = counts[f] || 0;
          const label = f + (count > 0 ? ' (' + count + ')' : '');
          link.textContent = label;
        }
      });
    }

    function updateEntryStatus(entryEl, entry, counts) {
      // Update status badge
      const badgeContainer = entryEl.querySelector('.status-badge');
      if (badgeContainer) {
        badgeContainer.innerHTML = renderStatusBadge(entry.status);
      }
      entryEl.dataset.status = entry.status;

      // Remove action buttons
      const actionsEl = entryEl.querySelector('.queue-actions');
      if (actionsEl) actionsEl.remove();

      // Add result or rejection section
      let resultHtml = '';
      if (entry.results) {
        resultHtml = '<details style="margin-top: 12px;"><summary>Results (' + entry.results.length + ')</summary>' +
          '<pre style="margin-top: 8px; font-size: 12px;">' + escapeHtml(JSON.stringify(entry.results, null, 2)) + '</pre></details>';
      }
      if (entry.rejection_reason) {
        resultHtml = '<div class="rejection-reason"><strong>Rejection reason:</strong> ' + escapeHtml(entry.rejection_reason) + '</div>';
      }
      if (resultHtml) {
        const existing = entryEl.querySelector('.rejection-reason') || entryEl.querySelector('details:last-of-type');
        const insertPoint = entryEl.querySelector('.warnings-section') || entryEl.querySelector('.notification-status');
        if (insertPoint) {
          insertPoint.insertAdjacentHTML('beforebegin', resultHtml);
        } else {
          entryEl.insertAdjacentHTML('beforeend', resultHtml);
        }
      }

      // Add notification status section
      if (['completed', 'failed', 'rejected', 'withdrawn'].includes(entry.status)) {
        let existingNotify = entryEl.querySelector('.notification-status');
        if (!existingNotify) {
          const notifyHtml = '<div class="notification-status" id="notify-status-' + entry.id + '">' +
            '<span class="notify-status notify-pending">— Not notified</span> ' +
            '<button type="button" class="btn-sm btn-link" onclick="retryNotify(\'' + entry.id + '\')" id="retry-' + entry.id + '">Retry</button>' +
            '</div>';
          entryEl.insertAdjacentHTML('beforeend', notifyHtml);
        }
      }

      // Flash the entry to indicate update
      entryEl.style.transition = 'box-shadow 0.3s ease';
      entryEl.style.boxShadow = '0 0 0 2px rgba(99, 102, 241, 0.5)';
      setTimeout(() => { entryEl.style.boxShadow = ''; }, 1500);

      // Update filter counts
      if (counts) updateFilterCounts(counts);
    }

    async function approveEntry(id) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Approving...';
      try {
        const res = await fetch('/ui/queue/' + id + '/approve', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          const entryEl = document.getElementById('entry-' + id);
          if (entryEl) updateEntryStatus(entryEl, data.entry, data.counts);
        } else {
          alert(data.error || 'Failed to approve');
          btn.disabled = false;
          btn.textContent = 'Approve';
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Approve';
      }
    }

    async function rejectEntry(id) {
      const btn = event.target;
      const reasonInput = document.getElementById('reason-' + id);
      const reason = reasonInput ? reasonInput.value : '';
      btn.disabled = true;
      btn.textContent = 'Rejecting...';
      try {
        const res = await fetch('/ui/queue/' + id + '/reject', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (data.success) {
          const entryEl = document.getElementById('entry-' + id);
          if (entryEl) updateEntryStatus(entryEl, data.entry, data.counts);
        } else {
          alert(data.error || 'Failed to reject');
          btn.disabled = false;
          btn.textContent = 'Reject';
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Reject';
      }
    }

    async function clearByStatus(status) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Clearing...';
      try {
        const res = await fetch('/ui/queue/clear', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (data.success) {
          // Remove cleared entries from DOM
          const container = document.getElementById('entries-container');
          const entries = container.querySelectorAll('.queue-entry');
          entries.forEach(el => {
            const s = el.dataset.status;
            if (status === 'all' ? s !== 'pending' : s === status) {
              el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
              el.style.opacity = '0';
              el.style.transform = 'translateX(-20px)';
              setTimeout(() => el.remove(), 300);
            }
          });
          // Show empty state after animation if needed
          setTimeout(() => {
            if (container.querySelectorAll('.queue-entry').length === 0) {
              container.innerHTML = '<div class="card empty-state"><p>No requests in queue</p></div>';
            }
          }, 350);
          if (data.counts) updateFilterCounts(data.counts);
          // Hide the clear button
          btn.style.display = 'none';
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
      }
    }

    async function deleteEntry(id) {
      if (!confirm('Delete this queue entry?')) return;
      try {
        const res = await fetch('/ui/queue/' + id, { method: 'DELETE', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          const el = document.getElementById('entry-' + id);
          if (el) {
            el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            el.style.opacity = '0';
            el.style.transform = 'translateX(-20px)';
            setTimeout(() => {
              el.remove();
              const container = document.getElementById('entries-container');
              if (container.querySelectorAll('.queue-entry').length === 0) {
                container.innerHTML = '<div class="card empty-state"><p>No requests in queue</p></div>';
              }
            }, 300);
          }
          if (data.counts) updateFilterCounts(data.counts);
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function retryNotify(id) {
      const btn = document.getElementById('retry-' + id);
      const statusContainer = document.getElementById('notify-status-' + id);
      if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
      try {
        const res = await fetch('/ui/queue/' + id + '/notify', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          // Update inline instead of page refresh
          if (statusContainer) {
            statusContainer.innerHTML = '<span class="notify-status notify-sent">✓ Notified</span>';
          }
        } else {
          // Show error and re-enable retry button
          if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
          const errorMsg = data.error || 'Unknown error';
          alert('Notification failed: ' + errorMsg);
        }
      } catch (err) {
        alert('Error: ' + err.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
      }
    }

    // Real-time queue item updates via socket.io
    document.addEventListener('DOMContentLoaded', function() {
      const socket = io();

      socket.on('queueItemUpdate', function(data) {
        const entryEl = document.getElementById('entry-' + data.id);
        if (!entryEl) return;

        if (data.type === 'warning_added') {
          // Update warning badge
          const headerEl = entryEl.querySelector('.entry-header');
          if (headerEl) {
            let badgeEl = headerEl.querySelector('.warning-badge');
            if (badgeEl) {
              badgeEl.textContent = '⚠️ ' + data.warningCount;
              badgeEl.title = data.warningCount + ' warning' + (data.warningCount > 1 ? 's' : '');
            } else {
              const badge = document.createElement('span');
              badge.className = 'warning-badge';
              badge.textContent = '⚠️ ' + data.warningCount;
              badge.title = data.warningCount + ' warning' + (data.warningCount > 1 ? 's' : '');
              headerEl.appendChild(badge);
            }
          }

          // Update or add warnings section
          let warningsSection = entryEl.querySelector('.warnings-section');
          if (!warningsSection) {
            warningsSection = document.createElement('div');
            warningsSection.className = 'warnings-section';
            // Insert after the entry header area
            const actionsEl = entryEl.querySelector('.queue-actions');
            if (actionsEl) {
              actionsEl.parentNode.insertBefore(warningsSection, actionsEl);
            } else {
              entryEl.appendChild(warningsSection);
            }
          }

          // Rebuild warnings content
          const warningItems = data.warnings.map(w => 
            '<div class="warning-item">' +
              '<div class="warning-header">' +
                '<strong>' + escapeHtml(w.agent_id) + '</strong>' +
                '<span class="warning-time">' + new Date(w.created_at).toLocaleString() + '</span>' +
              '</div>' +
              '<div class="warning-message">' + escapeHtml(w.message) + '</div>' +
            '</div>'
          ).join('');
          
          warningsSection.innerHTML = 
            '<div class="warnings-header">⚠️ Warnings (' + data.warningCount + ')</div>' +
            warningItems;
        }

        if (data.type === 'status_changed') {
          updateEntryStatus(entryEl, data.entry || { id: data.id, status: data.status });
        }
      });
    });
  </script>
${socketScript()}
${localizeScript()}
</body>
</html>`;
}

// Export queue data
router.get('/export', (req, res) => {
  try {
    const format = req.query.format || 'json';
    const entries = listQueueEntries();
    
    if (format === 'csv') {
      const headers = ['id', 'service', 'account_name', 'status', 'comment', 'submitted_by', 'rejection_reason', 'submitted_at', 'reviewed_at', 'completed_at'];
      const csvRows = [headers.join(',')];
      for (const entry of entries) {
        const row = headers.map(h => {
          const val = entry[h] ?? '';
          const str = String(val).replace(/"/g, '""');
          return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
        });
        csvRows.push(row.join(','));
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="queue-export.csv"');
      return res.send(csvRows.join('\n'));
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="queue-export.json"');
    res.json(entries);
  } catch (err) {
    console.error('Queue export error:', err);
    res.status(500).json({ error: 'Export failed', message: err.message });
  }
});

export default router;
