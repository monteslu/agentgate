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

// Re-export service helpers for backward compatibility
export { services, registerAllRoutes, renderAllCards } from './services.js';

// Export the combined router as default
export default router;
