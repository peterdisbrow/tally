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
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// ── HTML sanitizer for rich text notes ───────────────────────────────────────
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 'strong', 'em', 'ul', 'ol', 'li', 'span', 'br', 'p']);
function sanitizeHtml(html) {
  if (!html) return '';
  // Strip script tags and their content
  let clean = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Strip event handlers
  clean = clean.replace(/\s+on\w+\s*=\s*(['"]?)[\s\S]*?\1/gi, '');
  // Strip javascript: urls
  clean = clean.replace(/href\s*=\s*(['"]?)javascript:[\s\S]*?\1/gi, '');
  // Remove disallowed tags but keep their text content
  clean = clean.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, function(match, tag) {
    tag = tag.toLowerCase();
    if (ALLOWED_TAGS.has(tag)) {
      // For span, only allow style attribute
      if (tag === 'span') {
        var styleMatch = match.match(/style\s*=\s*"([^"]*)"/i);
        if (styleMatch) {
          // Only allow color in style
          var colorMatch = styleMatch[1].match(/color\s*:\s*[^;"]+/i);
          return match.startsWith('</') ? '</span>' : '<span' + (colorMatch ? ' style="' + colorMatch[0] + '"' : '') + '>';
        }
        return match.startsWith('</') ? '</span>' : '<span>';
      }
      return match;
    }
    return '';
  });
  return clean;
}

// ── File upload configuration ────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../../uploads/rundown');
// Ensure upload directory exists
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* exists */ }

const ALLOWED_MIMETYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: function(req, file, cb) {
      const ext = path.extname(file.originalname);
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: function(req, file, cb) {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed: ' + file.mimetype));
  },
});

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
   * Body: { title: string, itemType?: string, lengthSeconds?: number, notes?: string, assignee?: string }
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/items',
    requireChurchOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { title, itemType, lengthSeconds, notes, assignee } = req.body;
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
          assignee: assignee || '',
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
   * Body: { title?: string, itemType?: string, lengthSeconds?: number, notes?: string, assignee?: string }
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
        const { title, itemType, lengthSeconds, notes, assignee } = req.body;
        await manualRundown.updateItem(req.params.itemId, {
          title, itemType,
          lengthSeconds: lengthSeconds !== undefined ? parseInt(lengthSeconds, 10) || 0 : undefined,
          notes: notes !== undefined ? sanitizeHtml(notes) : undefined,
          assignee,
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

  // ─── CUSTOM COLUMNS ──────────────────────────────────────────────────────

  /**
   * GET /api/churches/:churchId/rundown-plans/:planId/columns
   * List all custom columns for a plan.
   */
  app.get('/api/churches/:churchId/rundown-plans/:planId/columns',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        const columns = await manualRundown.getColumns(planId);
        const values = await manualRundown.getColumnValues(planId);
        res.json({ columns, values });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/columns
   * Add a custom column.
   * Body: { name: string, department?: string }
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/columns',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      const { name, department } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        const col = await manualRundown.addColumn(planId, churchId, { name: name.trim(), department: department || '' });
        res.json(col);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * PUT /api/churches/:churchId/rundown-plans/:planId/columns/:colId
   * Update a column (rename/reorder).
   * Body: { name?: string, sortOrder?: number }
   */
  app.put('/api/churches/:churchId/rundown-plans/:planId/columns/:colId',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId, colId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        await manualRundown.updateColumn(colId, req.body);
        const columns = await manualRundown.getColumns(planId);
        res.json({ columns });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * DELETE /api/churches/:churchId/rundown-plans/:planId/columns/:colId
   * Delete a custom column.
   */
  app.delete('/api/churches/:churchId/rundown-plans/:planId/columns/:colId',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId, colId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        await manualRundown.deleteColumn(colId);
        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * PUT /api/churches/:churchId/rundown-plans/:planId/items/:itemId/columns/:colId
   * Set a cell value for a custom column.
   * Body: { value: string }
   */
  app.put('/api/churches/:churchId/rundown-plans/:planId/items/:itemId/columns/:colId',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId, itemId, colId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        await manualRundown.setColumnValue(itemId, colId, req.body.value || '');
        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  // ─── ATTACHMENTS ─────────────────────────────────────────────────────────

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/items/:itemId/attachments
   * Upload a file attachment to a rundown item.
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/items/:itemId/attachments',
    requireChurchOrAdmin,
    function(req, res, next) {
      upload.single('file')(req, res, function(err) {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 10MB)' });
          return res.status(400).json({ error: err.message });
        }
        next();
      });
    },
    async (req, res) => {
      const { churchId, planId, itemId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        const att = await manualRundown.addAttachment(itemId, planId, churchId, {
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
          storagePath: req.file.filename,
        });
        res.json(att);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * GET /api/church/rundown-attachments/:attachmentId
   * Serve an attachment file (auth required).
   */
  app.get('/api/church/rundown-attachments/:attachmentId',
    requireChurchOrAdmin,
    async (req, res) => {
      try {
        const att = await manualRundown.getAttachment(req.params.attachmentId);
        if (!att) return res.status(404).json({ error: 'Attachment not found' });
        const filePath = path.join(UPLOAD_DIR, att.storagePath);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
        res.setHeader('Content-Disposition', 'inline; filename="' + att.filename.replace(/"/g, '\\"') + '"');
        if (att.mimetype) res.setHeader('Content-Type', att.mimetype);
        res.sendFile(filePath);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * DELETE /api/church/rundown-attachments/:attachmentId
   * Delete an attachment.
   */
  app.delete('/api/church/rundown-attachments/:attachmentId',
    requireChurchOrAdmin,
    async (req, res) => {
      try {
        const att = await manualRundown.deleteAttachment(req.params.attachmentId);
        if (!att) return res.status(404).json({ error: 'Attachment not found' });
        // Try to clean up the file
        try { fs.unlinkSync(path.join(UPLOAD_DIR, att.storagePath)); } catch { /* file already gone */ }
        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * GET /api/churches/:churchId/rundown-plans/:planId/attachments
   * List all attachments for a plan (used by frontend to batch-load).
   */
  app.get('/api/churches/:churchId/rundown-plans/:planId/attachments',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        const attachments = await manualRundown.getAttachmentsByPlan(planId);
        res.json({ attachments });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  // ─── RICH TEXT NOTES (sanitized HTML) ─────────────────────────────────────

  /**
   * PUT /api/churches/:churchId/rundown-plans/:planId/items/:itemId
   * Already exists above — we enhance the existing item update route to sanitize HTML notes.
   * This is handled by adding sanitization in the existing route handler.
   * (No new route needed — we patch the existing one's notes handling.)
   */

  // Export sanitizeHtml for use by existing update handler
  app._rundownSanitizeHtml = sanitizeHtml;
};
