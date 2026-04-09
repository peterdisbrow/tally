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
const { buildManualPlanTimerState } = require('../rundownPublic');

const VALID_RUNDOWN_COLUMN_TYPES = new Set(['text', 'dropdown']);
const VALID_RUNDOWN_COLLABORATOR_ROLES = new Set(['owner', 'editor', 'viewer']);
const VALID_RUNDOWN_COLLABORATOR_STATUSES = new Set(['active', 'offline', 'revoked']);
const RUNDOWN_ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };
const PRESENCE_STALE_AFTER_MS = 5 * 60 * 1000;
const VALID_RUNDOWN_EQUIPMENT_BINDINGS = new Set([
  'atem.program_input',
  'atem.preview_input',
  'propresenter.presentation',
  'encoder.status',
  'stream.live',
]);

function normalizeRundownColumnOptions(options, type) {
  if (type !== 'dropdown') return [];
  const list = Array.isArray(options)
    ? options
    : String(options || '')
      .split(',');
  return [...new Set(list.map((option) => String(option || '').trim()).filter(Boolean))];
}

function normalizeRundownEquipmentBinding(binding) {
  if (binding === undefined) return undefined;
  const trimmed = String(binding || '').trim();
  if (!trimmed || trimmed === 'none') return null;
  return trimmed;
}

function normalizeRundownCollaboratorRole(role, fallback = 'editor') {
  const normalized = String(role || '').trim().toLowerCase();
  if (VALID_RUNDOWN_COLLABORATOR_ROLES.has(normalized)) return normalized;
  return fallback;
}

function normalizeRundownCollaboratorStatus(status, fallback = 'active') {
  const normalized = String(status || '').trim().toLowerCase();
  if (VALID_RUNDOWN_COLLABORATOR_STATUSES.has(normalized)) return normalized;
  return fallback;
}

function getRundownActor(req) {
  const sessionId = String(
    req.body?.sessionId
    || req.headers['x-rundown-session-id']
    || req.headers['x-session-id']
    || ''
  ).trim();
  const displayName = String(
    req.body?.userName
    || req.body?.displayName
    || req.headers['x-rundown-user-name']
    || req.headers['x-user-name']
    || req.churchPayload?.name
    || req.church?.name
    || ''
  ).trim();
  const requestedRole = normalizeRundownCollaboratorRole(
    req.body?.role || req.headers['x-rundown-role'],
    req.churchReadonly ? 'viewer' : 'editor'
  );
  return {
    sessionId: sessionId || null,
    displayName: displayName || '',
    role: requestedRole,
  };
}

function roleAtLeast(role, minimumRole) {
  const roleRank = RUNDOWN_ROLE_RANK[normalizeRundownCollaboratorRole(role, 'viewer')] ?? 0;
  const minRank = RUNDOWN_ROLE_RANK[normalizeRundownCollaboratorRole(minimumRole, 'viewer')] ?? 0;
  return roleRank >= minRank;
}

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
  const {
    db,
    churches,
    requireChurchOrAdmin,
    requireFeature,
    planningCenter,
    liveRundown,
    manualRundown,
    safeErrorMessage,
    uuidv4,
    broadcastToPortal,
    broadcastPublicRundownTimer,
    rundownPresence,
  } = ctx;

  const manualLiveTimerIntervals = new Map();

  // ─── Helper: broadcast a rundown collaboration event to all portal clients ───
  function broadcastRundownEvent(churchId, type, payload) {
    if (broadcastToPortal) {
      broadcastToPortal(churchId, { type, ...payload });
    }
  }

  function requireChurchWriteOrAdmin(req, res, next) {
    return requireChurchOrAdmin(req, res, () => {
      if (req.churchPayload?.readonly) {
        return res.status(403).json({ error: 'This token is read-only. Log in with full credentials to make changes.' });
      }
      return next();
    });
  }

  async function ensurePlanWriteAccess(req, res, plan) {
    if (!plan) return false;
    if (req.churchPayload?.readonly) {
      res.status(403).json({ error: 'This token is read-only. Log in with full credentials to make changes.' });
      return true;
    }
    const actor = getRundownActor(req);
    if (actor.sessionId) {
      const collaborator = await manualRundown.getCollaborator(plan.id, actor.sessionId);
      if (collaborator && collaborator.status === 'revoked') {
        res.status(403).json({ error: 'Your rundown access was revoked for this plan.' });
        return true;
      }
      if (collaborator && collaborator.role === 'viewer') {
        res.status(403).json({ error: 'View-only collaborators cannot edit this rundown.' });
        return true;
      }
    }
    return false;
  }

  function snapshotPresence(planId) {
    const rows = rundownPresence?.get(planId) || [];
    return rows.map((row) => ({
      sessionId: row.sessionId,
      userName: row.userName,
      displayName: row.displayName || row.userName || '',
      role: normalizeRundownCollaboratorRole(row.role, 'editor'),
      status: row.status || 'active',
      joinedAt: row.joinedAt || null,
      lastSeenAt: row.lastSeenAt || row.joinedAt || null,
      leftAt: row.leftAt || null,
      isStale: !!row.lastSeenAt && row.lastSeenAt < (Date.now() - PRESENCE_STALE_AFTER_MS),
    }));
  }

  function broadcastPresence(churchId, planId) {
    const collaborators = snapshotPresence(planId);
    broadcastRundownEvent(churchId, 'rundown_presence', {
      planId,
      collaborators,
      editors: collaborators,
      staleAfterMs: PRESENCE_STALE_AFTER_MS,
      updatedAt: Date.now(),
    });
  }

  function upsertPresenceCache(planId, record) {
    if (!rundownPresence) return record;
    if (!rundownPresence.has(planId)) rundownPresence.set(planId, []);
    const entries = rundownPresence.get(planId);
    const idx = entries.findIndex((entry) => entry.sessionId === record.sessionId);
    const now = Date.now();
    const next = {
      ...(idx >= 0 ? entries[idx] : {}),
      ...record,
      joinedAt: (idx >= 0 && entries[idx].joinedAt) || record.joinedAt || now,
      lastSeenAt: record.lastSeenAt || now,
      status: record.status || (idx >= 0 && entries[idx].status) || 'active',
    };
    if (idx >= 0) entries[idx] = next;
    else entries.push(next);
    return next;
  }

  function markPresenceOffline(planId, sessionId) {
    if (!rundownPresence?.has(planId)) return null;
    const entries = rundownPresence.get(planId);
    const idx = entries.findIndex((entry) => entry.sessionId === sessionId);
    if (idx < 0) return null;
    entries[idx] = {
      ...entries[idx],
      status: 'offline',
      leftAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    return entries[idx];
  }

  function stopManualLiveTimer(planId, planTitle, { broadcastEnded = true } = {}) {
    const interval = manualLiveTimerIntervals.get(planId);
    if (interval) {
      clearInterval(interval);
      manualLiveTimerIntervals.delete(planId);
    }
    if (broadcastEnded && broadcastPublicRundownTimer) {
      broadcastPublicRundownTimer(planId, { type: 'rundown_ended', planTitle, plan_id: planId });
    }
  }

  async function emitManualLiveTimer(planId) {
    if (!broadcastPublicRundownTimer) return;
    const plan = await manualRundown.getPlan(planId);
    if (!plan) {
      stopManualLiveTimer(planId);
      return;
    }
    const liveState = await manualRundown.getLiveState(planId);
    if (!liveState || !liveState.isLive) {
      stopManualLiveTimer(planId, plan.title);
      return;
    }
    broadcastPublicRundownTimer(planId, {
      type: 'timer_state',
      ...buildManualPlanTimerState(plan, liveState),
    });
  }

  function ensureManualLiveTimer(planId) {
    stopManualLiveTimer(planId, null, { broadcastEnded: false });
    emitManualLiveTimer(planId).catch((error) => {
      console.error('[rundown] manual timer emit error:', error);
    });
    const interval = setInterval(() => {
      emitManualLiveTimer(planId).catch((error) => {
        console.error('[rundown] manual timer tick error:', error);
      });
    }, 1000);
    manualLiveTimerIntervals.set(planId, interval);
  }

  async function buildPlanTimerState(plan) {
    if (!plan) return null;
    const found = liveRundown.findSessionByPlanId(plan.id);
    if (found) {
      return liveRundown.getTimerState(found.churchId, plan.id) || {
        is_live: false,
        plan_id: plan.id,
        plan_title: plan.title,
      };
    }
    const liveState = await manualRundown.getLiveState(plan.id);
    if (liveState?.isLive && !manualLiveTimerIntervals.has(plan.id)) {
      ensureManualLiveTimer(plan.id);
    }
    return buildManualPlanTimerState(plan, liveState);
  }

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
    requireChurchWriteOrAdmin,
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
            if (await ensurePlanWriteAccess(req, res, manualPlan)) return;
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

        // Auto-update status to 'live' for manual plans
        if (plan.source === 'manual') {
          try {
            await manualRundown.updateStatus(planId, 'live');
            broadcastRundownEvent(churchId, 'rundown_plan_updated', { planId, plan: { id: planId, status: 'live' } });
          } catch { /* non-critical */ }
        }

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
    requireChurchWriteOrAdmin,
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
    requireChurchWriteOrAdmin,
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
    requireChurchWriteOrAdmin,
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const summary = liveRundown.endSession(churchId);
      if (!summary) {
        return res.status(400).json({ error: 'No active rundown session' });
      }

      // Auto-revert manual plan status from 'live' back to 'show_ready'
      if (summary.planId) {
        try {
          const plan = await manualRundown.getPlan(summary.planId);
          if (plan && plan.status === 'live') {
            await manualRundown.updateStatus(summary.planId, 'show_ready');
            broadcastRundownEvent(churchId, 'rundown_plan_updated', { planId: summary.planId, plan: { id: summary.planId, status: 'show_ready' } });
          }
        } catch { /* non-critical */ }
      }

      res.json(summary);
    }
  );

  /**
   * POST /api/churches/:churchId/live-rundown/auto-advance
   * Body: { enabled: boolean }
   */
  app.post('/api/churches/:churchId/live-rundown/auto-advance',
    requireChurchWriteOrAdmin,
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
    requireChurchWriteOrAdmin,
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
    requireChurchWriteOrAdmin,
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
          ...manualPlans.map(p => {
            const totalDuration = (p.items || []).reduce((sum, it) => sum + (it.lengthSeconds || 0), 0);
            const collaborators = Array.isArray(p.collaborators) ? p.collaborators : [];
            const activeCollaborators = collaborators.filter((entry) => entry.status === 'active').length;
            return {
              id: p.id,
              title: p.title,
              serviceDate: p.serviceDate,
              source: 'manual',
              itemCount: p.items.length,
              isTemplate: p.isTemplate,
              status: p.status || 'draft',
              roomId: p.roomId || '',
              totalDuration,
              updatedAt: p.updatedAt,
              collaborators,
              activeEditors: activeCollaborators,
            };
          }),
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { title, serviceDate, roomId } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });

      try {
        const actor = getRundownActor(req);
        const plan = await manualRundown.createPlan(churchId, {
          title: title.trim(),
          serviceDate,
          roomId: roomId || '',
          ownerKey: actor.sessionId || actor.displayName || churchId,
          ownerName: actor.displayName || (actor.role === 'viewer' ? 'Viewer' : 'Owner'),
        });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const existing = await manualRundown.getPlan(req.params.planId);
        if (!existing || existing.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, existing)) return;
        const plan = await manualRundown.updatePlan(req.params.planId, req.body);
        broadcastRundownEvent(churchId, 'rundown_plan_updated', { planId: plan.id, plan: { id: plan.id, title: plan.title, status: plan.status, serviceDate: plan.serviceDate, roomId: plan.roomId, updatedAt: plan.updatedAt } });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const existing = await manualRundown.getPlan(req.params.planId);
        if (!existing || existing.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, existing)) return;
        const attachments = await manualRundown.getAttachmentsByPlan(req.params.planId);
        stopManualLiveTimer(req.params.planId, existing.title);
        await manualRundown.deletePlan(req.params.planId);
        for (const attachment of attachments) {
          try {
            fs.unlinkSync(path.join(UPLOAD_DIR, attachment.storagePath));
          } catch {
            // File cleanup is best-effort.
          }
        }
        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * PUT /api/churches/:churchId/rundown-plans/:planId/status
   * Update a plan's status.
   * Body: { status: 'draft'|'rehearsal'|'show_ready'|'live'|'archived' }
   */
  app.put('/api/churches/:churchId/rundown-plans/:planId/status',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { status } = req.body;
      const valid = ['draft', 'rehearsal', 'show_ready', 'live', 'archived'];
      if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status. Must be one of: ' + valid.join(', ') });

      try {
        const existing = await manualRundown.getPlan(req.params.planId);
        if (!existing || existing.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, existing)) return;
        const plan = await manualRundown.updateStatus(req.params.planId, status);
        broadcastRundownEvent(churchId, 'rundown_plan_updated', { planId: plan.id, plan: { id: plan.id, title: plan.title, status: plan.status, serviceDate: plan.serviceDate, roomId: plan.roomId, updatedAt: plan.updatedAt } });
        res.json(plan);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/duplicate
   * Duplicate a plan.
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/duplicate',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const existing = await manualRundown.getPlan(req.params.planId);
        if (!existing || existing.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, existing)) return;
        const actor = getRundownActor(req);
        const plan = await manualRundown.duplicatePlan(req.params.planId, {
          ownerKey: actor.sessionId || actor.displayName || null,
          ownerName: actor.displayName || existing.title,
        });
        res.json(plan);
      } catch (e) {
        console.error('[rundown] error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/subscribe
   * Subscribe to collaborative editing for a plan (presence tracking).
   * Body: { userName?: string, sessionId?: string, role?: 'owner'|'editor'|'viewer' }
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/subscribe',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      const plan = await manualRundown.getPlan(planId);
      if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
      const actor = getRundownActor(req);
      const sessionId = actor.sessionId || uuidv4();
      const role = normalizeRundownCollaboratorRole(
        req.body?.role,
        req.churchReadonly ? 'viewer' : actor.role
      );
      const collaborator = await manualRundown.upsertCollaborator(planId, churchId, {
        collaboratorKey: sessionId,
        displayName: actor.displayName || 'TD',
        role: req.churchReadonly ? 'viewer' : role,
        status: 'active',
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
        metadata: {
          source: req.churchReadonly ? 'viewer-token' : 'presence-subscribe',
        },
      });
      upsertPresenceCache(planId, {
        sessionId,
        churchId,
        userName: collaborator.displayName || actor.displayName || 'TD',
        displayName: collaborator.displayName || actor.displayName || 'TD',
        role: collaborator.role,
        status: collaborator.status,
        joinedAt: collaborator.joinedAt,
        lastSeenAt: collaborator.lastSeenAt,
        leftAt: collaborator.leftAt || null,
      });
      broadcastPresence(churchId, planId);
      res.json({
        ok: true,
        sessionId,
        collaborator,
        collaborators: snapshotPresence(planId),
        editors: snapshotPresence(planId),
        activeCollaborators: snapshotPresence(planId).filter((entry) => entry.status === 'active').length,
        heartbeatIntervalMs: 30_000,
        staleAfterMs: PRESENCE_STALE_AFTER_MS,
      });
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/heartbeat
   * Refresh presence and last-seen timestamps for a collaborator.
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/heartbeat',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      const plan = await manualRundown.getPlan(planId);
      if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
      const actor = getRundownActor(req);
      const sessionId = actor.sessionId || uuidv4();
      const current = await manualRundown.getCollaborator(planId, sessionId);
      const collaborator = await manualRundown.upsertCollaborator(planId, churchId, {
        collaboratorKey: sessionId,
        displayName: actor.displayName || current?.displayName || 'TD',
        role: req.churchReadonly ? 'viewer' : (current?.role || actor.role),
        status: current?.status === 'revoked' ? 'revoked' : 'active',
        joinedAt: current?.joinedAt || Date.now(),
        lastSeenAt: Date.now(),
        leftAt: current?.status === 'offline' ? null : current?.leftAt || null,
        metadata: {
          ...(current?.metadata || {}),
          source: 'presence-heartbeat',
        },
      });
      upsertPresenceCache(planId, {
        sessionId,
        churchId,
        userName: collaborator.displayName || actor.displayName || 'TD',
        displayName: collaborator.displayName || actor.displayName || 'TD',
        role: collaborator.role,
        status: collaborator.status,
        joinedAt: collaborator.joinedAt,
        lastSeenAt: collaborator.lastSeenAt,
        leftAt: collaborator.leftAt || null,
      });
      broadcastPresence(churchId, planId);
      res.json({
        ok: true,
        sessionId,
        collaborator,
        collaborators: snapshotPresence(planId),
        editors: snapshotPresence(planId),
        activeCollaborators: snapshotPresence(planId).filter((entry) => entry.status === 'active').length,
        heartbeatIntervalMs: 30_000,
        staleAfterMs: PRESENCE_STALE_AFTER_MS,
      });
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/unsubscribe
   * Unsubscribe from collaborative editing.
   * Body: { sessionId: string }
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/unsubscribe',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      const plan = await manualRundown.getPlan(planId);
      if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
      const actor = getRundownActor(req);
      const sessionId = actor.sessionId || req.body.sessionId || req.headers['x-session-id'];
      if (sessionId) {
        await manualRundown.markCollaboratorOffline(planId, sessionId);
        markPresenceOffline(planId, sessionId);
      }
      broadcastPresence(churchId, planId);
      res.json({ ok: true, collaborators: snapshotPresence(planId), editors: snapshotPresence(planId) });
    }
  );

  /**
   * GET /api/churches/:churchId/rundown-plans/:planId/collaborators
   * Return the durable collaborator roster for a plan.
   */
  app.get('/api/churches/:churchId/rundown-plans/:planId/collaborators',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      const plan = await manualRundown.getPlan(planId);
      if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
      const collaborators = await manualRundown.getCollaborators(planId);
      res.json({
        collaborators,
        activeCollaborators: collaborators.filter((collaborator) => collaborator.status === 'active').length,
        staleAfterMs: PRESENCE_STALE_AFTER_MS,
      });
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/collaborators
   * Add or update a collaborator role for a plan.
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/collaborators',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      const plan = await manualRundown.getPlan(planId);
      if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
      if (await ensurePlanWriteAccess(req, res, plan)) return;
      const collaboratorKey = String(req.body?.collaboratorKey || req.body?.sessionId || '').trim();
      if (!collaboratorKey) return res.status(400).json({ error: 'collaboratorKey is required' });
      const collaborator = await manualRundown.upsertCollaborator(planId, churchId, {
        collaboratorKey,
        displayName: String(req.body?.displayName || req.body?.userName || '').trim(),
        role: normalizeRundownCollaboratorRole(req.body?.role, 'editor'),
        status: normalizeRundownCollaboratorStatus(req.body?.status, 'active'),
        joinedAt: req.body?.joinedAt || Date.now(),
        lastSeenAt: req.body?.lastSeenAt || Date.now(),
        metadata: req.body?.metadata || {},
      });
      broadcastPresence(churchId, planId);
      res.json({ collaborator, collaborators: await manualRundown.getCollaborators(planId) });
    }
  );

  /**
   * PUT /api/churches/:churchId/rundown-plans/:planId/collaborators/:collaboratorKey
   * Update collaborator role/status.
   */
  app.put('/api/churches/:churchId/rundown-plans/:planId/collaborators/:collaboratorKey',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId, collaboratorKey } = req.params;
      const plan = await manualRundown.getPlan(planId);
      if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
      if (await ensurePlanWriteAccess(req, res, plan)) return;
      const existing = await manualRundown.getCollaborator(planId, collaboratorKey);
      if (!existing) return res.status(404).json({ error: 'Collaborator not found' });
      const collaborator = await manualRundown.upsertCollaborator(planId, churchId, {
        collaboratorKey,
        displayName: req.body?.displayName !== undefined ? String(req.body.displayName || '').trim() : existing.displayName,
        role: normalizeRundownCollaboratorRole(req.body?.role, existing.role),
        status: normalizeRundownCollaboratorStatus(req.body?.status, existing.status),
        joinedAt: existing.joinedAt,
        lastSeenAt: req.body?.lastSeenAt || existing.lastSeenAt,
        leftAt: req.body?.leftAt !== undefined ? req.body.leftAt : existing.leftAt,
        metadata: req.body?.metadata || existing.metadata || {},
      });
      broadcastPresence(churchId, planId);
      res.json({ collaborator, collaborators: await manualRundown.getCollaborators(planId) });
    }
  );

  /**
   * DELETE /api/churches/:churchId/rundown-plans/:planId/collaborators/:collaboratorKey
   * Revoke collaborator access.
   */
  app.delete('/api/churches/:churchId/rundown-plans/:planId/collaborators/:collaboratorKey',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId, collaboratorKey } = req.params;
      const plan = await manualRundown.getPlan(planId);
      if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
      if (await ensurePlanWriteAccess(req, res, plan)) return;
      const collaborator = await manualRundown.revokeCollaborator(planId, collaboratorKey);
      if (!collaborator) return res.status(404).json({ error: 'Collaborator not found' });
      markPresenceOffline(planId, collaboratorKey);
      broadcastPresence(churchId, planId);
      res.json({ ok: true, collaborator, collaborators: await manualRundown.getCollaborators(planId) });
    }
  );

  /**
   * POST /api/churches/:churchId/rundown-plans/:planId/items
   * Add an item to a manual plan.
   * Body: { title: string, itemType?: string, lengthSeconds?: number, notes?: string, assignee?: string }
   */
  app.post('/api/churches/:churchId/rundown-plans/:planId/items',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      const { title, itemType, lengthSeconds, notes, assignee, startType, hardStartTime, autoAdvance } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });

      try {
        const existing = await manualRundown.getPlan(req.params.planId);
        if (!existing || existing.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, existing)) return;
        const sanitizedNotes = sanitizeHtml(notes || '');
        const item = await manualRundown.addItem(req.params.planId, {
          title: title.trim(),
          itemType: itemType || 'other',
          lengthSeconds: parseInt(lengthSeconds, 10) || 0,
          notes: sanitizedNotes,
          assignee: assignee || '',
          startType,
          hardStartTime,
          autoAdvance: autoAdvance !== undefined ? !!autoAdvance : false,
        });
        broadcastRundownEvent(churchId, 'rundown_item_added', { planId: req.params.planId, item });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const plan = await manualRundown.getPlan(req.params.planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const targetItem = (plan.items || []).find((item) => item.id === req.params.itemId);
        if (!targetItem) {
          return res.status(404).json({ error: 'Item not found' });
        }
        const { title, itemType, lengthSeconds, notes, assignee, startType, hardStartTime, autoAdvance } = req.body;
        const sanitizedNotes = notes !== undefined ? sanitizeHtml(notes) : undefined;
        await manualRundown.updateItem(req.params.itemId, {
          title, itemType,
          lengthSeconds: lengthSeconds !== undefined ? parseInt(lengthSeconds, 10) || 0 : undefined,
          notes: sanitizedNotes,
          assignee,
          startType, hardStartTime,
          autoAdvance: autoAdvance !== undefined ? !!autoAdvance : undefined,
        });
        // Return updated plan
        const updated = await manualRundown.getPlan(req.params.planId);
        broadcastRundownEvent(churchId, 'rundown_item_updated', {
          planId: req.params.planId,
          itemId: req.params.itemId,
          item: {
            id: req.params.itemId,
            title,
            itemType,
            lengthSeconds: lengthSeconds !== undefined ? parseInt(lengthSeconds, 10) || 0 : undefined,
            notes: sanitizedNotes,
            assignee,
            startType,
            hardStartTime,
            autoAdvance: autoAdvance !== undefined ? !!autoAdvance : undefined,
          },
        });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const plan = await manualRundown.getPlan(req.params.planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const targetItem = (plan.items || []).find((item) => item.id === req.params.itemId);
        if (!targetItem) {
          return res.status(404).json({ error: 'Item not found' });
        }
        const attachments = await manualRundown.getAttachments(req.params.itemId);
        await manualRundown.deleteItem(req.params.itemId);
        for (const attachment of attachments) {
          try {
            fs.unlinkSync(path.join(UPLOAD_DIR, attachment.storagePath));
          } catch {
            // File cleanup is best-effort.
          }
        }
        const updated = await manualRundown.getPlan(req.params.planId);
        broadcastRundownEvent(churchId, 'rundown_item_deleted', { planId: req.params.planId, itemId: req.params.itemId });
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
    requireChurchWriteOrAdmin,
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
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const planItemIds = new Set((plan.items || []).map((item) => item.id));
        if (itemIds.length !== planItemIds.size || itemIds.some((itemId) => !planItemIds.has(itemId))) {
          return res.status(400).json({ error: 'itemIds must include each item in the plan exactly once' });
        }
        await manualRundown.reorderItems(req.params.planId, itemIds);
        const updated = await manualRundown.getPlan(req.params.planId);
        broadcastRundownEvent(churchId, 'rundown_item_reordered', { planId: req.params.planId, itemIds });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const plan = await manualRundown.getPlan(req.params.planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const actor = getRundownActor(req);
        const template = await manualRundown.saveAsTemplate(req.params.planId, req.body.templateName, {
          ownerKey: actor.sessionId || actor.displayName || churchId,
          ownerName: actor.displayName || 'Owner',
        });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const template = await manualRundown.getPlan(req.params.templateId);
        if (!template || template.churchId !== churchId || !template.isTemplate) {
          return res.status(404).json({ error: 'Template not found' });
        }
        if (await ensurePlanWriteAccess(req, res, template)) return;
        const actor = getRundownActor(req);
        const plan = await manualRundown.createFromTemplate(req.params.templateId, {
          title: req.body.title,
          serviceDate: req.body.serviceDate,
          ownerKey: actor.sessionId || actor.displayName || churchId,
          ownerName: actor.displayName || 'Owner',
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const expiresInDays = Number(req.body?.expiresInDays) || 7;
        const share = await manualRundown.createShare(planId, churchId, { expiresInDays });
        await manualRundown.setShareToken(planId, share.token);
        const baseUrl = process.env.PUBLIC_URL || 'https://api.tallyconnect.app';
        res.json({
          ...share,
          url: `${baseUrl}/rundown/view/${share.token}`,
          share_token: share.token,
          timer_url: `${baseUrl}/rundown/timer/${share.token}`,
        });
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
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const share = await manualRundown.getShareByPlanId(planId);
        if (!share || share.expiresAt < Date.now()) {
          await manualRundown.clearShareToken(planId);
          return res.json({ share: null });
        }
        await manualRundown.setShareToken(planId, share.token);
        const baseUrl = process.env.PUBLIC_URL || 'https://api.tallyconnect.app';
        res.json({
          share: {
            ...share,
            url: `${baseUrl}/rundown/view/${share.token}`,
            share_token: share.token,
            timer_url: `${baseUrl}/rundown/timer/${share.token}`,
          },
        });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const share = await manualRundown.getShareByPlanId(planId);
        if (share && share.churchId === churchId) {
          const plan = await manualRundown.getPlan(planId);
          if (plan && await ensurePlanWriteAccess(req, res, plan)) return;
          await manualRundown.revokeShare(share.id);
        }
        await manualRundown.clearShareToken(planId);
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const churchId = req.params.churchId;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });

      try {
        const template = await manualRundown.getPlan(req.params.templateId);
        if (!template || template.churchId !== churchId || !template.isTemplate) {
          return res.status(404).json({ error: 'Template not found' });
        }
        if (await ensurePlanWriteAccess(req, res, template)) return;
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
        if (await ensurePlanWriteAccess(req, res, plan)) return;
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      const { name, department } = req.body;
      const type = VALID_RUNDOWN_COLUMN_TYPES.has(req.body?.type) ? req.body.type : 'text';
      const options = normalizeRundownColumnOptions(req.body?.options, type);
      const equipmentBinding = normalizeRundownEquipmentBinding(req.body?.equipmentBinding);
      if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
      if (equipmentBinding && !VALID_RUNDOWN_EQUIPMENT_BINDINGS.has(equipmentBinding)) {
        return res.status(400).json({ error: 'Invalid equipment binding' });
      }
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const col = await manualRundown.addColumn(planId, churchId, {
          name: name.trim(),
          department: department || '',
          type,
          options,
          equipmentBinding,
        });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId, colId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const columns = await manualRundown.getColumns(planId);
        if (!columns.some((column) => column.id === colId)) {
          return res.status(404).json({ error: 'Column not found' });
        }
        const update = {};
        if (req.body?.name !== undefined) update.name = req.body.name;
        if (req.body?.sortOrder !== undefined) update.sortOrder = req.body.sortOrder;
        if (req.body?.type !== undefined) {
          if (!VALID_RUNDOWN_COLUMN_TYPES.has(req.body.type)) {
            return res.status(400).json({ error: 'Invalid column type' });
          }
          update.type = req.body.type;
        }
        if (req.body?.options !== undefined) {
          update.options = normalizeRundownColumnOptions(
            req.body.options,
            update.type || req.body.type || 'dropdown'
          );
        }
        if (req.body?.equipmentBinding !== undefined) {
          const equipmentBinding = normalizeRundownEquipmentBinding(req.body.equipmentBinding);
          if (equipmentBinding && !VALID_RUNDOWN_EQUIPMENT_BINDINGS.has(equipmentBinding)) {
            return res.status(400).json({ error: 'Invalid equipment binding' });
          }
          update.equipmentBinding = equipmentBinding;
        }
        await manualRundown.updateColumn(colId, update);
        const updatedColumns = await manualRundown.getColumns(planId);
        res.json({ columns: updatedColumns });
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId, colId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const columns = await manualRundown.getColumns(planId);
        if (!columns.some((column) => column.id === colId)) {
          return res.status(404).json({ error: 'Column not found' });
        }
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId, itemId, colId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const item = (plan.items || []).find((entry) => entry.id === itemId);
        if (!item) return res.status(404).json({ error: 'Item not found' });
        const columns = await manualRundown.getColumns(planId);
        if (!columns.some((column) => column.id === colId)) {
          return res.status(404).json({ error: 'Column not found' });
        }
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
    requireChurchWriteOrAdmin,
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
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const item = (plan.items || []).find((entry) => entry.id === itemId);
        if (!item) return res.status(404).json({ error: 'Item not found' });
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
        const callerChurchId = req.churchPayload?.churchId || null;
        if (callerChurchId && att.churchId !== callerChurchId) {
          return res.status(404).json({ error: 'Attachment not found' });
        }
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
    requireChurchWriteOrAdmin,
    async (req, res) => {
      try {
        const existing = await manualRundown.getAttachment(req.params.attachmentId);
        if (!existing) return res.status(404).json({ error: 'Attachment not found' });
        const plan = await manualRundown.getPlan(existing.planId);
        if (plan && await ensurePlanWriteAccess(req, res, plan)) return;
        const callerChurchId = req.churchPayload?.churchId || null;
        if (callerChurchId && existing.churchId !== callerChurchId) {
          return res.status(404).json({ error: 'Attachment not found' });
        }
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

  app.get('/api/public/rundown/:token/attachments/:attachmentId',
    async (req, res) => {
      try {
        const access = await manualRundown.resolvePublicAccess(req.params.token);
        if (!access?.plan) return res.status(404).json({ error: 'Link not found or expired' });
        const att = await manualRundown.getAttachment(req.params.attachmentId);
        if (!att || att.planId !== access.plan.id || att.churchId !== access.plan.churchId) {
          return res.status(404).json({ error: 'Attachment not found' });
        }
        const filePath = path.join(UPLOAD_DIR, att.storagePath);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
        res.setHeader('Content-Disposition', 'inline; filename="' + att.filename.replace(/"/g, '\\"') + '"');
        if (att.mimetype) res.setHeader('Content-Type', att.mimetype);
        res.sendFile(filePath);
      } catch (e) {
        console.error('[rundown] public attachment error:', e);
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

  // ─── COUNTDOWN TIMER ENDPOINTS ─────────────────────────────────────────────

  /**
   * GET /api/church/rundown-plans/:planId/live/timer
   * Authenticated timer state for the portal.
   */
  app.get('/api/church/rundown-plans/:planId/live/timer',
    requireChurchOrAdmin,
    async (req, res) => {
      try {
        const planId = req.params.planId;
        const plan = await manualRundown.getPlan(planId);
        if (!plan) return res.status(404).json({ error: 'Plan not found' });
        const callerChurchId = req.churchPayload?.churchId || null;
        if (callerChurchId && plan.churchId !== callerChurchId) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        const timer = await buildPlanTimerState(plan);
        if (!timer) return res.json({ is_live: false, plan_title: plan.title, plan_id: plan.id });
        res.json(timer);
      } catch (e) {
        console.error('[rundown] timer error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  /**
   * GET /api/public/rundown/:token/timer
   * Public countdown timer endpoint (no auth, uses share token).
   */
  app.get('/api/public/rundown/:token/timer',
    async (req, res) => {
      try {
        const access = await manualRundown.resolvePublicAccess(req.params.token);
        if (!access?.plan) return res.status(404).json({ error: 'Invalid share token' });
        const timer = await buildPlanTimerState(access.plan);
        if (!timer) return res.json({ is_live: false, plan_title: access.plan.title, plan_id: access.plan.id });
        res.json(timer);
      } catch (e) {
        console.error('[rundown] public timer error:', e);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  // ─── LIVE SHOW MODE (per-plan cueing) ─────────────────────────────────────

  app.post('/api/churches/:churchId/rundown-plans/:planId/live/start',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        await manualRundown.startLive(planId, churchId);
        const items = plan.items || [];
        let firstCueIdx = 0;
        for (let i = 0; i < items.length; i++) {
          if (items[i].itemType !== 'section') { firstCueIdx = i; break; }
        }
        if (firstCueIdx !== 0) {
          await manualRundown.updateLiveState(planId, { currentCueIndex: firstCueIdx, currentCueStartedAt: Date.now() });
        }
        const state = await manualRundown.getLiveState(planId);
        ensureManualLiveTimer(planId);
        res.json({ ...state, plan });
      } catch (e) {
        console.error('[rundown] live/start error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  app.post('/api/churches/:churchId/rundown-plans/:planId/live/stop',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        await manualRundown.stopLive(planId);
        stopManualLiveTimer(planId, plan.title);
        res.json({ ok: true });
      } catch (e) {
        console.error('[rundown] live/stop error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  app.post('/api/churches/:churchId/rundown-plans/:planId/live/go',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const liveState = await manualRundown.getLiveState(planId);
        if (!liveState) return res.status(400).json({ error: 'Not in live mode' });
        const items = plan.items || [];
        let nextIdx = liveState.currentCueIndex + 1;
        while (nextIdx < items.length && items[nextIdx].itemType === 'section') nextIdx++;
        if (nextIdx >= items.length) return res.status(400).json({ error: 'Already at last cue' });
        const updated = await manualRundown.updateLiveState(planId, { currentCueIndex: nextIdx, currentCueStartedAt: Date.now() });
        ensureManualLiveTimer(planId);
        res.json({ ...updated, plan });
      } catch (e) {
        console.error('[rundown] live/go error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  app.post('/api/churches/:churchId/rundown-plans/:planId/live/back',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const liveState = await manualRundown.getLiveState(planId);
        if (!liveState) return res.status(400).json({ error: 'Not in live mode' });
        const items = plan.items || [];
        let prevIdx = liveState.currentCueIndex - 1;
        while (prevIdx >= 0 && items[prevIdx].itemType === 'section') prevIdx--;
        if (prevIdx < 0) return res.status(400).json({ error: 'Already at first cue' });
        const updated = await manualRundown.updateLiveState(planId, { currentCueIndex: prevIdx, currentCueStartedAt: Date.now() });
        ensureManualLiveTimer(planId);
        res.json({ ...updated, plan });
      } catch (e) {
        console.error('[rundown] live/back error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  app.post('/api/churches/:churchId/rundown-plans/:planId/live/goto/:index',
    requireChurchWriteOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      const index = parseInt(req.params.index, 10);
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        if (await ensurePlanWriteAccess(req, res, plan)) return;
        const liveState = await manualRundown.getLiveState(planId);
        if (!liveState) return res.status(400).json({ error: 'Not in live mode' });
        const items = plan.items || [];
        if (index < 0 || index >= items.length) return res.status(400).json({ error: 'Invalid cue index' });
        const updated = await manualRundown.updateLiveState(planId, { currentCueIndex: index, currentCueStartedAt: Date.now() });
        ensureManualLiveTimer(planId);
        res.json({ ...updated, plan });
      } catch (e) {
        console.error('[rundown] live/goto error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );

  app.get('/api/churches/:churchId/rundown-plans/:planId/live/state',
    requireChurchOrAdmin,
    async (req, res) => {
      const { churchId, planId } = req.params;
      if (!churches.get(churchId)) return res.status(404).json({ error: 'Church not found' });
      try {
        const plan = await manualRundown.getPlan(planId);
        if (!plan || plan.churchId !== churchId) return res.status(404).json({ error: 'Plan not found' });
        const liveState = await manualRundown.getLiveState(planId);
        if (!liveState) return res.json({ isLive: false });
        if (!manualLiveTimerIntervals.has(planId)) ensureManualLiveTimer(planId);
        res.json({ ...liveState, plan });
      } catch (e) {
        console.error('[rundown] live/state error:', e);
        res.status(500).json({ error: safeErrorMessage(e) });
      }
    }
  );
};
