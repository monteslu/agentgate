// LLM Proxy — transparent OpenAI-compatible proxy with credential injection
import { Router } from 'express';
import { getLlmProvider, getAgentLlmConfig, listAgentModels } from '../lib/db.js';

const router = Router();

// Default timeout for LLM requests (5 minutes — models can be slow)
const LLM_TIMEOUT_MS = parseInt(process.env.AGENTGATE_LLM_TIMEOUT_MS, 10) || 300000;

// Provider base URLs (defaults)
const PROVIDER_DEFAULTS = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com'
};

/**
 * Build provider-specific headers for the upstream request.
 * AgentGate is transparent — it injects the real API key and
 * forwards the request as-is in OpenAI-compatible format.
 */
function buildUpstreamHeaders(provider, originalHeaders) {
  const headers = {
    'Content-Type': 'application/json'
  };

  // Provider-specific auth
  switch (provider.provider_type) {
  case 'anthropic':
    headers['x-api-key'] = provider.api_key;
    headers['anthropic-version'] = originalHeaders['anthropic-version'] || '2023-06-01';
    break;
  case 'openai':
  default:
    headers['Authorization'] = `Bearer ${provider.api_key}`;
    break;
  }

  // Forward select headers
  if (originalHeaders['anthropic-beta']) {
    headers['anthropic-beta'] = originalHeaders['anthropic-beta'];
  }

  return headers;
}

// POST /v1/chat/completions — transparent proxy
router.post('/v1/chat/completions', async (req, res) => {
  const agentName = req.apiKeyInfo.name;

  try {
    // Look up agent's LLM config
    const config = getAgentLlmConfig(agentName);
    if (!config) {
      return res.status(404).json({
        error: {
          message: `No LLM provider configured for agent "${agentName}"`,
          type: 'invalid_request_error',
          code: 'no_provider_configured'
        }
      });
    }

    const provider = getLlmProvider(config.provider_id);
    if (!provider || !provider.enabled) {
      return res.status(503).json({
        error: {
          message: 'LLM provider is not available',
          type: 'service_unavailable',
          code: 'provider_unavailable'
        }
      });
    }

    // Build upstream request
    const baseUrl = provider.base_url || PROVIDER_DEFAULTS[provider.provider_type] || provider.base_url;
    const upstreamUrl = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    const upstreamHeaders = buildUpstreamHeaders(provider, req.headers);

    // Override model if agent has a specific model assigned
    const body = { ...req.body };
    if (config.model_id) {
      body.model = config.model_id;
    }

    const isStreaming = body.stream === true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!upstreamRes.ok) {
        // Forward error response from provider
        const errorBody = await upstreamRes.text().catch(() => '');
        res.status(upstreamRes.status);
        res.set('Content-Type', upstreamRes.headers.get('content-type') || 'application/json');
        return res.send(errorBody);
      }

      if (isStreaming) {
        // Pipe SSE stream directly
        res.set('Content-Type', 'text/event-stream');
        res.set('Cache-Control', 'no-cache');
        res.set('Connection', 'keep-alive');

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);
          }
        } catch (streamErr) {
          // Client disconnected or stream error
          if (streamErr.name !== 'AbortError') {
            console.error(`[llm-proxy] Stream error for ${agentName}:`, streamErr.message);
          }
        } finally {
          res.end();
        }
      } else {
        // Forward JSON response
        const responseBody = await upstreamRes.text();
        res.set('Content-Type', 'application/json');
        res.send(responseBody);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: {
          message: `LLM request timed out after ${LLM_TIMEOUT_MS}ms`,
          type: 'timeout_error',
          code: 'timeout'
        }
      });
    }
    console.error(`[llm-proxy] Error for ${agentName}:`, err.message);
    return res.status(502).json({
      error: {
        message: 'Failed to reach LLM provider',
        type: 'upstream_error',
        code: 'provider_unreachable'
      }
    });
  }
});

// GET /v1/models — list available models for the authenticated agent
router.get('/v1/models', (req, res) => {
  const agentName = req.apiKeyInfo.name;
  const models = listAgentModels(agentName);

  res.json({
    object: 'list',
    data: models.map(m => ({
      id: m.model_id,
      object: 'model',
      created: 0,
      owned_by: m.provider_type || 'agentgate',
      provider_name: m.provider_name
    }))
  });
});

// GET /v1/test — test provider connectivity (for admin/debugging)
router.post('/v1/test', async (req, res) => {
  const agentName = req.apiKeyInfo.name;
  const config = getAgentLlmConfig(agentName);
  
  if (!config) {
    return res.json({ success: false, error: 'No LLM provider configured' });
  }

  const provider = getLlmProvider(config.provider_id);
  if (!provider || !provider.enabled) {
    return res.json({ success: false, error: 'Provider not available' });
  }

  const baseUrl = provider.base_url || PROVIDER_DEFAULTS[provider.provider_type] || provider.base_url;
  const upstreamUrl = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
  const headers = buildUpstreamHeaders(provider, {});

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const resp = await fetch(upstreamUrl, { headers, signal: controller.signal });
      const latency = Date.now() - start;
      
      if (resp.ok) {
        res.json({ success: true, latency_ms: latency, provider: provider.name });
      } else {
        res.json({ success: false, error: `HTTP ${resp.status}`, latency_ms: latency });
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const latency = Date.now() - start;
    res.json({ success: false, error: err.message, latency_ms: latency });
  }
});

export default router;
