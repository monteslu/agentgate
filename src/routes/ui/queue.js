// Queue routes - write queue management
import { Router } from 'express';
import {
  listQueueEntries, getQueueEntry, updateQueueStatus,
  clearQueueByStatus, deleteQueueEntry, getQueueCounts,
  getQueueWarnings, listAutoApprovedEntries, getAutoApprovedCount
} from '../../lib/db.js';
import { executeQueueEntry } from '../../lib/queueExecutor.js';
import { notifyAgentQueueStatus } from '../../lib/agentNotifier.js';
import { emitCountUpdate, emitEvent } from '../../lib/socketManager.js';
import { escapeHtml, renderMarkdownLinks, statusBadge, autoApprovedBadge, formatDate, htmlHead, navHeader, socketScript, localizeScript, menuScript, renderAvatar } from './shared.js';

const router = Router();

// Allowed reaction emojis (must match UI picker)
const ALL_EMOJIS = ['❤️', '🔥', '👏', '⭐', '👎', '😠', '💀', '😂', '🤔', '👀'];
const ALLOWED_REACTION_EMOJIS = new Set(ALL_EMOJIS);

// Validate and sanitize reaction emoji
function validateReactionEmoji(emoji) {
  if (!emoji) return null;
  return ALLOWED_REACTION_EMOJIS.has(emoji) ? emoji : null;
}

// Write Queue Management
router.get('/', (req, res) => {
  const filter = req.query.filter || 'pending';
  let entries;
  if (filter === 'all') {
    entries = listQueueEntries();
  } else if (filter === 'auto-approved') {
    entries = listAutoApprovedEntries();
  } else {
    entries = listQueueEntries(filter);
  }
  const counts = getQueueCounts();
  counts['auto-approved'] = getAutoApprovedCount();
  res.send(renderQueuePage(entries, filter, counts));
});

router.post('/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { emoji } = req.body;
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

  updateQueueStatus(id, 'approved', { reaction_emoji: validateReactionEmoji(emoji) });

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
  const { reason, emoji } = req.body;
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

  updateQueueStatus(id, 'rejected', { rejection_reason: reason || 'No reason provided', reaction_emoji: validateReactionEmoji(emoji) });

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

router.post('/:id/react', (req, res) => {
  const { id } = req.params;
  const { emoji } = req.body;
  const entry = getQueueEntry(id);
  if (!entry) return res.status(404).json({ error: 'Queue entry not found' });
  if (entry.status === 'pending') return res.status(400).json({ error: 'Cannot react to pending items' });
  const validEmoji = emoji ? validateReactionEmoji(emoji) : null;
  if (emoji && !validEmoji) return res.status(400).json({ error: 'Invalid emoji' });
  updateQueueStatus(id, entry.status, { reaction_emoji: validEmoji });
  const updated = getQueueEntry(id);
  notifyAgentQueueStatus(updated).catch(err => {
    console.error('[agentNotifier] Failed to notify agent of reaction:', err.message);
  });
  res.json({ success: true, emoji: validEmoji });
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
          <div class="action-row">
            <button type="button" class="btn-primary btn-sm" onclick="approveEntry('${entry.id}')">Approve</button>
          </div>
          <div class="action-row">
            <input type="text" id="reason-${entry.id}" placeholder="Rejection reason (optional)" class="reject-input" autocomplete="off">
            <button type="button" class="btn-danger btn-sm" onclick="rejectEntry('${entry.id}')">Reject</button>
          </div>
        </div>
      `;
    }

    let emojiSection = '';
    if (entry.status !== 'pending') {
      if (entry.reaction_emoji) {
        emojiSection = `
          <div class="emoji-section" id="emoji-section-${entry.id}">
            <span class="reaction-emoji-display" data-id="${entry.id}" title="Click to change">${escapeHtml(entry.reaction_emoji)}</span>
            <div class="emoji-picker-popup" id="emoji-popup-${entry.id}" class="d-none">
              ${ALL_EMOJIS.map(e => `<button type="button" class="emoji-btn" data-id="${entry.id}" data-emoji="${e}">${e}</button>`).join('')}
              <button type="button" class="emoji-btn emoji-remove" data-id="${entry.id}" data-emoji="" title="Remove">✕</button>
            </div>
          </div>
        `;
      } else {
        emojiSection = `
          <div class="emoji-section" id="emoji-section-${entry.id}">
            <button type="button" class="emoji-trigger" data-id="${entry.id}" title="Add reaction">😀</button>
            <div class="emoji-picker-popup" id="emoji-popup-${entry.id}" class="d-none">
              ${ALL_EMOJIS.map(e => `<button type="button" class="emoji-btn" data-id="${entry.id}" data-emoji="${e}">${e}</button>`).join('')}
            </div>
          </div>
        `;
      }
    }

    let resultSection = '';
    if (entry.results) {
      resultSection = `
        <details class="mt-12">
          <summary>Results (${entry.results.length})</summary>
          <pre class="meta-line">${escapeHtml(JSON.stringify(entry.results, null, 2))}</pre>
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
        <div class="flex-between mb-12" style="align-items: flex-start;">
          <div class="entry-header">
            <strong>${entry.service}</strong> / ${entry.account_name}
            <span class="status-badge">${statusBadge(entry.status)}${autoApprovedBadge(entry.auto_approved)}</span>
            ${warningBadge}
          </div>
          <div class="flex-center gap-12">
            <span class="help" class="m-0">${formatDate(entry.submitted_at)}</span>
            <button type="button" class="delete-btn" onclick="deleteEntry('${entry.id}')" title="Delete">&times;</button>
          </div>
        </div>

        ${entry.comment ? `<p class="agent-comment"><strong>Agent says:</strong> ${renderMarkdownLinks(entry.comment)}</p>` : ''}

        <div class="help" class="mb-8">Submitted by: <span class="agent-with-avatar">${renderAvatar(entry.submitted_by, { size: 20 })}<code>${escapeHtml(entry.submitted_by || 'unknown')}</code></span></div>

        <div class="requests-list">
          ${requestsSummary}
        </div>

        <details class="mt-12">
          <summary>Request Details</summary>
          <pre class="meta-line">${escapeHtml(JSON.stringify(entry.requests, null, 2))}</pre>
        </details>

        ${resultSection}
        ${warningsSection}
        ${notificationSection}
        ${actions}
        ${emojiSection}

        <div class="queue-entry-footer">
          <span class="entry-id">ID: ${entry.id}</span>
        </div>
      </div>
    `;
  };

  const filters = ['pending', 'auto-approved', 'completed', 'failed', 'rejected', 'withdrawn', 'all'];
  const filterLinks = filters.map(f =>
    `<a href="/ui/queue?filter=${f}" class="filter-link ${filter === f ? 'active' : ''}">${f}${counts[f] > 0 ? ` (${counts[f]})` : ''}</a>`
  ).join('');

  return `${htmlHead('Write Queue', { includeSocket: true })}
  
<body>
  ${navHeader()}
  <h2 class="mt-0">Write Queue</h2>
  <p>Review and approve write requests from agents.</p>

  <div class="filter-bar" id="filter-bar">
    ${filterLinks}
    <div class="clear-section">
      ${filter === 'completed' && counts.completed > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'completed\')">Clear Completed</button>' : ''}
      ${filter === 'failed' && counts.failed > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'failed\')">Clear Failed</button>' : ''}
      ${filter === 'rejected' && counts.rejected > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'rejected\')">Clear Rejected</button>' : ''}
      ${filter === 'all' && (counts.completed > 0 || counts.failed > 0 || counts.rejected > 0) ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'all\')">Clear All Non-Pending</button>' : ''}
      <a href="/ui/queue/export?format=json" class="btn-sm" class="no-underline">Export JSON</a>
      <a href="/ui/queue/export?format=csv" class="btn-sm" class="no-underline">Export CSV</a>
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

    function updateEntryStatus(id, entry) {
      const entryEl = document.getElementById('entry-' + id);
      if (!entryEl) return;

      // Update status badge
      const statusBadgeEl = entryEl.querySelector('.status-badge .status');
      if (statusBadgeEl) {
        statusBadgeEl.textContent = entry.status;
        statusBadgeEl.className = 'status ' + entry.status;
      }
      entryEl.dataset.status = entry.status;

      // Remove action buttons and add emoji picker
      if (entry.status !== 'pending') {
        const actionsEl = entryEl.querySelector('.queue-actions');
        if (actionsEl) actionsEl.remove();

        // Add emoji picker section if not already present
        if (!entryEl.querySelector('.emoji-section')) {
          const emojiDiv = document.createElement('div');
          emojiDiv.className = 'emoji-section';
          emojiDiv.id = 'emoji-section-' + entry.id;
          if (entry.reaction_emoji) {
            emojiDiv.innerHTML = '<span class="reaction-emoji-display" data-id="'+entry.id+'" title="Click to change">'+entry.reaction_emoji+'</span>' + emojiPickerHtml(entry.id, true);
          } else {
            emojiDiv.innerHTML = '<button type="button" class="emoji-trigger" data-id="'+entry.id+'" title="Add reaction">😀</button>' + emojiPickerHtml(entry.id, false);
          }
          const footer = entryEl.querySelector('.queue-entry-footer');
          if (footer) footer.parentNode.insertBefore(emojiDiv, footer);
          else entryEl.appendChild(emojiDiv);
        }
      }

      // Add results section if present
      let insertTarget = entryEl.querySelector('.notification-status') || entryEl.querySelector('.queue-entry-footer');
      if (entry.results && entry.results.length) {
        const details = document.createElement('details');
        details.style.marginTop = '12px';
        details.innerHTML = '<summary>Results (' + entry.results.length + ')</summary>' +
          '<pre class="meta-line">' + escapeHtml(JSON.stringify(entry.results, null, 2)) + '</pre>';
        if (insertTarget) insertTarget.parentNode.insertBefore(details, insertTarget);
        else entryEl.appendChild(details);
      }

      // Add rejection reason if present
      if (entry.rejection_reason) {
        const div = document.createElement('div');
        div.className = 'rejection-reason';
        div.innerHTML = '<strong>Rejection reason:</strong> ' + escapeHtml(entry.rejection_reason);
        if (insertTarget) insertTarget.parentNode.insertBefore(div, insertTarget);
        else entryEl.appendChild(div);
      }

      // Add notification status section for terminal states
      if (['completed', 'failed', 'rejected', 'withdrawn'].includes(entry.status)) {
        let notifyEl = document.getElementById('notify-status-' + id);
        if (!notifyEl) {
          notifyEl = document.createElement('div');
          notifyEl.className = 'notification-status';
          notifyEl.id = 'notify-status-' + id;
          const notifyStatus = entry.notified
            ? '<span class="notify-status notify-sent">✓ Notified</span>'
            : '<span class="notify-status notify-pending">— Not notified</span> <button type="button" class="btn-sm btn-link" onclick="retryNotify(' + "'" + id + "'" + ')" id="retry-' + id + '">Retry</button>';
          notifyEl.innerHTML = notifyStatus;
          const footer = entryEl.querySelector('.queue-entry-footer');
          if (footer) footer.parentNode.insertBefore(notifyEl, footer);
          else entryEl.appendChild(notifyEl);
        }
      }

      // Flash effect for visual feedback
      
      entryEl.classList.add('queue-entry-flash');
      setTimeout(() => { entryEl.classList.remove('queue-entry-flash'); }, 1500);
    }

    function updateFilterCounts(counts) {
      if (!counts) return;
      const filterBar = document.getElementById('filter-bar');
      if (!filterBar) return;
      filterBar.querySelectorAll('.filter-link').forEach(a => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/filter=([^&]*)/);
        const f = match ? match[1] : 'pending';
        if (counts[f] !== undefined) {
          const text = f + (counts[f] > 0 ? ' (' + counts[f] + ')' : '');
          a.textContent = text;
        }
      });
    }

    async function approveEntry(id, emoji = null) {
      const btn = event.target;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Approving...';
      try {
        const res = await fetch('/ui/queue/' + id + '/approve', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji })
        });
        const data = await res.json();
        if (data.success) {
          updateEntryStatus(id, data.entry);
          updateFilterCounts(data.counts);
        } else {
          alert(data.error || 'Failed to approve');
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    async function rejectEntry(id, emoji = null) {
      const btn = event.target;
      const reasonInput = document.getElementById('reason-' + id);
      const reason = reasonInput ? reasonInput.value : '';
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Rejecting...';
      try {
        const res = await fetch('/ui/queue/' + id + '/reject', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, emoji })
        });
        const data = await res.json();
        if (data.success) {
          updateEntryStatus(id, data.entry);
          updateFilterCounts(data.counts);
        } else {
          alert(data.error || 'Failed to reject');
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = originalText;
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
          // Animate out cleared entries
          const entries = document.querySelectorAll('.queue-entry');
          const targetStatuses = status === 'all'
            ? ['completed', 'failed', 'rejected', 'withdrawn']
            : [status];
          entries.forEach(el => {
            if (targetStatuses.includes(el.dataset.status)) {
              el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
              el.style.opacity = '0';
              el.style.transform = 'translateX(20px)';
              setTimeout(() => el.remove(), 300);
            }
          });
          // Check if container is empty after animation
          setTimeout(() => {
            const container = document.getElementById('entries-container');
            if (container && container.querySelectorAll('.queue-entry').length === 0) {
              container.innerHTML = '<div class="card empty-state"><p>No requests in queue</p></div>';
            }
          }, 350);
          updateFilterCounts(data.counts);
          // Remove the clear button itself
          btn.remove();
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
          document.getElementById('entry-' + id)?.remove();
          const container = document.getElementById('entries-container');
          if (container.querySelectorAll('.queue-entry').length === 0) {
            container.innerHTML = '<div class="card empty-state"><p>No requests in queue</p></div>';
          }
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function toggleEmojiPicker(id) {
      // Close any other open pickers
      document.querySelectorAll('.emoji-picker-popup').forEach(p => {
        if (p.id !== 'emoji-popup-' + id) p.style.display = 'none';
      });
      const popup = document.getElementById('emoji-popup-' + id);
      if (popup) popup.style.display = popup.style.display === 'none' ? 'flex' : 'none';
    }

    var EMOJI_LIST = ${JSON.stringify(ALL_EMOJIS)};

    function emojiPickerHtml(id, includeRemove) {
      var btns = EMOJI_LIST.map(function(e) {
        return '<button type="button" class="emoji-btn" data-id="'+id+'" data-emoji="'+e+'">'+e+'</button>';
      }).join('');
      if (includeRemove) btns += '<button type="button" class="emoji-btn emoji-remove" data-id="'+id+'" data-emoji="" title="Remove">✕</button>';
      return '<div class="emoji-picker-popup" id="emoji-popup-'+id+'" class="d-none">'+btns+'</div>';
    }

    async function setReaction(id, emoji) {
      var popup = document.getElementById('emoji-popup-' + id);
      if (popup) popup.style.display = 'none';
      try {
        var res = await fetch('/ui/queue/' + id + '/react', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji: emoji || null })
        });
        var data = await res.json();
        if (data.success) {
          var section = document.getElementById('emoji-section-' + id);
          if (!section) return;
          if (data.emoji) {
            section.innerHTML = '<span class="reaction-emoji-display" data-id="'+id+'">'+data.emoji+'</span>' + emojiPickerHtml(id, true);
          } else {
            section.innerHTML = '<button type="button" class="emoji-trigger" data-id="'+id+'">😀</button>' + emojiPickerHtml(id, false);
          }
        }
      } catch (err) {
        console.error('Error setting reaction:', err);
      }
    }

    // Event delegation for emoji interactions
    document.addEventListener('click', function(e) {
      var target = e.target;
      // Emoji picker button clicks
      if (target.closest('.emoji-picker-popup .emoji-btn')) {
        var btn = target.closest('.emoji-btn');
        setReaction(btn.dataset.id, btn.dataset.emoji);
        return;
      }
      // Toggle picker from trigger or display
      if (target.closest('.emoji-trigger, .reaction-emoji-display')) {
        var el = target.closest('.emoji-trigger, .reaction-emoji-display');
        toggleEmojiPicker(el.dataset.id);
        return;
      }
      // Close all pickers when clicking outside
      if (!target.closest('.emoji-section')) {
        document.querySelectorAll('.emoji-picker-popup').forEach(function(p) { p.style.display = 'none'; });
      }
    });

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
          // Update status badge
          const statusBadge = entryEl.querySelector('.status-badge .status');
          if (statusBadge) {
            statusBadge.textContent = data.status;
            statusBadge.className = 'status ' + data.status;
          }
          entryEl.dataset.status = data.status;

          // Remove action buttons if no longer pending
          if (data.status !== 'pending') {
            const actionsEl = entryEl.querySelector('.queue-actions');
            if (actionsEl) actionsEl.remove();
          }
        }
      });
    });
  </script>
${socketScript()}
${menuScript()}
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