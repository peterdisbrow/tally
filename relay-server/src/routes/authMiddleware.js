/**
 * Authentication & authorization middleware.
 *
 * Exports middleware factories for admin JWT, church app tokens,
 * reseller keys, and the legacy API key flow.
 *
 * @param {object} ctx - Shared server context
 */
const jwt = require('jsonwebtoken');

module.exports = function createAuthMiddleware(ctx) {
  const { db, JWT_SECRET, ADMIN_API_KEY, safeCompareKey, resolveAdminKey } = ctx;

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
   * JWT-based admin auth middleware.
   * Accepts: Authorization: Bearer <jwt> or x-admin-jwt header.
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
          const payload = jwt.verify(token, JWT_SECRET);
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

      return res.status(401).json({ error: 'unauthorized' });
    };
  }

  function requireAdmin(req, res, next) {
    // Alias for JWT-based admin auth
    return requireAdminJwt()(req, res, next);
  }

  function requireReseller(req, res, next) {
    const key = req.headers['x-reseller-key'];
    if (!key) return res.status(401).json({ error: 'Reseller API key required' });
    const reseller = db.prepare('SELECT * FROM resellers WHERE api_key = ? AND active = 1').get(key);
    if (!reseller) return res.status(403).json({ error: 'Invalid or deactivated reseller key' });
    req.reseller = reseller;
    next();
  }

  function requireChurchOrAdmin(req, res, next) {
    const key = resolveAdminKey(req);
    if (safeCompareKey(key, ADMIN_API_KEY)) return next();

    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
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

  function requireChurchAppAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
    }
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      if (payload.type !== 'church_app') throw new Error('wrong token type');
      const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });
      req.church = church;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  return {
    ADMIN_ROLES,
    ROLE_PERMISSIONS,
    hasPermission,
    requireAdminJwt,
    requireAdmin,
    requireReseller,
    requireChurchOrAdmin,
    requireChurchAppAuth,
  };
};
