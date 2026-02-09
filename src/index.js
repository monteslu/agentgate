import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getCookieSecret } from './lib/db.js';
import { connectHsync } from './lib/hsyncManager.js';
import { startCloudflared } from './lib/cloudflareManager.js';
import { initSocket } from './lib/socketManager.js';
import { apiKeyAuth, readOnlyEnforce, serviceAccessCheck } from './lib/middleware.js';
import githubRoutes from './routes/github.js';
import blueskyRoutes from './routes/bluesky.js';
import redditRoutes from './routes/reddit.js';
import calendarRoutes from './routes/calendar.js';
import mastodonRoutes from './routes/mastodon.js';
import linkedinRoutes from './routes/linkedin.js';
import youtubeRoutes from './routes/youtube.js';
import jiraRoutes from './routes/jira.js';
import fitbitRoutes from './routes/fitbit.js';
import queueRoutes from './routes/queue.js';
import agentsRoutes from './routes/agents.js';
import mementoRoutes from './routes/memento.js';
import uiRoutes from './routes/ui/index.js';
import webhooksRoutes from './routes/webhooks.js';
import servicesRoutes from './routes/services.js';
import readmeRoutes from './routes/readme.js';
import skillRoutes from './routes/skill.js';
import llmRoutes from './routes/llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3050;

app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    // Capture raw body for webhook signature verification
    if (req.originalUrl.startsWith('/webhooks')) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(getCookieSecret()));
app.use('/public', express.static(join(__dirname, '../public')));

// Health endpoint - public, no auth required
// Used by tunnel test button and Docker healthcheck
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// API routes - require auth, read-only, and service access check
// Pattern: /api/{service}/{accountName}/...
app.use('/api/github', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('github'), githubRoutes);
app.use('/api/bluesky', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('bluesky'), blueskyRoutes);
app.use('/api/reddit', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('reddit'), redditRoutes);
app.use('/api/calendar', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('calendar'), calendarRoutes);
app.use('/api/mastodon', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('mastodon'), mastodonRoutes);
app.use('/api/linkedin', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('linkedin'), linkedinRoutes);
app.use('/api/youtube', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('youtube'), youtubeRoutes);
app.use('/api/jira', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('jira'), jiraRoutes);
app.use('/api/fitbit', apiKeyAuth, readOnlyEnforce, serviceAccessCheck('fitbit'), fitbitRoutes);

// Service access management - admin API (requires auth)
app.use('/api/services', apiKeyAuth, servicesRoutes);

// Queue routes - require auth but allow POST for submitting write requests
app.use('/api/queue', apiKeyAuth, queueRoutes);

// Agent messaging routes - require auth, allow POST for sending messages
app.use('/api/agents', apiKeyAuth, (req, res, next) => {
  req.apiKeyName = req.apiKeyInfo.name;
  next();
}, agentsRoutes);

// Memento routes - require auth, allow POST for creating mementos
app.use('/api/agents/memento', apiKeyAuth, (req, res, next) => {
  req.apiKeyName = req.apiKeyInfo.name;
  next();
}, mementoRoutes);

// LLM proxy - require auth, no read-only enforcement (POST for completions)
app.use('/api/llm', apiKeyAuth, llmRoutes);

// Readme and skill endpoints - require auth
app.use('/api/readme', apiKeyAuth, readmeRoutes);
app.use('/api/skill', apiKeyAuth, skillRoutes);

// UI routes - no API key needed (local admin access)
app.use('/ui', uiRoutes);

// Webhook routes - no API key needed (uses signature verification instead)
app.use('/webhooks', webhooksRoutes);

// Root redirect to UI
app.get('/', (req, res) => {
  res.redirect('/ui');
});

const server = app.listen(PORT, async () => {
  console.log(`agentgate gateway running at http://localhost:${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/ui`);

  // Initialize socket.io for real-time updates
  initSocket(server);
  console.log('Socket.io initialized for real-time updates');

  // Start tunnels if configured
  try {
    await connectHsync(PORT);
  } catch (err) {
    console.error('hsync connection error:', err);
  }

  try {
    startCloudflared();
  } catch (err) {
    console.error('cloudflared error:', err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use. Is another instance running?`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
