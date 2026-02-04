import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();
const GITHUB_API = 'https://api.github.com';

// Proxy all GET requests to GitHub API
// Route: /api/github/:accountName/*
// Uses PAT if configured (5000 req/hr), falls back to unauthenticated (60 req/hr)
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const path = req.params[0] || '';
    const queryString = new URLSearchParams(req.query).toString();
    const url = `${GITHUB_API}/${path}${queryString ? '?' + queryString : ''}`;

    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'agentgate-gateway'
    };

    // Add auth if configured for this account
    const creds = getAccountCredentials('github', accountName);
    if (creds?.token) {
      headers['Authorization'] = `Bearer ${creds.token}`;
    }

    const response = await fetch(url, { headers });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'GitHub API request failed', message: error.message });
  }
});

// Also handle root path for account (e.g., /api/github/personal)
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'github',
    account: req.params.accountName,
    description: 'GitHub API proxy. Append path after account name.',
    examples: [
      `GET /api/github/${req.params.accountName}/users/octocat`,
      `GET /api/github/${req.params.accountName}/repos/owner/repo`
    ]
  });
});

export default router;
