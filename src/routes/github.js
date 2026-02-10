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
  authMethods: ['personal_token'],
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

// Simplify user profile - drop all the _url fields
function simplifyUser(data) {
  if (!data?.login) return data;
  return {
    login: data.login,
    id: data.id,
    html_url: data.html_url,
    name: data.name,
    company: data.company,
    blog: data.blog,
    location: data.location,
    email: data.email,
    bio: data.bio,
    twitter_username: data.twitter_username,
    public_repos: data.public_repos,
    public_gists: data.public_gists,
    followers: data.followers,
    following: data.following,
    created_at: data.created_at,
    updated_at: data.updated_at
  };
}

// Simplify repo
function simplifyRepo(data) {
  if (!data?.full_name) return data;
  return {
    id: data.id,
    name: data.name,
    full_name: data.full_name,
    html_url: data.html_url,
    description: data.description,
    private: data.private,
    fork: data.fork,
    language: data.language,
    stargazers_count: data.stargazers_count,
    forks_count: data.forks_count,
    open_issues_count: data.open_issues_count,
    default_branch: data.default_branch,
    created_at: data.created_at,
    updated_at: data.updated_at,
    pushed_at: data.pushed_at,
    topics: data.topics,
    license: data.license?.spdx_id
  };
}

// Simplify arrays of repos/users
function simplifyArray(data, itemSimplifier) {
  if (!Array.isArray(data)) return data;
  return data.map(itemSimplifier);
}

// Match path to simplifier
function getSimplifier(path) {
  // /users/{username} (not /users/{username}/repos etc.)
  if (/^users\/[^/]+$/.test(path)) return simplifyUser;
  // /repos/{owner}/{repo} (exact, not sub-paths)
  if (/^repos\/[^/]+\/[^/]+$/.test(path)) return simplifyRepo;
  // /users/{username}/repos or /orgs/{org}/repos
  if (/\/(users|orgs)\/[^/]+\/repos$/.test(path)) return data => simplifyArray(data, simplifyRepo);
  return null;
}

// Proxy all GET requests to GitHub API
// Route: /api/github/:accountName/*
// Uses PAT if configured (5000 req/hr), falls back to unauthenticated (60 req/hr)
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const path = req.params[0] || '';
    const raw = req.headers['x-agentgate-raw'] === 'true';
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

    if (!raw && response.ok) {
      const simplifier = getSimplifier(path);
      if (simplifier) {
        return res.status(response.status).json(simplifier(data));
      }
    }

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
