/**
 * AI Triage Routes — Admin API for triage dashboard, settings, and event feed.
 *
 * All routes require admin JWT authentication.
 */

'use strict';

module.exports = function registerAiTriageRoutes(app, ctx) {
  const { requireAdminJwt, requireAdmin, aiTriageEngine, db, queryClient, rateLimit } = ctx;

  if (!aiTriageEngine) {
    console.warn('[AITriage] Engine not initialized — skipping route registration');
    return;
  }

  // ─── EVENT FEED ──────────────────────────────────────────────────────────

  /**
   * GET /api/admin/ai-triage/events
   * Real-time event feed with optional filters.
   * Query params: churchId, severity, timeContext, limit, offset
   */
  app.get('/api/admin/ai-triage/events', requireAdmin, async (req, res) => {
    try {
      const events = await Promise.resolve(aiTriageEngine.getRecentEvents({
        churchId: req.query.churchId || null,
        severity: req.query.severity || null,
        timeContext: req.query.timeContext || null,
        limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
        offset: parseInt(req.query.offset, 10) || 0,
      }));
      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch triage events' });
    }
  });

  // ─── STATS DASHBOARD ────────────────────────────────────────────────────

  /**
   * GET /api/admin/ai-triage/stats
   * Aggregated statistics for the triage dashboard.
   * Query params: churchId, days
   */
  app.get('/api/admin/ai-triage/stats', requireAdmin, async (req, res) => {
    try {
      const stats = await Promise.resolve(aiTriageEngine.getStats({
        churchId: req.query.churchId || null,
        days: Math.min(parseInt(req.query.days, 10) || 7, 90),
      }));
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch triage stats' });
    }
  });

  // ─── CHURCH AI SETTINGS ──────────────────────────────────────────────────

  /**
   * GET /api/admin/ai-triage/settings/:churchId
   * Get AI settings for a specific church.
   */
  app.get('/api/admin/ai-triage/settings/:churchId', requireAdmin, async (req, res) => {
    try {
      const settings = await Promise.resolve(aiTriageEngine.getChurchSettings(req.params.churchId));
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch AI settings' });
    }
  });

  /**
   * PUT /api/admin/ai-triage/settings/:churchId
   * Update AI settings for a church.
   * Body: { ai_mode, sensitivity_threshold, pre_service_window_minutes, post_service_buffer_minutes, custom_settings }
   */
  app.put('/api/admin/ai-triage/settings/:churchId', requireAdmin, rateLimit(20, 60_000), async (req, res) => {
    try {
      const updatedBy = req.adminUser?.email || 'admin';
      const settings = await Promise.resolve(aiTriageEngine.updateChurchSettings(
        req.params.churchId,
        req.body,
        updatedBy,
      ));
      res.json(settings);
    } catch (err) {
      if (err.message.includes('Invalid AI mode')) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: 'Failed to update AI settings' });
    }
  });

  // ─── BULK SETTINGS (all churches overview) ──────────────────────────────

  /**
   * GET /api/admin/ai-triage/modes
   * Get all church AI mode settings at once (for admin overview table).
   */
  app.get('/api/admin/ai-triage/modes', requireAdmin, async (req, res) => {
    try {
      const modes = await Promise.resolve(aiTriageEngine.getAllChurchModes());
      res.json({ modes });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch church modes' });
    }
  });

  // ─── SERVICE WINDOWS ────────────────────────────────────────────────────

  /**
   * GET /api/admin/ai-triage/windows/:churchId
   * Get service window visualization data for a church.
   */
  app.get('/api/admin/ai-triage/windows/:churchId', requireAdmin, async (req, res) => {
    try {
      const windows = await Promise.resolve(aiTriageEngine.getServiceWindows(req.params.churchId));
      res.json(windows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch service windows' });
    }
  });

  // ─── RESOLUTIONS ────────────────────────────────────────────────────────

  /**
   * GET /api/admin/ai-triage/resolutions
   * Get resolution history.
   * Query params: churchId, limit, offset, success (0|1)
   */
  app.get('/api/admin/ai-triage/resolutions', requireAdmin, async (req, res) => {
    try {
      let sql = 'SELECT * FROM ai_resolutions WHERE 1=1';
      const params = [];

      if (req.query.churchId) { sql += ' AND church_id = ?'; params.push(req.query.churchId); }
      if (req.query.success !== undefined) { sql += ' AND success = ?'; params.push(parseInt(req.query.success, 10)); }

      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(Math.min(parseInt(req.query.limit, 10) || 50, 200));
      params.push(parseInt(req.query.offset, 10) || 0);

      const resolutions = queryClient
        ? await queryClient.query(sql, params)
        : db.prepare(sql).all(...params);
      res.json({ resolutions });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch resolutions' });
    }
  });

  // ─── TIME CONTEXT CHECK (live) ──────────────────────────────────────────

  /**
   * GET /api/admin/ai-triage/context/:churchId
   * Get the current time context for a church (useful for debugging).
   */
  app.get('/api/admin/ai-triage/context/:churchId', requireAdmin, async (req, res) => {
    try {
      const context = await Promise.resolve(aiTriageEngine.getTimeContext(req.params.churchId));
      res.json(context);
    } catch (err) {
      res.status(500).json({ error: 'Failed to determine time context' });
    }
  });

  // ─── SSE STREAM (dedicated triage events) ──────────────────────────────

  const triageSseClients = new Set();
  const MAX_TRIAGE_SSE = 20;

  app.get('/api/admin/ai-triage/stream', requireAdmin, async (req, res) => {
    if (triageSseClients.size >= MAX_TRIAGE_SSE) {
      return res.status(503).json({ error: 'Maximum triage SSE connections reached' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send initial stats snapshot
    try {
      const stats = await Promise.resolve(aiTriageEngine.getStats({ days: 1 }));
      res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
    } catch { /* ignore */ }

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15_000);

    triageSseClients.add(res);

    req.on('close', () => {
      clearInterval(keepAlive);
      triageSseClients.delete(res);
    });
  });

  // Expose SSE broadcast for the engine to use
  ctx._triageSseClients = triageSseClients;

  console.log('[Server] \u2713 AI Triage routes registered');
};
