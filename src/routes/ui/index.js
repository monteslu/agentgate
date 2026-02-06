// UI Router - combines all modular UI route handlers into a single Express router
// This replaces the monolithic src/routes/ui.js with modular sub-routers
import { Router } from 'express';

// Import modular route handlers
import authRouter, { requireAuth, isAuthenticated } from './auth.js';
import keysRouter from './keys.js';
import queueRouter from './queue.js';
import messagesRouter from './messages.js';
import settingsRouter from './settings.js';
import homeRouter from './home.js';

// Create the main UI router
const router = Router();

// Public routes (login, setup-password) - handled by auth module
router.use('/', authRouter);

// Apply auth middleware to protected routes
router.use(requireAuth);

// Home/dashboard route (GET /ui/)
router.use('/', homeRouter);

// Agent keys management: /keys, /keys/create, /keys/:id/*, /keys/avatar/*
router.use('/keys', keysRouter);

// Write queue management: /queue, /queue/:id/approve, /queue/:id/reject, etc.
router.use('/queue', queueRouter);

// Agent messages: /messages, /messages/:id/approve, /messages/:id/reject, etc.
router.use('/messages', messagesRouter);

// Settings routes: /hsync/*, /messaging/*, /queue/settings/* (mounted at root)
router.use('/', settingsRouter);

// Re-export auth utilities for external use
export { requireAuth, isAuthenticated };

// Export the combined router as default
export default router;

// ------------------------------------------------------------------
// Service card registration (preserved from original for compatibility)
// These are used by the main dashboard to render OAuth service cards
// ------------------------------------------------------------------
import * as github from './github.js';
import * as bluesky from './bluesky.js';
import * as reddit from './reddit.js';
import * as calendar from './calendar.js';
import * as youtube from './youtube.js';
import * as mastodon from './mastodon.js';
import * as linkedin from './linkedin.js';
import * as jira from './jira.js';
import * as fitbit from './fitbit.js';

// Export all services in display order
export const services = [
  github,
  bluesky,
  mastodon,
  reddit,
  calendar,
  youtube,
  fitbit,
  jira,
  linkedin
];

// Register all service routes
export function registerAllRoutes(router, baseUrl) {
  for (const service of services) {
    service.registerRoutes(router, baseUrl);
  }
}

// Render all service cards
export function renderAllCards(accounts, baseUrl) {
  return services.map(service => service.renderCard(accounts, baseUrl)).join('\n');
}
