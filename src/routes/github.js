import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();
const GITHUB_API = 'https://api.github.com';

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'github',
  name: 'GitHub',
  shortDesc: 'Repos, issues, PRs, commits',
  description: 'GitHub API proxy',
  authType: 'personal access token',
  docs: 'https://docs.github.com/en/rest',
  examples: [
    'GET /api/github/{accountName}/users/{username}',
    'GET /api/github/{accountName}/repos/{owner}/{repo}',
    'GET /api/github/{accountName}/repos/{owner}/{repo}/commits'
  ],
  writeGuidelines: [
    'NEVER push directly to main/master branches (except for initial commits on new projects)',
    'Always create a new branch for changes to existing projects',
    'Run tests locally before submitting PRs (if tests exist)',
    'Create a pull request for review',
    'Workflow: create branch → commit changes → run tests → create PR'
  ]
};

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
