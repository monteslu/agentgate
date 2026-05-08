import { Router } from 'express';
import {
  createMemento,
  getMementoKeywords,
  searchMementos,
  getRecentMementos,
  getMementosById
} from '../lib/db.js';

const router = Router();

// POST /api/agents/memento - Store a memento
router.post('/', (req, res) => {
  const { content, keywords, model, role } = req.body;
  const agentId = req.apiKeyName;

  if (!content) {
    return res.status(400).json({ via: 'agentgate', error: 'Missing "content" field' });
  }

  if (!keywords || !Array.isArray(keywords)) {
    return res.status(400).json({ via: 'agentgate', error: 'Missing or invalid "keywords" field (must be an array)' });
  }

  try {
    const memento = createMemento(agentId, content, keywords, { model, role });
    return res.status(201).json({ via: 'agentgate', ...memento });
  } catch (err) {
    return res.status(400).json({ via: 'agentgate', error: err.message });
  }
});

// GET /api/agents/memento/keywords - List all keywords for the agent
router.get('/keywords', (req, res) => {
  const agentId = req.apiKeyName;

  const keywords = getMementoKeywords(agentId);
  return res.json({ via: 'agentgate', keywords });
});

// GET /api/agents/memento/search - Search mementos by keyword
router.get('/search', (req, res) => {
  const agentId = req.apiKeyName;
  const { keywords, limit } = req.query;

  if (!keywords) {
    return res.status(400).json({ via: 'agentgate', error: 'Missing "keywords" query parameter' });
  }

  // Parse keywords (comma-separated)
  const keywordList = keywords.split(',').map(k => k.trim()).filter(k => k);

  if (keywordList.length === 0) {
    return res.status(400).json({ via: 'agentgate', error: 'No valid keywords provided' });
  }

  const options = {};
  if (limit) {
    const parsedLimit = parseInt(limit, 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      options.limit = Math.min(parsedLimit, 100); // Cap at 100
    }
  }

  const matches = searchMementos(agentId, keywordList, options);
  return res.json({ via: 'agentgate', matches });
});

// GET /api/agents/memento/recent - Get recent mementos
router.get('/recent', (req, res) => {
  const agentId = req.apiKeyName;
  const { limit } = req.query;

  let parsedLimit = 5;
  if (limit) {
    const l = parseInt(limit, 10);
    if (!isNaN(l) && l > 0) {
      parsedLimit = Math.min(l, 20); // Cap at 20
    }
  }

  const mementos = getRecentMementos(agentId, parsedLimit);
  return res.json({ via: 'agentgate', mementos });
});

// GET /api/agents/memento/:ids - Fetch full content by IDs
router.get('/:ids', (req, res) => {
  const agentId = req.apiKeyName;
  const { ids } = req.params;

  // Parse IDs (comma-separated)
  const idList = ids.split(',').map(id => id.trim()).filter(id => id);

  if (idList.length === 0) {
    return res.status(400).json({ via: 'agentgate', error: 'No valid IDs provided' });
  }

  if (idList.length > 20) {
    return res.status(400).json({ via: 'agentgate', error: 'Cannot fetch more than 20 mementos at once' });
  }

  const mementos = getMementosById(agentId, idList);
  return res.json({ via: 'agentgate', mementos });
});

export const routeMeta = {
  name: 'Mementos',
  description: 'Persistent memory storage — store and retrieve notes across sessions using keywords',
  category: 'internal',
  endpoints: [
    {
      method: 'POST',
      path: '/api/agents/memento',
      description: 'Store a new memento',
      params: {
        body: {
          content: { type: 'string', required: true, description: 'Memory content (max 12KB)' },
          keywords: { type: 'array', required: true, description: 'Array of keyword strings (max 10)' },
          model: { type: 'string', required: false, description: 'Model name at time of storage' },
          role: { type: 'string', required: false, description: 'Agent role (user, assistant, system)' }
        }
      },
      auth: 'agent'
    },
    {
      method: 'GET',
      path: '/api/agents/memento/keywords',
      description: 'List all keywords used by the agent',
      params: {},
      auth: 'agent'
    },
    {
      method: 'GET',
      path: '/api/agents/memento/search',
      description: 'Search mementos by keyword (returns metadata only)',
      params: {
        query: {
          keywords: { type: 'string', required: true, description: 'Comma-separated keywords' },
          limit: { type: 'number', required: false, description: 'Max results (default 10, max 100)' }
        }
      },
      auth: 'agent'
    },
    {
      method: 'GET',
      path: '/api/agents/memento/recent',
      description: 'Get most recent mementos',
      params: {
        query: {
          limit: { type: 'number', required: false, description: 'Max results (default 5, max 20)' }
        }
      },
      auth: 'agent'
    },
    {
      method: 'GET',
      path: '/api/agents/memento/:ids',
      description: 'Fetch full memento content by IDs (comma-separated, max 20)',
      params: {},
      auth: 'agent'
    }
  ]
};

export default router;
