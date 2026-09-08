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

  function churchIdOf(req) {
    return req.churchId || req.church?.churchId || null;
  }

  function logLayoutError(message, err) {
    const text = `${message}: ${err && err.message ? err.message : err}`;
    if (typeof log === 'function') log(text);
    else if (log && typeof log.error === 'function') log.error(text);
    else console.error(text);
  }

  // ─── LIST saved layouts ──────────────────────────────────────────
  app.get('/api/church/app/clock-layouts', requireChurchAppAuth, async (req, res) => {
    try {
      const churchId = churchIdOf(req);
      if (!churchId) return res.status(401).json({ error: 'unauthorized' });
      const rows = await qAll(
        `SELECT id, name, layout_mode AS "layoutMode", cells, created_at AS "createdAt"
         FROM clock_layouts WHERE church_id = ? ORDER BY created_at DESC`,
        [churchId]
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
      logLayoutError('clock-layouts list error', err);
      res.status(500).json({ error: 'Failed to load layouts' });
    }
  });

  // ─── SAVE a layout ───────────────────────────────────────────────
  app.post('/api/church/app/clock-layouts', requireChurchAppAuth, rateLimit(30, 60 * 1000), async (req, res) => {
    try {
      const churchId = churchIdOf(req);
      if (!churchId) return res.status(401).json({ error: 'unauthorized' });
      if (req.churchReadonly) return res.status(403).json({ error: 'Read-only token' });
      const { name, layoutMode, cells } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Layout name is required' });
      }
      if (!layoutMode || typeof layoutMode !== 'string' || !cells || !Array.isArray(cells)) {
        return res.status(400).json({ error: 'layoutMode and cells are required' });
      }
      const id = uuidv4();
      const now = new Date().toISOString();
      await qRun(
        `INSERT INTO clock_layouts (id, church_id, name, layout_mode, cells, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, churchId, name.trim(), layoutMode, JSON.stringify(cells), now]
      );
      res.status(201).json({ id, name: name.trim(), layoutMode, cells, createdAt: now });
    } catch (err) {
      logLayoutError('clock-layouts save error', err);
      res.status(500).json({ error: 'Failed to save layout' });
    }
  });

  // ─── DELETE a layout ─────────────────────────────────────────────
  app.delete('/api/church/app/clock-layouts/:id', requireChurchAppAuth, async (req, res) => {
    try {
      const churchId = churchIdOf(req);
      if (!churchId) return res.status(401).json({ error: 'unauthorized' });
      if (req.churchReadonly) return res.status(403).json({ error: 'Read-only token' });
      const row = await qOne(
        'SELECT id FROM clock_layouts WHERE id = ? AND church_id = ?',
        [req.params.id, churchId]
      );
      if (!row) return res.status(404).json({ error: 'Layout not found' });
      await qRun('DELETE FROM clock_layouts WHERE id = ? AND church_id = ?', [req.params.id, churchId]);
      res.json({ deleted: true });
    } catch (err) {
      logLayoutError('clock-layouts delete error', err);
      res.status(500).json({ error: 'Failed to delete layout' });
    }
  });
};
