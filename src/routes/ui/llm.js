// LLM Provider management UI routes
import { Router } from 'express';
import {
  listLlmProviders, createLlmProvider, getLlmProvider, updateLlmProvider, deleteLlmProvider,
  listAllAgentLlmModels, setAgentLlmModel, removeAgentLlmModel, listApiKeys,
  getPendingQueueCount, listPendingMessages, getMessagingMode
} from '../../lib/db.js';
import { renderPage } from '../../lib/render.js';

const router = Router();

const PROVIDER_ICONS = { openai: '🤖', anthropic: '🧠', google: '🔮', custom: '⚙️' };

router.get('/', (req, res) => {
  const providers = listLlmProviders();
  const models = listAllAgentLlmModels();
  const agents = listApiKeys().map(k => k.name).sort();
  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = messagingMode !== 'off' ? listPendingMessages().length : 0;

  renderPage(res, 'pages/llm', {
    title: 'LLM Providers',
    includeSocket: true,
    pendingQueueCount,
    pendingMessagesCount,
    messagingMode,
    providers,
    models,
    agents,
    providerIcons: PROVIDER_ICONS
  });
});

// ============ Test provider endpoint (UI-facing) ============

router.post('/providers/:id/test', async (req, res) => {
  const { id } = req.params;
  const provider = getLlmProvider(id);
  if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });
  if (!provider.enabled) return res.json({ success: false, error: 'Provider is disabled' });

  const PROVIDER_DEFAULTS = {
    openai: 'https://api.openai.com',
    anthropic: 'https://api.anthropic.com',
    google: 'https://generativelanguage.googleapis.com'
  };

  const baseUrl = provider.base_url || PROVIDER_DEFAULTS[provider.provider_type] || '';
  if (!baseUrl) return res.json({ success: false, error: 'No base URL configured' });

  let url, headers;
  if (provider.provider_type === 'anthropic') {
    url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    headers = { 'x-api-key': provider.api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] })
      });
      clearTimeout(timer);
      const latency = Date.now() - start;
      if (resp.status === 401 || resp.status === 403) {
        return res.json({ success: false, error: 'Authentication failed', latency });
      }
      return res.json({ success: true, latency });
    } catch (e) {
      return res.json({ success: false, error: e.message, latency: Date.now() - start });
    }
  } else {
    url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
    headers = { 'Authorization': `Bearer ${provider.api_key}` };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    const latency = Date.now() - start;
    if (resp.status === 401 || resp.status === 403) {
      return res.json({ success: false, error: 'Authentication failed', latency });
    }
    if (!resp.ok) {
      return res.json({ success: false, error: `HTTP ${resp.status}`, latency });
    }
    return res.json({ success: true, latency });
  } catch (e) {
    return res.json({ success: false, error: e.message, latency: Date.now() - start });
  }
});

// ============ JSON API endpoints ============

router.get('/providers', (req, res) => {
  const providers = listLlmProviders();
  res.json(providers);
});

router.post('/providers', (req, res) => {
  const { name, provider_type, api_key, base_url } = req.body;
  if (!name || !provider_type || !api_key) {
    return res.status(400).json({ error: 'name, provider_type, and api_key are required' });
  }
  try {
    const provider = createLlmProvider(name, provider_type, api_key, base_url);
    res.json({ success: true, provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/providers/:id', (req, res) => {
  const { id } = req.params;
  const provider = getLlmProvider(id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  updateLlmProvider(id, req.body);
  res.json({ success: true });
});

router.delete('/providers/:id', (req, res) => {
  const { id } = req.params;
  deleteLlmProvider(id);
  res.json({ success: true });
});

router.get('/models', (req, res) => {
  const models = listAllAgentLlmModels();
  res.json(models);
});

router.post('/models', (req, res) => {
  const { agent_name, provider_id, model_id, is_default } = req.body;
  if (!agent_name || !provider_id || !model_id) {
    return res.status(400).json({ error: 'agent_name, provider_id, and model_id are required' });
  }
  try {
    setAgentLlmModel(agent_name, provider_id, model_id, is_default || false);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/models', (req, res) => {
  const { agent_name, provider_id, model_id } = req.body;
  if (!agent_name || !provider_id || !model_id) {
    return res.status(400).json({ error: 'agent_name, provider_id, and model_id are required' });
  }
  removeAgentLlmModel(agent_name, provider_id, model_id);
  res.json({ success: true });
});

export default router;
