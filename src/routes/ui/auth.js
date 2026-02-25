// Auth routes - login, logout, password setup
import { Router } from 'express';
import { setAdminPassword, verifyAdminPassword, hasAdminPassword } from '../../lib/db.js';
import { AUTH_COOKIE, COOKIE_MAX_AGE } from './shared.js';
import { checkAuthBackoff, recordAuthFailure, clearAuthFailures } from '../../lib/rateLimiter.js';

const router = Router();

// Check if user is authenticated
export function isAuthenticated(req) {
  return req.signedCookies[AUTH_COOKIE] === 'authenticated';
}

// Auth middleware for protected routes
export function requireAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/setup-password') {
    return next();
  }

  if (!hasAdminPassword()) {
    return res.redirect('/ui/setup-password');
  }

  if (!isAuthenticated(req)) {
    return res.redirect('/ui/login');
  }

  next();
}

// Login page
router.get('/login', (req, res) => {
  if (!hasAdminPassword()) {
    return res.redirect('/ui/setup-password');
  }
  if (isAuthenticated(req)) {
    return res.redirect('/ui');
  }
  res.render('pages/login');
});

// Handle login
router.post('/login', async (req, res) => {
  // Check if IP is in backoff from previous failures
  const { blocked, retryAfter } = checkAuthBackoff(req.ip);
  if (blocked) {
    return res.render('pages/login', { error: `Too many failed attempts. Try again in ${retryAfter} seconds.` });
  }

  const { password } = req.body;
  if (!password) {
    return res.render('pages/login', { error: 'Password required' });
  }

  const valid = await verifyAdminPassword(password);
  if (!valid) {
    recordAuthFailure(req.ip);
    return res.render('pages/login', { error: 'Invalid password' });
  }

  // Successful auth — clear any backoff
  clearAuthFailures(req.ip);

  res.cookie(AUTH_COOKIE, 'authenticated', {
    signed: true,
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax'
  });
  res.redirect('/ui');
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.redirect('/ui/login');
});

// Password setup page (first time only)
router.get('/setup-password', (req, res) => {
  if (hasAdminPassword()) {
    return res.redirect('/ui/login');
  }
  res.render('pages/setup-password');
});

// Handle password setup
router.post('/setup-password', async (req, res) => {
  if (hasAdminPassword()) {
    return res.redirect('/ui/login');
  }

  const { password, confirmPassword } = req.body;
  if (!password || password.length < 4) {
    return res.render('pages/setup-password', { error: 'Password must be at least 4 characters' });
  }
  if (password !== confirmPassword) {
    return res.render('pages/setup-password', { error: 'Passwords do not match' });
  }

  await setAdminPassword(password);

  res.cookie(AUTH_COOKIE, 'authenticated', {
    signed: true,
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax'
  });
  res.redirect('/ui');
});

export default router;
