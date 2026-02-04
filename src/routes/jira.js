import { Router } from 'express';
import { getAccountCredentials } from '../lib/db.js';

const router = Router();

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'jira',
  name: 'Jira',
  shortDesc: 'Issues, projects, search',
  description: 'Jira API proxy',
  authType: 'api token',
  docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
  examples: [
    'GET /api/jira/{accountName}/myself',
    'GET /api/jira/{accountName}/project',
    'GET /api/jira/{accountName}/search?jql=assignee=currentUser()',
    'GET /api/jira/{accountName}/issue/{issueKey}'
  ]
};

// Get Jira config for an account
function getJiraConfig(accountName) {
  const creds = getAccountCredentials('jira', accountName);
  if (!creds || !creds.domain || !creds.email || !creds.apiToken) {
    return null;
  }
  return creds;
}

// Proxy GET requests to Jira API
// Route: /api/jira/:accountName/*
router.get('/:accountName/*', async (req, res) => {
  try {
    const { accountName } = req.params;
    const config = getJiraConfig(accountName);
    if (!config) {
      return res.status(401).json({
        error: 'Jira account not configured',
        message: `Set up Jira account "${accountName}" in the admin UI`
      });
    }

    const path = req.params[0] || '';
    const queryString = new URLSearchParams(req.query).toString();
    const url = `https://${config.domain}/rest/api/3/${path}${queryString ? '?' + queryString : ''}`;

    const basicAuth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');

    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Jira API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'jira',
    account: req.params.accountName,
    description: 'Jira API proxy. Append API path after account name.',
    examples: [
      `GET /api/jira/${req.params.accountName}/myself`,
      `GET /api/jira/${req.params.accountName}/search?jql=assignee=currentUser()`
    ]
  });
});

export default router;
