import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();
const GOOGLE_SEARCH_API = 'https://www.googleapis.com/customsearch/v1';

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

// Search endpoint
router.get('/:accountName/search', async (req, res) => {
  try {
    const { accountName } = req.params;
    const { q, searchType, start, num, ...otherParams } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Missing required "q" query parameter' });
    }

    const creds = getAccountCredentials('google_search', accountName);
    if (!creds?.api_key || !creds?.cx) {
      return res.status(401).json({
        error: 'Google Search credentials not configured',
        hint: `Configure API key and Search Engine ID for account "${accountName}" in the AgentGate UI`
      });
    }

    const params = new URLSearchParams(otherParams);
    // Set these after otherParams to prevent user override of credentials
    params.set('key', creds.api_key);
    params.set('cx', creds.cx);
    params.set('q', q);
    if (searchType) params.set('searchType', searchType);
    if (start) params.set('start', start);
    if (num) params.set('num', num);

    const url = `${GOOGLE_SEARCH_API}?${params.toString()}`;

    const response = await fetch(url);
    const data = await response.json();
    res.status(response.status).json(data);
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
