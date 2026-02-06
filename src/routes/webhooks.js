import { Router } from 'express';
import crypto from 'crypto';
import { getWebhookSecret, listApiKeys } from '../lib/db.js';
import { notifyAgentWebhook } from '../lib/agentNotifier.js';

const router = Router();

/**
 * Verify GitHub webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - X-Hub-Signature-256 header
 * @param {string} secret - Webhook secret
 * @returns {boolean}
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

  // Extract common fields
  if (payload.repository) {
    base.repo = payload.repository.full_name;
  }

  // Event-specific parsing
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

    default:
      return {
        ...base,
        data: { action: payload.action }
      };
  }
}

/**
 * Broadcast webhook event to all agents with webhooks configured
 */
async function broadcastToAgents(event) {
  const agents = listApiKeys();
  const results = { delivered: [], failed: [] };

  for (const agent of agents) {
    if (!agent.webhook_url) continue;

    try {
      const response = await fetch(agent.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(agent.webhook_token ? { 'Authorization': `Bearer ${agent.webhook_token}` } : {})
        },
        body: JSON.stringify({
          type: 'service_event',
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

  if (!eventType) {
    return res.status(400).json({ error: 'Missing X-GitHub-Event header' });
  }

  // Get stored webhook secret
  const secret = getWebhookSecret('github');
  
  // Verify signature if secret is configured
  if (secret) {
    const rawBody = JSON.stringify(req.body); // Note: requires express.json() to preserve raw
    if (!verifyGitHubSignature(rawBody, signature, secret)) {
      console.error('GitHub webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Handle ping event (GitHub sends this when webhook is first configured)
  if (eventType === 'ping') {
    console.log('GitHub webhook ping received:', req.body.zen);
    return res.json({ ok: true, message: 'pong', zen: req.body.zen });
  }

  // Parse event
  const event = parseGitHubEvent(eventType, req.body);
  console.log('GitHub webhook received:', event.event, event.repo || '');

  // Broadcast to agents
  const results = await broadcastToAgents(event);
  console.log('Webhook broadcast results:', results);

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
