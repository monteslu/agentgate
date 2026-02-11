import { Router } from 'express';
import crypto from 'crypto';
import {
  getWebhookSecret, listApiKeys,
  getWebhookConfigBySource, logWebhookDelivery,
  isWebhookDeliveryDuplicate
} from '../lib/db.js';

const router = Router();

// Default max payload size (1MB) if not configured
const DEFAULT_MAX_PAYLOAD_SIZE = 1048576;

/**
 * Verify GitHub webhook signature (HMAC SHA256)
 */
function verifyGitHubSignature(payload, signature, secret) {
  if (!signature || !secret) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/**
 * Parse GitHub event into normalized format
 */
function parseGitHubEvent(eventType, payload) {
  const base = {
    service: 'github',
    event: eventType,
    received_at: new Date().toISOString()
  };

  if (payload.repository) {
    base.repo = payload.repository.full_name;
  }

  switch (eventType) {
  case 'push':
    return {
      ...base,
      data: {
        ref: payload.ref,
        commits: payload.commits?.length || 0,
        pusher: payload.pusher?.name,
        compare_url: payload.compare
      }
    };

  case 'pull_request':
    return {
      ...base,
      event: `pull_request.${payload.action}`,
      data: {
        number: payload.pull_request?.number,
        title: payload.pull_request?.title,
        action: payload.action,
        url: payload.pull_request?.html_url,
        user: payload.pull_request?.user?.login,
        merged: payload.pull_request?.merged || false
      }
    };

  case 'issues':
    return {
      ...base,
      event: `issues.${payload.action}`,
      data: {
        number: payload.issue?.number,
        title: payload.issue?.title,
        action: payload.action,
        url: payload.issue?.html_url,
        user: payload.issue?.user?.login
      }
    };

  case 'issue_comment':
    return {
      ...base,
      event: `issue_comment.${payload.action}`,
      data: {
        issue_number: payload.issue?.number,
        issue_title: payload.issue?.title,
        comment_id: payload.comment?.id,
        action: payload.action,
        url: payload.comment?.html_url,
        user: payload.comment?.user?.login,
        is_pr: !!payload.issue?.pull_request
      }
    };

  case 'check_suite':
    return {
      ...base,
      event: `check_suite.${payload.action}`,
      data: {
        status: payload.check_suite?.status,
        conclusion: payload.check_suite?.conclusion,
        head_sha: payload.check_suite?.head_sha?.substring(0, 7)
      }
    };

  case 'check_run':
    return {
      ...base,
      event: `check_run.${payload.action}`,
      data: {
        name: payload.check_run?.name,
        status: payload.check_run?.status,
        conclusion: payload.check_run?.conclusion,
        head_sha: payload.check_run?.head_sha?.substring(0, 7)
      }
    };

  case 'release':
    return {
      ...base,
      event: `release.${payload.action}`,
      data: {
        tag: payload.release?.tag_name,
        name: payload.release?.name,
        url: payload.release?.html_url,
        prerelease: payload.release?.prerelease
      }
    };

  case 'workflow_run':
    return {
      ...base,
      event: `workflow_run.${payload.action}`,
      data: {
        name: payload.workflow_run?.name,
        status: payload.workflow_run?.status,
        conclusion: payload.workflow_run?.conclusion,
        head_sha: payload.workflow_run?.head_sha?.substring(0, 7),
        url: payload.workflow_run?.html_url
      }
    };

  default:
    return {
      ...base,
      data: { action: payload.action }
    };
  }
}

/**
 * Check if event type is enabled in webhook config
 */
function isEventEnabled(config, eventType) {
  if (!config || !config.events || config.events.length === 0) {
    return true; // No filter = accept all
  }
  return config.events.some(e => eventType === e || eventType.startsWith(e + '.'));
}

/**
 * Filter agents by assignment list
 * SECURITY: Default is NO agents receive webhooks - must be explicitly assigned
 * If assignedAgents is null/empty, returns empty array (no one gets messages)
 * Otherwise, returns only agents in the assignment list
 */
function filterAgentsByAssignment(agents, assignedAgents) {
  if (!assignedAgents || assignedAgents.length === 0) {
    return []; // SECURITY: No assignment = no agents receive (explicit opt-in required)
  }
  const assignedSet = new Set(assignedAgents.map(a => a.toLowerCase()));
  return agents.filter(a => assignedSet.has(a.name.toLowerCase()) || assignedSet.has(String(a.id)));
}

/**
 * Broadcast webhook event to agents with webhooks configured
 * Respects agent assignment filtering from webhook config
 */
async function broadcastToAgents(event, assignedAgents = null) {
  let agents = listApiKeys().filter(a => a.webhook_url);
  
  // Filter by assignment if specified
  agents = filterAgentsByAssignment(agents, assignedAgents);
  
  const results = { delivered: [], failed: [], skipped: [] };

  for (const agent of agents) {
    try {
      const response = await fetch(agent.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(agent.webhook_token ? { 'Authorization': `Bearer ${agent.webhook_token}` } : {})
        },
        body: JSON.stringify({
          type: 'service_webhook',
          ...event
        })
      });

      if (response.ok) {
        results.delivered.push(agent.name);
      } else {
        results.failed.push({ name: agent.name, status: response.status });
      }
    } catch (err) {
      results.failed.push({ name: agent.name, error: err.message });
    }
  }

  return results;
}

// POST /webhooks/github - Receive GitHub webhooks
router.post('/github', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const eventType = req.headers['x-github-event'];
  const deliveryId = req.headers['x-github-delivery'];
  const repo = req.body?.repository?.full_name;

  if (!eventType) {
    return res.status(400).json({ error: 'Missing X-GitHub-Event header' });
  }

  // Get webhook config
  const webhookConfig = getWebhookConfigBySource('github');
  const maxPayloadSize = webhookConfig?.maxPayloadSize || DEFAULT_MAX_PAYLOAD_SIZE;

  // Security: Check payload size limit
  const rawBody = req.rawBody;
  if (rawBody && rawBody.length > maxPayloadSize) {
    console.error(`GitHub webhook payload too large: ${rawBody.length} > ${maxPayloadSize}`);
    logWebhookDelivery({
      configId: webhookConfig?.id,
      source: 'github',
      eventType,
      deliveryId,
      repo,
      payload: { error: 'Payload truncated - too large', size: rawBody.length },
      success: false,
      broadcastResult: { error: 'Payload exceeds size limit' }
    });
    return res.status(413).json({ error: 'Payload too large' });
  }

  // Security: Replay protection - check for duplicate delivery
  if (deliveryId && isWebhookDeliveryDuplicate('github', deliveryId)) {
    console.log('GitHub webhook replay detected:', deliveryId);
    return res.json({
      ok: true,
      duplicate: true,
      delivery_id: deliveryId,
      message: 'Delivery already processed'
    });
  }

  // Get stored webhook secret
  const secret = getWebhookSecret('github');

  // Verify signature if secret is configured
  if (secret) {
    if (!rawBody) {
      console.error('GitHub webhook missing raw body - cannot verify signature');
      logWebhookDelivery({
        configId: webhookConfig?.id,
        source: 'github',
        eventType,
        deliveryId,
        repo,
        payload: req.body,
        success: false,
        broadcastResult: { error: 'Missing raw body for signature verification' }
      });
      return res.status(500).json({ error: 'Internal error: raw body not captured' });
    }
    if (!verifyGitHubSignature(rawBody, signature, secret)) {
      console.error('GitHub webhook signature verification failed');
      logWebhookDelivery({
        configId: webhookConfig?.id,
        source: 'github',
        eventType,
        deliveryId,
        repo,
        payload: req.body,
        success: false,
        broadcastResult: { error: 'Invalid signature' }
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Handle ping event
  if (eventType === 'ping') {
    console.log('GitHub webhook ping received:', req.body.zen);
    logWebhookDelivery({
      configId: webhookConfig?.id,
      source: 'github',
      eventType: 'ping',
      deliveryId,
      repo,
      payload: req.body,
      success: true,
      broadcastResult: { message: 'pong', zen: req.body.zen }
    });
    return res.json({ ok: true, message: 'pong', zen: req.body.zen });
  }

  // Parse event
  const event = parseGitHubEvent(eventType, req.body);
  console.log('GitHub webhook received:', event.event, event.repo || '');

  // Check if event type is enabled
  if (!isEventEnabled(webhookConfig, eventType)) {
    console.log('GitHub webhook event filtered out:', eventType);
    logWebhookDelivery({
      configId: webhookConfig?.id,
      source: 'github',
      eventType: event.event,
      deliveryId,
      repo: event.repo,
      payload: req.body,
      success: true,
      broadcastResult: { filtered: true, reason: 'Event type not enabled' }
    });
    return res.json({
      ok: true,
      filtered: true,
      reason: 'Event type not enabled in webhook configuration'
    });
  }

  // Broadcast to agents (respecting assignment filter)
  const results = await broadcastToAgents(event, webhookConfig?.assignedAgents);
  console.log('Webhook broadcast:', results.delivered.length, 'delivered,', results.failed.length, 'failed');

  // Log the delivery
  logWebhookDelivery({
    configId: webhookConfig?.id,
    source: 'github',
    eventType: event.event,
    deliveryId,
    repo: event.repo,
    payload: req.body,
    success: results.failed.length === 0,
    broadcastResult: results
  });

  return res.json({
    ok: true,
    delivery_id: deliveryId,
    event: event.event,
    repo: event.repo,
    broadcast: {
      delivered: results.delivered.length,
      failed: results.failed.length
    }
  });
});

export default router;
