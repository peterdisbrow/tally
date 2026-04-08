/**
 * Live Rundown API routes — show-calling with PCO or manual service plans.
 *
 * Live session endpoints (no PCO requirement — rundown works for any church):
 *   POST /api/churches/:churchId/live-rundown/start         — Start a session
 *   POST /api/churches/:churchId/live-rundown/advance       — Advance to next item
 *   POST /api/churches/:churchId/live-rundown/back          — Go back to previous item
 *   POST /api/churches/:churchId/live-rundown/goto          — Jump to specific item
 *   POST /api/churches/:churchId/live-rundown/end           — End the session
 *   POST /api/churches/:churchId/live-rundown/auto-advance  — Toggle auto-advance
 *   GET  /api/churches/:churchId/live-rundown/state         — Get current session state
 *
 * Companion actions:
 *   GET    /api/churches/:churchId/live-rundown/actions/:planId              — Get all companion actions
 *   PUT    /api/churches/:churchId/live-rundown/actions/:planId/:itemId      — Save actions for item
 *   DELETE /api/churches/:churchId/live-rundown/actions/:planId/:itemId      — Clear actions for item
 *
 * Manual plan CRUD:
 *   GET    /api/churches/:churchId/rundown-plans                      — List plans (manual + PCO)
 *   POST   /api/churches/:churchId/rundown-plans                      — Create a manual plan
 *   GET    /api/churches/:churchId/rundown-plans/:planId              — Get a plan
 *   PUT    /api/churches/:churchId/rundown-plans/:planId              — Update a plan
 *   DELETE /api/churches/:churchId/rundown-plans/:planId              — Delete a plan
 *   POST   /api/churches/:churchId/rundown-plans/:planId/items        — Add item
 *   PUT    /api/churches/:churchId/rundown-plans/:planId/items/:itemId — Edit item
 *   DELETE /api/churches/:churchId/rundown-plans/:planId/items/:itemId — Delete item
 *   PUT    /api/churches/:churchId/rundown-plans/:planId/reorder      — Reorder items
 *
 * Templates:
 *   GET    /api/churches/:churchId/rundown-templates                   — List templates
 *   POST   /api/churches/:churchId/rundown-plans/:planId/save-template — Save plan as template
 *   POST   /api/churches/:churchId/rundown-templates/:templateId/create — Create plan from template
 *   DELETE /api/churches/:churchId/rundown-templates/:templateId        — Delete template
 *
 * Auth: requireChurchOrAdmin (portal TDs and mobile church_app tokens)
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupLiveRundownRoutes(app, ctx) {
  const { db, churches, requireChurchOrAdmin, requireFeature, planningCenter, liveRundown, manualRundown, safeErrorMessage, uuidv4 } = ctx;

  // ─── Helper: load companion actions for a plan from DB ──────────────────────
  function loadPlanActions(churchId, planId) {
    try {
      const rows = db.prepare(
        'SELECT item_id, actions_json FROM rundown_companion_actions WHERE church_id = ? AND plan_id = ?'
      ).all(churchId, planId);
      const map = {};
      for (const row of rows) {
        try { map[row.item_id] = JSON.parse(row.actions_json); } catch { /* skip malformed */ }
      }
      return map;
    } catch {
      return {};
    }
  }

  // ─── LIVE SESSION ENDPOINTS ────────────────────────────────────────────────
  // These no longer require planning_center feature — rundown works for everyone.

  /**
   * POST /api/churches/:churchId/live-rundown/start
   * Start a new live rundown session.
   * Body: { planId: string, source?: 'pco'|'manual', callerName?: string }
   */
  app.post('/api/churches/:churchId/live-rundown/start',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      const church = churches.get(churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });

      const { planId, source, callerName } = req.body;
      if (!planId) return res.status(400).json({ error: 'planId is required' });

      try {
        let plan;
        const effectiveSource = source || 'auto';

        if (effectiveSource === 'manual' || effectiveSource === 'auto') {
          // Try manual plan first (or if explicitly manual)
          const manualPlan = await manualRundown.getPlan(planId);
          if (manualPlan) {
            if (manualPlan.churchId !== churchId) {
              return res.status(403).json({ error: 'Plan does not belong to this church' });
            }
            // Convert manual plan to the format liveRundown expects
            plan = {
              id: manualPlan.id,
              title: manualPlan.title,
              churchId: manualPlan.churchId,
              source: 'manual',
              items: manualPlan.items.map(item => ({
                id: item.id,
                title: item.title,
                itemType: item.itemType,
                servicePosition: item.sortOrder,
                lengthSeconds: item.lengthSeconds,
                description: '',
                notes: item.notes ? [item.notes] : [],
                songTitle: null,
                author: null,
                arrangementKey: null,
              })),
              team: [],
              times: [],
            };
          } else if (effectiveSource === 'auto') {
            // Fall through to try PCO
          } else {
            return res.status(404).json({ error: 'Manual plan not found' });
          }
        }

        if (!plan && (effectiveSource === 'pco' || effectiveSource === 'auto')) {
          // Try PCO plan
          const pcoPlan = planningCenter.getCachedPlan(planId);
          if (!pcoPlan) {
            return res.status(404).json({ error: 'Plan not found. If this is a PCO plan, try syncing Planning Center first.' });
          }
          if (pcoPlan.churchId !== churchId) {
            return res.status(403).json({ error: 'Plan does not belong to this church' });
          }
          plan = { ...pcoPlan, source: 'pco' };
        }

        if (!plan) {
          return res.status(404).json({ error: 'Plan not found' });
        }

        // Load companion actions for this plan from DB
        const companionActionsMap = loadPlanActions(churchId, planId);
        const state = liveRundown.startSession(churchId, plan, callerName || 'TD', companionActionsMap);
        res.json(state);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/live-rundown/advance
   */
  app.post('/api/churches/:churchId/live-rundown/advance',
    requireChurchOrAdmin,
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
   */
  app.post('/api/churches/:churchId/live-rundown/back',
    requireChurchOrAdmin,
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
   * Body: { index: number }
   */
  app.post('/api/churches/:churchId/live-rundown/goto',
    requireChurchOrAdmin,
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
   */
  app.post('/api/churches/:churchId/live-rundown/end',
    requireChurchOrAdmin,
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
   * POST /api/churches/:churchId/live-rundown/auto-advance
   * Body: { enabled: boolean }
   */
  app.post('/api/churches/:churchId/live-rundown/auto-advance',
    requireChurchOrAdmin,
    (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { enabled } = req.body;
      if (enabled === undefined || enabled === null) {
        return res.status(400).json({ error: 'enabled is required (boolean)' });
      }

      const state = liveRundown.setAutoAdvance(churchId, !!enabled);
      if (!state) {
        return res.status(400).json({ error: 'No active rundown session' });
      }
      res.json(state);
    }
  );

  /**
   * GET /api/churches/:churchId/live-rundown/state
   */
  app.get('/api/churches/:churchId/live-rundown/state',
    requireChurchOrAdmin,
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

  // ─── Companion Actions API ────────────────────────────────────────────────

  /**
   * GET /api/churches/:churchId/live-rundown/actions/:planId
   * Get all configured Companion actions for every item in a plan.
   * Returns: { [itemId]: Action[] }
   */
  app.get('/api/churches/:churchId/live-rundown/actions/:planId',
    requireChurchOrAdmin,
    (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      res.json(loadPlanActions(churchId, planId));
    }
  );

  /**
   * PUT /api/churches/:churchId/live-rundown/actions/:planId/:itemId
   * Save (upsert) Companion actions for a specific plan item.
   * Body: { actions: Action[] }
   *
   * Action schema:
   *   { type: 'button_press', page: number, row: number, col: number, label?: string }
   *   { type: 'custom_variable', name: string, value: string }
   */
  app.put('/api/churches/:churchId/live-rundown/actions/:planId/:itemId',
    requireChurchOrAdmin,
    (req, res) => {
      const { churchId, planId, itemId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { actions } = req.body;
      if (!Array.isArray(actions)) return res.status(400).json({ error: 'actions must be an array' });

      // Validate each action
      for (const a of actions) {
        if (a.type === 'button_press') {
          if (a.page == null || a.row == null || a.col == null) {
            return res.status(400).json({ error: 'button_press actions require page, row, col' });
          }
        } else if (a.type === 'custom_variable') {
          if (!a.name) return res.status(400).json({ error: 'custom_variable actions require name' });
        } else {
          return res.status(400).json({ error: `Unknown action type: ${a.type}` });
        }
      }

      try {
        const now = new Date().toISOString();
        const existing = db.prepare(
          'SELECT id FROM rundown_companion_actions WHERE church_id = ? AND plan_id = ? AND item_id = ?'
        ).get(churchId, planId, itemId);

        if (existing) {
          db.prepare(
            'UPDATE rundown_companion_actions SET actions_json = ?, updated_at = ? WHERE church_id = ? AND plan_id = ? AND item_id = ?'
          ).run(JSON.stringify(actions), now, churchId, planId, itemId);
        } else {
          db.prepare(
            'INSERT INTO rundown_companion_actions (id, church_id, plan_id, item_id, actions_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(uuidv4(), churchId, planId, itemId, JSON.stringify(actions), now);
        }

        // Update the live session's in-memory cache if a session is active
        liveRundown.setItemActions(churchId, itemId, actions);

        res.json({ ok: true, itemId, actionCount: actions.length });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * DELETE /api/churches/:churchId/live-rundown/actions/:planId/:itemId
   * Clear all Companion actions for a specific plan item.
   */
  app.delete('/api/churches/:churchId/live-rundown/actions/:planId/:itemId',
    requireChurchOrAdmin,
    (req, res) => {
      const { churchId, planId, itemId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        db.prepare(
          'DELETE FROM rundown_companion_actions WHERE church_id = ? AND plan_id = ? AND item_id = ?'
        ).run(churchId, planId, itemId);

        // Clear from live session too
        liveRundown.setItemActions(churchId, itemId, []);

        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  // ─── MANUAL PLAN CRUD ─────────────────────────────────────────────────────

  /**
   * GET /api/churches/:churchId/rundown-plans
   * List all available plans — both manual and PCO (if connected).
   */
  app.get('/api/churches/:churchId/rundown-plans',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        // Get manual plans
        const manualPlans = await manualRundown.listPlans(churchId);

        // Get PCO plans if available (don't require the feature — just check if data exists)
        let pcoPlans = [];
        try {
          const cached = planningCenter.getCachedPlans(churchId, 20);
          pcoPlans = (cached || []).map(p => ({
            id: p.id,
            title: p.title,
            serviceDate: p.sortDate || null,
            source: 'pco',
            itemCount: (p.items || []).length,
            isTemplate: false,
          }));
        } catch { /* PCO not available — fine */ }

        // Combine: manual first, then PCO
        const plans = [
          ...manualPlans.map(p => ({
            id: p.id,
            title: p.title,
            serviceDate: p.serviceDate,
            source: 'manual',
            itemCount: p.items.length,
            isTemplate: p.isTemplate,
          })),
          ...pcoPlans,
        ];

        res.json({ plans });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans
   * Create a new manual plan.
   * Body: { title: string, serviceDate?: string }
   */
  app.post('/api/churches/:churchId/rundown-plans',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { title, serviceDate } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });

      try {
        const plan = await manualRundown.createPlan(churchId, { title: title.trim(), serviceDate });
        res.json(plan);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * GET /api/churches/:churchId/rundown-plans/:planId
   * Get a single manual plan with items.
   */
  app.get('/api/churches/:churchId/rundown-plans/:planId',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const plan = await manualRundown.getPlan(req.params.planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        res.json(plan);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * PUT /api/churches/:churchId/rundown-plans/:planId
   * Update a manual plan.
   * Body: { title?: string, serviceDate?: string }
   */
  app.put('/api/churches/:churchId/rundown-plans/:planId',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const existing = await manualRundown.getPlan(req.params.planId);
        if (!existing || existing.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        const plan = await manualRundown.updatePlan(req.params.planId, req.body);
        res.json(plan);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * DELETE /api/churches/:churchId/rundown-plans/:planId
   */
  app.delete('/api/churches/:churchId/rundown-plans/:planId',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const existing = await manualRundown.getPlan(req.params.planId);
        if (!existing || existing.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        await manualRundown.deletePlan(req.params.planId);
        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/items
   * Add an item to a manual plan.
   * Body: { title: string, itemType?: string, lengthSeconds?: number, notes?: string }
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/items',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { title, itemType, lengthSeconds, notes } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });

      try {
        const existing = await manualRundown.getPlan(req.params.planId);
        if (!existing || existing.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        const item = await manualRundown.addItem(req.params.planId, {
          title: title.trim(),
          itemType: itemType || 'other',
          lengthSeconds: parseInt(lengthSeconds, 10) || 0,
          notes: notes || '',
        });
        res.json(item);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * PUT /api/churches/:churchId/rundown-plans/:planId/items/:itemId
   * Update an item.
   * Body: { title?: string, itemType?: string, lengthSeconds?: number, notes?: string }
   */
  app.put('/api/churches/:churchId/rundown-plans/:planId/items/:itemId',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const plan = await manualRundown.getPlan(req.params.planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        const { title, itemType, lengthSeconds, notes } = req.body;
        await manualRundown.updateItem(req.params.itemId, {
          title, itemType,
          lengthSeconds: lengthSeconds !== undefined ? parseInt(lengthSeconds, 10) || 0 : undefined,
          notes,
        });
        // Return updated plan
        const updated = await manualRundown.getPlan(req.params.planId);
        res.json(updated);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * DELETE /api/churches/:churchId/rundown-plans/:planId/items/:itemId
   */
  app.delete('/api/churches/:churchId/rundown-plans/:planId/items/:itemId',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const plan = await manualRundown.getPlan(req.params.planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        await manualRundown.deleteItem(req.params.itemId);
        const updated = await manualRundown.getPlan(req.params.planId);
        res.json(updated);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * PUT /api/churches/:churchId/rundown-plans/:planId/reorder
   * Reorder items in a plan.
   * Body: { itemIds: string[] }
   */
  app.put('/api/churches/:churchId/rundown-plans/:planId/reorder',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { itemIds } = req.body;
      if (!Array.isArray(itemIds)) return res.status(400).json({ error: 'itemIds array is required' });

      try {
        const plan = await manualRundown.getPlan(req.params.planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        await manualRundown.reorderItems(req.params.planId, itemIds);
        const updated = await manualRundown.getPlan(req.params.planId);
        res.json(updated);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  // ─── TEMPLATES ─────────────────────────────────────────────────────────────

  /**
   * GET /api/churches/:churchId/rundown-templates
   * List all templates.
   */
  app.get('/api/churches/:churchId/rundown-templates',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const templates = await manualRundown.listTemplates(churchId);
        res.json({ templates });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/save-template
   * Save a plan as a reusable template.
   * Body: { templateName?: string }
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/save-template',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const plan = await manualRundown.getPlan(req.params.planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        const template = await manualRundown.saveAsTemplate(req.params.planId, req.body.templateName);
        res.json(template);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-templates/:templateId/create
   * Create a new plan from a template.
   * Body: { title?: string, serviceDate?: string }
   */
  app.post('/api/churches/:churchId/rundown-templates/:templateId/create',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const template = await manualRundown.getPlan(req.params.templateId);
        if (!template || template.churchId !== churchId || !template.isTemplate) {
          return res.status(404).json({ error: 'Template not found' });
        }
        const plan = await manualRundown.createFromTemplate(req.params.templateId, {
          title: req.body.title,
          serviceDate: req.body.serviceDate,
        });
        res.json(plan);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  // ─── SHARE / GUEST PASS ENDPOINTS ─────────────────────────────────────────

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/share
   * Generate (or replace) a guest-pass share token for a plan.
   * Body: { expiresInDays?: number }  (default 7)
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/share',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        const expiresInDays = Number(req.body?.expiresInDays) || 7;
        const share = await manualRundown.createShare(planId, churchId, { expiresInDays });
        const baseUrl = process.env.PUBLIC_URL || 'https://api.tallyconnect.app';
        res.json({ ...share, url: `${baseUrl}/rundown/view/${share.token}` });
      } catch (e) {
        console.error('[rundown] share error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * GET /api/churches/:churchId/rundown-plans/:planId/share
   * Get the active share for a plan (if any).
   */
  app.get('/api/churches/:churchId/rundown-plans/:planId/share',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        const share = await manualRundown.getShareByPlanId(planId);
        if (!share || share.expiresAt < Date.now()) {
          return res.json({ share: null });
        }
        const baseUrl = process.env.PUBLIC_URL || 'https://api.tallyconnect.app';
        res.json({ share: { ...share, url: `${baseUrl}/rundown/view/${share.token}` } });
      } catch (e) {
        console.error('[rundown] share error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * DELETE /api/churches/:churchId/rundown-plans/:planId/share
   * Revoke the active share for a plan.
   */
  app.delete('/api/churches/:churchId/rundown-plans/:planId/share',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const share = await manualRundown.getShareByPlanId(planId);
        if (share && share.churchId === churchId) {
          await manualRundown.revokeShare(share.id);
        }
        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] share revoke error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * DELETE /api/churches/:churchId/rundown-templates/:templateId
   */
  app.delete('/api/churches/:churchId/rundown-templates/:templateId',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const template = await manualRundown.getPlan(req.params.templateId);
        if (!template || template.churchId !== churchId || !template.isTemplate) {
          return res.status(404).json({ error: 'Template not found' });
        }
        await manualRundown.deletePlan(req.params.templateId);
        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );
};
