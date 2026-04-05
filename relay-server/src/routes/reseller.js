/**
 * Reseller management (admin CRUD) + reseller-authenticated API routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupResellerRoutes(app, ctx) {
  const { churches, requireAdmin, requireReseller, resellerSystem,
          hashPassword, safeErrorMessage,
          lifecycleEmails, log } = ctx;
  const WebSocket = require('ws').WebSocket;
  const { hasOpenSocket } = require('../runtimeSockets');

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
    resellerSystem.deactivateReseller(req.params.resellerId);
    res.json({ deactivated: true });
  });

  app.post('/api/resellers/:resellerId/password', requireAdmin, (req, res) => {
    const row = resellerSystem.getResellerById(req.params.resellerId);
    if (!row) return res.status(404).json({ error: 'Reseller not found' });
    const { password, email } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hashed = hashPassword(password);
    const patch = { portal_password_hash: hashed };
    if (email) {
      const cleanEmail = email.trim().toLowerCase();
      const existing = resellerSystem.getResellerByPortalEmail(cleanEmail);
      if (existing && existing.id !== req.params.resellerId) {
        return res.status(409).json({ error: 'Email already used by another reseller' });
      }
      patch.portal_email = cleanEmail;
    }
    resellerSystem.updateReseller(req.params.resellerId, patch);
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

    try {
      const result = resellerSystem.generateChurchToken(reseller.id, name);
      if (email) {
        resellerSystem.updateChurch(result.churchId, { email: email || '' });
      }

      churches.set(result.churchId, {
        churchId: result.churchId, name, email: email || '', token: result.token, ws: null,
        status: {},
        lastSeen: null, lastHeartbeat: null, registeredAt: new Date().toISOString(),
        disconnectedAt: null, _offlineAlertSent: false,
        church_type: 'recurring', event_expires_at: null, event_label: null,
        reseller_id: reseller.id,
      });

      log(`Reseller "${reseller.name}" registered church: ${name} (${result.churchId})`);

      // Send registration confirmation lifecycle email if the church has a contact email
      if (lifecycleEmails && email) {
        const regChurch = { churchId: result.churchId, name, portal_email: email };
        lifecycleEmails.sendRegistrationConfirmation(regChurch)
          .catch(e => log(`[Reseller] Registration email failed for ${email}: ${e.message}`));
      }

      res.json({ churchId: result.churchId, name, token: result.token, resellerId: reseller.id, message: 'Church registered. Share this token with the church client app.' });
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
          connected: hasOpenSocket(runtime, WebSocket.OPEN),
          status: runtime?.status || null, lastSeen: runtime?.lastSeen || null,
        };
      });
      res.json(list);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/reseller/churches/:churchId', requireReseller, (req, res) => {
    const row = resellerSystem.getChurchForReseller(req.reseller.id, req.params.churchId);
    if (!row) return res.status(404).json({ error: 'Church not found or does not belong to your account' });
    const runtime = churches.get(row.churchId);
    res.json({
      churchId: row.churchId, name: row.name,
      connected: hasOpenSocket(runtime, WebSocket.OPEN),
      status: runtime?.status || null, lastSeen: runtime?.lastSeen || null,
    });
  });

  app.get('/api/reseller/branding', requireReseller, (req, res) => {
    const branding = resellerSystem.getBranding(req.reseller.id);
    if (!branding) return res.status(404).json({ error: 'Reseller not found' });
    res.json(branding);
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
      if (logo_url !== undefined) {
        if (logo_url !== null && logo_url !== '') {
          try { const u = new URL(logo_url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); }
          catch { return res.status(400).json({ error: 'logo_url must be a valid http/https URL' }); }
        }
        patch.logo_url = logo_url || null;
      }
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
        const existingEmail = resellerSystem.getChurchByPortalEmail(cleanPortalEmail);
        if (existingEmail) return res.status(409).json({ error: 'portalEmail already exists' });
      }

      const result = resellerSystem.generateChurchToken(req.reseller.id, churchName);
      if (cleanContactEmail || cleanPortalEmail) {
        const churchPatch = {};
        if (cleanContactEmail) churchPatch.email = cleanContactEmail;
        if (cleanPortalEmail) {
          churchPatch.portal_email = cleanPortalEmail;
          churchPatch.portal_password_hash = hashPassword(password);
        }
        resellerSystem.updateChurch(result.churchId, churchPatch);
      }

      churches.set(result.churchId, {
        churchId: result.churchId, name: result.churchName,
        email: cleanContactEmail, token: result.token, ws: null,
        status: {},
        lastSeen: null, lastHeartbeat: null, registeredAt: new Date().toISOString(),
        disconnectedAt: null, _offlineAlertSent: false,
        church_type: 'recurring', event_expires_at: null, event_label: null,
        reseller_id: req.reseller.id,
      });

      log(`Reseller "${req.reseller.name}" created church token: ${result.churchName} (${result.churchId})`);

      // Send registration confirmation lifecycle email to portal email or contact email
      const emailRecipient = cleanPortalEmail || cleanContactEmail;
      if (lifecycleEmails && emailRecipient) {
        const regChurch = { churchId: result.churchId, name: result.churchName, portal_email: emailRecipient };
        lifecycleEmails.sendRegistrationConfirmation(regChurch)
          .catch(e => log(`[Reseller] Registration email failed for ${emailRecipient}: ${e.message}`));
      }

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
      res.status(status).json({ error: safeErrorMessage(e, 'Church provisioning failed') });
    }
  });

  app.get('/api/reseller/stats', requireReseller, (req, res) => {
    try {
      const stats = resellerSystem.getResellerStats(req.reseller.id, churches);
      res.json(stats);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });
};
