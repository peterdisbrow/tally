/**
 * Status components & incidents API.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupStatusComponentRoutes(app, ctx) {
  const { db, requireAdmin, runStatusChecks, lastStatusCheckAt } = ctx;

  app.get('/api/status/components', (_req, res) => {
    const rows = db.prepare(`
      SELECT component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at
      FROM status_components
      ORDER BY name ASC
    `).all();
    res.json({
      updatedAt: ctx.lastStatusCheckAt(),
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

  app.post('/api/status/run-checks', requireAdmin, async (_req, res) => {
    try {
      await runStatusChecks();
      res.json({ ok: true, checkedAt: ctx.lastStatusCheckAt() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
};
