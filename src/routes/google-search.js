import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();
const GOOGLE_SEARCH_API = 'https://www.googleapis.com/customsearch/v1';

// Simplify search results to just title, url, description (like Claude's WebSearch)
function simplifyResults(data) {
  if (!data?.items) return { results: [] };
  return {
    query: data.queries?.request?.[0]?.searchTerms || '',
    results: data.items.map(r => ({
      title: r.title,
      url: r.link,
      description: r.snippet || ''
    }))
  };
}

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'google_search',
  name: 'Google Search',
  shortDesc: 'Web and image search',
  description: 'Google Custom Search API proxy',
  authType: 'API key + Search Engine ID',
  authMethods: ['api_key'],
  docs: 'https://developers.google.com/custom-search/v1/overview',
  examples: [
    'GET /api/google_search/{accountName}/search?q=query',
    'GET /api/google_search/{accountName}/search?q=query&searchType=image'
  ]
};

// Core read function - used by both Express routes and MCP
export async function readService(accountName, path, { query = {}, raw = false } = {}) {
  const { q, searchType, start, num, ...otherParams } = query;

  if (!q) {
    return { status: 400, data: { error: 'Missing required "q" query parameter' } };
  }

  const creds = getAccountCredentials('google_search', accountName);
  if (!creds?.api_key || !creds?.cx) {
    return { status: 401, data: { error: 'Google Search credentials not configured', hint: `Configure API key and Search Engine ID for account "${accountName}" in the AgentGate UI` } };
  }

  const params = new URLSearchParams(otherParams);
  params.set('key', creds.api_key);
  params.set('cx', creds.cx);
  params.set('q', q);
  if (searchType) params.set('searchType', searchType);
  if (start) params.set('start', start);
  if (num) params.set('num', num);

  const url = `${GOOGLE_SEARCH_API}?${params.toString()}`;

  const response = await fetch(url);
  let data = await response.json();

  if (!raw && response.ok) {
    data = simplifyResults(data);
  }

  return { status: response.status, data };
}

// Search endpoint
router.get('/:accountName/search', async (req, res) => {
  try {
    const raw = req.headers['x-agentgate-raw'] === 'true';
    const result = await readService(req.params.accountName, 'search', { query: req.query, raw });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Google Search API request failed', message: error.message });
  }
});

// Account info endpoint
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'google_search',
    account: req.params.accountName,
    description: 'Google Custom Search API proxy. Use the search endpoint with a query.',
    examples: [
      `GET /api/google_search/${req.params.accountName}/search?q=hello`,
      `GET /api/google_search/${req.params.accountName}/search?q=cats&searchType=image`,
      `GET /api/google_search/${req.params.accountName}/search?q=news&num=5`
    ],
    docs: 'https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list'
  });
});

export default router;
