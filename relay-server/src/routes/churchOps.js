/**
 * Church operations routes: maintenance windows, on-call rotation,
 * guest tokens, events, command dispatch, church status/detail.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupChurchOpsRoutes(app, ctx) {
  const { db, queryClient, churches, requireAdmin, requireFeature,
          onCallRotation, guestTdMode, eventMode, safeErrorMessage,
          checkCommandRateLimit, checkBillingAccessForCommand,
          safeSend, queueMessage, messageQueues, uuidv4,
          totalMessagesRelayed, QUEUE_TTL_MS, log } = ctx;
  const WebSocket = require('ws').WebSocket;
  const hasQueryClient = !!queryClient;
  const qOne = (sql, params = []) =>
    hasQueryClient ? queryClient.queryOne(sql, params) : db.prepare(sql).get(...params) || null;
  const qAll = (sql, params = []) =>
    hasQueryClient ? queryClient.query(sql, params) : db.prepare(sql).all(...params);
  const qRun = (sql, params = []) =>
    hasQueryClient ? queryClient.run(sql, params) : db.prepare(sql).run(...params);

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

    const hasOpen = church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN);
    if (!hasOpen) {
      if (church.disconnectedAt && (Date.now() - church.disconnectedAt) < QUEUE_TTL_MS) {
        queueMessage(churchId, msg);
        log(`CMD → ${church.name}: ${command} (queued — church offline)`);
        return res.json({ sent: false, queued: true, messageId: msg.id });
      }
      return res.status(503).json({ error: 'Church client not connected' });
    }

    // Send to ALL connected instances — each agent handles only its own devices
    for (const sock of church.sockets.values()) safeSend(sock, msg);
    log(`CMD → ${church.name}: ${command} ${JSON.stringify(params)}`);
    res.json({ sent: true, messageId: msg.id });
  });

  app.post('/api/broadcast', requireAdmin, (req, res) => {
    const { command, params = {} } = req.body;
    let sent = 0;
    for (const church of churches.values()) {
      if (church.sockets?.size) {
        for (const sock of church.sockets.values()) {
          if (sock.readyState === WebSocket.OPEN) {
            safeSend(sock, { type: 'command', command, params, id: uuidv4() });
          }
        }
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
      connected: !!(church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN)),
      status: church.status,
      lastSeen: church.lastSeen,
    });
  });

  app.get('/api/churches/:churchId', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const row = await qOne('SELECT * FROM churches WHERE churchId = ?', [req.params.churchId]);
    res.json({
      churchId: church.churchId, name: church.name,
      connected: !!(church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === 1)),
      status: church.status, lastSeen: church.lastSeen,
      registrationCode: row?.registration_code || null,
      token: row?.token,
    });
  });

  // ─── MAINTENANCE WINDOWS ─────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/maintenance', requireAdmin, async (req, res) => {
    const windows = await qAll(
      'SELECT * FROM maintenance_windows WHERE churchId = ? ORDER BY startTime ASC',
      [req.params.churchId],
    );
    res.json(windows);
  });

  app.post('/api/churches/:churchId/maintenance', requireAdmin, async (req, res) => {
    const { startTime, endTime, reason } = req.body;
    if (!startTime || !endTime) return res.status(400).json({ error: 'startTime and endTime required' });
    const result = await qRun(
      'INSERT INTO maintenance_windows (churchId, startTime, endTime, reason) VALUES (?, ?, ?, ?)',
      [req.params.churchId, startTime, endTime, reason || ''],
    );
    res.json({ id: result.lastInsertRowid, churchId: req.params.churchId, startTime, endTime, reason });
  });

  app.delete('/api/maintenance/:id', requireAdmin, async (req, res) => {
    await qRun('DELETE FROM maintenance_windows WHERE id = ?', [req.params.id]);
    res.json({ deleted: true });
  });

  // ─── ON-CALL ROTATION ────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/oncall', requireAdmin, requireFeature('oncall_rotation'), async (req, res) => {
    try {
      const [onCall, all] = await Promise.all([
        onCallRotation.getOnCallTD(req.params.churchId),
        onCallRotation.listTDs(req.params.churchId),
      ]);
      res.json({ onCall, all });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/churches/:churchId/oncall', requireAdmin, requireFeature('oncall_rotation'), async (req, res) => {
    const { tdName } = req.body;
    if (!tdName) return res.status(400).json({ error: 'tdName required' });
    try {
      const result = await onCallRotation.setOnCall(req.params.churchId, tdName);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/churches/:churchId/tds/add', requireAdmin, requireFeature('oncall_rotation'), async (req, res) => {
    const { name, telegramChatId, telegramUserId, phone, isPrimary } = req.body;
    if (!name || !telegramChatId) return res.status(400).json({ error: 'name and telegramChatId required' });
    try {
      const id = await onCallRotation.addOrUpdateTD({
        churchId: req.params.churchId,
        name,
        telegramChatId,
        telegramUserId,
        phone,
        isPrimary,
      });
      res.json({ id, name });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── GUEST TOKENS ────────────────────────────────────────────────────────────

  app.post('/api/churches/:churchId/guest-token', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const result = await guestTdMode.generateToken(req.params.churchId, church.name);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/guest-token/:token', requireAdmin, async (req, res) => {
    try {
      const result = await guestTdMode.revokeToken(req.params.token);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/guest-tokens', requireAdmin, async (req, res) => {
    try {
      const tokens = await guestTdMode.listActiveTokens();
      res.json(tokens);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── EVENTS ──────────────────────────────────────────────────────────────────

  app.get('/api/events', requireAdmin, async (req, res) => {
    const events = await qAll("SELECT * FROM churches WHERE church_type = 'event' ORDER BY registeredAt DESC");
    res.json(events.map(e => ({ ...e, timeRemaining: eventMode.getTimeRemaining(e), expired: eventMode.isEventExpired(e) })));
  });

  app.post('/api/events/create', requireAdmin, async (req, res) => {
    const { name, eventLabel, durationHours = 72, tdName, tdTelegramChatId, contactEmail } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const existing = await qOne('SELECT churchId FROM churches WHERE name = ?', [name]);
    if (existing) return res.status(409).json({ error: `A church named "${name}" already exists` });

    try {
      const result = await eventMode.createEvent({ name, eventLabel, durationHours, tdName, tdTelegramChatId, contactEmail });
      churches.set(result.churchId, {
        churchId: result.churchId, name, email: contactEmail || '', token: result.token,
        ws: null, status: {},
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
