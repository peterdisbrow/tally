/**
 * Session recap, timeline, debrief, monthly report, schedule, alerts, and digest routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupSessionRoutes(app, ctx) {
  const { db, queryClient, churches, requireAdmin, requireFeature,
          scheduleEngine, alertEngine, weeklyDigest, sessionRecap, signalFailover,
          monthlyReport, safeErrorMessage, logAiUsage, isOnTopic,
          OFF_TOPIC_RESPONSE, rateLimit, log } = ctx;
  const hasQueryClient = queryClient && typeof queryClient.queryOne === 'function';
  const qOne = (sql, params = []) => (
    hasQueryClient ? queryClient.queryOne(sql, params) : db.prepare(sql).get(...params) || null
  );
  const qAll = (sql, params = []) => (
    hasQueryClient ? queryClient.query(sql, params) : db.prepare(sql).all(...params)
  );
  const qRun = (sql, params = []) => (
    hasQueryClient ? queryClient.run(sql, params) : db.prepare(sql).run(...params)
  );

  // ─── SCHEDULE ────────────────────────────────────────────────────────────────

  app.put('/api/churches/:churchId/schedule', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const { serviceTimes } = req.body;
    if (!Array.isArray(serviceTimes)) return res.status(400).json({ error: 'serviceTimes array required' });
    try {
      await scheduleEngine.setSchedule(req.params.churchId, serviceTimes);
      res.json({ saved: true, serviceTimes });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/churches/:churchId/schedule', requireAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const schedule = scheduleEngine.getSchedule(req.params.churchId);
    const inWindow = scheduleEngine.isServiceWindow(req.params.churchId);
    const next = scheduleEngine.getNextService(req.params.churchId);
    res.json({ schedule, inServiceWindow: inWindow, nextService: next });
  });

  app.put('/api/churches/:churchId/td-contact', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const { tdChatId, tdName, alertBotToken } = req.body;
      if (tdChatId) await qRun('UPDATE churches SET td_telegram_chat_id = ? WHERE churchId = ?', [tdChatId, req.params.churchId]);
      if (tdName) await qRun('UPDATE churches SET td_name = ? WHERE churchId = ?', [tdName, req.params.churchId]);
      if (alertBotToken) await qRun('UPDATE churches SET alert_bot_token = ? WHERE churchId = ?', [alertBotToken, req.params.churchId]);
      const row = await qOne('SELECT * FROM churches WHERE churchId = ?', [req.params.churchId]);
      if (row) { church.td_telegram_chat_id = row.td_telegram_chat_id; church.td_name = row.td_name; church.alert_bot_token = row.alert_bot_token; }
      if (signalFailover?.refreshChurchConfig) {
        await signalFailover.refreshChurchConfig(req.params.churchId);
      }
      res.json({ saved: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── ALERTS & DIGEST ─────────────────────────────────────────────────────────

  app.post('/api/alerts/:alertId/acknowledge', requireAdmin, async (req, res) => {
    const { responder } = req.body;
    try {
      const result = await alertEngine.acknowledgeAlert(req.params.alertId, responder || 'admin');
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/digest/latest', requireAdmin, (req, res) => {
    const latest = weeklyDigest.getLatestDigest();
    if (!latest) return res.status(404).json({ error: 'No digest yet' });
    res.json(latest);
  });

  app.get('/api/digest/generate', requireAdmin, async (req, res) => {
    try {
      const result = await weeklyDigest.saveDigest();
      res.json({ generated: true, filePath: result.filePath });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── AI CHAT (Dashboard panel) ───────────────────────────────────────────────

  app.post('/api/chat', requireAdmin, rateLimit(30, 60_000), async (req, res) => {
    const { message, churchStates, history = [] } = req.body || {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message (string) required' });

    if (!isOnTopic(message)) {
      return res.json({ reply: OFF_TOPIC_RESPONSE });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });

    const { buildAdminPrompt } = require('../tally-engineer');
    const systemPrompt = buildAdminPrompt() + '\n\nChurch states: ' + JSON.stringify(churchStates || {});

    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          system: systemPrompt,
          messages: [
            ...(Array.isArray(history) ? history : []).filter(
              (m) => m?.role && ['user', 'assistant'].includes(m.role) && m.content
            ).slice(-20),
            { role: 'user', content: message },
          ],
          temperature: 0.5,
          max_tokens: 1200,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!aiRes.ok) {
        const errBody = await aiRes.text();
        throw new Error(`Anthropic ${aiRes.status}: ${errBody.slice(0, 100)}`);
      }

      const data = await aiRes.json();
      const reply = data?.content?.[0]?.text || 'No response.';

      if (data?.usage) {
        logAiUsage({
          churchId: null,
          feature: 'dashboard_chat',
          model: 'claude-haiku-4-5-20251001',
          inputTokens: data.usage.input_tokens || 0,
          outputTokens: data.usage.output_tokens || 0,
        });
      }

      res.json({ reply });
    } catch (err) {
      console.error(`[Dashboard Chat] Error: ${err.message}`);
      res.status(503).json({ error: safeErrorMessage(err, 'AI unavailable') });
    }
  });

  // ─── MONTHLY REPORT ──────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/report', requireAdmin, requireFeature('monthly_report'), async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const report = await monthlyReport.generateReport(req.params.churchId, req.query.month);
      const text = monthlyReport.formatReport(report);
      res.json({ ...report, formatted: text });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── SESSION RECAP ───────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/sessions', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const sessions = await qAll(
      'SELECT * FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
      [req.params.churchId, limit, offset],
    );
    const total = await qOne('SELECT COUNT(*) as count FROM service_sessions WHERE church_id = ?', [req.params.churchId]);
    res.json({ sessions, total: total?.count || 0, limit, offset });
  });

  app.get('/api/churches/:churchId/sessions/current', requireAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const active = sessionRecap.getActiveSession(req.params.churchId);
    if (!active) return res.json({ active: false });
    res.json({ active: true, ...active });
  });

  app.get('/api/churches/:churchId/sessions/:sessionId/timeline', requireAdmin, async (req, res) => {
    const { churchId, sessionId } = req.params;
    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    const session = await qOne('SELECT * FROM service_sessions WHERE id = ? AND church_id = ?', [sessionId, churchId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const TIMELINE_LIMIT = 500; // per-table hard cap to protect in-memory sort
    const events = await qAll(
      'SELECT *, \'event\' as _type FROM service_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?',
      [sessionId, TIMELINE_LIMIT],
    );
    const alerts = await qAll(
      'SELECT *, \'alert\' as _type FROM alerts WHERE session_id = ? AND church_id = ? ORDER BY created_at ASC LIMIT ?',
      [sessionId, churchId, TIMELINE_LIMIT],
    );
    const chatMsgs = await qAll(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?',
      [sessionId, TIMELINE_LIMIT],
    );

    const timeline = [
      { _type: 'marker', timestamp: session.started_at, label: 'Session Started', severity: 'INFO', td_name: session.td_name },
      ...events.map(e => ({
        _type: 'event', id: e.id, timestamp: e.timestamp, event_type: e.event_type,
        details: e.details, resolved: !!e.resolved, auto_resolved: !!e.auto_resolved, resolved_at: e.resolved_at,
      })),
      ...alerts.map(a => ({
        _type: 'alert', id: a.id, timestamp: a.created_at, alert_type: a.alert_type,
        severity: a.severity, context: (() => { try { return JSON.parse(a.context); } catch { return {}; } })(),
        acknowledged_at: a.acknowledged_at, acknowledged_by: a.acknowledged_by,
        escalated: !!a.escalated, resolved: !!a.resolved,
      })),
      ...chatMsgs.map(c => ({
        _type: 'chat', id: c.id, timestamp: c.timestamp,
        sender_name: c.sender_name, sender_role: c.sender_role, source: c.source, message: c.message,
      })),
      ...(session.ended_at ? [{
        _type: 'marker', timestamp: session.ended_at, label: 'Session Ended', severity: 'INFO',
        grade: session.grade, duration_minutes: session.duration_minutes,
      }] : []),
    ];

    timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ session, timeline });
  });

  // ─── SESSION TYPE OVERRIDE ───────────────────────────────────────────────────

  app.put('/api/churches/:churchId/sessions/:sessionId/type', requireAdmin, async (req, res) => {
    const { churchId, sessionId } = req.params;
    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    const { type } = req.body;
    if (type !== 'service' && type !== 'test') {
      return res.status(400).json({ error: 'type must be "service" or "test"' });
    }

    const session = await qOne('SELECT * FROM service_sessions WHERE id = ? AND church_id = ?', [sessionId, churchId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    await qRun('UPDATE service_sessions SET session_type = ? WHERE id = ?', [type, sessionId]);
    res.json({ updated: true, session_type: type });
  });

  app.get('/api/churches/:churchId/sessions/:sessionId/debrief', requireAdmin, async (req, res) => {
    const { churchId, sessionId } = req.params;
    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    const session = await qOne('SELECT * FROM service_sessions WHERE id = ? AND church_id = ?', [sessionId, churchId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const DEBRIEF_LIMIT = 500;
    const events = await qAll('SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?', [sessionId, DEBRIEF_LIMIT]);
    const alerts = await qAll('SELECT * FROM alerts WHERE session_id = ? AND church_id = ? ORDER BY created_at ASC LIMIT ?', [sessionId, churchId, DEBRIEF_LIMIT]);
    const chatMsgs = await qAll('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?', [sessionId, DEBRIEF_LIMIT]);

    const startTime = new Date(session.started_at);
    const endTime = session.ended_at ? new Date(session.ended_at) : null;
    const gradeIcon = session.grade === 'Clean' ? '\u{1F7E2}' : session.grade === 'Minor issues' ? '\u{1F7E1}' : '\u{1F534}';

    const lines = [
      `SERVICE DEBRIEF — ${church.name}`,
      `${'─'.repeat(40)}`,
      `Date: ${startTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
      `Time: ${startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${endTime ? ' – ' + endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ' (in progress)'}`,
      `Duration: ${session.duration_minutes ? session.duration_minutes + ' min' : 'In progress'}`,
      `TD: ${session.td_name || 'Unknown'}`,
      `Grade: ${gradeIcon} ${session.grade || 'N/A'}`,
      '',
      `STATS`,
      `${'─'.repeat(20)}`,
      `Alerts: ${session.alert_count || 0}`,
      `Auto-recovered: ${session.auto_recovered_count || 0}`,
      `Escalated: ${session.escalated_count || 0}`,
      `Audio silences: ${session.audio_silence_count || 0}`,
      `Stream ran: ${session.stream_ran ? 'Yes' : 'No'}${session.stream_runtime_minutes ? ' (' + session.stream_runtime_minutes + ' min)' : ''}`,
      `Recording: ${session.recording_confirmed ? 'Confirmed' : 'Not confirmed'}`,
      `Peak viewers: ${session.peak_viewers || 'N/A'}`,
      `Chat messages: ${chatMsgs.length}`,
    ];

    if (events.length > 0 || alerts.length > 0 || chatMsgs.length > 0) {
      lines.push('', `ACTIVITY LOG`, `${'─'.repeat(20)}`);
      const merged = [
        ...events.map(e => ({ time: e.timestamp, text: `[EVENT] ${e.event_type}${e.auto_resolved ? ' (auto-resolved)' : e.resolved ? ' (resolved)' : ''}${e.details ? ': ' + e.details.substring(0, 80) : ''}` })),
        ...alerts.map(a => ({ time: a.created_at, text: `[${a.severity}] ${a.alert_type}${a.acknowledged_at ? ' (ack by ' + (a.acknowledged_by || '?') + ')' : ''}${a.escalated ? ' ESCALATED' : ''}` })),
        ...chatMsgs.map(c => ({ time: c.timestamp, text: `[CHAT] ${c.sender_name} (${c.source}): ${c.message.substring(0, 80)}` })),
      ].sort((a, b) => new Date(a.time) - new Date(b.time));
      for (const item of merged) {
        const t = new Date(item.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        lines.push(`  ${t}  ${item.text}`);
      }
    } else {
      lines.push('', 'No activity recorded during this session.');
    }

    lines.push('', `— Generated by Tally • ${new Date().toLocaleDateString()}`);
    res.json({ debrief: lines.join('\n'), session });
  });
};
