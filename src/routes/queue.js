import { Router } from 'express';
import { createQueueEntry, getQueueEntry, getAccountCredentials, listQueueEntriesBySubmitter, updateQueueStatus, getSharedQueueVisibility, listAllQueueEntries } from '../lib/db.js';

const router = Router();

// Valid services that support write operations
const VALID_SERVICES = ['github', 'bluesky', 'reddit', 'mastodon', 'calendar', 'google_calendar', 'youtube', 'linkedin', 'jira', 'fitbit'];

// Valid HTTP methods for write operations
const VALID_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Submit a batch of write requests for approval
// POST /api/queue/:service/:accountName/submit
router.post('/:service/:accountName/submit', (req, res) => {
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

    // Create the queue entry
    const entry = createQueueEntry(service, accountName, requests, comment, submittedBy);

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
    const { id } = req.params;
    const agentName = req.agentName; // Set by auth middleware

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

    // Update status to withdrawn
    updateQueueStatus(id, 'withdrawn', { 
      reviewed_at: new Date().toISOString().replace('T', ' ').replace('Z', '')
    });

    res.json({
      success: true,
      message: 'Queue entry withdrawn',
      id: id
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to withdraw',
      message: error.message
    });
  }
});

export default router;
