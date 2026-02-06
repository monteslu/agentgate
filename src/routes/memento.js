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
router.post('/', async (req, res) => {
  const { content, keywords, model, role } = req.body;
  const agentId = req.apiKeyName;

  if (!content) {
    return res.status(400).json({ error: 'Missing "content" field' });
  }

  if (!keywords || !Array.isArray(keywords)) {
    return res.status(400).json({ error: 'Missing or invalid "keywords" field (must be an array)' });
  }

  try {
    const memento = createMemento(agentId, content, keywords, { model, role });
    return res.status(201).json(memento);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/agents/memento/keywords - List all keywords for the agent
router.get('/keywords', async (req, res) => {
  const agentId = req.apiKeyName;

  const keywords = getMementoKeywords(agentId);
  return res.json({ keywords });
});

// GET /api/agents/memento/search - Search mementos by keyword
router.get('/search', async (req, res) => {
  const agentId = req.apiKeyName;
  const { keywords, limit } = req.query;

  if (!keywords) {
    return res.status(400).json({ error: 'Missing "keywords" query parameter' });
  }

  // Parse keywords (comma-separated)
  const keywordList = keywords.split(',').map(k => k.trim()).filter(k => k);

  if (keywordList.length === 0) {
    return res.status(400).json({ error: 'No valid keywords provided' });
  }

  const options = {};
  if (limit) {
    const parsedLimit = parseInt(limit, 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      options.limit = Math.min(parsedLimit, 100); // Cap at 100
    }
  }

  const matches = searchMementos(agentId, keywordList, options);
  return res.json({ matches });
});

// GET /api/agents/memento/recent - Get recent mementos
router.get('/recent', async (req, res) => {
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
  return res.json({ mementos });
});

// GET /api/agents/memento/:ids - Fetch full content by IDs
router.get('/:ids', async (req, res) => {
  const agentId = req.apiKeyName;
  const { ids } = req.params;

  // Parse IDs (comma-separated)
  const idList = ids.split(',').map(id => id.trim()).filter(id => id);

  if (idList.length === 0) {
    return res.status(400).json({ error: 'No valid IDs provided' });
  }

  if (idList.length > 20) {
    return res.status(400).json({ error: 'Cannot fetch more than 20 mementos at once' });
  }

  const mementos = getMementosById(agentId, idList);
  return res.json({ mementos });
});

export default router;
