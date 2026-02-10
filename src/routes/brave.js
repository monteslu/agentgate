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

// Generic proxy handler for all Brave Search endpoints
async function proxyBraveRequest(req, res, endpoint, simplifyFn = null) {
  try {
    const { accountName } = req.params;
    const raw = req.query.raw === 'true';
    const queryParams = { ...req.query };
    delete queryParams.raw;
    const queryString = new URLSearchParams(queryParams).toString();
    const url = `${BRAVE_API}/${endpoint}${queryString ? '?' + queryString : ''}`;

    const creds = getAccountCredentials('brave', accountName);
    if (!creds?.api_key) {
      return res.status(401).json({
        error: 'Brave Search API key not configured',
        hint: `Configure API key for account "${accountName}" in the AgentGate UI`
      });
    }

    const headers = {
      'Accept': 'application/json',
      'X-Subscription-Token': creds.api_key
    };

    const response = await fetch(url, { headers });
    const data = await response.json();

    // Return simplified results by default, raw if requested
    if (!raw && simplifyFn && response.ok) {
      res.status(response.status).json(simplifyFn(data));
    } else {
      res.status(response.status).json(data);
    }
  } catch (error) {
    res.status(500).json({ error: 'Brave Search API request failed', message: error.message });
  }
}

// Web search
router.get('/:accountName/web/search', (req, res) => {
  proxyBraveRequest(req, res, 'web/search', simplifyWebResults);
});

// Image search
router.get('/:accountName/images/search', (req, res) => {
  proxyBraveRequest(req, res, 'images/search', simplifyImageResults);
});

// News search
router.get('/:accountName/news/search', (req, res) => {
  proxyBraveRequest(req, res, 'news/search', simplifyNewsResults);
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
