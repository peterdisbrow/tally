/**
 * Reseller management (admin CRUD) + reseller-authenticated API routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupResellerRoutes(app, ctx) {
  const { db, churches, requireAdmin, requireReseller, resellerSystem,
          hashPassword, safeErrorMessage, stmtInsert, stmtFindByName,
          jwt, JWT_SECRET, buildResellerPortalHtml, log } = ctx;
  const WebSocket = require('ws').WebSocket;

  // ─── ADMIN CRUD (requires admin JWT) ──────────────────────────────────────

  app.post('/api/resellers', requireAdmin, (req, res) => {
    const { name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit, commissionRate } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const result = resellerSystem.createReseller({ name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit, commissionRate });
      res.json(result);
    } catch (e) {
      console.error('[/api/resellers POST]', e.message);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/resellers', requireAdmin, (req, res) => {
    try { res.json(resellerSystem.listResellers()); }
    catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/resellers/:resellerId', requireAdmin, (req, res) => {
    const reseller = resellerSystem.getResellerById(req.params.resellerId);
    if (!reseller) return res.status(404).json({ error: 'Reseller not found' });
    const resellerChurches = resellerSystem.getResellerChurches(req.params.resellerId);
    res.json({ reseller, churches: resellerChurches });
  });

  app.put('/api/resellers/:resellerId', requireAdmin, (req, res) => {
    const { resellerId } = req.params;
    const row = resellerSystem.getResellerById(resellerId);
    if (!row) return res.status(404).json({ error: 'Reseller not found' });
    const map = { brandName: 'brand_name', supportEmail: 'support_email', logoUrl: 'logo_url', primaryColor: 'primary_color', customDomain: 'custom_domain', webhookUrl: 'webhook_url', churchLimit: 'church_limit', commissionRate: 'commission_rate' };
    const patch = {};
    for (const [k, v] of Object.entries(req.body)) {
      const key = map[k] || k;
      patch[key] = v;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      const updated = resellerSystem.updateReseller(resellerId, patch);
      res.json({ updated: true, reseller: updated });
    } catch (e) {
      console.error('[/api/resellers PUT]', e.message);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/resellers/:resellerId', requireAdmin, (req, res) => {
    const row = resellerSystem.getResellerById(req.params.resellerId);
    if (!row) return res.status(404).json({ error: 'Reseller not found' });
    db.prepare('UPDATE resellers SET active = 0 WHERE id = ?').run(req.params.resellerId);
    res.json({ deactivated: true });
  });

  app.post('/api/resellers/:resellerId/password', requireAdmin, (req, res) => {
    const row = resellerSystem.getResellerById(req.params.resellerId);
    if (!row) return res.status(404).json({ error: 'Reseller not found' });
    const { password, email } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hashed = hashPassword(password);
    try { db.exec('ALTER TABLE resellers ADD COLUMN portal_password_hash TEXT'); } catch { /* exists */ }
    try { db.exec('ALTER TABLE resellers ADD COLUMN portal_email TEXT'); } catch { /* exists */ }
    if (email) {
      const cleanEmail = email.trim().toLowerCase();
      db.prepare('UPDATE resellers SET portal_password_hash = ?, portal_password = ?, portal_email = ? WHERE id = ?').run(hashed, hashed, cleanEmail, req.params.resellerId);
    } else {
      db.prepare('UPDATE resellers SET portal_password_hash = ?, portal_password = ? WHERE id = ?').run(hashed, hashed, req.params.resellerId);
    }
    res.json({ updated: true });
  });

  // ─── RESELLER-AUTHENTICATED API ──────────────────────────────────────────

  app.post('/api/reseller/churches/register', requireReseller, (req, res) => {
    const reseller = req.reseller;
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    if (!resellerSystem.canAddChurch(reseller.id)) {
      return res.status(403).json({ error: `Church limit reached (max ${reseller.church_limit})` });
    }

    const existing = stmtFindByName.get(name);
    if (existing) return res.status(409).json({ error: `A church named "${name}" already exists` });

    try {
      const { v4: uuid } = require('uuid');
      const churchId = uuid();
      const token = jwt.sign({ churchId, name }, JWT_SECRET, { expiresIn: '365d' });
      const registeredAt = new Date().toISOString();

      stmtInsert.run(churchId, name, email || '', token, registeredAt);
      resellerSystem.registerChurch(reseller.id, churchId, name);

      churches.set(churchId, {
        churchId, name, email: email || '', token, ws: null,
        status: { connected: false, atem: null, obs: null },
        lastSeen: null, lastHeartbeat: null, registeredAt,
        disconnectedAt: null, _offlineAlertSent: false,
        church_type: 'recurring', event_expires_at: null, event_label: null,
        reseller_id: reseller.id,
      });

      log(`Reseller "${reseller.name}" registered church: ${name} (${churchId})`);
      res.json({ churchId, name, token, resellerId: reseller.id, message: 'Church registered. Share this token with the church client app.' });
    } catch (e) {
      console.error('[/api/reseller/churches/register]', e.message);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/reseller/churches', requireReseller, (req, res) => {
    try {
      const dbChurches = resellerSystem.getResellerChurches(req.reseller.id);
      const list = dbChurches.map(c => {
        const runtime = churches.get(c.churchId);
        return {
          churchId: c.churchId, name: c.name,
          connected: runtime?.ws?.readyState === WebSocket.OPEN,
          status: runtime?.status || null, lastSeen: runtime?.lastSeen || null,
        };
      });
      res.json(list);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/reseller/churches/:churchId', requireReseller, (req, res) => {
    const row = db.prepare('SELECT * FROM churches WHERE churchId = ? AND reseller_id = ?')
      .get(req.params.churchId, req.reseller.id);
    if (!row) return res.status(404).json({ error: 'Church not found or does not belong to your account' });
    const runtime = churches.get(row.churchId);
    res.json({
      churchId: row.churchId, name: row.name,
      connected: runtime?.ws?.readyState === WebSocket.OPEN,
      status: runtime?.status || null, lastSeen: runtime?.lastSeen || null,
    });
  });

  app.get('/api/reseller/branding', requireReseller, (req, res) => {
    const branding = resellerSystem.getBranding(req.reseller.id);
    if (!branding) return res.status(404).json({ error: 'Reseller not found' });
    res.json(branding);
  });

  // GET /portal — white-labeled portal HTML
  app.get('/portal', (req, res) => {
    const key = req.query.key || req.headers['x-reseller-key'];
    if (!key) {
      return res.status(401).send('<html><body style="background:#0f1117;color:#e2e4ef;font-family:monospace;padding:40px"><h1>401 Unauthorized</h1><p>Add <code>?key=YOUR_RESELLER_KEY</code> to the URL.</p></body></html>');
    }
    const reseller = resellerSystem.getReseller(key);
    if (!reseller) {
      return res.status(403).send('<html><body style="background:#0f1117;color:#e2e4ef;font-family:monospace;padding:40px"><h1>403 Forbidden</h1><p>Invalid reseller key.</p></body></html>');
    }
    if (reseller.active === 0) {
      return res.status(403).send('<html><body style="background:#0f1117;color:#e2e4ef;font-family:monospace;padding:40px"><h1>403 Forbidden</h1><p>Reseller account is inactive.</p></body></html>');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildResellerPortalHtml(reseller));
  });

  app.get('/api/reseller/me', requireReseller, (req, res) => {
    try {
      const stats = resellerSystem.getResellerStats(req.reseller.id, churches);
      const { api_key, ...safe } = req.reseller;
      res.json({ ...safe, ...stats });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.put('/api/reseller/me', requireReseller, (req, res) => {
    try {
      const { name, brand_name, support_email, logo_url, primary_color, custom_domain } = req.body;
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (brand_name !== undefined) patch.brand_name = brand_name;
      if (support_email !== undefined) patch.support_email = support_email;
      if (logo_url !== undefined) patch.logo_url = logo_url;
      if (primary_color !== undefined) patch.primary_color = primary_color;
      if (custom_domain !== undefined) patch.custom_domain = custom_domain;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields provided' });
      const updated = resellerSystem.updateReseller(req.reseller.id, patch);
      const { api_key, ...safe } = updated;
      res.json(safe);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/reseller/churches/token', requireReseller, (req, res) => {
    try {
      const { churchName, contactEmail, portalEmail, password } = req.body || {};
      if (!churchName) return res.status(400).json({ error: 'churchName required' });
      if (password && !portalEmail) return res.status(400).json({ error: 'portalEmail is required when password is provided' });
      if (portalEmail && !password) return res.status(400).json({ error: 'password is required when portalEmail is provided' });
      if (password && String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

      const cleanContactEmail = String(contactEmail || '').trim();
      const cleanPortalEmail = String(portalEmail || '').trim().toLowerCase();

      if (cleanPortalEmail) {
        const existingEmail = db.prepare('SELECT churchId FROM churches WHERE portal_email = ?').get(cleanPortalEmail);
        if (existingEmail) return res.status(409).json({ error: 'portalEmail already exists' });
      }

      const createChurch = db.transaction(() => {
        const result = resellerSystem.generateChurchToken(req.reseller.id, churchName);
        if (cleanContactEmail) {
          db.prepare('UPDATE churches SET email = ? WHERE churchId = ?').run(cleanContactEmail, result.churchId);
        }
        if (cleanPortalEmail) {
          db.prepare('UPDATE churches SET portal_email = ?, portal_password_hash = ? WHERE churchId = ?')
            .run(cleanPortalEmail, hashPassword(password), result.churchId);
        }
        return result;
      });
      const result = createChurch();

      churches.set(result.churchId, {
        churchId: result.churchId, name: result.churchName,
        email: cleanContactEmail, token: result.token, ws: null,
        status: { connected: false, atem: null, obs: null },
        lastSeen: null, lastHeartbeat: null, registeredAt: new Date().toISOString(),
        disconnectedAt: null, _offlineAlertSent: false,
        church_type: 'recurring', event_expires_at: null, event_label: null,
        reseller_id: req.reseller.id,
      });

      log(`Reseller "${req.reseller.name}" created church token: ${result.churchName} (${result.churchId})`);
      res.json({
        churchId: result.churchId, churchName: result.churchName,
        registrationCode: result.registrationCode,
        portalEmail: cleanPortalEmail || null, appLoginCreated: !!cleanPortalEmail,
        reseller: req.reseller.brand_name || req.reseller.name,
      });
    } catch (e) {
      const msg = String(e.message || '');
      const status = msg.includes('limit') ? 403 :
        (msg.includes('already exists') || msg.includes('UNIQUE constraint failed')) ? 409 :
        (msg.includes('required') || msg.includes('at least 8')) ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  app.get('/api/reseller/stats', requireReseller, (req, res) => {
    try {
      const stats = resellerSystem.getResellerStats(req.reseller.id, churches);
      res.json(stats);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });
};
