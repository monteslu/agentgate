// UI Router - combines all modular UI route handlers into a single Express router
// This replaces the monolithic src/routes/ui.js with modular sub-routers
import { Router } from 'express';

// Import modular route handlers
import authRouter, { requireAuth, isAuthenticated } from './auth.js';
import keysRouter from './keys.js';
import queueRouter from './queue.js';
import messagesRouter from './messages.js';
import mementosRouter from './mementos.js';
import settingsRouter from './settings.js';
import homeRouter from './home.js';
import accessRouter from './access.js';
import llmRouter from './llm.js';
import serviceDetailRouter from './service-detail.js';
import webhooksRouter from './webhooks.js';

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

// Agent mementos: /mementos, /mementos/:id
router.use('/mementos', mementosRouter);

// Service access control: /access, /access/:service/:account/*
router.use('/access', accessRouter);

// LLM provider management: /llm/providers, /llm/models
router.use('/llm', llmRouter);

// Service detail pages: /services/:id
router.use('/services', serviceDetailRouter);

// Webhook management: /webhooks, /webhooks/add, /webhooks/:id
router.use('/', webhooksRouter);

// Settings page: /settings
// Also handles POST routes: /hsync/*, /messaging/*, /queue/settings/*
router.use('/', settingsRouter);

// Re-export auth utilities for external use
export { requireAuth, isAuthenticated };

// Re-export service helpers for backward compatibility
export { services, registerAllRoutes, renderAllCards } from './services.js';

// Export the combined router as default
export default router;
