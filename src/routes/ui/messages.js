// Messages routes - agent messaging management
import { Router } from 'express';
import {
  getMessagingMode, listAgentMessages,
  approveAgentMessage, rejectAgentMessage, deleteAgentMessage,
  clearAgentMessagesByStatus, getMessageCounts, getAgentMessage,
  listApiKeys, createBroadcast, addBroadcastRecipient, listBroadcastsWithRecipients,
  deleteBroadcast, clearBroadcasts
} from '../../lib/db.js';
import { notifyAgentMessage, notifyMessageRejected } from '../../lib/agentNotifier.js';
import { emitCountUpdate } from '../../lib/socketManager.js';
import { escapeHtml, statusBadge, formatDate, renderAvatar } from './shared.js';
import { renderPage } from '../../lib/render.js';

const router = Router();
const PAGE_SIZE = 25;

// Agent Messages Queue
router.get('/', (req, res) => {
  const filter = req.query.filter || 'all';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const pagination = { limit: PAGE_SIZE + 1, offset };

  let messages;
  if (filter === 'all') {
    messages = listAgentMessages(null, pagination);
  } else {
    messages = listAgentMessages(filter, pagination);
  }

  const hasNext = messages.length > PAGE_SIZE;
  if (hasNext) messages = messages.slice(0, PAGE_SIZE);

  const counts = getMessageCounts();
  const mode = getMessagingMode();
  const broadcasts = page === 1 ? listBroadcastsWithRecipients(10) : [];

  // Build timeline
  const messageItems = messages.map(m => ({ ...m, _type: 'message' }));
  const broadcastItems = broadcasts.map(b => ({ ...b, _type: 'broadcast' }));
  const timeline = [...messageItems, ...broadcastItems].sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  renderPage(res, 'pages/messages', {
    title: 'Agent Messages',
    includeSocket: true,
    filter,
    counts,
    mode,
    broadcasts,
    timeline,
    page,
    hasNext,
    renderAvatar,
    escapeHtml,
    formatDate,
    statusBadge
  });
});

router.post('/:id/approve', async (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const msg = getAgentMessage(id);
  if (!msg) {
    return wantsJson
      ? res.status(404).json({ error: 'Message not found' })
      : res.status(404).send('Message not found');
  }

  if (msg.status !== 'pending') {
    return wantsJson
      ? res.status(400).json({ error: 'Can only approve pending messages' })
      : res.status(400).send('Can only approve pending messages');
  }

  approveAgentMessage(id);
  const updated = getAgentMessage(id);
  const counts = getMessageCounts();

  emitCountUpdate();

  notifyAgentMessage(updated).catch(err => {
    console.error('[agentNotifier] Failed to notify agent:', err.message);
  });

  if (wantsJson) {
    return res.json({ success: true, message: updated, counts });
  }
  res.redirect('/ui/messages');
});

router.post('/:id/reject', (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  const msg = getAgentMessage(id);
  if (!msg) {
    return wantsJson
      ? res.status(404).json({ error: 'Message not found' })
      : res.status(404).send('Message not found');
  }

  if (msg.status !== 'pending') {
    return wantsJson
      ? res.status(400).json({ error: 'Can only reject pending messages' })
      : res.status(400).send('Can only reject pending messages');
  }

  rejectAgentMessage(id, reason);
  const updated = getAgentMessage(id);
  const counts = getMessageCounts();

  emitCountUpdate();
  notifyMessageRejected(updated);

  if (wantsJson) {
    return res.json({ success: true, message: updated, counts });
  }
  res.redirect('/ui/messages');
});

router.post('/:id/delete', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  deleteAgentMessage(id);
  const counts = getMessageCounts();
  emitCountUpdate();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/messages');
});

router.post('/clear', (req, res) => {
  const { status } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  clearAgentMessagesByStatus(status || 'all');
  if (!status || status === 'all') {
    clearBroadcasts();
  }
  const counts = getMessageCounts();
  emitCountUpdate();

  if (wantsJson) {
    return res.json({ success: true, counts });
  }
  res.redirect('/ui/messages');
});

router.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json');

  if (!message || !message.trim()) {
    if (wantsJson) {
      return res.status(400).json({ error: 'Message is required' });
    }
    return res.redirect('/ui/messages?broadcast_error=Message+is+required');
  }

  const mode = getMessagingMode();
  if (mode === 'off') {
    if (wantsJson) {
      return res.status(403).json({ error: 'Agent messaging is disabled' });
    }
    return res.redirect('/ui/messages?broadcast_error=Messaging+disabled');
  }

  const apiKeys = listApiKeys();
  const recipients = apiKeys.filter(k => k.webhook_url && k.enabled);

  if (recipients.length === 0) {
    if (wantsJson) {
      return res.json({ broadcast_id: null, delivered: [], failed: [], total: 0 });
    }
    return res.redirect('/ui/messages?broadcast_result=No+agents+with+webhooks');
  }

  const broadcastId = createBroadcast('admin', message, recipients.length);

  const delivered = [];
  const failed = [];

  const TIMEOUT_MS = parseInt(process.env.AGENTGATE_WEBHOOK_TIMEOUT_MS, 10) || 10000;

  await Promise.allSettled(recipients.map(async (agent) => {
    const payload = {
      type: 'broadcast',
      from: 'admin',
      message: message,
      broadcast_id: broadcastId,
      timestamp: new Date().toISOString(),
      text: `📢 [agentgate] Broadcast from admin:\n${message.substring(0, 500)}`,
      mode: 'now'
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (agent.webhook_token) {
        headers['Authorization'] = `Bearer ${agent.webhook_token}`;
      }

      const response = await fetch(agent.webhook_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (response.ok) {
        delivered.push(agent.name);
        addBroadcastRecipient(broadcastId, agent.name, 'delivered');
      } else {
        const errorMsg = `HTTP ${response.status}`;
        failed.push({ name: agent.name, error: errorMsg });
        addBroadcastRecipient(broadcastId, agent.name, 'failed', errorMsg);
      }
    } catch (err) {
      const errorMsg = err.name === 'AbortError' ? `Webhook timeout after ${TIMEOUT_MS}ms` : err.message;
      failed.push({ name: agent.name, error: errorMsg });
      addBroadcastRecipient(broadcastId, agent.name, 'failed', errorMsg);
    } finally {
      clearTimeout(timer);
    }
  }));

  if (wantsJson) {
    return res.json({ broadcast_id: broadcastId, delivered, failed, total: recipients.length });
  }

  const resultMsg = `Delivered: ${delivered.length}, Failed: ${failed.length}`;
  res.redirect(`/ui/messages?broadcast_result=${encodeURIComponent(resultMsg)}`);
});

router.post('/broadcast/:id/delete', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  deleteBroadcast(id);

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/messages');
});

router.post('/broadcasts/clear', (req, res) => {
  const wantsJson = req.headers.accept?.includes('application/json');

  clearBroadcasts();

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/messages');
});

router.get('/export', (req, res) => {
  try {
    const format = req.query.format || 'json';
    const messages = listAgentMessages();

    if (format === 'csv') {
      const headers = ['id', 'from_agent', 'to_agent', 'message', 'status', 'rejection_reason', 'created_at', 'delivered_at'];
      const csvRows = [headers.join(',')];
      for (const msg of messages) {
        const row = headers.map(h => {
          const val = msg[h] ?? '';
          const str = String(val).replace(/"/g, '""');
          return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
        });
        csvRows.push(row.join(','));
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="messages-export.csv"');
      return res.send(csvRows.join('\n'));
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="messages-export.json"');
    res.json(messages);
  } catch (err) {
    console.error('Messages export error:', err);
    res.status(500).json({ error: 'Export failed', message: err.message });
  }
});

export default router;
