import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();
const BRAVE_API = 'https://api.search.brave.com/res/v1';

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'brave',
  name: 'Brave Search',
  shortDesc: 'Web, news, and image search',
  description: 'Brave Search API proxy',
  authType: 'API key',
  authMethods: ['api_key'],
  docs: 'https://brave.com/search/api/',
  examples: [
    'GET /api/brave/{accountName}/web/search?q=query',
    'GET /api/brave/{accountName}/images/search?q=query',
    'GET /api/brave/{accountName}/news/search?q=query'
  ]
};

// Simplify search results to just title, url, description (like Claude's WebSearch)
function simplifyWebResults(data) {
  if (!data?.web?.results) return { results: [] };
  return {
    query: data.query?.original || '',
    results: data.web.results.map(r => ({
      title: r.title,
      url: r.url,
      description: r.description?.replace(/<\/?strong>/g, '') || ''
    }))
  };
}

function simplifyNewsResults(data) {
  if (!data?.results) return { results: [] };
  return {
    query: data.query?.original || '',
    results: data.results.map(r => ({
      title: r.title,
      url: r.url,
      description: r.description?.replace(/<\/?strong>/g, '') || '',
      age: r.age || ''
    }))
  };
}

function simplifyImageResults(data) {
  if (!data?.results) return { results: [] };
  return {
    query: data.query?.original || '',
    results: data.results.map(r => ({
      title: r.title,
      url: r.url,
      thumbnail: r.thumbnail?.src || '',
      source: r.source || ''
    }))
  };
}

// Endpoint to simplifier mapping
const BRAVE_SIMPLIFIERS = {
  'web/search': simplifyWebResults,
  'images/search': simplifyImageResults,
  'news/search': simplifyNewsResults
};

// Core read function - used by both Express routes and MCP
export async function readService(accountName, path, { query = {}, raw = false } = {}) {
  const creds = getAccountCredentials('brave', accountName);
  if (!creds?.api_key) {
    return { status: 401, data: { error: 'Brave Search API key not configured', hint: `Configure API key for account "${accountName}" in the AgentGate UI` } };
  }

  const queryString = new URLSearchParams(query).toString();
  const url = `${BRAVE_API}/${path}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': creds.api_key
    }
  });

  let data = await response.json();

  if (!raw && response.ok) {
    const simplifyFn = BRAVE_SIMPLIFIERS[path];
    if (simplifyFn) {
      data = simplifyFn(data);
    }
  }

  return { status: response.status, data };
}

// Web search
router.get('/:accountName/web/search', async (req, res) => {
  try {
    const raw = req.headers['x-agentgate-raw'] === 'true';
    const result = await readService(req.params.accountName, 'web/search', { query: req.query, raw });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Brave Search API request failed', message: error.message });
  }
});

// Image search
router.get('/:accountName/images/search', async (req, res) => {
  try {
    const raw = req.headers['x-agentgate-raw'] === 'true';
    const result = await readService(req.params.accountName, 'images/search', { query: req.query, raw });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Brave Search API request failed', message: error.message });
  }
});

// News search
router.get('/:accountName/news/search', async (req, res) => {
  try {
    const raw = req.headers['x-agentgate-raw'] === 'true';
    const result = await readService(req.params.accountName, 'news/search', { query: req.query, raw });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Brave Search API request failed', message: error.message });
  }
});

// Account info endpoint
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'brave',
    account: req.params.accountName,
    description: 'Brave Search API proxy. Use web/search, images/search, or news/search endpoints.',
    examples: [
      `GET /api/brave/${req.params.accountName}/web/search?q=hello`,
      `GET /api/brave/${req.params.accountName}/images/search?q=cats`,
      `GET /api/brave/${req.params.accountName}/news/search?q=technology`
    ],
    docs: 'https://brave.com/search/api/'
  });
});

export default router;
