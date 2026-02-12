// Auth routes - login, logout, password setup
import { Router } from 'express';
import { setAdminPassword, verifyAdminPassword, hasAdminPassword } from '../../lib/db.js';
import { AUTH_COOKIE, COOKIE_MAX_AGE, htmlHead } from './shared.js';

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
  res.send(renderLoginPage());
});

// Handle login
router.post('/login', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.send(renderLoginPage('Password required'));
  }

  const valid = await verifyAdminPassword(password);
  if (!valid) {
    return res.send(renderLoginPage('Invalid password'));
  }

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
  res.send(renderSetupPasswordPage());
});

// Handle password setup
router.post('/setup-password', async (req, res) => {
  if (hasAdminPassword()) {
    return res.redirect('/ui/login');
  }

  const { password, confirmPassword } = req.body;
  if (!password || password.length < 4) {
    return res.send(renderSetupPasswordPage('Password must be at least 4 characters'));
  }
  if (password !== confirmPassword) {
    return res.send(renderSetupPasswordPage('Passwords do not match'));
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

// Render functions
function renderLoginPage(error = '') {
  return `${htmlHead('Login')}
<body>
  <div style="max-width: 400px; margin: 100px auto;">
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 24px;">
      <img src="/public/favicon.svg" alt="agentgate" style="height: 48px;">
      <h1 style="margin: 0;">agentgate</h1>
    </div>
    <div class="card">
      <h2 style="margin-top: 0;">Login</h2>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form method="POST" action="/ui/login">
        <label>Password</label>
        <input type="password" name="password" required autofocus autocomplete="off">
        <button type="submit" class="btn-primary" style="width: 100%;">Login</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderSetupPasswordPage(error = '') {
  return `${htmlHead('Setup')}
<body>
  <div style="max-width: 400px; margin: 100px auto;">
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 24px;">
      <img src="/public/favicon.svg" alt="agentgate" style="height: 48px;">
      <h1 style="margin: 0;">agentgate</h1>
    </div>
    <div class="card">
      <h2 style="margin-top: 0;">Set Admin Password</h2>
      <p class="help">This is your first time running agentgate. Please set an admin password.</p>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form method="POST" action="/ui/setup-password">
        <label>Password</label>
        <input type="password" name="password" required autofocus minlength="4" autocomplete="off">
        <label>Confirm Password</label>
        <input type="password" name="confirmPassword" required minlength="4" autocomplete="off">
        <button type="submit" class="btn-primary" style="width: 100%;">Set Password</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

export default router;
