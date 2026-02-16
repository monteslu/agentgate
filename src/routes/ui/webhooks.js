/**
 * Webhook Management UI
 *
 * Provides UI for configuring inbound webhooks from external services
 * (GitHub, etc.) and viewing delivery history.
 */

import { Router } from 'express';
import crypto from 'crypto';
import {
  listWebhookConfigs, getWebhookConfig, createWebhookConfig, updateWebhookConfig, deleteWebhookConfig,
  listWebhookDeliveries, getWebhookDelivery, clearWebhookDeliveries,
  getWebhookSecret, setWebhookSecret, deleteWebhookSecret,
  listApiKeys
} from '../../lib/db.js';
import { escapeHtml } from './shared.js';
import { renderPage } from '../../lib/render.js';

const router = Router();

// Supported webhook sources with their event types
const WEBHOOK_SOURCES = {
  github: {
    name: 'GitHub',
    icon: '/public/icons/github.svg',
    events: [
      { id: 'push', name: 'Push', description: 'Code pushed to repository' },
      { id: 'pull_request', name: 'Pull Request', description: 'PR opened, closed, merged, etc.' },
      { id: 'issues', name: 'Issues', description: 'Issue created, updated, closed' },
      { id: 'issue_comment', name: 'Issue Comments', description: 'Comments on issues or PRs' },
      { id: 'check_suite', name: 'Check Suite', description: 'CI/CD check suite status' },
      { id: 'check_run', name: 'Check Run', description: 'Individual check run status' },
      { id: 'release', name: 'Release', description: 'Release published' },
      { id: 'workflow_run', name: 'Workflow Run', description: 'GitHub Actions workflow status' }
    ]
  }
};

// ============================================================================
// Routes
// ============================================================================

// Main webhooks page - list all configured webhooks
router.get('/webhooks', (req, res) => {
  const configs = listWebhookConfigs();
  const deliveries = listWebhookDeliveries(50);
  renderPage(res, 'pages/webhooks', {
    title: 'Service Hooks',
    configs,
    deliveries,
    webhookSources: WEBHOOK_SOURCES,
    escapeHtml
  });
});

// Add new webhook config form
router.get('/webhooks/add', (req, res) => {
  const agents = listApiKeys().filter(k => k.enabled);
  renderPage(res, 'pages/webhook-add', {
    title: 'Add Webhook',
    agents,
    webhookSources: WEBHOOK_SOURCES,
    escapeHtml
  });
});

// Create new webhook config
router.post('/webhooks/add', (req, res) => {
  const { source, name, events, assigned_agents } = req.body;

  if (!source || !WEBHOOK_SOURCES[source]) {
    return res.status(400).send('Invalid webhook source');
  }

  // Generate a secure secret
  const secret = crypto.randomBytes(32).toString('hex');

  // Parse events (comes as array or single value)
  const eventList = Array.isArray(events) ? events : (events ? [events] : []);

  // Parse assigned agents (default to empty = no agents receive)
  const agentList = Array.isArray(assigned_agents) ? assigned_agents : (assigned_agents ? [assigned_agents] : []);

  try {
    const config = createWebhookConfig({
      source,
      name: name || `${WEBHOOK_SOURCES[source].name} Webhook`,
      secret,
      events: eventList,
      enabled: true,
      assignedAgents: agentList.length > 0 ? agentList : null
    });

    // Also set the webhook secret in settings for verification
    setWebhookSecret(source, secret);

    res.redirect(`/ui/webhooks/${config.id}?created=1`);
  } catch (err) {
    res.status(500).send(`Error creating webhook: ${err.message}`);
  }
});

// View/edit single webhook config
router.get('/webhooks/:id', (req, res) => {
  const config = getWebhookConfig(req.params.id);
  if (!config) {
    return res.status(404).send('Webhook not found');
  }

  const deliveries = listWebhookDeliveries(20, config.id);
  const agents = listApiKeys().filter(k => k.enabled);
  const source = WEBHOOK_SOURCES[config.source] || { name: config.source, icon: '/public/favicon.svg', events: [] };
  const secret = getWebhookSecret(config.source) || config.secret || 'Not configured';
  const webhookPath = `/webhooks/${config.source}`;
  const assignedAgents = config.assignedAgents || [];
  const alerts = {
    created: req.query.created === '1',
    updated: req.query.updated === '1',
    secretRegenerated: req.query.secret_regenerated === '1',
    cleared: req.query.cleared === '1'
  };
  renderPage(res, 'pages/webhook-detail', {
    title: 'Webhook: ' + config.name,
    config,
    deliveries,
    agents,
    source,
    secret,
    webhookPath,
    assignedAgents,
    alerts,
    escapeHtml
  });
});

// Update webhook config
router.post('/webhooks/:id', (req, res) => {
  const { name, events, enabled, assigned_agents } = req.body;
  const config = getWebhookConfig(req.params.id);

  if (!config) {
    return res.status(404).send('Webhook not found');
  }

  const eventList = Array.isArray(events) ? events : (events ? [events] : []);

  // Parse assigned agents (empty = no agents receive)
  const agentList = Array.isArray(assigned_agents) ? assigned_agents : (assigned_agents ? [assigned_agents] : []);

  try {
    updateWebhookConfig(req.params.id, {
      name,
      events: eventList,
      enabled: enabled === 'on' || enabled === '1',
      assignedAgents: agentList.length > 0 ? agentList : null
    });
    res.redirect(`/ui/webhooks/${req.params.id}?updated=1`);
  } catch (err) {
    res.status(500).send(`Error updating webhook: ${err.message}`);
  }
});

// Regenerate webhook secret
router.post('/webhooks/:id/regenerate-secret', (req, res) => {
  const config = getWebhookConfig(req.params.id);
  if (!config) {
    return res.status(404).send('Webhook not found');
  }

  const newSecret = crypto.randomBytes(32).toString('hex');

  try {
    updateWebhookConfig(req.params.id, { secret: newSecret });
    setWebhookSecret(config.source, newSecret);
    res.redirect(`/ui/webhooks/${req.params.id}?secret_regenerated=1`);
  } catch (err) {
    res.status(500).send(`Error regenerating secret: ${err.message}`);
  }
});

// Delete webhook config
router.post('/webhooks/:id/delete', (req, res) => {
  const config = getWebhookConfig(req.params.id);
  if (!config) {
    return res.status(404).send('Webhook not found');
  }

  try {
    deleteWebhookConfig(req.params.id);
    deleteWebhookSecret(config.source);
    res.redirect('/ui/webhooks?deleted=1');
  } catch (err) {
    res.status(500).send(`Error deleting webhook: ${err.message}`);
  }
});

// View delivery details
router.get('/webhooks/delivery/:id', (req, res) => {
  const delivery = getWebhookDelivery(req.params.id);
  if (!delivery) {
    return res.status(404).send('Delivery not found');
  }

  let payload = delivery.payload;
  try {
    payload = JSON.stringify(JSON.parse(delivery.payload), null, 2);
  } catch {
    // Keep as-is if not valid JSON
  }

  let broadcastResult = delivery.broadcast_result;
  try {
    broadcastResult = JSON.stringify(JSON.parse(delivery.broadcast_result), null, 2);
  } catch {
    // Keep as-is
  }

  renderPage(res, 'pages/webhook-delivery', {
    title: 'Delivery Details',
    delivery,
    payload,
    broadcastResult,
    escapeHtml
  });
});

// Clear delivery history
router.post('/webhooks/:id/clear-history', (req, res) => {
  try {
    clearWebhookDeliveries(req.params.id);
    res.redirect(`/ui/webhooks/${req.params.id}?cleared=1`);
  } catch (err) {
    res.status(500).send(`Error clearing history: ${err.message}`);
  }
});

// Test webhook connectivity (sends a ping)
router.post('/webhooks/:id/test', async (req, res) => {
  const config = getWebhookConfig(req.params.id);
  if (!config) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  // For testing, we just verify the secret is configured
  const secret = getWebhookSecret(config.source);
  if (!secret) {
    return res.json({
      success: false,
      message: 'Webhook secret not configured. Regenerate the secret.'
    });
  }

  return res.json({
    success: true,
    message: 'Webhook is configured and ready to receive events.',
    endpoint: `/webhooks/${config.source}`,
    configured_events: config.events || []
  });
});

export default router;
