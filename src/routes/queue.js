import { Router } from 'express';
import {
  submitWriteRequest,
  listQueueEntries,
  getQueueStatus,
  withdrawQueueEntry,
  addWarningToQueue,
  getWarningsForQueue
} from '../services/queueService.js';

const router = Router();

// Submit a batch of write requests for approval
// POST /api/queue/:service/:accountName/submit
router.post('/:service/:accountName/submit', async (req, res) => {
  try {
    const { service, accountName } = req.params;
    const { requests, comment } = req.body;
    const agentName = req.apiKeyInfo?.name || 'unknown';

    const result = await submitWriteRequest(agentName, service, accountName, requests, comment);

    // If bypassed, return 200 with results
    if (result.bypassed) {
      return res.status(200).json({
        id: result.id,
        status: result.status,
        message: result.message,
        bypassed: true,
        results: result.results
      });
    }

    // Normal queued response
    res.status(201).json({
      id: result.id,
      status: result.status,
      message: result.message
    });

  } catch (error) {
    // Handle bypass execution failures
    if (error.bypassed) {
      return res.status(500).json({
        id: error.queueId,
        status: error.status,
        message: 'Bypass execution failed',
        bypassed: true,
        error: error.details
      });
    }

    // Handle access errors
    if (error.reason) {
      return res.status(403).json({
        error: error.message,
        reason: error.reason
      });
    }

    // Generic error
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
    const agentName = req.apiKeyInfo?.name || 'unknown';
    const result = listQueueEntries(agentName);
    res.json(result);
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
    const agentName = req.apiKeyInfo?.name || 'unknown';

    const result = listQueueEntries(agentName, service, accountName);
    res.json(result);
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

    const response = getQueueStatus(id, service, accountName);
    res.json(response);

  } catch (error) {
    res.status(404).json({
      error: 'Not found',
      message: error.message
    });
  }
});


// Withdraw a pending queue item (agent can only withdraw their own submissions)
// DELETE /api/queue/:service/:accountName/status/:id
router.delete('/:service/:accountName/status/:id', (req, res) => {
  try {
    const { id } = req.params;
    const agentName = req.apiKeyInfo?.name || 'unknown';
    const { reason } = req.body || {};

    const result = withdrawQueueEntry(id, agentName, reason);
    res.json(result);

  } catch (error) {
    const statusCode = error.message.includes('not enabled') ? 403 :
                      error.message.includes('not found') ? 404 :
                      error.message.includes('only withdraw') ? 403 : 400;

    res.status(statusCode).json({
      error: error.message.includes('not enabled') ? 'Disabled' :
             error.message.includes('not found') ? 'Not found' :
             error.message.includes('only withdraw') ? 'Forbidden' : 'Cannot withdraw',
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

    const result = await addWarningToQueue(id, agentName, message);
    res.json(result);

  } catch (error) {
    const statusCode = error.message.includes('authentication') ? 401 :
                      error.message.includes('not found') ? 404 :
                      error.message.includes('own submission') ? 403 : 400;

    res.status(statusCode).json({
      error: error.message.includes('authentication') ? 'Unauthorized' :
             error.message.includes('not found') ? 'Not found' :
             error.message.includes('own submission') ? 'Forbidden' : 'Cannot warn',
      message: error.message
    });
  }
});

// Get warnings for a queue item
// GET /api/queue/:service/:accountName/:id/warnings
router.get('/:service/:accountName/:id/warnings', (req, res) => {
  try {
    const { id } = req.params;

    const result = getWarningsForQueue(id);
    res.json(result);

  } catch (error) {
    res.status(404).json({
      error: 'Not found',
      message: error.message
    });
  }
});

export default router;
