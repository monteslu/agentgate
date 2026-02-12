// Agent notification delivery - sends webhooks to agent gateways
import { getApiKeyByName, updateQueueNotification, getQueueWarnings } from './db.js';

// Default per-agent webhook timeout (ms)
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.AGENTGATE_WEBHOOK_TIMEOUT_MS, 10) || 10000;

// Send a notification to an agent's webhook
export async function notifyAgent(agentName, payload, { timeoutMs = WEBHOOK_TIMEOUT_MS } = {}) {
  const agent = getApiKeyByName(agentName);

  if (!agent) {
    return { success: false, error: `Agent "${agentName}" not found` };
  }

  if (!agent.webhook_url) {
    return { success: false, error: `Agent "${agentName}" has no webhook configured` };
  }

  try {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (agent.webhook_token) {
      headers['Authorization'] = `Bearer ${agent.webhook_token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(agent.webhook_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (response.ok) {
        return { success: true };
      } else {
        const text = await response.text().catch(() => '');
        return { success: false, error: `HTTP ${response.status}: ${text.substring(0, 200)}` };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return { success: false, error: `Webhook timeout after ${timeoutMs}ms` };
    }
    return { success: false, error: err.message };
  }
}

// Notify agent about a queue item status change
export async function notifyAgentQueueStatus(entry) {
  const agentName = entry.submitted_by;
  if (!agentName) {
    return { success: false, error: 'No submitter on queue entry' };
  }

  const agent = getApiKeyByName(agentName);
  if (!agent?.webhook_url) {
    // Agent doesn't have webhook configured - that's ok, just skip
    return { success: false, error: 'No webhook configured' };
  }

  const statusEmoji = {
    completed: '✅',
    failed: '❌',
    rejected: '🚫'
  };

  // Build reaction suffix if emoji was added
  const reactionSuffix = entry.reaction_emoji ? ` ${entry.reaction_emoji}` : '';

  const payload = {
    type: 'queue_status',
    entry: {
      id: entry.id,
      service: entry.service,
      account_name: entry.account_name,
      status: entry.status,
      comment: entry.comment,
      rejection_reason: entry.rejection_reason,
      reaction_emoji: entry.reaction_emoji,
      results: entry.results
    },
    // Also include a human-readable message for Clawdbot-style gateways
    text: `${statusEmoji[entry.status] || '📋'} [agentgate] Queue #${entry.id} ${entry.auto_approved ? 'auto-approved + ' : ''}${entry.status}${reactionSuffix}\n→ ${entry.service}/${entry.account_name}${entry.rejection_reason ? `\nReason: ${entry.rejection_reason}` : ''}${entry.comment ? `\nOriginal: "${entry.comment.substring(0, 100)}"` : ''}`,
    mode: 'now'
  };

  const result = await notifyAgent(agentName, payload);

  // Update notification status in db
  if (result.success) {
    updateQueueNotification(entry.id, true);
  } else {
    updateQueueNotification(entry.id, false, result.error);
  }

  // Also notify any agents who warned on this item
  await notifyWarningAgentsOnResolution(entry);

  return result;
}

// Notify all agents who warned on a queue item when it's resolved
async function notifyWarningAgentsOnResolution(entry) {
  const warnings = getQueueWarnings(entry.id);
  if (!warnings || warnings.length === 0) {
    return;
  }

  // Get unique warning agent IDs (excluding the submitter - they already get notified)
  const warningAgents = [...new Set(warnings.map(w => w.agent_id))]
    .filter(agentId => agentId !== entry.submitted_by);

  if (warningAgents.length === 0) {
    return;
  }

  const statusEmoji = {
    completed: '✅',
    failed: '❌',
    rejected: '🚫',
    approved: '✅'
  };

  for (const agentId of warningAgents) {
    const payload = {
      type: 'queue_warning_resolved',
      entry: {
        id: entry.id,
        service: entry.service,
        account_name: entry.account_name,
        status: entry.status,
        comment: entry.comment,
        rejection_reason: entry.rejection_reason,
        submitted_by: entry.submitted_by
      },
      // Human-readable for Clawdbot-style gateways
      text: `${statusEmoji[entry.status] || '📋'} [agentgate] Queue #${entry.id} you warned on was ${entry.status}\n→ ${entry.service}/${entry.account_name}\nSubmitted by: ${entry.submitted_by}${entry.rejection_reason ? `\nReason: ${entry.rejection_reason}` : ''}`,
      mode: 'now'
    };

    // Fire and forget - don't block on warning agent notifications
    notifyAgent(agentId, payload).catch(err => {
      console.error(`[agentNotifier] Failed to notify warning agent ${agentId}:`, err.message);
    });
  }
}

// Notify agent about a warning on their queue submission
export async function notifyAgentQueueWarning(entry, warningAgent, warningMessage) {
  const agentName = entry.submitted_by;
  if (!agentName) {
    return { success: false, error: 'No submitter on queue entry' };
  }

  const agent = getApiKeyByName(agentName);
  if (!agent?.webhook_url) {
    return { success: false, error: 'No webhook configured' };
  }

  const payload = {
    type: 'queue_warning',
    entry: {
      id: entry.id,
      service: entry.service,
      account_name: entry.account_name,
      status: entry.status,
      comment: entry.comment
    },
    warning: {
      from: warningAgent,
      message: warningMessage
    },
    text: `⚠️ [agentgate] Warning on Queue #${entry.id}\n→ ${entry.service}/${entry.account_name}\nFrom: ${warningAgent}\n"${warningMessage.substring(0, 200)}"`,
    mode: 'now'
  };

  return await notifyAgent(agentName, payload);
}

// Notify agent about a new message (delivered to recipient)
export async function notifyAgentMessage(message) {
  const agentName = message.to_agent;

  const agent = getApiKeyByName(agentName);
  if (!agent?.webhook_url) {
    return { success: false, error: 'No webhook configured' };
  }

  const payload = {
    type: 'agent_message',
    message: {
      id: message.id,
      from: message.from_agent,
      message: message.message,
      created_at: message.created_at,
      delivered_at: message.delivered_at
    },
    // Human-readable for Clawdbot-style gateways
    text: `💬 [agentgate] Message from ${message.from_agent}:\n${message.message.substring(0, 500)}`,
    mode: 'now'
  };

  return notifyAgent(agentName, payload);
}

// Notify sender that their message was rejected
export async function notifyMessageRejected(message) {
  const agentName = message.from_agent;

  const agent = getApiKeyByName(agentName);
  if (!agent?.webhook_url) {
    return { success: false, error: 'No webhook configured' };
  }

  const payload = {
    type: 'message_rejected',
    message: {
      id: message.id,
      to: message.to_agent,
      message: message.message,
      rejection_reason: message.rejection_reason,
      created_at: message.created_at,
      rejected_at: message.reviewed_at
    },
    // Human-readable for Clawdbot-style gateways
    text: `🚫 [agentgate] Message to ${message.to_agent} was rejected${message.rejection_reason ? `\nReason: ${message.rejection_reason}` : ''}\nOriginal: "${message.message.substring(0, 200)}"`,
    mode: 'now'
  };

  return notifyAgent(agentName, payload);
}

// Batch notify multiple agents about their messages (parallel)
export async function notifyAgentMessagesBatch(messages) {
  const settled = await Promise.allSettled(
    messages.map(async (msg) => {
      const result = await notifyAgentMessage(msg);
      return { messageId: msg.id, ...result };
    })
  );
  return settled.map(s => s.status === 'fulfilled' ? s.value : { success: false, error: s.reason?.message || 'Unknown error' });
}
