import { Router } from 'express';
import { createQueueEntry, getQueueEntry, getAccountCredentials, listQueueEntriesBySubmitter, updateQueueStatus, getSharedQueueVisibility, listAllQueueEntries, getAgentWithdrawEnabled, checkServiceAccess, checkBypassAuth, addQueueWarning, getQueueWarnings } from '../lib/db.js';
import { notifyAgentQueueWarning } from '../lib/agentNotifier.js';
import { emitCountUpdate } from '../lib/socketManager.js';
import { executeQueueEntry } from '../lib/queueExecutor.js';

const router = Router();

// Valid services that support write operations
const VALID_SERVICES = ['github', 'bluesky', 'reddit', 'mastodon', 'calendar', 'google_calendar', 'youtube', 'linkedin', 'jira', 'fitbit'];

// Valid HTTP methods for write operations
const VALID_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Submit a batch of write requests for approval
// POST /api/queue/:service/:accountName/submit
router.post('/:service/:accountName/submit', async (req, res) => {
  try {
    const { service, accountName } = req.params;
    const { requests, comment } = req.body;

    // Validate service
    if (!VALID_SERVICES.includes(service)) {
      return res.status(400).json({
        error: 'Invalid service',
        message: `Service must be one of: ${VALID_SERVICES.join(', ')}`
      });
    }

    // Check account exists
    const creds = getAccountCredentials(service, accountName);
    if (!creds) {
      return res.status(404).json({
        error: 'Account not found',
        message: `No ${service} account named "${accountName}" is configured`
      });
    }

    // Check service access
    const agentName = req.apiKeyInfo?.name;
    if (agentName) {
      const access = checkServiceAccess(service, accountName, agentName);
      if (!access.allowed) {
        return res.status(403).json({
          error: `Agent '${agentName}' does not have access to service '${service}/${accountName}'`,
          reason: access.reason
        });
      }
    }


    // Validate requests array
    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(400).json({
        error: 'Invalid requests',
        message: 'requests must be a non-empty array'
      });
    }

    // Validate each request in the batch
    for (let i = 0; i < requests.length; i++) {
      const req_item = requests[i];

      if (!req_item.method || !VALID_METHODS.includes(req_item.method.toUpperCase())) {
        return res.status(400).json({
          error: 'Invalid request method',
          message: `Request ${i}: method must be one of: ${VALID_METHODS.join(', ')}`
        });
      }

      if (!req_item.path || typeof req_item.path !== 'string') {
        return res.status(400).json({
          error: 'Invalid request path',
          message: `Request ${i}: path is required and must be a string`
        });
      }

      // Normalize method to uppercase
      requests[i].method = req_item.method.toUpperCase();
    }

    // Get the API key name for audit trail
    const submittedBy = req.apiKeyInfo?.name || 'unknown';

    // Check if agent has bypass_auth enabled for this service
    const hasBypass = agentName && checkBypassAuth(service, accountName, agentName);

    // Create the queue entry
    const entry = createQueueEntry(service, accountName, requests, comment, submittedBy);

    // If bypass enabled, execute immediately
    if (hasBypass) {
      try {
        updateQueueStatus(entry.id, 'approved');
        await executeQueueEntry({ ...entry, status: 'approved' });
        const updatedEntry = getQueueEntry(entry.id);
        
        emitCountUpdate();
        
        return res.status(200).json({
          id: entry.id,
          status: updatedEntry.status,
          message: 'Request executed immediately (bypass_auth enabled)',
          bypassed: true,
          results: updatedEntry.results
        });
      } catch (err) {
        updateQueueStatus(entry.id, 'failed', { results: [{ error: err.message }] });
        emitCountUpdate();
        
        return res.status(500).json({
          id: entry.id,
          status: 'failed',
          message: 'Bypass execution failed',
          bypassed: true,
          error: err.message
        });
      }
    }

    // Emit real-time update
    emitCountUpdate();

    res.status(201).json({
      id: entry.id,
      status: entry.status,
      message: 'Request queued for approval'
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to queue request',
      message: error.message
    });
  }
});

// List all queue entries submitted by the requesting API key
// GET /api/queue/list (all services) or /api/queue/:service/:accountName/list (filtered)
router.get('/list', (req, res) => {
  try {
    const submittedBy = req.apiKeyInfo?.name || 'unknown';
    const sharedVisibility = getSharedQueueVisibility();
    const entries = sharedVisibility 
      ? listAllQueueEntries() 
      : listQueueEntriesBySubmitter(submittedBy);

    res.json({
      count: entries.length,
      shared_visibility: sharedVisibility,
      entries: entries
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list queue entries',
      message: error.message
    });
  }
});

router.get('/:service/:accountName/list', (req, res) => {
  try {
    const { service, accountName } = req.params;
    const submittedBy = req.apiKeyInfo?.name || 'unknown';

    // Validate service
    if (!VALID_SERVICES.includes(service)) {
      return res.status(400).json({
        error: 'Invalid service',
        message: `Service must be one of: ${VALID_SERVICES.join(', ')}`
      });
    }

    const sharedVisibility = getSharedQueueVisibility();
    const entries = sharedVisibility 
      ? listAllQueueEntries(service, accountName) 
      : listQueueEntriesBySubmitter(submittedBy, service, accountName);

    res.json({
      count: entries.length,
      shared_visibility: sharedVisibility,
      entries: entries
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list queue entries',
      message: error.message
    });
  }
});

// Check status of a queued request
// GET /api/queue/:service/:accountName/status/:id
router.get('/:service/:accountName/status/:id', (req, res) => {
  try {
    const { service, accountName, id } = req.params;

    const entry = getQueueEntry(id);

    if (!entry) {
      return res.status(404).json({
        error: 'Not found',
        message: `No queue entry with id "${id}"`
      });
    }

    // Verify the entry belongs to this service/account
    if (entry.service !== service || entry.account_name !== accountName) {
      return res.status(404).json({
        error: 'Not found',
        message: `No queue entry with id "${id}" for ${service}/${accountName}`
      });
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

    res.json(response);

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get status',
      message: error.message
    });
  }
});


// Withdraw a pending queue item (agent can only withdraw their own submissions)
// DELETE /api/queue/:service/:accountName/status/:id
router.delete('/:service/:accountName/status/:id', (req, res) => {
  try {
    // Check if withdraw is enabled
    if (!getAgentWithdrawEnabled()) {
      return res.status(403).json({
        error: 'Disabled',
        message: 'Agent withdraw is not enabled. Ask admin to enable agent_withdraw_enabled setting.'
      });
    }

    const { id } = req.params;
    const agentName = req.apiKeyInfo?.name || 'unknown'; // Set by auth middleware

    const entry = getQueueEntry(id);

    if (!entry) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Queue entry not found'
      });
    }

    // Verify the requesting agent is the submitter
    if (entry.submitted_by !== agentName) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You can only withdraw your own submissions'
      });
    }

    // Only allow withdrawal of pending items
    if (entry.status !== 'pending') {
      return res.status(400).json({
        error: 'Cannot withdraw',
        message: `Cannot withdraw entry with status "${entry.status}". Only pending items can be withdrawn.`
      });
    }

    // Get optional reason from request body
    const { reason } = req.body || {};

    // Update status to withdrawn (with optional reason)
    updateQueueStatus(id, 'withdrawn', { 
      reviewed_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      rejection_reason: reason || null
    });

    // Emit real-time update
    emitCountUpdate();

    res.json({
      success: true,
      message: 'Queue entry withdrawn',
      id: id,
      reason: reason || null
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to withdraw',
      message: error.message
    });
  }
});

// Add a warning to a queue item (peer review)
// POST /api/queue/:service/:accountName/:id/warn
router.post('/:service/:accountName/:id/warn', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const agentName = req.apiKeyInfo?.name;

    if (!agentName) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Agent authentication required'
      });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Warning message is required'
      });
    }

    const entry = getQueueEntry(id);

    if (!entry) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Queue entry not found'
      });
    }

    // Only allow warnings on pending items
    if (entry.status !== 'pending') {
      return res.status(400).json({
        error: 'Cannot warn',
        message: `Cannot add warning to entry with status "${entry.status}". Only pending items can be warned.`
      });
    }

    // Cannot warn your own items (should withdraw instead)
    if (entry.submitted_by === agentName) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Cannot warn your own submission. Use withdraw instead.'
      });
    }

    // Add the warning
    const warningId = addQueueWarning(id, agentName, message.trim());

    // Notify the submitting agent
    if (entry.submitted_by) {
      notifyAgentQueueWarning(entry, agentName, message.trim()).catch(err => {
        console.error('Failed to notify agent of warning:', err.message);
      });
    }

    res.json({
      success: true,
      message: 'Warning added',
      warning_id: warningId,
      queue_id: id
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to add warning',
      message: error.message
    });
  }
});

// Get warnings for a queue item
// GET /api/queue/:service/:accountName/:id/warnings
router.get('/:service/:accountName/:id/warnings', (req, res) => {
  try {
    const { id } = req.params;
    
    const entry = getQueueEntry(id);
    if (!entry) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Queue entry not found'
      });
    }

    const warnings = getQueueWarnings(id);
    res.json({ warnings });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get warnings',
      message: error.message
    });
  }
});

export default router;
