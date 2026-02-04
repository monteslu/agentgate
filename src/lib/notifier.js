import { getSetting, updateQueueNotification } from './db.js';

/**
 * Send a notification to Clawdbot webhook when queue items complete/fail
 */

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5000;

/**
 * Format the notification text for a queue entry
 */
function formatNotification(entry) {
  const emoji = entry.status === 'completed' ? '✅' :
    entry.status === 'failed' ? '❌' : '🚫';

  let text = `${emoji} [agentgate] Queue #${entry.id} ${entry.status}`;
  text += `\n→ ${entry.service}/${entry.account_name}`;

  // Include key result info (e.g., PR URL, issue URL)
  if (entry.results?.length) {
    const firstResult = entry.results[0];
    if (firstResult.body) {
      // GitHub PR/Issue
      if (firstResult.body.html_url) {
        text += `\n→ ${firstResult.body.html_url}`;
      }
      // Other useful fields
      else if (firstResult.body.url) {
        text += `\n→ ${firstResult.body.url}`;
      }
    }
  }

  // Include error info for failures
  if (entry.status === 'failed' && entry.results?.length) {
    // Find the failing result (first non-ok one, or last one if all look ok)
    const failingResult = entry.results.find(r => !r.ok) || entry.results[entry.results.length - 1];
    if (failingResult.error) {
      text += `\n→ Error: ${failingResult.error}`;
    } else if (failingResult.body?.message) {
      text += `\n→ Error: ${failingResult.body.message}`;
    } else if (!failingResult.ok && failingResult.status) {
      text += `\n→ Error: HTTP ${failingResult.status}`;
    }
  }

  // Include rejection reason
  if (entry.status === 'rejected' && entry.rejection_reason) {
    text += `\n→ Reason: ${entry.rejection_reason}`;
  }

  // Original comment/intent
  if (entry.comment) {
    // Truncate long comments
    const comment = entry.comment.length > 100
      ? entry.comment.substring(0, 100) + '...'
      : entry.comment;
    text += `\nOriginal: "${comment}"`;
  }

  return text;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send notification to Clawdbot
 * @param {object} entry - The queue entry to notify about
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function notifyClawdbot(entry) {
  const config = getSetting('notifications');

  if (!config?.clawdbot?.enabled) {
    return { success: true, skipped: true };
  }

  const { url, token, events, retryAttempts, retryDelayMs } = config.clawdbot;

  // Check if this event type should be notified
  const allowedEvents = events || ['completed', 'failed'];
  if (!allowedEvents.includes(entry.status)) {
    return { success: true, skipped: true };
  }

  if (!url || !token) {
    const error = 'Clawdbot notification config incomplete (missing url or token)';
    updateQueueNotification(entry.id, false, error);
    return { success: false, error };
  }

  const payload = {
    text: formatNotification(entry),
    mode: 'now'
  };

  const maxAttempts = retryAttempts || DEFAULT_RETRY_ATTEMPTS;
  const delay = retryDelayMs || DEFAULT_RETRY_DELAY_MS;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        // Success
        updateQueueNotification(entry.id, true, null);
        return { success: true };
      }

      // Non-OK response
      const text = await response.text().catch(() => '');
      lastError = `HTTP ${response.status}: ${text.substring(0, 100)}`;

    } catch (err) {
      lastError = err.message;
    }

    // Retry after delay (unless last attempt)
    if (attempt < maxAttempts) {
      await sleep(delay);
    }
  }

  // All retries failed
  updateQueueNotification(entry.id, false, lastError);
  return { success: false, error: lastError };
}

/**
 * Retry notification for a specific queue entry
 */
export async function retryNotification(entryId, getQueueEntry) {
  const entry = getQueueEntry(entryId);
  if (!entry) {
    return { success: false, error: 'Queue entry not found' };
  }

  // Only retry for completed/failed/rejected entries
  if (!['completed', 'failed', 'rejected'].includes(entry.status)) {
    return { success: false, error: 'Can only notify for completed/failed/rejected entries' };
  }

  return notifyClawdbot(entry);
}

/**
 * Format a short summary line for batch notifications
 */
function formatBatchLine(entry) {
  const emoji = entry.status === 'completed' ? '✅' :
    entry.status === 'failed' ? '❌' : '🚫';

  let line = `${emoji} #${entry.id.substring(0, 8)} - ${entry.service}/${entry.account_name}`;

  // Add brief result info
  if (entry.status === 'completed' && entry.results?.[0]?.body?.html_url) {
    line += ` - ${entry.results[0].body.html_url}`;
  } else if (entry.status === 'failed') {
    // Find the failing result
    const failingResult = entry.results?.find(r => !r.ok) || entry.results?.[entry.results.length - 1];
    const err = failingResult?.error || failingResult?.body?.message || (failingResult && !failingResult.ok ? `HTTP ${failingResult.status || '?'}` : 'Unknown error');
    line += ` - ${err.substring(0, 50)}`;
  } else if (entry.status === 'rejected') {
    line += ` - ${(entry.rejection_reason || 'rejected').substring(0, 50)}`;
  }

  return line;
}

/**
 * Send a single batched notification for multiple queue entries
 * @param {object[]} entries - Array of queue entries to notify about
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function notifyClawdbotBatch(entries) {
  const config = getSetting('notifications');

  if (!config?.clawdbot?.enabled) {
    return { success: true, skipped: true };
  }

  const { url, token, retryAttempts, retryDelayMs } = config.clawdbot;

  if (!url || !token) {
    const error = 'Clawdbot notification config incomplete (missing url or token)';
    for (const entry of entries) {
      updateQueueNotification(entry.id, false, error);
    }
    return { success: false, error };
  }

  // Build batched message
  const completed = entries.filter(e => e.status === 'completed').length;
  const failed = entries.filter(e => e.status === 'failed').length;
  const rejected = entries.filter(e => e.status === 'rejected').length;

  const counts = [];
  if (completed) counts.push(`${completed} completed`);
  if (failed) counts.push(`${failed} failed`);
  if (rejected) counts.push(`${rejected} rejected`);

  let text = `📬 [agentgate] Catch-up: ${entries.length} item${entries.length > 1 ? 's' : ''} (${counts.join(', ')})\n\n`;
  text += entries.map(formatBatchLine).join('\n');

  const payload = { text, mode: 'now' };

  const maxAttempts = retryAttempts || DEFAULT_RETRY_ATTEMPTS;
  const delay = retryDelayMs || DEFAULT_RETRY_DELAY_MS;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        // Success - mark all as notified
        for (const entry of entries) {
          updateQueueNotification(entry.id, true, null);
        }
        return { success: true };
      }

      const respText = await response.text().catch(() => '');
      lastError = `HTTP ${response.status}: ${respText.substring(0, 100)}`;

    } catch (err) {
      lastError = err.message;
    }

    if (attempt < maxAttempts) {
      await sleep(delay);
    }
  }

  // All retries failed
  for (const entry of entries) {
    updateQueueNotification(entry.id, false, lastError);
  }
  return { success: false, error: lastError };
}
