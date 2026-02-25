// Rate limiting and exponential backoff on failed auth
// In-memory stores (single-process deployment)

// --- Global rate limit: per-IP request counter ---

const globalHits = new Map(); // ip -> { count, resetTime }
const GLOBAL_WINDOW_MS = 60 * 1000; // 1 minute
const GLOBAL_MAX_REQUESTS = 200;

/**
 * Global rate limit middleware — 200 req/min per IP.
 * Applies to all routes.
 */
export function globalRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  let entry = globalHits.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + GLOBAL_WINDOW_MS };
    globalHits.set(ip, entry);
  }

  entry.count++;

  // Set standard rate limit headers
  const remaining = Math.max(0, GLOBAL_MAX_REQUESTS - entry.count);
  res.set('X-RateLimit-Limit', String(GLOBAL_MAX_REQUESTS));
  res.set('X-RateLimit-Remaining', String(remaining));
  res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));

  if (entry.count > GLOBAL_MAX_REQUESTS) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter
    });
  }

  next();
}

// --- Auth failure exponential backoff ---

const authFailures = new Map(); // ip -> { count, lockedUntil }
const AUTH_BACKOFF_THRESHOLD = 3; // failures before delays kick in
const AUTH_BACKOFF_MAX_MS = 10 * 60 * 1000; // 10 minute cap
const AUTH_FAILURE_WINDOW_MS = 30 * 60 * 1000; // reset after 30 min of no failures

/**
 * Calculate delay for a given failure count.
 * 1-3 failures: no delay
 * 4-5: 2s
 * 6+: doubles each time (4s, 8s, 16s, ...) capped at 10 min
 */
function getBackoffDelay(failureCount) {
  if (failureCount <= AUTH_BACKOFF_THRESHOLD) return 0;

  const exponent = failureCount - AUTH_BACKOFF_THRESHOLD - 1;
  const delayMs = 2000 * Math.pow(2, exponent);
  return Math.min(delayMs, AUTH_BACKOFF_MAX_MS);
}

/**
 * Check if an IP is currently in a backoff delay.
 * Returns { blocked, retryAfter } where retryAfter is seconds.
 */
export function checkAuthBackoff(ip) {
  const entry = authFailures.get(ip);
  if (!entry) return { blocked: false, retryAfter: 0 };

  const now = Date.now();

  // Clear stale entries
  if (now - entry.lastFailure > AUTH_FAILURE_WINDOW_MS) {
    authFailures.delete(ip);
    return { blocked: false, retryAfter: 0 };
  }

  if (entry.lockedUntil && now < entry.lockedUntil) {
    const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
    return { blocked: true, retryAfter };
  }

  return { blocked: false, retryAfter: 0 };
}

/**
 * Record a failed auth attempt for an IP.
 */
export function recordAuthFailure(ip) {
  const now = Date.now();
  let entry = authFailures.get(ip);

  if (!entry || now - entry.lastFailure > AUTH_FAILURE_WINDOW_MS) {
    entry = { count: 0, lastFailure: now, lockedUntil: null };
  }

  entry.count++;
  entry.lastFailure = now;

  const delay = getBackoffDelay(entry.count);
  entry.lockedUntil = delay > 0 ? now + delay : null;

  authFailures.set(ip, entry);
}

/**
 * Clear auth failures for an IP (on successful auth).
 */
export function clearAuthFailures(ip) {
  authFailures.delete(ip);
}

/**
 * Middleware that blocks requests from IPs in backoff.
 * Mount before auth-checking routes.
 */
export function authBackoffMiddleware(req, res, next) {
  const { blocked, retryAfter } = checkAuthBackoff(req.ip);
  if (blocked) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many failed authentication attempts',
      retryAfter
    });
  }
  next();
}

// --- Cleanup: periodically purge stale entries ---

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 min

function cleanup() {
  const now = Date.now();

  for (const [ip, entry] of globalHits) {
    if (now > entry.resetTime) globalHits.delete(ip);
  }

  for (const [ip, entry] of authFailures) {
    if (now - entry.lastFailure > AUTH_FAILURE_WINDOW_MS) authFailures.delete(ip);
  }
}

const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
cleanupTimer.unref(); // don't prevent process exit

// Export for testing
export { getBackoffDelay, globalHits, authFailures, cleanup };
