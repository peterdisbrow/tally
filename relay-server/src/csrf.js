/**
 * CSRF protection — double-submit cookie pattern.
 *
 * On session creation (login/signup), call generateCsrfToken() and
 * setCsrfCookie(res, token) to issue a readable cookie. The portal JS
 * reads the cookie value and sends it as the `x-csrf-token` request header
 * on every state-changing fetch call. csrfMiddleware validates the match.
 *
 * Routes authenticated via X-Admin-Api-Key or Authorization Bearer header
 * never carry a session cookie, so they are skipped automatically.
 */

const crypto = require('node:crypto');

const CSRF_COOKIE = 'tally_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Login/logout routes are exempt: login has no session cookie yet,
// logout is low-risk, and Stripe webhook is verified by signature.
const CSRF_EXEMPT = new Set([
  '/api/church/login',
  '/api/church/logout',
  '/api/church/app/onboard',
  '/api/church/app/login',
  '/api/admin/login',
  '/api/reseller-portal/login',
  '/api/reseller-portal/logout',
  '/api/reseller-portal/signup',
  '/api/billing/webhook',
]);

// Browser-session cookie names. Routes that arrive without any of these
// cookies are authenticated by API key or Bearer token — no CSRF risk.
const SESSION_COOKIES = ['tally_church_session', 'tally_reseller_session', 'tally_admin_key'];

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Set the CSRF cookie on the response.
 * httpOnly must be false so JS can read it and include it in request headers.
 */
function setCsrfCookie(res, token) {
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: 'Strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

/**
 * Express middleware — validates x-csrf-token header against tally_csrf cookie
 * for all state-changing requests from browser-session-authenticated callers.
 */
function csrfMiddleware(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT.has(req.path)) return next();

  // Only enforce when the request carries a browser session cookie.
  const hasSessionCookie = SESSION_COOKIES.some(name => req.cookies && req.cookies[name]);
  if (!hasSessionCookie) return next();

  // Admin SPA routes authenticated via JWT/API key (no session cookie) are
  // already skipped above. If a session cookie IS present, enforce CSRF.

  const cookieToken = req.cookies[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];

  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  // Constant-time comparison to prevent timing oracle attacks.
  try {
    const a = Buffer.from(cookieToken, 'hex');
    const b = Buffer.from(headerToken, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'CSRF token invalid' });
    }
  } catch {
    return res.status(403).json({ error: 'CSRF token invalid' });
  }

  next();
}

module.exports = { generateCsrfToken, setCsrfCookie, csrfMiddleware };
