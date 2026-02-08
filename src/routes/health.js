// Health endpoint — public, no auth required
// Used by tunnel test button and Docker healthcheck
import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

export default router;
