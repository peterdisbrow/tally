/**
 * Scheduler API routes — rundown CRUD + cue control.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupSchedulerRoutes(app, ctx) {
  const { churches, requireChurchOrAdmin, requireFeature,
          rundownEngine, scheduler } = ctx;

  // Helper: get churchId and validate
  function getChurch(req, res) {
    const church = churches.get(req.params.churchId);
    if (!church) { res.status(404).json({ error: 'Church not found' }); return null; }
    return church;
  }

  // ─── RUNDOWN CRUD ───────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/rundowns', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    res.json(rundownEngine.getRundowns(req.params.churchId));
  });

  app.post('/api/churches/:churchId/rundowns', requireChurchOrAdmin, async (req, res) => {
    try {
      if (!getChurch(req, res)) return;
      const { name, steps, service_day, auto_activate } = req.body;
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const rundown = rundownEngine.createRundown(req.params.churchId, name, steps || []);

      // Set scheduler-specific columns if provided
      if (service_day !== undefined || auto_activate !== undefined) {
        rundownEngine.setSchedulerConfig(rundown.id, {
          serviceDay: service_day,
          autoActivate: auto_activate,
        });
      }

      if (rundownEngine.flushWrites) await rundownEngine.flushWrites();
      res.status(201).json(rundownEngine.getRundown(rundown.id));
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not create rundown' });
    }
  });

  app.get('/api/churches/:churchId/rundowns/:id', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    const rundown = rundownEngine.getRundown(req.params.id);
    if (!rundown || rundown.church_id !== req.params.churchId) {
      return res.status(404).json({ error: 'Rundown not found' });
    }
    res.json(rundown);
  });

  app.put('/api/churches/:churchId/rundowns/:id', requireChurchOrAdmin, async (req, res) => {
    try {
      if (!getChurch(req, res)) return;
      const existing = rundownEngine.getRundown(req.params.id);
      if (!existing || existing.church_id !== req.params.churchId) {
        return res.status(404).json({ error: 'Rundown not found' });
      }

      const { name, steps, service_day, auto_activate } = req.body;
      rundownEngine.updateRundown(req.params.id, { name, steps });

      if (service_day !== undefined || auto_activate !== undefined) {
        rundownEngine.setSchedulerConfig(req.params.id, {
          serviceDay: service_day,
          autoActivate: auto_activate,
        });
      }

      if (rundownEngine.flushWrites) await rundownEngine.flushWrites();
      res.json(rundownEngine.getRundown(req.params.id));
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not update rundown' });
    }
  });

  app.delete('/api/churches/:churchId/rundowns/:id', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    const existing = rundownEngine.getRundown(req.params.id);
    if (!existing || existing.church_id !== req.params.churchId) {
      return res.status(404).json({ error: 'Rundown not found' });
    }
    rundownEngine.deleteRundown(req.params.id);
    res.json({ deleted: true });
  });

  // ─── SCHEDULER CONTROLS ────────────────────────────────────────────────────

  app.post('/api/churches/:churchId/scheduler/activate', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    const { rundownId } = req.body;
    if (!rundownId) return res.status(400).json({ error: 'rundownId is required' });
    const result = scheduler.activate(req.params.churchId, rundownId);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/churches/:churchId/scheduler/advance', requireChurchOrAdmin, async (req, res) => {
    if (!getChurch(req, res)) return;
    const result = await scheduler.advance(req.params.churchId);
    if (result?.error) return res.status(400).json(result);
    res.json(result || { error: 'Could not advance' });
  });

  app.post('/api/churches/:churchId/scheduler/skip', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    const result = scheduler.skip(req.params.churchId);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/churches/:churchId/scheduler/back', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    const result = scheduler.goBack(req.params.churchId);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/churches/:churchId/scheduler/jump', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    const { cueIndex } = req.body;
    if (cueIndex === undefined) return res.status(400).json({ error: 'cueIndex is required' });
    const result = scheduler.jumpToCue(req.params.churchId, Number(cueIndex));
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/churches/:churchId/scheduler/pause', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    res.json(scheduler.pause(req.params.churchId));
  });

  app.post('/api/churches/:churchId/scheduler/resume', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    const result = scheduler.resume(req.params.churchId);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/churches/:churchId/scheduler/deactivate', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    res.json(scheduler.deactivate(req.params.churchId));
  });

  app.get('/api/churches/:churchId/scheduler/status', requireChurchOrAdmin, (req, res) => {
    if (!getChurch(req, res)) return;
    res.json(scheduler.getStatus(req.params.churchId));
  });
};
