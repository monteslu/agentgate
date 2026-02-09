// Queue service layer - shared business logic for HTTP and MCP
import {
  createQueueEntry,
  getQueueEntry,
  getAccountCredentials,
  listQueueEntriesBySubmitter,
  updateQueueStatus,
  getSharedQueueVisibility,
  listAllQueueEntries,
  getAgentWithdrawEnabled,
  checkServiceAccess,
  checkBypassAuth,
  markAutoApproved,
  addQueueWarning,
  getQueueWarnings
} from '../lib/db.js';
import { emitCountUpdate, emitEvent } from '../lib/socketManager.js';
import { executeQueueEntry } from '../lib/queueExecutor.js';
import { notifyAgentQueueWarning } from '../lib/agentNotifier.js';

// Valid services that support write operations
const VALID_SERVICES = ['github', 'bluesky', 'reddit', 'mastodon', 'calendar', 'google_calendar', 'youtube', 'linkedin', 'jira', 'fitbit'];

// Valid HTTP methods for write operations
const VALID_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Submit a write request for approval
 * @param {string} agentName - Name of the agent submitting the request
 * @param {string} service - Service name (github, bluesky, etc.)
 * @param {string} accountName - Account name for the service
 * @param {Array} requests - Array of request objects with method, path, body, headers
 * @param {string} comment - Optional comment about the request
 * @param {Object} options - Options object
 * @param {boolean} options.emitEvents - Whether to emit socket.io events (default: true)
 * @returns {Object} Queue entry object
 * @throws {Error} If validation fails or execution errors occur
 */
export async function submitWriteRequest(
  agentName,
  service,
  accountName,
  requests,
  comment,
  { emitEvents = true } = {}
) {
  // Validate service
  if (!VALID_SERVICES.includes(service)) {
    throw new Error(`Invalid service. Must be one of: ${VALID_SERVICES.join(', ')}`);
  }

  // Check account exists
  const creds = getAccountCredentials(service, accountName);
  if (!creds) {
    throw new Error(`No ${service} account named "${accountName}" is configured`);
  }

  // Check service access
  const access = checkServiceAccess(service, accountName, agentName);
  if (!access.allowed) {
    const error = new Error(`Agent '${agentName}' does not have access to service '${service}/${accountName}'`);
    error.reason = access.reason;
    throw error;
  }

  // Validate requests array
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('requests must be a non-empty array');
  }

  // Validate each request in the batch
  for (let i = 0; i < requests.length; i++) {
    const req_item = requests[i];

    if (!req_item.method || !VALID_METHODS.includes(req_item.method.toUpperCase())) {
      throw new Error(`Request ${i}: method must be one of: ${VALID_METHODS.join(', ')}`);
    }

    if (!req_item.path || typeof req_item.path !== 'string') {
      throw new Error(`Request ${i}: path is required and must be a string`);
    }

    // Normalize method to uppercase
    requests[i].method = req_item.method.toUpperCase();
  }

  // Check if agent has bypass_auth enabled for this service
  const hasBypass = checkBypassAuth(service, accountName, agentName);

  // Create the queue entry
  const entry = createQueueEntry(service, accountName, requests, comment, agentName);

  // If bypass enabled, auto-approve with audit trail
  if (hasBypass) {
    try {
      markAutoApproved(entry.id);
      updateQueueStatus(entry.id, 'approved');
      await executeQueueEntry({ ...entry, status: 'approved' });
      const updatedEntry = getQueueEntry(entry.id);

      if (emitEvents) {
        emitCountUpdate();
      }

      return {
        ...updatedEntry,
        bypassed: true,
        message: 'Request auto-approved and executed (bypass_auth)'
      };
    } catch (err) {
      updateQueueStatus(entry.id, 'failed', { results: [{ error: err.message }] });

      if (emitEvents) {
        emitCountUpdate();
      }

      const error = new Error('Bypass execution failed');
      error.queueId = entry.id;
      error.status = 'failed';
      error.bypassed = true;
      error.details = err.message;
      throw error;
    }
  }

  // Emit real-time update
  if (emitEvents) {
    emitCountUpdate();
  }

  return {
    ...entry,
    message: 'Request queued for approval'
  };
}

/**
 * List queue entries for an agent
 * @param {string} agentName - Name of the agent
 * @param {string} service - Optional service filter
 * @param {string} accountName - Optional account filter
 * @returns {Object} Object with count, shared_visibility, and entries array
 */
export function listQueueEntries(agentName, service = null, accountName = null) {
  const sharedVisibility = getSharedQueueVisibility();
  const entries = sharedVisibility
    ? listAllQueueEntries(service, accountName)
    : listQueueEntriesBySubmitter(agentName, service, accountName);

  return {
    count: entries.length,
    shared_visibility: sharedVisibility,
    entries: entries
  };
}

/**
 * Get status of a queue entry
 * @param {string} id - Queue entry ID
 * @param {string} service - Service name (for verification)
 * @param {string} accountName - Account name (for verification)
 * @returns {Object} Queue entry status object
 * @throws {Error} If entry not found or doesn't match service/account
 */
export function getQueueStatus(id, service, accountName) {
  const entry = getQueueEntry(id);

  if (!entry) {
    throw new Error(`No queue entry with id "${id}"`);
  }

  // Verify the entry belongs to this service/account
  if (entry.service !== service || entry.account_name !== accountName) {
    throw new Error(`No queue entry with id "${id}" for ${service}/${accountName}`);
  }

  // Build response based on status
  const response = {
    id: entry.id,
    status: entry.status,
    submitted_at: entry.submitted_at
  };

  if (entry.status === 'rejected') {
    response.rejection_reason = entry.rejection_reason;
    response.reviewed_at = entry.reviewed_at;
  }

  if (entry.status === 'completed' || entry.status === 'failed') {
    response.results = entry.results;
    response.completed_at = entry.completed_at;
  }

  if (entry.status === 'executing') {
    response.message = 'Request is currently being executed';
  }

  return response;
}

/**
 * Withdraw a pending queue entry
 * @param {string} id - Queue entry ID
 * @param {string} agentName - Name of the agent withdrawing
 * @param {string} reason - Optional withdrawal reason
 * @param {Object} options - Options object
 * @param {boolean} options.emitEvents - Whether to emit socket.io events (default: true)
 * @returns {Object} Success response with id and reason
 * @throws {Error} If withdraw is disabled, entry not found, wrong submitter, or wrong status
 */
export function withdrawQueueEntry(id, agentName, reason = null, { emitEvents = true } = {}) {
  // Check if withdraw is enabled
  if (!getAgentWithdrawEnabled()) {
    throw new Error('Agent withdraw is not enabled. Ask admin to enable agent_withdraw_enabled setting.');
  }

  const entry = getQueueEntry(id);

  if (!entry) {
    throw new Error('Queue entry not found');
  }

  // Verify the requesting agent is the submitter
  if (entry.submitted_by !== agentName) {
    throw new Error('You can only withdraw your own submissions');
  }

  // Only allow withdrawal of pending items
  if (entry.status !== 'pending') {
    throw new Error(`Cannot withdraw entry with status "${entry.status}". Only pending items can be withdrawn.`);
  }

  // Update status to withdrawn (with optional reason)
  updateQueueStatus(id, 'withdrawn', {
    reviewed_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
    rejection_reason: reason || null
  });

  // Emit real-time update
  if (emitEvents) {
    emitCountUpdate();
  }

  return {
    success: true,
    message: 'Queue entry withdrawn',
    id: id,
    reason: reason || null
  };
}

/**
 * Add a warning to a queue entry (peer review)
 * @param {string} id - Queue entry ID
 * @param {string} agentName - Name of the agent adding the warning
 * @param {string} message - Warning message
 * @param {Object} options - Options object
 * @param {boolean} options.emitEvents - Whether to emit socket.io events (default: true)
 * @returns {Object} Success response with warning_id
 * @throws {Error} If validation fails or entry can't be warned
 */
export async function addWarningToQueue(id, agentName, message, { emitEvents = true } = {}) {
  if (!agentName) {
    throw new Error('Agent authentication required');
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('Warning message is required');
  }

  const entry = getQueueEntry(id);

  if (!entry) {
    throw new Error('Queue entry not found');
  }

  // Only allow warnings on pending items
  if (entry.status !== 'pending') {
    throw new Error(`Cannot add warning to entry with status "${entry.status}". Only pending items can be warned.`);
  }

  // Cannot warn your own items (should withdraw instead)
  if (entry.submitted_by === agentName) {
    throw new Error('Cannot warn your own submission. Use withdraw instead.');
  }

  // Add the warning
  const warningId = addQueueWarning(id, agentName, message.trim());

  // Notify the submitting agent
  if (entry.submitted_by) {
    notifyAgentQueueWarning(entry, agentName, message.trim()).catch(err => {
      console.error('Failed to notify agent of warning:', err.message);
    });
  }

  // Emit socket event for real-time UI update
  if (emitEvents) {
    const warnings = getQueueWarnings(id);
    emitEvent('queueItemUpdate', {
      id,
      type: 'warning_added',
      warningCount: warnings.length,
      warnings
    });
  }

  return {
    success: true,
    message: 'Warning added',
    warning_id: warningId,
    queue_id: id
  };
}

/**
 * Get warnings for a queue entry
 * @param {string} id - Queue entry ID
 * @returns {Object} Object with warnings array
 * @throws {Error} If entry not found
 */
export function getWarningsForQueue(id) {
  const entry = getQueueEntry(id);
  if (!entry) {
    throw new Error('Queue entry not found');
  }

  const warnings = getQueueWarnings(id);
  return { warnings };
}
