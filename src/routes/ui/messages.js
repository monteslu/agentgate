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
import { escapeHtml, statusBadge, formatDate, htmlHead, navHeader, socketScript, localizeScript, menuScript, renderAvatar } from './shared.js';

const router = Router();

// Agent Messages Queue
router.get('/', (req, res) => {
  const filter = req.query.filter || 'all';
  let messages;
  if (filter === 'all') {
    messages = listAgentMessages();
  } else {
    messages = listAgentMessages(filter);
  }
  const counts = getMessageCounts();
  const mode = getMessagingMode();
  const broadcasts = listBroadcastsWithRecipients(10); // Last 10 broadcasts
  res.send(renderMessagesPage(messages, filter, counts, mode, broadcasts));
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

// Broadcast message to all agents
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

  // Create broadcast record in database
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

// Delete a single broadcast
router.post('/broadcast/:id/delete', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  deleteBroadcast(id);

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/messages');
});

// Clear all broadcasts
router.post('/broadcasts/clear', (req, res) => {
  const wantsJson = req.headers.accept?.includes('application/json');

  clearBroadcasts();

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/messages');
});

// Render function
function renderMessagesPage(messages, filter, counts, mode, broadcasts = []) {
  // Combine messages and broadcasts into a unified timeline
  const messageItems = messages.map(m => ({ ...m, _type: 'message' }));
  const broadcastItems = broadcasts.map(b => ({ ...b, _type: 'broadcast' }));
  const timeline = [...messageItems, ...broadcastItems].sort((a, b) => 
    new Date(b.created_at) - new Date(a.created_at)
  );

  const renderBroadcast = (b) => `
    <div class="card message-entry broadcast-entry" class="accent-border-left">
      <div class="flex-between mb-12" style="align-items: flex-start;">
        <div class="entry-header">
          <span class="primary-badge">📢 BROADCAST</span>
          <span class="agent-with-avatar">${renderAvatar(b.from_agent, { size: 24 })}<strong>${escapeHtml(b.from_agent)}</strong></span>
          <span class="help" class="ml-8">→ ${b.total_recipients} recipient${b.total_recipients !== 1 ? 's' : ''}</span>
        </div>
        <div class="flex-center gap-12">
          <span class="help" class="m-0">${formatDate(b.created_at)}</span>
          <button type="button" class="delete-btn" onclick="deleteBroadcast('${b.id}')" title="Delete">×</button>
        </div>
      </div>
      <div class="message-content">
        <pre class="bubble-content">${escapeHtml(b.message)}</pre>
      </div>
      <div class="flex gap-8 flex-wrap mt-12">
        ${(b.recipients || []).map(r => `
          <span class="recipient-badge ${r.status === 'delivered' ? 'recipient-delivered' : 'recipient-failed'}">
            ${renderAvatar(r.to_agent, { size: 18 })}${escapeHtml(r.to_agent)} ${r.status === 'delivered' ? '✓' : '✗'}
          </span>
        `).join('')}
      </div>
    </div>
  `;

  const renderMessage = (msg) => {
    let actions = '';
    if (msg.status === 'pending') {
      actions = `
        <div class="message-actions">
          <button type="button" class="btn-primary btn-sm" onclick="approveMessage('${msg.id}')">Approve</button>
          <input type="text" id="reason-${msg.id}" placeholder="Rejection reason (optional)" class="reject-input" class="w-200" autocomplete="off">
          <button type="button" class="btn-danger btn-sm" onclick="rejectMessage('${msg.id}')">Reject</button>
        </div>
      `;
    }

    let rejectionSection = '';
    if (msg.rejection_reason) {
      rejectionSection = `
        <div class="rejection-reason">
          <strong>Rejection reason:</strong> ${escapeHtml(msg.rejection_reason)}
        </div>
      `;
    }

    return `
      <div class="card message-entry" id="message-${msg.id}" data-status="${msg.status}">
        <div class="flex-between mb-12" style="align-items: flex-start;">
          <div class="entry-header">
            <span class="agent-with-avatar">${renderAvatar(msg.from_agent, { size: 24 })}<strong>${escapeHtml(msg.from_agent)}</strong></span>
            → 
            <span class="agent-with-avatar">${renderAvatar(msg.to_agent, { size: 24 })}<strong>${escapeHtml(msg.to_agent)}</strong></span>
            <span class="status-badge">${statusBadge(msg.status)}</span>
          </div>
          <div class="flex-center gap-12">
            <span class="help" class="m-0">${formatDate(msg.created_at)}</span>
            <button type="button" class="delete-btn" onclick="deleteMessage('${msg.id}')" title="Delete">&times;</button>
          </div>
        </div>

        <div class="message-content">
          <pre class="bubble-content">${escapeHtml(msg.message)}</pre>
        </div>

        ${rejectionSection}
        ${actions}
      </div>
    `;
  };

  const filters = ['all', 'pending', 'delivered', 'rejected'];
  const filterLinks = filters.map(f =>
    `<a href="/ui/messages?filter=${f}" class="filter-link ${filter === f ? 'active' : ''}">${f}${counts[f] > 0 ? ` (${counts[f]})` : ''}</a>`
  ).join('');

  return `${htmlHead('Agent Messages', { includeSocket: true })}
  
<body>
  ${navHeader()}
  <div class="flex-between mb-16">
    <h2 class="m-0">Agent Messages</h2>
    <span class="mode-badge">Mode: ${mode}</span>
  </div>
  <p>Review and approve messages between agents${mode === 'supervised' ? ' (supervised mode)' : ''}.</p>

  <div class="card" class="mb-24">
    <h3 class="mt-0 flex-center gap-8">
      <span>📢</span> Broadcast Message
    </h3>
    <p class="help" class="mb-16">Send a message to all agents with webhooks configured.</p>
    <form method="POST" action="/ui/messages/broadcast" id="broadcast-form">
      <textarea name="message" id="broadcast-message" placeholder="Enter your broadcast message..." rows="3" class="textarea-input" required autocomplete="off"></textarea>
      <div class="flex-center gap-12">
        <button type="submit" class="btn-primary" id="broadcast-btn">Send Broadcast</button>
        <span id="broadcast-status" class="help" class="m-0"></span>
      </div>
    </form>
  </div>

  <h3>Timeline</h3>

  <div class="filter-bar" id="filter-bar">
    ${filterLinks}
    <div class="clear-section">
      ${filter === 'delivered' && counts.delivered > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'delivered\')">Clear Delivered</button>' : ''}
      ${filter === 'rejected' && counts.rejected > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'rejected\')">Clear Rejected</button>' : ''}
      ${filter === 'all' && (counts.delivered > 0 || counts.rejected > 0) ? '<button type="button" class="btn-sm btn-danger" onclick="clearByStatus(\'all\')">Clear All Non-Pending</button>' : ''}
      ${broadcasts.length > 0 ? '<button type="button" class="btn-sm btn-danger" onclick="clearBroadcasts()">Clear Broadcasts</button>' : ''}
      <a href="/ui/messages/export?format=json" class="btn-sm" class="no-underline">Export JSON</a>
      <a href="/ui/messages/export?format=csv" class="btn-sm" class="no-underline">Export CSV</a>
    </div>
  </div>

  <div id="messages-container">
  ${timeline.length === 0 ? `
    <div class="card empty-state">
      <p>No ${filter === 'all' ? '' : filter + ' '}messages</p>
    </div>
  ` : timeline.map(item => item._type === 'broadcast' ? renderBroadcast(item) : renderMessage(item)).join('')}
  </div>

  <script>
    function escapeHtml(str) {
      if (typeof str !== 'string') str = JSON.stringify(str, null, 2);
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    document.getElementById('broadcast-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('broadcast-btn');
      const status = document.getElementById('broadcast-status');
      const message = document.getElementById('broadcast-message').value;

      btn.disabled = true;
      btn.textContent = 'Sending...';
      status.textContent = '';

      try {
        const res = await fetch('/ui/messages/broadcast', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'message=' + encodeURIComponent(message)
        });
        const data = await res.json();

        if (data.error) {
          status.textContent = '❌ ' + data.error;
          status.className = 'status-error';
        } else {
          const deliveredNames = data.delivered.join(', ') || 'none';
          const failedCount = data.failed.length;
          status.textContent = '✅ Delivered to: ' + deliveredNames + (failedCount > 0 ? ' | Failed: ' + failedCount : '');
          status.className = 'status-success';
          document.getElementById('broadcast-message').value = '';
        }
      } catch (err) {
        status.textContent = '❌ Error: ' + err.message;
        status.className = 'status-error';
      }

      btn.disabled = false;
      btn.textContent = 'Send Broadcast';
    });

    async function approveMessage(id) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Approving...';
      try {
        const res = await fetch('/ui/messages/' + id + '/approve', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
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

    async function rejectMessage(id) {
      const btn = event.target;
      const reason = document.getElementById('reason-' + id)?.value || '';
      btn.disabled = true;
      btn.textContent = 'Rejecting...';
      try {
        const res = await fetch('/ui/messages/' + id + '/reject', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
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

    async function deleteMessage(id) {
      if (!confirm('Delete this message?')) return;
      try {
        const res = await fetch('/ui/messages/' + id + '/delete', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          document.getElementById('message-' + id)?.remove();
          const container = document.getElementById('messages-container');
          if (container.querySelectorAll('.message-entry').length === 0) {
            container.innerHTML = '<div class="card empty-state"><p>No messages</p></div>';
          }
        } else {
          alert(data.error || 'Failed to delete');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function deleteBroadcast(id) {
      if (!confirm('Delete this broadcast?')) return;
      try {
        const res = await fetch('/ui/messages/broadcast/' + id + '/delete', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          alert(data.error || 'Failed to delete broadcast');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function clearBroadcasts() {
      if (!confirm('Clear all broadcasts?')) return;
      try {
        const res = await fetch('/ui/messages/broadcasts/clear', { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          alert(data.error || 'Failed to clear broadcasts');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function clearByStatus(status) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Clearing...';
      try {
        const res = await fetch('/ui/messages/clear', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
      }
    }
  </script>
${socketScript()}
${menuScript()}
${localizeScript()}
</body>
</html>`;
}

// Export messages data
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
