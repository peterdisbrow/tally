/**
 * Clock layout save/load routes for TallyConnect clock app.
 * Allows authenticated church app users to persist multi-clock layouts.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupClockLayoutRoutes(app, ctx) {
  const { requireChurchAppAuth, rateLimit, uuidv4, log } = ctx;

  const hasQueryClient = ctx.queryClient && typeof ctx.queryClient.queryOne === 'function';
  const qOne = (sql, params = []) => (
    hasQueryClient ? ctx.queryClient.queryOne(sql, params) : ctx.db.prepare(sql).get(...params) || null
  );
  const qAll = (sql, params = []) => (
    hasQueryClient ? ctx.queryClient.query(sql, params) : ctx.db.prepare(sql).all(...params)
  );
  const qRun = (sql, params = []) => (
    hasQueryClient ? ctx.queryClient.run(sql, params) : ctx.db.prepare(sql).run(...params)
  );

  // ─── LIST saved layouts ──────────────────────────────────────────
  app.get('/api/church/app/clock-layouts', requireChurchAppAuth, async (req, res) => {
    try {
      const rows = await qAll(
        `SELECT id, name, layout_mode AS "layoutMode", cells, created_at AS "createdAt"
         FROM clock_layouts WHERE church_id = ? ORDER BY created_at DESC`,
        [req.churchId]
      );
      const layouts = rows.map(r => ({
        id: r.id,
        name: r.name,
        layoutMode: r.layoutMode || r.layout_mode,
        cells: JSON.parse(r.cells || '[]'),
        createdAt: r.createdAt || r.created_at,
      }));
      res.json({ layouts });
    } catch (err) {
      log.error('clock-layouts', 'list error', err.message);
      res.status(500).json({ error: 'Failed to load layouts' });
    }
  });

  // ─── SAVE a layout ───────────────────────────────────────────────
  app.post('/api/church/app/clock-layouts', requireChurchAppAuth, rateLimit(30, 60 * 1000), async (req, res) => {
    try {
      const { name, layoutMode, cells } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Layout name is required' });
      }
      if (!layoutMode || !cells || !Array.isArray(cells)) {
        return res.status(400).json({ error: 'layoutMode and cells are required' });
      }
      const id = uuidv4();
      const now = new Date().toISOString();
      await qRun(
        `INSERT INTO clock_layouts (id, church_id, name, layout_mode, cells, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, req.churchId, name.trim(), layoutMode, JSON.stringify(cells), now]
      );
      res.status(201).json({ id, name: name.trim(), layoutMode, cells, createdAt: now });
    } catch (err) {
      log.error('clock-layouts', 'save error', err.message);
      res.status(500).json({ error: 'Failed to save layout' });
    }
  });

  // ─── DELETE a layout ─────────────────────────────────────────────
  app.delete('/api/church/app/clock-layouts/:id', requireChurchAppAuth, async (req, res) => {
    try {
      const row = await qOne(
        'SELECT id FROM clock_layouts WHERE id = ? AND church_id = ?',
        [req.params.id, req.churchId]
      );
      if (!row) return res.status(404).json({ error: 'Layout not found' });
      await qRun('DELETE FROM clock_layouts WHERE id = ?', [req.params.id]);
      res.json({ deleted: true });
    } catch (err) {
      log.error('clock-layouts', 'delete error', err.message);
      res.status(500).json({ error: 'Failed to delete layout' });
    }
  });
};
