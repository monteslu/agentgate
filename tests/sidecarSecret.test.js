import { jest } from '@jest/globals';

// Mock db module
const mockGetSidecarSecretHash = jest.fn();
const mockValidateApiKey = jest.fn();

jest.unstable_mockModule('../src/lib/db.js', () => ({
  getSidecarSecretHash: mockGetSidecarSecretHash,
  validateApiKey: mockValidateApiKey,
  getCookieSecret: jest.fn(() => 'test-secret'),
  hasAdminPassword: jest.fn(() => true),
  getSetting: jest.fn(),
  getPendingQueueCount: jest.fn(() => 0),
  checkServiceAccess: jest.fn(() => ({ allowed: true })),
  checkBypassAuth: jest.fn(() => false),
  createQueueEntry: jest.fn(() => ({ id: 1 })),
  markAutoApproved: jest.fn(),
  updateQueueStatus: jest.fn(),
  getAccountCredentials: jest.fn(() => null)
}));

jest.unstable_mockModule('../src/lib/queueExecutor.js', () => ({
  getAccessToken: jest.fn(),
  buildUrl: jest.fn(),
  buildHeaders: jest.fn()
}));

jest.unstable_mockModule('../src/lib/socketManager.js', () => ({
  emitCountUpdate: jest.fn()
}));

// Mock hsyncManager
jest.unstable_mockModule('../src/lib/hsyncManager.js', () => ({
  connectHsync: jest.fn(),
  disconnectHsync: jest.fn(),
  getHsyncUrl: jest.fn(),
  isHsyncConnected: jest.fn(() => false)
}));

describe('Sidecar Secret Middleware', () => {
  let sidecarSecretCheck;
  let express;
  let request;
  let bcrypt;

  beforeAll(async () => {
    const supertest = await import('supertest');
    request = supertest.default;
    express = (await import('express')).default;
    bcrypt = (await import('bcrypt')).default;

    const middleware = await import('../src/lib/middleware.js');
    sidecarSecretCheck = middleware.sidecarSecretCheck;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', sidecarSecretCheck);
    app.get('/api/test', (req, res) => {
      res.json({
        success: true,
        hasSidecarHeader: 'x-sidecar-secret' in req.headers
      });
    });
    return app;
  }

  it('should pass through when no secret is configured', async () => {
    mockGetSidecarSecretHash.mockReturnValue(null);
    const app = createApp();

    const res = await request(app).get('/api/test');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should reject with 401 when secret configured but header missing', async () => {
    const hash = await bcrypt.hash('my-secret', 10);
    mockGetSidecarSecretHash.mockReturnValue(hash);
    const app = createApp();

    const res = await request(app).get('/api/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing or invalid sidecar secret');
  });

  it('should reject with 401 when header has wrong secret', async () => {
    const hash = await bcrypt.hash('my-secret', 10);
    mockGetSidecarSecretHash.mockReturnValue(hash);
    const app = createApp();

    const res = await request(app)
      .get('/api/test')
      .set('X-Sidecar-Secret', 'wrong-secret');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing or invalid sidecar secret');
  });

  it('should pass when header matches configured secret', async () => {
    const hash = await bcrypt.hash('my-secret', 10);
    mockGetSidecarSecretHash.mockReturnValue(hash);
    const app = createApp();

    const res = await request(app)
      .get('/api/test')
      .set('X-Sidecar-Secret', 'my-secret');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should strip X-Sidecar-Secret header after validation', async () => {
    const hash = await bcrypt.hash('my-secret', 10);
    mockGetSidecarSecretHash.mockReturnValue(hash);
    const app = createApp();

    const res = await request(app)
      .get('/api/test')
      .set('X-Sidecar-Secret', 'my-secret');
    expect(res.status).toBe(200);
    expect(res.body.hasSidecarHeader).toBe(false);
  });
});
