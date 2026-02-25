import { jest } from '@jest/globals';

// Import the module
let rateLimiter;

beforeEach(async () => {
  // Fresh import each test to reset state
  rateLimiter = await import('../src/lib/rateLimiter.js');
  // Clear maps between tests
  rateLimiter.globalHits.clear();
  rateLimiter.authFailures.clear();
});

describe('getBackoffDelay', () => {
  test('no delay for 1-3 failures', () => {
    expect(rateLimiter.getBackoffDelay(1)).toBe(0);
    expect(rateLimiter.getBackoffDelay(2)).toBe(0);
    expect(rateLimiter.getBackoffDelay(3)).toBe(0);
  });

  test('2s delay for 4th failure', () => {
    expect(rateLimiter.getBackoffDelay(4)).toBe(2000);
  });

  test('2s delay for 5th failure', () => {
    expect(rateLimiter.getBackoffDelay(5)).toBe(4000);
  });

  test('doubles each time after threshold', () => {
    expect(rateLimiter.getBackoffDelay(6)).toBe(8000);
    expect(rateLimiter.getBackoffDelay(7)).toBe(16000);
  });

  test('caps at 10 minutes', () => {
    expect(rateLimiter.getBackoffDelay(100)).toBe(10 * 60 * 1000);
  });
});

describe('globalRateLimit middleware', () => {
  function mockReqRes(ip = '127.0.0.1') {
    const req = { ip };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn()
    };
    const next = jest.fn();
    return { req, res, next };
  }

  test('allows requests under limit', () => {
    const { req, res, next } = mockReqRes();
    rateLimiter.globalRateLimit(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('X-RateLimit-Remaining', '199');
  });

  test('blocks requests over limit', () => {
    const ip = '10.0.0.1';
    // Fill up the limit
    for (let i = 0; i < 200; i++) {
      const { req, res, next } = mockReqRes(ip);
      rateLimiter.globalRateLimit(req, res, next);
    }
    // 201st should be blocked
    const { req, res, next } = mockReqRes(ip);
    rateLimiter.globalRateLimit(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  test('different IPs have separate limits', () => {
    // Fill up IP A
    for (let i = 0; i < 200; i++) {
      const { req, res, next } = mockReqRes('10.0.0.1');
      rateLimiter.globalRateLimit(req, res, next);
    }
    // IP B should still be fine
    const { req, res, next } = mockReqRes('10.0.0.2');
    rateLimiter.globalRateLimit(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('auth backoff', () => {
  test('no block initially', () => {
    const result = rateLimiter.checkAuthBackoff('1.2.3.4');
    expect(result.blocked).toBe(false);
  });

  test('no block after 3 failures', () => {
    rateLimiter.recordAuthFailure('1.2.3.4');
    rateLimiter.recordAuthFailure('1.2.3.4');
    rateLimiter.recordAuthFailure('1.2.3.4');
    const result = rateLimiter.checkAuthBackoff('1.2.3.4');
    expect(result.blocked).toBe(false);
  });

  test('blocks after 4th failure', () => {
    for (let i = 0; i < 4; i++) {
      rateLimiter.recordAuthFailure('1.2.3.4');
    }
    const result = rateLimiter.checkAuthBackoff('1.2.3.4');
    expect(result.blocked).toBe(true);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test('clearAuthFailures resets', () => {
    for (let i = 0; i < 10; i++) {
      rateLimiter.recordAuthFailure('1.2.3.4');
    }
    rateLimiter.clearAuthFailures('1.2.3.4');
    const result = rateLimiter.checkAuthBackoff('1.2.3.4');
    expect(result.blocked).toBe(false);
  });
});

describe('cleanup', () => {
  test('removes stale global hits', () => {
    rateLimiter.globalHits.set('old-ip', { count: 5, resetTime: Date.now() - 1000 });
    rateLimiter.cleanup();
    expect(rateLimiter.globalHits.has('old-ip')).toBe(false);
  });

  test('keeps fresh global hits', () => {
    rateLimiter.globalHits.set('fresh-ip', { count: 5, resetTime: Date.now() + 60000 });
    rateLimiter.cleanup();
    expect(rateLimiter.globalHits.has('fresh-ip')).toBe(true);
  });
});
