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

// Generic proxy handler for all Brave Search endpoints
async function proxyBraveRequest(req, res, endpoint) {
  try {
    const { accountName } = req.params;
    const queryString = new URLSearchParams(req.query).toString();
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
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Brave Search API request failed', message: error.message });
  }
}

// Web search
router.get('/:accountName/web/search', (req, res) => {
  proxyBraveRequest(req, res, 'web/search');
});

// Image search
router.get('/:accountName/images/search', (req, res) => {
  proxyBraveRequest(req, res, 'images/search');
});

// News search
router.get('/:accountName/news/search', (req, res) => {
  proxyBraveRequest(req, res, 'news/search');
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
