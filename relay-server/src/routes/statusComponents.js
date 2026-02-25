'use strict';

/**
 * Status components + incidents route handlers.
 *
 * @param {import('express').Express} app
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Function} ctx.requireAdmin
 * @param {Function} ctx.runStatusChecks
 * @param {Function} ctx.getLastStatusCheckAt - getter for the mutable lastStatusCheckAt
 */
module.exports = function setupStatusComponentRoutes(app, ctx) {
  const { db, requireAdmin, runStatusChecks, getLastStatusCheckAt } = ctx;

  app.get('/api/status/components', (req, res) => {
    const rows = db.prepare(`
      SELECT component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at
      FROM status_components
      ORDER BY name ASC
    `).all();
    res.json({
      updatedAt: getLastStatusCheckAt(),
      components: rows,
    });
  });

  app.get('/api/status/incidents', (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200));
    const rows = db.prepare(`
      SELECT id, component_id, previous_state, new_state, message, started_at, resolved_at
      FROM status_incidents
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
    res.json(rows);
  });

  app.post('/api/status/run-checks', requireAdmin, async (req, res) => {
    try {
      await runStatusChecks();
      res.json({ ok: true, checkedAt: getLastStatusCheckAt() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
};
