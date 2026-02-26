'use strict';

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { WebSocket } = require('ws');
const { isStreamActive, isRecordingActive } = require('../status-utils');

const supportCategories = new Set([
  'stream_down',
  'no_audio_stream',
  'slides_issue',
  'atem_connectivity',
  'recording_issue',
  'other',
]);
const supportSeverities = new Set(['P1', 'P2', 'P3', 'P4']);
const supportTicketStates = new Set(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed']);

function normalizeSupportCategory(value) {
  const normalized = String(value || 'other').trim().toLowerCase().replace(/\s+/g, '_');
  return supportCategories.has(normalized) ? normalized : 'other';
}

function normalizeSupportSeverity(value) {
  const normalized = String(value || 'P3').trim().toUpperCase();
  return supportSeverities.has(normalized) ? normalized : 'P3';
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Support ticket route handlers.
 *
 * @param {import('express').Express} app
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Map} ctx.churches
 * @param {Function} ctx.requireAdminJwt
 * @param {Object} ctx.stmtGet - prepared statement: SELECT * FROM churches WHERE churchId = ?
 * @param {Object} ctx.scheduleEngine
 * @param {string} ctx.JWT_SECRET
 * @param {string} ctx.RELAY_VERSION
 * @param {number} ctx.SUPPORT_TRIAGE_WINDOW_HOURS
 * @param {Function} ctx.rateLimit
 */
module.exports = function setupSupportTicketRoutes(app, ctx) {
  const {
    db, churches, requireAdminJwt, stmtGet, scheduleEngine,
    JWT_SECRET, RELAY_VERSION, SUPPORT_TRIAGE_WINDOW_HOURS, rateLimit,
  } = ctx;

  function buildSupportDiagnostics(churchId, options = {}) {
    const runtime = churches.get(churchId);
    const now = Date.now();
    const sinceIso = new Date(now - 15 * 60 * 1000).toISOString();
    const recentAlerts = db.prepare(`
      SELECT id, alert_type, severity, context, created_at, acknowledged_at, resolved
      FROM alerts
      WHERE church_id = ? AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 25
    `).all(churchId, sinceIso).map((row) => ({
      id: row.id,
      alertType: row.alert_type,
      severity: row.severity,
      context: safeJsonParse(row.context, {}),
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      resolved: !!row.resolved,
    }));

    return {
      churchId,
      campusId: options.campusId || null,
      room: options.room || null,
      timezone: options.timezone || null,
      issueCategory: normalizeSupportCategory(options.issueCategory),
      severity: normalizeSupportSeverity(options.severity),
      relayVersion: RELAY_VERSION,
      appVersion: options.appVersion || null,
      generatedAt: new Date().toISOString(),
      connection: {
        churchClientConnected: runtime?.ws?.readyState === WebSocket.OPEN,
        lastSeen: runtime?.lastSeen || null,
        lastHeartbeat: runtime?.lastHeartbeat || null,
        secondsSinceHeartbeat: runtime?.lastHeartbeat ? Math.floor((now - runtime.lastHeartbeat) / 1000) : null,
      },
      deviceHealth: runtime?.status || {},
      recentAlerts,
      serviceWindow: scheduleEngine.isServiceWindow(churchId),
      autoFixAttempts: Array.isArray(options.autoFixAttempts) ? options.autoFixAttempts : [],
    };
  }

  function computeTriageResult(diagnostics) {
    const checks = [];
    const issueCategory = diagnostics.issueCategory;
    const status = diagnostics.deviceHealth || {};

    checks.push({
      key: 'church_client_connection',
      ok: !!diagnostics.connection.churchClientConnected,
      note: diagnostics.connection.churchClientConnected
        ? 'Church client currently connected'
        : 'Church client is offline',
    });

    if (issueCategory === 'stream_down') {
      const streaming = isStreamActive(status);
      checks.push({
        key: 'stream_state',
        ok: streaming,
        note: streaming ? 'Stream appears active' : 'Stream appears inactive',
      });
    }

    if (issueCategory === 'no_audio_stream') {
      const audioOk = status.obs?.audioConnected !== false
        && status.mixer?.mainMuted !== true
        && status.audio?.silenceDetected !== true;
      checks.push({
        key: 'audio_path',
        ok: audioOk,
        note: audioOk ? 'No hard audio mute detected' : 'Audio path likely muted/disconnected',
      });
    }

    if (issueCategory === 'atem_connectivity') {
      checks.push({
        key: 'atem_link',
        ok: status.atem?.connected === true,
        note: status.atem?.connected ? 'ATEM reports connected' : 'ATEM disconnected',
      });
    }

    if (issueCategory === 'recording_issue') {
      const recording = isRecordingActive(status);
      checks.push({
        key: 'recording_state',
        ok: recording,
        note: recording ? 'Recording appears active' : 'Recording appears inactive',
      });
    }

    const autoFixed = (diagnostics.autoFixAttempts || []).some((attempt) => attempt && attempt.success === true);
    const failedChecks = checks.filter((check) => !check.ok).length;
    const triageResult = autoFixed
      ? 'auto_resolved'
      : failedChecks > 0
        ? 'needs_escalation'
        : 'monitoring';

    return { checks, triageResult };
  }

  function requireSupportAccess(req, res, next) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
        if (payload.type === 'church_app') {
          const church = db.prepare('SELECT churchId, name FROM churches WHERE churchId = ?').get(payload.churchId);
          if (!church) return res.status(404).json({ error: 'Church not found' });
          req.supportActor = { type: 'church', churchId: church.churchId, name: church.name };
          return next();
        }
      } catch {
        // Continue to admin auth fallback
      }
    }

    return requireAdminJwt()(req, res, () => {
      req.supportActor = {
        type: 'admin',
        adminUser: req.adminUser || { id: 'unknown', role: 'super_admin' },
      };
      next();
    });
  }

  function resolveSupportChurchId(req) {
    if (req.supportActor?.type === 'church') {
      return req.supportActor.churchId;
    }
    return req.params.churchId || req.body?.churchId || req.query?.churchId || null;
  }

  // ─── SUPPORT TRIAGE + TICKETS ────────────────────────────────────────────────

  app.post('/api/support/triage', requireSupportAccess, (req, res) => {
    const churchId = resolveSupportChurchId(req);
    if (!churchId) {
      return res.status(400).json({ error: 'churchId required' });
    }
    const church = stmtGet.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    const issueCategory = normalizeSupportCategory(req.body?.issueCategory);
    const severity = normalizeSupportSeverity(req.body?.severity);
    const summary = String(req.body?.summary || req.body?.description || '').trim().slice(0, 2000);
    const actor = req.supportActor?.type === 'church'
      ? `church:${churchId}`
      : `admin:${req.supportActor?.adminUser?.id || 'unknown'}`;
    const diagnostics = buildSupportDiagnostics(churchId, {
      issueCategory,
      severity,
      timezone: req.body?.timezone,
      appVersion: req.body?.appVersion,
      autoFixAttempts: req.body?.autoFixAttempts,
      campusId: req.body?.campusId,
      room: req.body?.room,
    });
    const triage = computeTriageResult(diagnostics);
    diagnostics.checks = triage.checks;

    const triageId = uuidv4();
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO support_triage_runs (
        id, church_id, issue_category, severity, summary, triage_result,
        diagnostics_json, autofix_attempts_json, timezone, app_version, created_by, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      triageId,
      churchId,
      issueCategory,
      severity,
      summary,
      triage.triageResult,
      JSON.stringify(diagnostics),
      JSON.stringify(diagnostics.autoFixAttempts || []),
      diagnostics.timezone || null,
      diagnostics.appVersion || null,
      actor,
      createdAt
    );

    res.status(201).json({
      triageId,
      churchId,
      triageResult: triage.triageResult,
      checks: triage.checks,
      diagnostics,
      createdAt,
    });
  });

  app.post('/api/support/tickets', requireSupportAccess, rateLimit(5, 60_000), (req, res) => {
    const churchId = resolveSupportChurchId(req);
    if (!churchId) return res.status(400).json({ error: 'churchId required' });

    const church = stmtGet.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    let severity = normalizeSupportSeverity(req.body?.severity);
    let issueCategory = normalizeSupportCategory(req.body?.issueCategory);
    const triageId = String(req.body?.triageId || '').trim() || null;
    const forceBypass = req.body?.forceBypass === true;

    if (!triageId && !(forceBypass && severity === 'P1')) {
      return res.status(400).json({ error: 'triageId required unless forceBypass=true with P1 severity' });
    }
    if (forceBypass && severity !== 'P1') {
      return res.status(400).json({ error: 'forceBypass is only allowed for P1 tickets' });
    }

    let triageRow = null;
    if (triageId) {
      triageRow = db.prepare('SELECT * FROM support_triage_runs WHERE id = ? AND church_id = ?').get(triageId, churchId);
      if (!triageRow) return res.status(404).json({ error: 'triageId not found for church' });
      const triageAgeMs = Date.now() - new Date(triageRow.created_at).getTime();
      if (triageAgeMs > SUPPORT_TRIAGE_WINDOW_HOURS * 60 * 60 * 1000) {
        return res.status(400).json({ error: `triageId is older than ${SUPPORT_TRIAGE_WINDOW_HOURS} hours; rerun triage first` });
      }
      if (!req.body?.severity) severity = normalizeSupportSeverity(triageRow.severity);
      if (!req.body?.issueCategory) issueCategory = normalizeSupportCategory(triageRow.issue_category);
    }

    const title = String(req.body?.title || triageRow?.summary || issueCategory.replace(/_/g, ' ')).trim().slice(0, 160);
    if (!title) return res.status(400).json({ error: 'title required' });
    const description = String(req.body?.description || '').trim().slice(0, 4000);
    const actor = req.supportActor?.type === 'church'
      ? `church:${churchId}`
      : `admin:${req.supportActor?.adminUser?.id || 'unknown'}`;
    const nowIso = new Date().toISOString();
    const ticketId = uuidv4();
    const diagnostics = triageRow
      ? safeJsonParse(triageRow.diagnostics_json, {})
      : buildSupportDiagnostics(churchId, { issueCategory, severity });

    db.prepare(`
      INSERT INTO support_tickets (
        id, church_id, triage_id, issue_category, severity, title, description,
        status, forced_bypass, diagnostics_json, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ticketId,
      churchId,
      triageId,
      issueCategory,
      severity,
      title,
      description,
      'open',
      forceBypass ? 1 : 0,
      JSON.stringify(diagnostics),
      actor,
      nowIso,
      nowIso
    );

    db.prepare(`
      INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      ticketId,
      description || 'Ticket opened',
      req.supportActor?.type === 'church' ? 'church' : 'admin',
      req.supportActor?.type === 'church' ? churchId : (req.supportActor?.adminUser?.id || ''),
      nowIso
    );

    res.status(201).json({
      ticketId,
      churchId,
      triageId,
      status: 'open',
      severity,
      issueCategory,
      title,
      forceBypass,
      createdAt: nowIso,
    });
  });

  app.get('/api/support/tickets', requireSupportAccess, (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200));
    const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;

    if (status && !supportTicketStates.has(status)) {
      return res.status(400).json({ error: 'invalid status filter' });
    }

    if (req.supportActor?.type === 'church') {
      const churchId = req.supportActor.churchId;
      const rows = status
        ? db.prepare(`
            SELECT * FROM support_tickets
            WHERE church_id = ? AND status = ?
            ORDER BY datetime(updated_at) DESC
            LIMIT ?
          `).all(churchId, status, limit)
        : db.prepare(`
            SELECT * FROM support_tickets
            WHERE church_id = ?
            ORDER BY datetime(updated_at) DESC
            LIMIT ?
          `).all(churchId, limit);

      return res.json(rows.map((row) => ({
        ...row,
        forcedBypass: !!row.forced_bypass,
        diagnostics: safeJsonParse(row.diagnostics_json, {}),
      })));
    }

    const churchId = String(req.query.churchId || '').trim() || null;
    let query = 'SELECT * FROM support_tickets WHERE 1 = 1';
    const params = [];
    if (churchId) {
      query += ' AND church_id = ?';
      params.push(churchId);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY datetime(updated_at) DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(query).all(...params);
    return res.json(rows.map((row) => ({
      ...row,
      forcedBypass: !!row.forced_bypass,
      diagnostics: safeJsonParse(row.diagnostics_json, {}),
    })));
  });

  app.get('/api/support/tickets/:ticketId', requireSupportAccess, (req, res) => {
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    if (req.supportActor?.type === 'church' && ticket.church_id !== req.supportActor.churchId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const updates = db.prepare(`
      SELECT id, message, actor_type, actor_id, created_at
      FROM support_ticket_updates
      WHERE ticket_id = ?
      ORDER BY created_at ASC
    `).all(ticket.id);

    res.json({
      ...ticket,
      forcedBypass: !!ticket.forced_bypass,
      diagnostics: safeJsonParse(ticket.diagnostics_json, {}),
      updates,
    });
  });

  app.post('/api/support/tickets/:ticketId/updates', requireSupportAccess, (req, res) => {
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (req.supportActor?.type === 'church' && ticket.church_id !== req.supportActor.churchId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message required' });
    const nowIso = new Date().toISOString();

    const requestedStatus = req.body?.status ? String(req.body.status).trim().toLowerCase() : null;
    let nextStatus = ticket.status;
    if (requestedStatus) {
      if (!supportTicketStates.has(requestedStatus)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      if (req.supportActor?.type === 'church' && !['waiting_customer', 'closed'].includes(requestedStatus)) {
        return res.status(403).json({ error: 'church users can only set waiting_customer or closed' });
      }
      nextStatus = requestedStatus;
    }

    db.prepare(`
      INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      ticket.id,
      message.slice(0, 4000),
      req.supportActor?.type === 'church' ? 'church' : 'admin',
      req.supportActor?.type === 'church' ? req.supportActor.churchId : (req.supportActor?.adminUser?.id || ''),
      nowIso
    );

    db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, nowIso, ticket.id);
    res.json({ ok: true, ticketId: ticket.id, status: nextStatus, updatedAt: nowIso });
  });

  app.put('/api/support/tickets/:ticketId', requireSupportAccess, (req, res) => {
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    if (req.supportActor?.type === 'church') {
      if (ticket.church_id !== req.supportActor.churchId) return res.status(403).json({ error: 'forbidden' });
      return res.status(403).json({ error: 'church users cannot edit ticket metadata' });
    }

    const patch = {};
    if (req.body?.status !== undefined) {
      const status = String(req.body.status).trim().toLowerCase();
      if (!supportTicketStates.has(status)) return res.status(400).json({ error: 'invalid status' });
      patch.status = status;
    }
    if (req.body?.severity !== undefined) patch.severity = normalizeSupportSeverity(req.body.severity);
    if (req.body?.title !== undefined) patch.title = String(req.body.title).trim().slice(0, 160);
    if (req.body?.description !== undefined) patch.description = String(req.body.description).trim().slice(0, 4000);

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no changes supplied' });

    patch.updated_at = new Date().toISOString();
    const columns = Object.keys(patch);
    const sets = columns.map((key) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE support_tickets SET ${sets} WHERE id = ?`).run(...columns.map((key) => patch[key]), ticket.id);

    res.json({ ok: true, ticketId: ticket.id, ...patch });
  });
};

// Export constants/helpers so they remain available to server.js if needed
module.exports.supportCategories = supportCategories;
module.exports.supportSeverities = supportSeverities;
module.exports.supportTicketStates = supportTicketStates;
module.exports.normalizeSupportCategory = normalizeSupportCategory;
module.exports.normalizeSupportSeverity = normalizeSupportSeverity;
module.exports.safeJsonParse = safeJsonParse;
