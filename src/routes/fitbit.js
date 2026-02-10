import { Router } from 'express';
import { getAccountCredentials, setAccountCredentials } from '../lib/db.js';

const router = Router();
const FITBIT_API = 'https://api.fitbit.com';
const FITBIT_AUTH = 'https://api.fitbit.com/oauth2/token';

// Service metadata - exported for /api/readme and /api/skill
export const serviceInfo = {
  key: 'fitbit',
  name: 'Fitbit',
  shortDesc: 'Activity, sleep, heart rate, profile',
  description: 'Fitbit API proxy',
  authType: 'oauth',
  authMethods: ['oauth'],
  docs: 'https://dev.fitbit.com/build/reference/web-api/',
  examples: [
    'GET /api/fitbit/{accountName}/1/user/-/profile.json',
    'GET /api/fitbit/{accountName}/1/user/-/activities/date/today.json',
    'GET /api/fitbit/{accountName}/1/user/-/sleep/date/today.json',
    'GET /api/fitbit/{accountName}/1/user/-/body/log/weight/date/today.json'
  ]
};

// Get a valid access token, refreshing if needed
async function getAccessToken(accountName) {
  const creds = getAccountCredentials('fitbit', accountName);
  if (!creds) {
    return null;
  }

  // If we have an access token and it's not expired, use it
  if (creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt) {
    return creds.accessToken;
  }

  // Need to refresh the token
  if (!creds.refreshToken) {
    return null;
  }

  try {
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

    const response = await fetch(FITBIT_AUTH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken
      })
    });

    if (!response.ok) {
      console.error('Fitbit token refresh failed:', await response.text());
      return null;
    }

    const tokens = await response.json();

    // Store the new tokens
    setAccountCredentials('fitbit', accountName, {
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in * 1000) - 60000 // 1 min buffer
    });

    return tokens.access_token;
  } catch (error) {
    console.error('Fitbit token refresh failed:', error);
    return null;
  }
}

// Export for queue executor
export { getAccessToken };

// Simplify profile - strip badge images, marketing copy, unit settings
function simplifyProfile(data) {
  if (!data?.user) return data;
  const u = data.user;
  return {
    user: {
      displayName: u.displayName,
      fullName: u.fullName,
      age: u.age,
      gender: u.gender,
      height: u.height,
      weight: u.weight,
      averageDailySteps: u.averageDailySteps,
      memberSince: u.memberSince,
      timezone: u.timezone,
      country: u.country,
      state: u.state
    }
  };
}

// Simplify activities
function simplifyActivities(data) {
  if (!data?.summary) return data;
  return {
    summary: {
      steps: data.summary.steps,
      caloriesOut: data.summary.caloriesOut,
      distances: data.summary.distances,
      activeMinutes: data.summary.fairlyActiveMinutes + data.summary.veryActiveMinutes,
      sedentaryMinutes: data.summary.sedentaryMinutes,
      floors: data.summary.floors,
      elevation: data.summary.elevation
    },
    goals: data.goals
  };
}

// Simplify sleep
function simplifySleep(data) {
  if (!data?.sleep) return data;
  return {
    summary: data.summary,
    sleep: data.sleep.map(s => ({
      dateOfSleep: s.dateOfSleep,
      duration: s.duration,
      efficiency: s.efficiency,
      startTime: s.startTime,
      endTime: s.endTime,
      minutesAsleep: s.minutesAsleep,
      minutesAwake: s.minutesAwake,
      type: s.type
    }))
  };
}

// Match path to simplifier
function getSimplifier(path) {
  if (/1\/user\/-\/profile\.json/.test(path)) return simplifyProfile;
  if (/1\/user\/-\/activities\/date\//.test(path)) return simplifyActivities;
  if (/1\/user\/-\/sleep\/date\//.test(path)) return simplifySleep;
  return null;
}

// Core read function - used by both Express routes and MCP
export async function readService(accountName, path, { query = {}, raw = false } = {}) {
  const accessToken = await getAccessToken(accountName);
  if (!accessToken) {
    return { status: 401, data: { error: 'Fitbit account not configured', message: `Set up Fitbit account "${accountName}" in the admin UI` } };
  }

  const queryString = new URLSearchParams(query).toString();
  const url = `${FITBIT_API}/${path}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  let data = await response.json();

  if (!raw && response.ok) {
    const simplifier = getSimplifier(path);
    if (simplifier) {
      data = simplifier(data);
    }
  }

  return { status: response.status, data };
}

// Proxy GET requests to Fitbit API
router.get('/:accountName/*', async (req, res) => {
  try {
    const raw = req.headers['x-agentgate-raw'] === 'true';
    const result = await readService(req.params.accountName, req.params[0] || '', { query: req.query, raw });
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Fitbit API request failed', message: error.message });
  }
});

// Handle root path for account
router.get('/:accountName', async (req, res) => {
  res.json({
    service: 'fitbit',
    account: req.params.accountName,
    description: 'Fitbit API proxy. Append API path after account name.',
    examples: [
      `GET /api/fitbit/${req.params.accountName}/1/user/-/profile.json`,
      `GET /api/fitbit/${req.params.accountName}/1/user/-/activities/date/today.json`,
      `GET /api/fitbit/${req.params.accountName}/1/user/-/sleep/date/today.json`,
      `GET /api/fitbit/${req.params.accountName}/1/user/-/body/log/weight/date/today.json`
    ]
  });
});

export default router;
