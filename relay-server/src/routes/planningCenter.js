/**
 * Planning Center integration routes.
 *
 * OAuth flow:
 *   GET  /api/admin/pco/auth-url          — Generate OAuth authorization URL
 *   GET  /api/admin/pco/callback          — Handle OAuth callback (public, receives redirect from PCO)
 *   POST /api/churches/:id/planning-center/disconnect — Disconnect OAuth
 *
 * Plan data:
 *   GET  /api/churches/:id/planning-center/plans          — Upcoming cached plans
 *   GET  /api/churches/:id/planning-center/plans/:planId   — Single plan with items & team
 *   GET  /api/churches/:id/planning-center/next-service    — Next upcoming service plan
 *
 * Sync:
 *   POST /api/churches/:id/planning-center/sync            — Trigger manual sync
 *
 * Status & config:
 *   GET  /api/churches/:id/planning-center                 — Connection status
 *   PUT  /api/churches/:id/planning-center                 — Set credentials/config
 *   GET  /api/churches/:id/planning-center/service-types   — List available service types
 *
 * ProPresenter cross-reference:
 *   POST /api/churches/:id/planning-center/plans/:planId/pp-check — Compare with ProPresenter playlist
 *
 * Preview (legacy):
 *   GET  /api/churches/:id/planning-center/preview         — Preview upcoming services without saving
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupPlanningCenterRoutes(app, ctx) {
  const { db, churches, requireAdmin, requireChurchOrAdmin, requireChurchAppAuth, requireFeature, planningCenter, safeErrorMessage } = ctx;

  const PCO_REDIRECT_URI = process.env.PCO_REDIRECT_URI || 'https://relay.tallyconnect.com/api/admin/pco/callback';

  // ─── OAUTH FLOW ──────────────────────────────────────────────────────────────

  /**
   * GET /api/admin/pco/auth-url
   * Generate an OAuth authorization URL for connecting Planning Center.
   * Query: ?churchId=xxx
   */
  app.get('/api/admin/pco/auth-url', requireAdmin, (req, res) => {
    const { churchId } = req.query;
    if (!churchId) return res.status(400).json({ error: 'churchId is required' });

    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    try {
      const { authUrl, state } = planningCenter.generateOAuthUrl(churchId, PCO_REDIRECT_URI);
      res.json({ authUrl, state });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  /**
   * GET /api/admin/pco/callback
   * OAuth callback — receives redirect from Planning Center after user authorizes.
   * This is a public endpoint (no auth) because PCO redirects the browser here.
   * Query: ?code=xxx&state=xxx
   */
  app.get('/api/admin/pco/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      console.warn(`[PlanningCenter] OAuth denied: ${oauthError}`);
      return res.send(_callbackHtml(false, 'Authorization was denied.'));
    }

    if (!code || !state) {
      return res.status(400).send(_callbackHtml(false, 'Missing code or state parameter.'));
    }

    try {
      const result = await planningCenter.handleOAuthCallback(code, state, PCO_REDIRECT_URI);

      if (!result.success) {
        return res.send(_callbackHtml(false, result.error || 'Connection failed.'));
      }

      // Trigger initial sync in background
      planningCenter.syncChurch(result.churchId).catch(e =>
        console.warn(`[PlanningCenter] Initial sync after OAuth failed: ${e.message}`)
      );

      // Broadcast connection event via SSE if available
      if (ctx.broadcastToSSE) {
        ctx.broadcastToSSE(result.churchId, {
          type: 'pco:connected',
          orgName: result.orgName,
        });
      }

      res.send(_callbackHtml(true, result.orgName
        ? `Connected to "${result.orgName}"`
        : 'Planning Center connected!'));
    } catch (e) {
      console.error(`[PlanningCenter] OAuth callback error: ${e.message}`);
      res.status(500).send(_callbackHtml(false, 'An error occurred. Please try again.'));
    }
  });

  /**
   * POST /api/churches/:churchId/planning-center/disconnect
   * Disconnect Planning Center OAuth for a church.
   */
  app.post('/api/churches/:churchId/planning-center/disconnect',
    requireAdmin, requireFeature('planning_center'),
    async (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      try {
        const result = await planningCenter.disconnect(req.params.churchId);

        if (ctx.broadcastToSSE) {
          ctx.broadcastToSSE(req.params.churchId, { type: 'pco:disconnected' });
        }

        res.json(result);
      } catch (e) {
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  // ─── CHURCH APP ENDPOINTS (Electron desktop app, Bearer token auth) ─────────

  /**
   * GET /api/church/app/pco/auth-url
   * Generate PCO OAuth URL for the Electron desktop app.
   * Uses churchId from the church_app token (no query param needed).
   */
  app.get('/api/church/app/pco/auth-url', requireChurchAppAuth, (req, res) => {
    const churchId = req.church.churchId;
    try {
      const { authUrl, state } = planningCenter.generateOAuthUrl(churchId, PCO_REDIRECT_URI);
      res.json({ authUrl, state });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  /**
   * GET /api/church/app/pco/status
   * Get PCO connection status for the Electron desktop app.
   */
  app.get('/api/church/app/pco/status', requireChurchAppAuth, (req, res) => {
    const churchId = req.church.churchId;
    try {
      const status = planningCenter.getStatus(churchId);
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  /**
   * POST /api/church/app/pco/disconnect
   * Disconnect PCO from the Electron desktop app.
   */
  app.post('/api/church/app/pco/disconnect', requireChurchAppAuth, async (req, res) => {
    const churchId = req.church.churchId;
    try {
      const result = await planningCenter.disconnect(churchId);

      if (ctx.broadcastToSSE) {
        ctx.broadcastToSSE(churchId, { type: 'pco:disconnected' });
      }

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── STATUS & CONFIG ─────────────────────────────────────────────────────────

  /**
   * GET /api/churches/:churchId/planning-center
   * Get current Planning Center connection status.
   */
  app.get('/api/churches/:churchId/planning-center',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });
      const status = planningCenter.getStatus(req.params.churchId);
      res.json(status);
    }
  );

  /**
   * PUT /api/churches/:churchId/planning-center
   * Set Planning Center credentials and configuration.
   */
  app.put('/api/churches/:churchId/planning-center',
    requireAdmin, requireFeature('planning_center'),
    async (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });
      const { appId, secret, serviceTypeId, syncEnabled, writebackEnabled, serviceTypeIds } = req.body;
      try {
        planningCenter.setCredentials(req.params.churchId, {
          appId, secret, serviceTypeId, syncEnabled, writebackEnabled, serviceTypeIds,
        });
        await planningCenter.flushWrites();
        res.json({ saved: true });
      } catch (e) {
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * GET /api/churches/:churchId/planning-center/service-types
   * List available service types from Planning Center.
   */
  app.get('/api/churches/:churchId/planning-center/service-types',
    requireAdmin, requireFeature('planning_center'),
    async (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      try {
        const serviceTypes = await planningCenter.getServiceTypes(req.params.churchId);
        res.json({ serviceTypes });
      } catch (e) {
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  // ─── SYNC ────────────────────────────────────────────────────────────────────

  /**
   * POST /api/churches/:churchId/planning-center/sync
   * Trigger a manual sync of schedule + plan data.
   */
  app.post('/api/churches/:churchId/planning-center/sync',
    requireAdmin, requireFeature('planning_center'),
    async (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      try {
        // Sync schedule times
        const scheduleResult = await planningCenter.syncChurch(req.params.churchId);

        // Also trigger full plan sync
        const planResult = await planningCenter.syncFullPlans(req.params.churchId);

        if (ctx.broadcastToSSE) {
          ctx.broadcastToSSE(req.params.churchId, { type: 'pco:syncComplete' });
        }

        res.json({
          schedule: scheduleResult,
          plans: planResult,
        });
      } catch (e) {
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  // ─── PLAN DATA ───────────────────────────────────────────────────────────────

  /**
   * GET /api/churches/:churchId/planning-center/plans
   * Get upcoming cached plans for this church.
   * Query: ?limit=5
   */
  app.get('/api/churches/:churchId/planning-center/plans',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      const limit = parseInt(req.query.limit) || 5;
      const plans = planningCenter.getCachedPlans(req.params.churchId, limit);
      res.json({ plans });
    }
  );

  /**
   * GET /api/churches/:churchId/planning-center/plans/:planId
   * Get a specific cached plan with full items and team data.
   */
  app.get('/api/churches/:churchId/planning-center/plans/:planId',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      const plan = planningCenter.getCachedPlan(req.params.planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found in cache. Try syncing first.' });

      // Verify this plan belongs to the requested church
      if (plan.churchId !== req.params.churchId) {
        return res.status(403).json({ error: 'Plan does not belong to this church' });
      }

      res.json(plan);
    }
  );

  /**
   * GET /api/churches/:churchId/planning-center/next-service
   * Get the next upcoming service plan with full details.
   */
  app.get('/api/churches/:churchId/planning-center/next-service',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      const plan = planningCenter.getNextPlanCached(req.params.churchId);
      if (!plan) return res.json({ plan: null, message: 'No upcoming service plan found. Try syncing.' });

      res.json({ plan });
    }
  );

  // ─── PROPRESENTER CROSS-REFERENCE ────────────────────────────────────────────

  /**
   * POST /api/churches/:churchId/planning-center/plans/:planId/pp-check
   * Compare PCO service order with ProPresenter playlist.
   * Body: { playlistItems: [{name: "Song Title"}, ...] }
   */
  app.post('/api/churches/:churchId/planning-center/plans/:planId/pp-check',
    requireAdmin, requireFeature('planning_center'),
    (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      const { playlistItems } = req.body;
      if (!Array.isArray(playlistItems)) {
        return res.status(400).json({ error: 'playlistItems array is required' });
      }

      const result = planningCenter.crossReferencePP(req.params.planId, playlistItems);
      res.json(result);
    }
  );

  // ─── PREVIEW (LEGACY) ───────────────────────────────────────────────────────

  /**
   * GET /api/churches/:churchId/planning-center/preview
   * Preview upcoming services without saving (legacy endpoint).
   */
  app.get('/api/churches/:churchId/planning-center/preview',
    requireAdmin, requireFeature('planning_center'),
    async (req, res) => {
      const church = churches.get(req.params.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });
      try {
        const plans = await planningCenter.getUpcomingPlans(req.params.churchId);
        res.json({ services: plans });
      } catch (e) {
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );
};

// ─── HELPERS ────────────────────────────────────────────────────────────────────

/**
 * Generate a simple HTML page for the OAuth callback redirect.
 * This page is shown briefly in the browser before the user returns to the portal.
 */
function _callbackHtml(success, message) {
  const color = success ? '#22c55e' : '#ef4444';
  const icon = success ? '&#10003;' : '&#10007;';
  return `<!DOCTYPE html>
<html>
<head><title>Planning Center — Tally Connect</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
  .card { text-align: center; padding: 2rem 3rem; border-radius: 12px; background: #1e293b; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
  .icon { font-size: 48px; color: ${color}; margin-bottom: 1rem; }
  .msg { font-size: 18px; margin-bottom: 1rem; }
  .hint { color: #94a3b8; font-size: 14px; }
</style></head>
<body>
<div class="card">
  <div class="icon">${icon}</div>
  <div class="msg">${message}</div>
  <div class="hint">${success ? 'You can close this tab and return to the portal.' : 'Please try again from the portal settings.'}</div>
</div>
<script>
  // Auto-close after 3 seconds if opened as popup
  setTimeout(() => { try { window.close(); } catch(e) {} }, 3000);
</script>
</body>
</html>`;
}
