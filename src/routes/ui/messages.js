// Messages routes - agent messaging management
import { Router } from 'express';
import { nanoid } from 'nanoid';
import {
  getMessagingMode, listAgentMessages,
  approveAgentMessage, rejectAgentMessage, deleteAgentMessage,
  clearAgentMessagesByStatus, getMessageCounts, getAgentMessage,
  listApiKeys, createBroadcast, addBroadcastRecipient, listBroadcastsWithRecipients,
  deleteBroadcast, clearBroadcasts
} from '../../lib/db.js';
import { notifyAgentMessage, notifyMessageRejected } from '../../lib/agentNotifier.js';
import { emitCountUpdate } from '../../lib/socketManager.js';
import { escapeHtml, statusBadge, formatDate, simpleNavHeader, socketScript, localizeScript, renderAvatar } from './shared.js';

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
  const broadcastId = nanoid();
  createBroadcast(broadcastId, 'admin', message, recipients.length);

  const delivered = [];
  const failed = [];

  await Promise.all(recipients.map(async (agent) => {
    const payload = {
      type: 'broadcast',
      from: 'admin',
      message: message,
      broadcast_id: broadcastId,
      timestamp: new Date().toISOString(),
      text: `📢 [agentgate] Broadcast from admin:\n${message.substring(0, 500)}`,
      mode: 'now'
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (agent.webhook_token) {
        headers['Authorization'] = `Bearer ${agent.webhook_token}`;
      }

      const response = await fetch(agent.webhook_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
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
      failed.push({ name: agent.name, error: err.message });
      addBroadcastRecipient(broadcastId, agent.name, 'failed', err.message);
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
    <div class="card message-entry broadcast-entry" style="margin-bottom: 20px; border-left: 4px solid #6366f1;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
        <div class="entry-header">
          <span style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; margin-right: 8px;">📢 BROADCAST</span>
          <span class="agent-with-avatar">${renderAvatar(b.from_agent, { size: 24 })}<strong>${escapeHtml(b.from_agent)}</strong></span>
          <span class="help" style="margin-left: 8px;">→ ${b.total_recipients} recipient${b.total_recipients !== 1 ? 's' : ''}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span class="help" style="margin: 0;">${formatDate(b.created_at)}</span>
          <button type="button" class="delete-btn" onclick="deleteBroadcast('${b.id}')" title="Delete">×</button>
        </div>
      </div>
      <div class="message-content">
        <pre style="white-space: pre-wrap; word-wrap: break-word; margin: 0; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px;">${escapeHtml(b.message)}</pre>
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;">
        ${(b.recipients || []).map(r => `
          <span style="padding: 4px 10px; border-radius: 16px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; background: ${r.status === 'delivered' ? 'rgba(52, 211, 153, 0.15)' : 'rgba(239, 68, 68, 0.15)'}; color: ${r.status === 'delivered' ? '#34d399' : '#f87171'}; border: 1px solid ${r.status === 'delivered' ? 'rgba(52, 211, 153, 0.3)' : 'rgba(239, 68, 68, 0.3)'};">
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
          <input type="text" id="reason-${msg.id}" placeholder="Rejection reason (optional)" class="reject-input" style="width: 200px;">
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
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
          <div class="entry-header">
            <span class="agent-with-avatar">${renderAvatar(msg.from_agent, { size: 24 })}<strong>${escapeHtml(msg.from_agent)}</strong></span>
            → 
            <span class="agent-with-avatar">${renderAvatar(msg.to_agent, { size: 24 })}<strong>${escapeHtml(msg.to_agent)}</strong></span>
            <span class="status-badge">${statusBadge(msg.status)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="help" style="margin: 0;">${formatDate(msg.created_at)}</span>
            <button type="button" class="delete-btn" onclick="deleteMessage('${msg.id}')" title="Delete">&times;</button>
          </div>
        </div>

        <div class="message-content">
          <pre style="white-space: pre-wrap; word-wrap: break-word; margin: 0; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px;">${escapeHtml(msg.message)}</pre>
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

  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - Agent Messages</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    .filter-bar { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; align-items: center; }
    .filter-link { padding: 10px 20px; border-radius: 25px; text-decoration: none; background: rgba(255, 255, 255, 0.05); color: #9ca3af; font-weight: 600; font-size: 13px; border: 1px solid rgba(255, 255, 255, 0.1); transition: all 0.3s ease; }
    .filter-link:hover { background: rgba(255, 255, 255, 0.1); color: #e5e7eb; border-color: rgba(255, 255, 255, 0.2); }
    .filter-link.active { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; border-color: transparent; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4); }
    .message-entry { margin-bottom: 20px; }
    .message-actions { margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .back-link { color: #818cf8; text-decoration: none; font-weight: 600; transition: color 0.2s ease; }
    .back-link:hover { color: #ffffff; }
    .delete-btn { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; font-size: 18px; cursor: pointer; padding: 4px 10px; line-height: 1; font-weight: bold; border-radius: 6px; transition: all 0.2s ease; }
    .delete-btn:hover { background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.4); }
    .clear-section { margin-left: auto; display: flex; gap: 10px; }
    .entry-header { display: flex; align-items: center; gap: 12px; }
    .entry-header strong { color: #f3f4f6; font-size: 16px; }
    .rejection-reason { margin-top: 16px; padding: 16px; background: rgba(239, 68, 68, 0.1); border-radius: 10px; border-left: 4px solid #f87171; color: #e5e7eb; }
    .rejection-reason strong { color: #f87171; }
    .empty-state { text-align: center; padding: 60px 40px; }
    .empty-state p { color: #6b7280; margin: 0; font-size: 16px; }
    .reject-input { padding: 10px 14px; margin: 0; font-size: 13px; background: rgba(15, 15, 25, 0.6); border: 2px solid rgba(239, 68, 68, 0.2); border-radius: 8px; color: #f3f4f6; }
    .reject-input:focus { outline: none; border-color: #f87171; box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.15); }
    .reject-input::placeholder { color: #6b7280; }
    .mode-badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3); }
  </style>
</head>
<body>
  ${simpleNavHeader()}
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <h2 style="margin: 0;">Agent Messages</h2>
    <span class="mode-badge">Mode: ${mode}</span>
  </div>
  <p>Review and approve messages between agents${mode === 'supervised' ? ' (supervised mode)' : ''}.</p>

  <div class="card" style="margin-bottom: 24px;">
    <h3 style="margin-top: 0; display: flex; align-items: center; gap: 8px;">
      <span>📢</span> Broadcast Message
    </h3>
    <p class="help" style="margin-bottom: 16px;">Send a message to all agents with webhooks configured.</p>
    <form method="POST" action="/ui/messages/broadcast" id="broadcast-form">
      <textarea name="message" id="broadcast-message" placeholder="Enter your broadcast message..." rows="3" style="width: 100%; margin-bottom: 12px; padding: 12px; background: rgba(15, 15, 25, 0.6); border: 2px solid rgba(99, 102, 241, 0.2); border-radius: 8px; color: #f3f4f6; font-family: inherit; resize: vertical;" required></textarea>
      <div style="display: flex; gap: 12px; align-items: center;">
        <button type="submit" class="btn-primary" id="broadcast-btn">Send Broadcast</button>
        <span id="broadcast-status" class="help" style="margin: 0;"></span>
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
      <a href="/ui/messages/export?format=json" class="btn-sm" style="text-decoration: none;">Export JSON</a>
      <a href="/ui/messages/export?format=csv" class="btn-sm" style="text-decoration: none;">Export CSV</a>
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
          status.style.color = '#f87171';
        } else {
          const deliveredNames = data.delivered.join(', ') || 'none';
          const failedCount = data.failed.length;
          status.textContent = '✅ Delivered to: ' + deliveredNames + (failedCount > 0 ? ' | Failed: ' + failedCount : '');
          status.style.color = '#34d399';
          document.getElementById('broadcast-message').value = '';
        }
      } catch (err) {
        status.textContent = '❌ Error: ' + err.message;
        status.style.color = '#f87171';
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
