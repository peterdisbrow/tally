/**
 * Live Rundown API routes — show-calling with PCO service plans.
 *
 * Endpoints:
 *   POST /api/churches/:churchId/live-rundown/start     — Start a session with a PCO plan
 *   POST /api/churches/:churchId/live-rundown/advance   — Advance to next item
 *   POST /api/churches/:churchId/live-rundown/back      — Go back to previous item
 *   POST /api/churches/:churchId/live-rundown/goto      — Jump to specific item
 *   POST /api/churches/:churchId/live-rundown/end       — End the session
 *   GET  /api/churches/:churchId/live-rundown/state     — Get current session state
 *
 * Auth: requireChurchOrAdmin (portal TDs and mobile church_app tokens)
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupLiveRundownRoutes(app, ctx) {
  const { churches, requireChurchOrAdmin, requireFeature, planningCenter, liveRundown, safeErrorMessage } = ctx;

  /**
   * POST /api/churches/:churchId/live-rundown/start
   * Start a new live rundown session.
   * Body: { planId: string, callerName?: string }
   */
  app.post('/api/churches/:churchId/live-rundown/start',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const churchId = req.params.churchId;
      const church = churches.get(churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      const { planId, callerName } = req.body;
      if (!planId) return res.status(400).json({ error: 'planId is required' });

      // Get the cached PCO plan
      const plan = planningCenter.getCachedPlan(planId);
      if (!plan) {
        return res.status(404).json({ error: 'Plan not found in cache. Try syncing Planning Center first.' });
      }
      if (plan.churchId !== churchId) {
        return res.status(403).json({ error: 'Plan does not belong to this church' });
      }

      try {
        const state = liveRundown.startSession(churchId, plan, callerName || 'TD');
        res.json(state);
      } catch (e) {
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/live-rundown/advance
   * Advance to the next item.
   */
  app.post('/api/churches/:churchId/live-rundown/advance',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const state = liveRundown.advance(churchId);
      if (!state) {
        return res.status(400).json({ error: 'No active rundown session, or already at the last item' });
      }
      res.json(state);
    }
  );

  /**
   * POST /api/churches/:churchId/live-rundown/back
   * Go back to the previous item.
   */
  app.post('/api/churches/:churchId/live-rundown/back',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const state = liveRundown.back(churchId);
      if (!state) {
        return res.status(400).json({ error: 'No active rundown session, or already at the first item' });
      }
      res.json(state);
    }
  );

  /**
   * POST /api/churches/:churchId/live-rundown/goto
   * Jump to a specific item index.
   * Body: { index: number }
   */
  app.post('/api/churches/:churchId/live-rundown/goto',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { index } = req.body;
      if (index === undefined || index === null) {
        return res.status(400).json({ error: 'index is required' });
      }

      const state = liveRundown.goTo(churchId, index);
      if (!state) {
        return res.status(400).json({ error: 'No active rundown session, or invalid index' });
      }
      res.json(state);
    }
  );

  /**
   * POST /api/churches/:churchId/live-rundown/end
   * End the current session.
   */
  app.post('/api/churches/:churchId/live-rundown/end',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const summary = liveRundown.endSession(churchId);
      if (!summary) {
        return res.status(400).json({ error: 'No active rundown session' });
      }
      res.json(summary);
    }
  );

  /**
   * GET /api/churches/:churchId/live-rundown/state
   * Get current session state (for late-joining clients).
   */
  app.get('/api/churches/:churchId/live-rundown/state',
    requireChurchOrAdmin, requireFeature('planning_center'),
    (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const state = liveRundown.getState(churchId);
      if (!state) {
        return res.json({ active: false });
      }
      res.json({ active: true, ...state });
    }
  );
};
