/**
 * Admin authentication & user management routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupAdminAuthRoutes(app, ctx) {
  const { db, queryClient, requireAdminJwt, rateLimit, hashPassword, verifyPassword,
          ADMIN_ROLES, uuidv4, jwt, JWT_SECRET, log, logAudit } = ctx;
  const { SqliteQueryClient } = require('../db/queryClient');
  const adminQuery = queryClient || new SqliteQueryClient(db);
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const qOne = (sql, params = []) => adminQuery.queryOne(sql, params);
  const qAll = (sql, params = []) => adminQuery.query(sql, params);
  const qRun = (sql, params = []) => adminQuery.run(sql, params);

  // POST /api/admin/login
  app.post('/api/admin/login', rateLimit(5, 15 * 60 * 1000), asyncRoute(async (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await qOne('SELECT * FROM admin_users WHERE email = ?', [cleanEmail]);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      logAudit({ adminEmail: cleanEmail, action: 'admin_login_failed', targetType: 'admin_user', details: { reason: !user ? 'not_found' : !user.active ? 'inactive' : 'bad_password' }, ip: req.ip });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await qRun('UPDATE admin_users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);

    const token = jwt.sign(
      { type: 'admin', userId: user.id, role: user.role, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    logAudit({ adminUserId: user.id, adminEmail: user.email, action: 'admin_login_success', targetType: 'admin_user', targetId: user.id, ip: req.ip });
    log(`[AdminLogin] ${user.email} (${user.role}) logged in`);
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }));

  // GET /api/admin/me
  app.get('/api/admin/me', requireAdminJwt(), (req, res) => {
    const u = req.adminUser;
    res.json({ id: u.id, email: u.email, name: u.name, role: u.role });
  });

  // PUT /api/admin/me/password
  app.put('/api/admin/me/password', requireAdminJwt(), asyncRoute(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const user = await qOne('SELECT password_hash FROM admin_users WHERE id = ?', [req.adminUser.id]);
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    await qRun('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(newPassword), new Date().toISOString(), req.adminUser.id]);

    log(`[AdminUsers] ${req.adminUser.email} changed their password`);
    res.json({ ok: true });
  }));

  // GET /api/admin/users
  app.get('/api/admin/users', requireAdminJwt('super_admin'), asyncRoute(async (req, res) => {
    const users = await qAll('SELECT id, email, name, role, active, created_at, created_by, last_login_at, updated_at FROM admin_users ORDER BY created_at ASC');
    res.json(users);
  }));

  // POST /api/admin/users
  app.post('/api/admin/users', requireAdminJwt('super_admin'), asyncRoute(async (req, res) => {
    const { email, password, name, role } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!cleanEmail || !password || !name) {
      return res.status(400).json({ error: 'email, password, and name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!ADMIN_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${ADMIN_ROLES.join(', ')}` });
    }

    const existing = await qOne('SELECT id FROM admin_users WHERE email = ?', [cleanEmail]);
    if (existing) {
      return res.status(409).json({ error: 'An admin with this email already exists' });
    }

    const id = uuidv4();
    await qRun(
      'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [id, cleanEmail, hashPassword(password), name.trim(), role, 1, new Date().toISOString(), req.adminUser.id],
    );

    logAudit({ adminUserId: req.adminUser.id, adminEmail: req.adminUser.email, action: 'admin_user_created', targetType: 'admin_user', targetId: id, details: { email: cleanEmail, role }, ip: req.ip });
    log(`[AdminUsers] ${req.adminUser.email} created ${role} user: ${cleanEmail}`);
    res.status(201).json({ id, email: cleanEmail, name: name.trim(), role, active: 1 });
  }));

  // PUT /api/admin/users/:userId
  app.put('/api/admin/users/:userId', requireAdminJwt('super_admin'), asyncRoute(async (req, res) => {
    const { name, role, active } = req.body || {};
    const target = await qOne('SELECT * FROM admin_users WHERE id = ?', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (target.role === 'super_admin' && (role !== 'super_admin' || active === 0 || active === false)) {
      const superCount = (await qOne("SELECT COUNT(*) as cnt FROM admin_users WHERE role = 'super_admin' AND active = 1"))?.cnt || 0;
      if (superCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote or deactivate the last super_admin' });
      }
    }

    if (role !== undefined && !ADMIN_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${ADMIN_ROLES.join(', ')}` });
    }

    const patch = {};
    if (name   !== undefined) patch.name   = name.trim();
    if (role   !== undefined) patch.role   = role;
    if (active !== undefined) patch.active = active ? 1 : 0;

    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const sets = Object.keys(patch).map(k => `${k} = ?`).join(', ');
      await qRun(`UPDATE admin_users SET ${sets} WHERE id = ?`, [...Object.values(patch), req.params.userId]);
    }

    log(`[AdminUsers] ${req.adminUser.email} updated user ${target.email}: ${JSON.stringify(patch)}`);
    res.json({ ok: true });
  }));

  // PUT /api/admin/users/:userId/password
  app.put('/api/admin/users/:userId/password', requireAdminJwt('super_admin'), asyncRoute(async (req, res) => {
    const { password } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const target = await qOne('SELECT email FROM admin_users WHERE id = ?', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    await qRun('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(password), new Date().toISOString(), req.params.userId]);

    log(`[AdminUsers] ${req.adminUser.email} reset password for ${target.email}`);
    res.json({ ok: true });
  }));

  // DELETE /api/admin/users/:userId
  app.delete('/api/admin/users/:userId', requireAdminJwt('super_admin'), asyncRoute(async (req, res) => {
    const target = await qOne('SELECT * FROM admin_users WHERE id = ?', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (target.id === req.adminUser.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    if (target.role === 'super_admin') {
      const superCount = (await qOne("SELECT COUNT(*) as cnt FROM admin_users WHERE role = 'super_admin' AND active = 1"))?.cnt || 0;
      if (superCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last super_admin' });
      }
    }

    await qRun('UPDATE admin_users SET active = 0, updated_at = ? WHERE id = ?', [new Date().toISOString(), req.params.userId]);

    logAudit({ adminUserId: req.adminUser.id, adminEmail: req.adminUser.email, action: 'admin_user_deleted', targetType: 'admin_user', targetId: req.params.userId, details: { email: target.email }, ip: req.ip });
    log(`[AdminUsers] ${req.adminUser.email} deactivated user ${target.email}`);
    res.json({ ok: true });
  }));

  // GET /api/admin/ai-usage
  app.get('/api/admin/ai-usage', requireAdminJwt(), asyncRoute(async (req, res) => {
    try {
      const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const to   = req.query.to   || new Date().toISOString();

      const totals = await qOne(`
        SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END), 0) as cache_hits
        FROM ai_usage_log WHERE created_at >= ? AND created_at <= ?
      `, [from, to]);

      const byChurch = await qAll(`
        SELECT
          u.church_id,
          COALESCE(c.name, u.church_id, 'Admin / Dashboard') as church_name,
          COUNT(*) as requests,
          SUM(u.input_tokens) as input_tokens,
          SUM(u.output_tokens) as output_tokens,
          SUM(u.cost_usd) as cost
        FROM ai_usage_log u
        LEFT JOIN churches c ON c.churchId = u.church_id
        WHERE u.created_at >= ? AND u.created_at <= ?
        GROUP BY u.church_id
        ORDER BY cost DESC
      `, [from, to]);

      const byFeature = await qAll(`
        SELECT
          feature,
          COUNT(*) as requests,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cost_usd) as cost
        FROM ai_usage_log WHERE created_at >= ? AND created_at <= ?
        GROUP BY feature
        ORDER BY cost DESC
      `, [from, to]);

      res.json({ totals, byChurch, byFeature });
    } catch (err) {
      console.error('[AI Usage API] Error:', err.message);
      res.status(500).json({ error: 'Failed to load AI usage data' });
    }
  }));
};
