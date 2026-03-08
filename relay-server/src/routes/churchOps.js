/**
 * Church operations routes: maintenance windows, on-call rotation,
 * guest tokens, events, command dispatch, church status/detail.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupChurchOpsRoutes(app, ctx) {
  const { db, churches, requireAdmin, requireFeature, stmtGet, stmtFindByName,
          onCallRotation, guestTdMode, eventMode, safeErrorMessage,
          checkCommandRateLimit, checkBillingAccessForCommand,
          safeSend, queueMessage, messageQueues, uuidv4,
          totalMessagesRelayed, QUEUE_TTL_MS, log } = ctx;
  const WebSocket = require('ws').WebSocket;

  // ─── COMMAND DISPATCH ────────────────────────────────────────────────────────

  app.post('/api/command', requireAdmin, async (req, res) => {
    const { churchId, command, params = {} } = req.body;
    if (!churchId || !command) return res.status(400).json({ error: 'churchId and command required' });

    const rateCheck = await checkCommandRateLimit(churchId);
    if (!rateCheck.ok) {
      return res.status(429).json({ error: 'Rate limit exceeded (max 10 commands/second)' });
    }

    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    const access = checkBillingAccessForCommand(churchId, command);
    if (!access.allowed) {
      return res.status(access.status).json({ error: access.error, command, device: access.device });
    }

    const msg = { type: 'command', command, params, id: uuidv4() };
    ctx.totalMessagesRelayed++;

    if (!church.ws || church.ws.readyState !== WebSocket.OPEN) {
      if (church.disconnectedAt && (Date.now() - church.disconnectedAt) < QUEUE_TTL_MS) {
        queueMessage(churchId, msg);
        log(`CMD → ${church.name}: ${command} (queued — church offline)`);
        return res.json({ sent: false, queued: true, messageId: msg.id });
      }
      return res.status(503).json({ error: 'Church client not connected' });
    }

    safeSend(church.ws, msg);
    log(`CMD → ${church.name}: ${command} ${JSON.stringify(params)}`);
    res.json({ sent: true, messageId: msg.id });
  });

  app.post('/api/broadcast', requireAdmin, (req, res) => {
    const { command, params = {} } = req.body;
    let sent = 0;
    for (const church of churches.values()) {
      if (church.ws?.readyState === WebSocket.OPEN) {
        safeSend(church.ws, { type: 'command', command, params, id: uuidv4() });
        sent++;
        ctx.totalMessagesRelayed++;
      }
    }
    res.json({ sent, total: churches.size });
  });

  // ─── CHURCH STATUS & DETAIL ──────────────────────────────────────────────────

  app.get('/api/churches/:churchId/status', requireAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    res.json({
      name: church.name,
      connected: church.ws?.readyState === WebSocket.OPEN,
      status: church.status,
      lastSeen: church.lastSeen,
    });
  });

  app.get('/api/churches/:churchId', requireAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const row = stmtGet.get(req.params.churchId);
    res.json({
      churchId: church.churchId, name: church.name,
      connected: church.ws?.readyState === 1,
      status: church.status, lastSeen: church.lastSeen,
      registrationCode: row?.registration_code || null,
      token: row?.token,
    });
  });

  // ─── MAINTENANCE WINDOWS ─────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/maintenance', requireAdmin, (req, res) => {
    const windows = db.prepare('SELECT * FROM maintenance_windows WHERE churchId = ? ORDER BY startTime ASC').all(req.params.churchId);
    res.json(windows);
  });

  app.post('/api/churches/:churchId/maintenance', requireAdmin, (req, res) => {
    const { startTime, endTime, reason } = req.body;
    if (!startTime || !endTime) return res.status(400).json({ error: 'startTime and endTime required' });
    const result = db.prepare(
      'INSERT INTO maintenance_windows (churchId, startTime, endTime, reason) VALUES (?, ?, ?, ?)'
    ).run(req.params.churchId, startTime, endTime, reason || '');
    res.json({ id: result.lastInsertRowid, churchId: req.params.churchId, startTime, endTime, reason });
  });

  app.delete('/api/maintenance/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(req.params.id);
    res.json({ deleted: true });
  });

  // ─── ON-CALL ROTATION ────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/oncall', requireAdmin, requireFeature('oncall_rotation'), (req, res) => {
    const onCall = onCallRotation.getOnCallTD(req.params.churchId);
    const all = db.prepare('SELECT * FROM td_oncall WHERE churchId = ? ORDER BY isPrimary DESC, id ASC').all(req.params.churchId);
    res.json({ onCall, all });
  });

  app.post('/api/churches/:churchId/oncall', requireAdmin, requireFeature('oncall_rotation'), (req, res) => {
    const { tdName } = req.body;
    if (!tdName) return res.status(400).json({ error: 'tdName required' });
    const result = onCallRotation.setOnCall(req.params.churchId, tdName);
    res.json(result);
  });

  app.post('/api/churches/:churchId/tds/add', requireAdmin, requireFeature('oncall_rotation'), (req, res) => {
    const { name, telegramChatId, telegramUserId, phone, isPrimary } = req.body;
    if (!name || !telegramChatId) return res.status(400).json({ error: 'name and telegramChatId required' });
    const id = onCallRotation.addOrUpdateTD({ churchId: req.params.churchId, name, telegramChatId, telegramUserId, phone, isPrimary });
    res.json({ id, name });
  });

  // ─── GUEST TOKENS ────────────────────────────────────────────────────────────

  app.post('/api/churches/:churchId/guest-token', requireAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const result = guestTdMode.generateToken(req.params.churchId, church.name);
    res.json(result);
  });

  app.delete('/api/guest-token/:token', requireAdmin, (req, res) => {
    const result = guestTdMode.revokeToken(req.params.token);
    res.json(result);
  });

  app.get('/api/guest-tokens', requireAdmin, (req, res) => {
    res.json(guestTdMode.listActiveTokens());
  });

  // ─── EVENTS ──────────────────────────────────────────────────────────────────

  app.get('/api/events', requireAdmin, (req, res) => {
    const events = db.prepare("SELECT * FROM churches WHERE church_type = 'event' ORDER BY registeredAt DESC").all();
    res.json(events.map(e => ({ ...e, timeRemaining: eventMode.getTimeRemaining(e), expired: eventMode.isEventExpired(e) })));
  });

  app.post('/api/events/create', requireAdmin, (req, res) => {
    const { name, eventLabel, durationHours = 72, tdName, tdTelegramChatId, contactEmail } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const existing = stmtFindByName.get(name);
    if (existing) return res.status(409).json({ error: `A church named "${name}" already exists` });

    try {
      const result = eventMode.createEvent({ name, eventLabel, durationHours, tdName, tdTelegramChatId, contactEmail });
      churches.set(result.churchId, {
        churchId: result.churchId, name, email: contactEmail || '', token: result.token,
        ws: null, status: { connected: false, atem: null, obs: null },
        lastSeen: null, lastHeartbeat: null, registeredAt: new Date().toISOString(),
        disconnectedAt: null, _offlineAlertSent: false,
        church_type: 'event', event_expires_at: result.expiresAt, event_label: eventLabel || name,
        reseller_id: null,
      });
      log(`Event church created: "${name}" (${result.churchId}), expires ${result.expiresAt}`);
      res.json({ churchId: result.churchId, token: result.token, expiresAt: result.expiresAt, name });
    } catch (e) {
      console.error('[/api/events/create]', e.message);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── INTERNAL ────────────────────────────────────────────────────────────────

  app.post('/api/internal/backups/snapshot', requireAdmin, (req, res) => {
    try {
      const label = String(req.body?.label || 'manual').trim().slice(0, 40) || 'manual';
      const snapshot = ctx.runManualDbSnapshot(label);
      res.status(201).json({ ok: true, snapshot });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
};
