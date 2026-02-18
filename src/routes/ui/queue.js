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
import { escapeHtml, renderMarkdownLinks, statusBadge, autoApprovedBadge, formatDate, renderAvatar } from './shared.js';
import { renderPage } from '../../lib/render.js';

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
const PAGE_SIZE = 25;

router.get('/', (req, res) => {
  const filter = req.query.filter || 'pending';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const pagination = { limit: PAGE_SIZE + 1, offset };

  let entries;
  if (filter === 'all') {
    entries = listQueueEntries(undefined, pagination);
  } else if (filter === 'auto-approved') {
    entries = listAutoApprovedEntries(pagination);
  } else {
    entries = listQueueEntries(filter, pagination);
  }

  const hasNext = entries.length > PAGE_SIZE;
  if (hasNext) entries = entries.slice(0, PAGE_SIZE);

  const counts = getQueueCounts();
  counts['auto-approved'] = getAutoApprovedCount();
  renderPage(res, 'pages/queue', {
    title: 'Write Queue',
    includeSocket: true,
    entries,
    filter,
    counts,
    page,
    hasNext,
    allEmojis: ALL_EMOJIS,
    escapeHtml,
    renderMarkdownLinks,
    statusBadge,
    autoApprovedBadge,
    formatDate,
    renderAvatar,
    getQueueWarnings
  });
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
