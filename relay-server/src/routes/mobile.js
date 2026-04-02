/**
 * Mobile API routes — device registration, notification preferences,
 * mobile-optimized login, and dashboard summary.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupMobileRoutes(app, ctx) {
  const {
    db, churches, requireChurchAppAuth, rateLimit,
    hashPassword, verifyPassword, issueChurchAppToken, checkChurchPaidAccess,
    pushNotifications, scheduleEngine, rundownEngine,
    jwt, JWT_SECRET, CHURCH_APP_TOKEN_TTL, uuidv4, safeErrorMessage, log,
  } = ctx;

  // ─── MOBILE LOGIN ──────────────────────────────────────────────────────────
  // Returns JWT in body (not cookie) for mobile clients.
  // Includes room list and church metadata the app needs on launch.

  app.post('/api/church/mobile/login', rateLimit(5, 15 * 60 * 1000), (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }

    const church = db.prepare('SELECT * FROM churches WHERE portal_email = ?').get(cleanEmail);
    if (!church || !church.portal_password_hash || !verifyPassword(password, church.portal_password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const access = checkChurchPaidAccess(church.churchId);
    if (!access.allowed) {
      return res.status(402).json({
        error: access.message,
        billing: { status: access.status, tier: access.tier },
      });
    }

    const token = issueChurchAppToken(church.churchId, church.name);

    // Gather rooms
    let rooms = [];
    try {
      rooms = db.prepare(
        'SELECT id, name, description FROM rooms WHERE campus_id = ? AND deleted_at IS NULL ORDER BY name ASC'
      ).all(church.churchId);
    } catch { /* no rooms table yet */ }

    // Runtime connection status
    const runtime = churches.get(church.churchId);

    res.json({
      token,
      tokenType: 'Bearer',
      tokenExpiresIn: CHURCH_APP_TOKEN_TTL,
      churchId: church.churchId,
      churchName: church.name,
      email: church.portal_email,
      role: 'admin',
      billing: { status: access.status, tier: access.tier },
      rooms,
      connected: !!(runtime && _hasLiveSocket(runtime)),
      timezone: church.timezone || null,
    });
  });

  // ─── REGISTER DEVICE ──────────────────────────────────────────────────────

  app.post('/api/church/mobile/register-device', requireChurchAppAuth, (req, res) => {
    try {
      const { pushToken, platform, deviceName, appVersion } = req.body || {};
      if (!pushToken) return res.status(400).json({ error: 'pushToken required' });

      const result = pushNotifications.registerDevice({
        churchId: req.church.churchId,
        userId: null,
        deviceToken: pushToken,
        platform: platform || 'ios',
        deviceName: deviceName || null,
        appVersion: appVersion || null,
      });

      res.status(result.created ? 201 : 200).json(result);
    } catch (e) {
      log(`[Mobile] Device registration error: ${e.message}`);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── UNREGISTER DEVICE ────────────────────────────────────────────────────

  app.delete('/api/church/mobile/unregister-device', requireChurchAppAuth, (req, res) => {
    try {
      const { pushToken } = req.body || {};
      if (!pushToken) return res.status(400).json({ error: 'pushToken required' });

      const result = pushNotifications.unregisterDevice(pushToken, req.church.churchId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── NOTIFICATION PREFERENCES ─────────────────────────────────────────────

  app.get('/api/church/mobile/notification-prefs', requireChurchAppAuth, (req, res) => {
    try {
      const prefs = pushNotifications.getPrefs(req.church.churchId);
      res.json(prefs);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.put('/api/church/mobile/notification-prefs', requireChurchAppAuth, (req, res) => {
    try {
      const updated = pushNotifications.updatePrefs(req.church.churchId, null, req.body || {});
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── MOBILE DASHBOARD SUMMARY ────────────────────────────────────────────
  // Single endpoint that returns everything the mobile dashboard needs.
  // Reduces initial API calls from 5-6 down to 1.

  app.get('/api/church/mobile/summary', requireChurchAppAuth, (req, res) => {
    try {
      const churchId = req.church.churchId;
      const runtime = churches.get(churchId);

      // Rooms with connection/status info
      let rooms = [];
      try {
        const dbRooms = db.prepare(
          'SELECT id, name, description FROM rooms WHERE campus_id = ? AND deleted_at IS NULL ORDER BY name ASC'
        ).all(churchId);
        rooms = dbRooms.map(room => ({
          id: room.id,
          name: room.name,
          description: room.description,
          connected: _isRoomConnected(runtime, room.id),
          status: _getRoomStatus(runtime, room.id),
        }));
      } catch { /* no rooms */ }

      // Recent alerts (last 10)
      let recentAlerts = [];
      try {
        recentAlerts = db.prepare(
          'SELECT id, alert_type, severity, context, created_at, acknowledged_at, room_id FROM alerts WHERE church_id = ? ORDER BY created_at DESC LIMIT 10'
        ).all(churchId).map(a => ({
          id: a.id,
          alertType: a.alert_type,
          severity: a.severity,
          createdAt: a.created_at,
          acknowledgedAt: a.acknowledged_at,
          roomId: a.room_id,
        }));
      } catch { /* no alerts table */ }

      // Active session info
      let activeSession = null;
      try {
        const session = db.prepare(
          'SELECT id, started_at, grade FROM service_sessions WHERE church_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
        ).get(churchId);
        if (session) {
          const duration = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000);
          const incidentCount = db.prepare(
            'SELECT COUNT(*) as cnt FROM alerts WHERE church_id = ? AND session_id = ?'
          ).get(churchId, session.id)?.cnt || 0;
          activeSession = {
            id: session.id,
            grade: session.grade || null,
            duration,
            incidents: incidentCount,
          };
        }
      } catch { /* no sessions table */ }

      // Health score (if available)
      let healthScore = null;
      try {
        const report = db.prepare(
          'SELECT score FROM health_score_cache WHERE church_id = ? ORDER BY computed_at DESC LIMIT 1'
        ).get(churchId);
        if (report) healthScore = report.score;
      } catch { /* no health score cache */ }

      // Upcoming service (from schedule engine)
      let upcomingService = null;
      if (scheduleEngine) {
        try {
          const schedule = scheduleEngine.getSchedule(churchId);
          if (schedule) {
            const next = scheduleEngine.getNextServiceWindow(churchId);
            if (next) {
              upcomingService = {
                name: next.name || 'Service',
                startsAt: next.start,
              };
            }
          }
        } catch { /* schedule engine not available */ }
      }

      // Push device count
      const pushStats = pushNotifications.getStats(churchId);

      res.json({
        rooms,
        activeSession,
        recentAlerts,
        healthScore,
        upcomingService,
        connected: !!(runtime && _hasLiveSocket(runtime)),
        status: runtime?.status || {},
        instanceStatus: runtime?.instanceStatus || {},
        roomInstanceMap: runtime?.roomInstanceMap || {},
        pushDevices: pushStats.deviceCount,
      });
    } catch (e) {
      log(`[Mobile] Summary error: ${e.message}`);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  function _hasLiveSocket(runtime) {
    if (!runtime) return false;
    // Multi-room: check if any socket is open
    if (runtime.sockets && runtime.sockets instanceof Map) {
      for (const ws of runtime.sockets.values()) {
        if (ws?.readyState === 1) return true;
      }
      return false;
    }
    return runtime.ws?.readyState === 1;
  }

  function _isRoomConnected(runtime, roomId) {
    if (!runtime) return false;
    if (runtime.roomInstanceMap) {
      for (const [rid, instance] of Object.entries(runtime.roomInstanceMap)) {
        if (rid === roomId && runtime.sockets?.get(instance)?.readyState === 1) return true;
      }
    }
    return false;
  }

  function _getRoomStatus(runtime, roomId) {
    if (!runtime?.instanceStatus) return {};
    // Use roomInstanceMap to find the correct instance for this room
    const instanceName = runtime.roomInstanceMap?.[roomId];
    if (instanceName && runtime.instanceStatus[instanceName]) {
      return runtime.instanceStatus[instanceName];
    }
    return {};
  }
};
