import { jest } from '@jest/globals';

// Mock dependencies before importing
jest.unstable_mockModule('../src/lib/db.js', () => ({
  validateApiKey: jest.fn(),
  checkServiceAccess: jest.fn(() => ({ allowed: true })),
  checkBypassAuth: jest.fn(),
  createQueueEntry: jest.fn(() => ({ id: 42, status: 'pending' })),
  markAutoApproved: jest.fn(),
  updateQueueStatus: jest.fn(),
  getQueueEntry: jest.fn(),
  getAccountCredentials: jest.fn(() => ({ token: 'test-token' }))
}));

jest.unstable_mockModule('../src/lib/queueExecutor.js', () => ({
  getAccessToken: jest.fn(),
  buildUrl: jest.fn(),
  buildHeaders: jest.fn(() => ({ 'Authorization': 'Bearer test' })),
  executeQueueEntry: jest.fn()
}));

jest.unstable_mockModule('../src/lib/socketManager.js', () => ({
  emitCountUpdate: jest.fn(),
  emitEvent: jest.fn()
}));

const db = await import('../src/lib/db.js');
const executor = await import('../src/lib/queueExecutor.js');
const { writeProxy } = await import('../src/lib/middleware.js');

function mockReq(method, path, body = {}) {
  return {
    method,
    path,
    body,
    apiKeyInfo: { name: 'TestAgent' }
  };
}

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; }
  };
  return res;
}

describe('writeProxy middleware', () => {
  const middleware = writeProxy('github');

  beforeEach(() => {
    jest.clearAllMocks();
    db.getAccountCredentials.mockReturnValue({ token: 'test-token' });
  });

  it('passes GET requests through to next()', async () => {
    const req = mockReq('GET', '/gimli/repos');
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('returns 400 if no account name in path', async () => {
    const req = mockReq('POST', '/');
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('queues write requests without bypass and returns 202', async () => {
    db.checkBypassAuth.mockReturnValue(false);
    const req = mockReq('POST', '/gimli/repos/test/issues', { title: 'test' });
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(res.body.id).toBe(42);
    expect(res.body.message).toBe('Awaiting approval');
    expect(db.createQueueEntry).toHaveBeenCalledWith(
      'github', 'gimli',
      [{ method: 'POST', path: '/repos/test/issues', body: { title: 'test' }, headers: {} }],
      'Transparent write proxy',
      'TestAgent'
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('executes immediately with bypass and returns upstream response', async () => {
    db.checkBypassAuth.mockReturnValue(true);
    executor.getAccessToken.mockResolvedValue('token-123');
    executor.buildUrl.mockReturnValue('https://api.github.com/repos/test/issues');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ id: 1, title: 'test' })
    });

    const req = mockReq('POST', '/gimli/repos/test/issues', { title: 'test' });
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ id: 1, title: 'test' });
    expect(db.markAutoApproved).toHaveBeenCalledWith(42);
    expect(db.updateQueueStatus).toHaveBeenCalledWith(42, 'approved');
    expect(next).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it('returns 502 when bypass execution fails to get token', async () => {
    db.checkBypassAuth.mockReturnValue(true);
    executor.getAccessToken.mockResolvedValue(null);

    const req = mockReq('DELETE', '/gimli/repos/test/issues/1');
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toContain('Failed to get access token');
  });

  it('returns 404 when account does not exist', async () => {
    db.getAccountCredentials.mockReturnValue(null);

    const req = mockReq('POST', '/nonexistent/repos', {});
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(404);
  });

  it('handles PUT and PATCH methods', async () => {
    db.checkBypassAuth.mockReturnValue(false);
    const req = mockReq('PUT', '/gimli/repos/test/contents/file.txt', { content: 'abc' });
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(202);
    expect(db.createQueueEntry).toHaveBeenCalled();
  });
});
