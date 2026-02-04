import { jest } from '@jest/globals';

// Mock the db module before importing anything that uses it
jest.unstable_mockModule('../src/lib/db.js', () => ({
  validateApiKey: jest.fn(),
  getAccountsByService: jest.fn(() => ({})),
  getAccountCredentials: jest.fn(),
  setAccountCredentials: jest.fn(),
  createQueueEntry: jest.fn(),
  getQueueEntry: jest.fn(),
  listQueueEntries: jest.fn(() => []),
  listQueueEntriesBySubmitter: jest.fn(() => []),
  updateQueueStatus: jest.fn(),
  getCookieSecret: jest.fn(() => 'test-secret'),
  hasAdminPassword: jest.fn(() => true),
  listAccounts: jest.fn(() => []),
  getSetting: jest.fn(),
  getPendingQueueCount: jest.fn(() => 0)
}));

// Mock hsyncManager
jest.unstable_mockModule('../src/lib/hsyncManager.js', () => ({
  connectHsync: jest.fn(),
  disconnectHsync: jest.fn(),
  getHsyncUrl: jest.fn(),
  isHsyncConnected: jest.fn(() => false)
}));

describe('API Endpoints', () => {
  let app;
  let request;
  let db;

  beforeAll(async () => {
    // Dynamic imports after mocks are set up
    const supertest = await import('supertest');
    request = supertest.default;

    db = await import('../src/lib/db.js');

    // Import express and set up a minimal app for testing
    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;

    app = express();
    app.use(express.json());
    app.use(cookieParser('test-secret'));

    // API key auth middleware
    const apiKeyAuth = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
      }
      const key = authHeader.slice(7);
      const valid = await db.validateApiKey(key);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
      req.apiKeyInfo = valid;
      next();
    };

    // Test endpoint
    app.get('/api/test', apiKeyAuth, (req, res) => {
      res.json({ success: true, keyName: req.apiKeyInfo.name });
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should reject requests without auth header', async () => {
      const res = await request(app).get('/api/test');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authorization');
    });

    it('should reject requests with invalid auth format', async () => {
      const res = await request(app)
        .get('/api/test')
        .set('Authorization', 'Basic invalid');
      expect(res.status).toBe(401);
    });

    it('should reject requests with invalid API key', async () => {
      db.validateApiKey.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer rms_invalid_key');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid API key');
    });

    it('should accept requests with valid API key', async () => {
      db.validateApiKey.mockResolvedValue({ id: 'key_1', name: 'test-agent' });

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer rms_valid_key');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.keyName).toBe('test-agent');
    });
  });
});

describe('Queue API', () => {
  let app;
  let request;
  let db;

  beforeAll(async () => {
    const supertest = await import('supertest');
    request = supertest.default;

    db = await import('../src/lib/db.js');

    const express = (await import('express')).default;
    app = express();
    app.use(express.json());

    // Simplified auth that always passes
    const mockAuth = (req, _res, next) => {
      req.apiKeyInfo = { id: 'key_1', name: 'test-agent' };
      next();
    };

    // Queue submit endpoint
    app.post('/api/queue/:service/:accountName/submit', mockAuth, (req, res) => {
      const { service, accountName } = req.params;
      const { requests, comment } = req.body;

      if (!requests || !Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ error: 'requests array required' });
      }

      const entry = db.createQueueEntry(service, accountName, requests, comment, req.apiKeyInfo.name);
      res.status(201).json(entry);
    });

    // Queue status endpoint
    app.get('/api/queue/:service/:accountName/status/:id', mockAuth, (req, res) => {
      const entry = db.getQueueEntry(req.params.id);
      if (!entry) {
        return res.status(404).json({ error: 'Queue entry not found' });
      }
      res.json(entry);
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/queue/:service/:accountName/submit', () => {
    it('should reject empty requests array', async () => {
      const res = await request(app)
        .post('/api/queue/github/personal/submit')
        .send({ requests: [], comment: 'test' });
      expect(res.status).toBe(400);
    });

    it('should reject missing requests', async () => {
      const res = await request(app)
        .post('/api/queue/github/personal/submit')
        .send({ comment: 'test' });
      expect(res.status).toBe(400);
    });

    it('should create queue entry', async () => {
      db.createQueueEntry.mockReturnValue({ id: 'queue_123', status: 'pending' });

      const res = await request(app)
        .post('/api/queue/github/personal/submit')
        .send({
          requests: [{ method: 'POST', path: '/repos/o/r/issues', body: { title: 'Bug' } }],
          comment: 'Creating issue'
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('queue_123');
      expect(res.body.status).toBe('pending');
      expect(db.createQueueEntry).toHaveBeenCalledWith(
        'github',
        'personal',
        [{ method: 'POST', path: '/repos/o/r/issues', body: { title: 'Bug' } }],
        'Creating issue',
        'test-agent'
      );
    });
  });

  describe('GET /api/queue/:service/:accountName/status/:id', () => {
    it('should return 404 for unknown entry', async () => {
      db.getQueueEntry.mockReturnValue(null);

      const res = await request(app)
        .get('/api/queue/github/personal/status/unknown_id');
      expect(res.status).toBe(404);
    });

    it('should return queue entry status', async () => {
      db.getQueueEntry.mockReturnValue({
        id: 'queue_123',
        status: 'completed',
        results: [{ ok: true, status: 201 }]
      });

      const res = await request(app)
        .get('/api/queue/github/personal/status/queue_123');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.results).toHaveLength(1);
    });
  });
});
