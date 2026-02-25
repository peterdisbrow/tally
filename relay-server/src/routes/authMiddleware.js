'use strict';

const jwt = require('jsonwebtoken');

const ADMIN_ROLES = ['super_admin', 'admin', 'engineer', 'sales'];

const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  admin:       ['churches:read', 'churches:write', 'churches:delete',
                'billing:read', 'billing:write',
                'resellers:read', 'resellers:write', 'resellers:delete',
                'commands:send', 'settings:read', 'settings:write'],
  engineer:    ['churches:read', 'commands:send',
                'sessions:read', 'alerts:read', 'alerts:ack',
                'settings:read'],
  sales:       ['churches:read',
                'billing:read',
                'resellers:read', 'resellers:write'],
};

function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

/**
 * Create auth middleware functions bound to the app's runtime context.
 *
 * @param {Object} ctx
 * @param {Object} ctx.db - better-sqlite3 database instance
 * @param {string} ctx.JWT_SECRET
 * @param {string} ctx.ADMIN_API_KEY
 * @param {string} ctx.ADMIN_SESSION_COOKIE
 * @param {Function} ctx.safeCompareKey
 * @returns {{ requireAdminJwt, requireAdmin, requireReseller, requireChurchOrAdmin }}
 */
function createAuthMiddleware(ctx) {
  const { db, JWT_SECRET: jwtSecret, ADMIN_API_KEY: adminApiKey, ADMIN_SESSION_COOKIE: sessionCookie, safeCompareKey } = ctx;

  function resolveAdminKey(req) {
    return req.headers['x-api-key'] || req.cookies[sessionCookie];
  }

  /**
   * JWT-based admin auth middleware.
   * Accepts: Authorization: Bearer <jwt>, x-admin-jwt header, or legacy x-api-key.
   * @param {...string} allowedRoles - If provided, only these roles are allowed. Empty = any admin role.
   */
  function requireAdminJwt(...allowedRoles) {
    return (req, res, next) => {
      // 1. Try JWT from Authorization: Bearer header
      let token = null;
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
      // 2. Try x-admin-jwt header (from landing site proxy)
      if (!token) token = req.headers['x-admin-jwt'];

      if (token) {
        try {
          const payload = jwt.verify(token, jwtSecret);
          if (payload.type !== 'admin') throw new Error('wrong token type');

          // Verify user still exists and is active (catches revocations)
          const user = db.prepare('SELECT id, email, name, role, active FROM admin_users WHERE id = ?').get(payload.userId);
          if (!user || !user.active) {
            return res.status(401).json({ error: 'Account deactivated or not found' });
          }

          // Check role permission
          if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
          }

          req.adminUser = { id: user.id, email: user.email, name: user.name, role: user.role };
          return next();
        } catch (e) {
          if (e.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
          }
          return res.status(401).json({ error: 'Invalid admin token' });
        }
      }

      // 3. Legacy fallback: x-api-key or admin cookie → treat as super_admin
      const key = resolveAdminKey(req);
      if (safeCompareKey(key, adminApiKey)) {
        req.adminUser = { id: '_legacy_api_key', email: '', name: 'API Key', role: 'super_admin' };
        if (allowedRoles.length > 0 && !allowedRoles.includes('super_admin')) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
        return next();
      }

      return res.status(401).json({ error: 'unauthorized' });
    };
  }

  function requireAdmin(req, res, next) {
    // Backward-compatible: accepts JWT or legacy API key
    return requireAdminJwt()(req, res, next);
  }

  function requireReseller(req, res, next) {
    const key = req.headers['x-reseller-key'];
    if (!key) return res.status(401).json({ error: 'Reseller API key required' });
    const reseller = db.prepare('SELECT * FROM resellers WHERE api_key = ?').get(key);
    if (!reseller) return res.status(403).json({ error: 'Invalid reseller key' });
    req.reseller = reseller;
    next();
  }

  function requireChurchOrAdmin(req, res, next) {
    const key = resolveAdminKey(req);
    if (safeCompareKey(key, adminApiKey)) return next();

    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), jwtSecret);
        // Church JWT can only access its own data
        if (req.params.churchId && payload.churchId !== req.params.churchId) {
          return res.status(403).json({ error: 'forbidden' });
        }
        req.churchPayload = payload;
        return next();
      } catch {
        return res.status(401).json({ error: 'invalid token' });
      }
    }

    return res.status(401).json({ error: 'unauthorized' });
  }

  return {
    resolveAdminKey,
    requireAdminJwt,
    requireAdmin,
    requireReseller,
    requireChurchOrAdmin,
  };
}

module.exports = {
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  createAuthMiddleware,
};
