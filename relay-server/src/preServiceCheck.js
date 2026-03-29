/**
 * Pre-Service Auto-Check
 * Every 5 min, check if any church has a service starting in 25–35 min
 * and hasn't been pre-checked yet. Sends system.preServiceCheck to the
 * church client and notifies the TD via Telegram with results.
 */

class PreServiceCheck {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {object} opts.scheduleEngine - ScheduleEngine instance
   * @param {Map} opts.churches - in-memory church runtime map from server.js
   * @param {string} [opts.defaultBotToken] - Telegram bot token for sending alerts
   * @param {string} [opts.andrewChatId] - Andrew's Telegram chat ID
   * @param {object} [opts.sessionRecap] - SessionRecap instance for session ID linking
   */
  constructor({ db, scheduleEngine, churches, defaultBotToken, andrewChatId, sessionRecap, versionConfig } = {}) {
    this.lastPreServiceCheckAt = new Map(); // churchId → timestamp (ms)
    this._timer = null;
    this.db = db || null;
    this.scheduleEngine = scheduleEngine || null;
    this.churches = churches || null;
    this.sessionRecap = sessionRecap || null;
    this.versionConfig = versionConfig || null;
    this.tallyBot = null;
    this.sendCommand = null;
    this.defaultBotToken = defaultBotToken || process.env.ALERT_BOT_TOKEN;
    this.andrewChatId = andrewChatId || process.env.ANDREW_TELEGRAM_CHAT_ID;
    this._resultListeners = [];
    this._ensureTable();
    // Restore last-check timestamps from DB so relay restarts don't re-fire
    // checks that already ran within the dedup window.
    this._restoreLastCheckTimes();
  }

  /**
   * Populate lastPreServiceCheckAt from the most recent DB row per church.
   * Called once at startup so in-memory state survives relay restarts.
   */
  _restoreLastCheckTimes() {
    if (!this.db) return;
    try {
      const rows = this.db.prepare(`
        SELECT church_id, MAX(created_at) AS last_at
        FROM preservice_check_results
        GROUP BY church_id
      `).all();
      for (const row of rows) {
        if (row.last_at) {
          const ts = new Date(row.last_at).getTime();
          if (!isNaN(ts)) this.lastPreServiceCheckAt.set(row.church_id, ts);
        }
      }
      if (rows.length > 0) {
        console.log(`[PreServiceCheck] Restored last-check times for ${rows.length} church(es) from DB`);
      }
    } catch (e) {
      // Table may not exist yet on first boot — non-fatal
      console.warn('[PreServiceCheck] Could not restore last-check times:', e.message);
    }
  }

  _ensureTable() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preservice_check_results (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        session_id TEXT,
        pass INTEGER DEFAULT 0,
        checks_json TEXT DEFAULT '[]',
        trigger_type TEXT DEFAULT 'auto',
        created_at TEXT NOT NULL
      )
    `);
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_preservice_church ON preservice_check_results(church_id, created_at DESC)');
    } catch { /* already exists */ }
    // Migration: add instance_name for room-based filtering
    try { this.db.prepare('SELECT instance_name FROM preservice_check_results LIMIT 1').get(); }
    catch { try { this.db.exec('ALTER TABLE preservice_check_results ADD COLUMN instance_name TEXT'); } catch { /* already exists */ } }
  }

  /**
   * Get the latest pre-service check result for a church.
   * @param {string} churchId
   * @returns {object|null}
   */
  getLatestResult(churchId) {
    try {
      const row = this.db.prepare(
        'SELECT * FROM preservice_check_results WHERE church_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(churchId);
      if (!row) return null;
      return { ...row, checks: JSON.parse(row.checks_json || '[]') };
    } catch { return null; }
  }

  /**
   * Start the pre-service check timer.
   * Also runs an immediate startup sweep so checks missed during a relay
   * restart (e.g., relay crashed right in the 25–35 min window) fire
   * without waiting up to 5 minutes for the first tick.
   */
  start() {
    this._timer = setInterval(() => this._tick(), 5 * 60 * 1000);
    console.log('[PreServiceCheck] Started — polling every 5 min');
    // Startup sweep: run immediately so a restart inside the service window
    // doesn't silently skip the pre-service check.
    setImmediate(() => this._tick().catch(e =>
      console.error('[PreServiceCheck] Startup sweep error:', e.message)
    ));
  }

  /** Call from server.js when a command_result is broadcast */
  onCommandResult(msg) {
    for (const handler of this._resultListeners) handler(msg);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // ─── INTERNALS ────────────────────────────────────────────────────────────

  _getSchedule(churchId) {
    try {
      const row = this.db.prepare('SELECT service_times FROM churches WHERE churchId = ?').get(churchId);
      if (!row || !row.service_times) return [];
      return JSON.parse(row.service_times);
    } catch { return []; }
  }

  /** Returns { startHour, startMin } if service starts in 25–35 min, else null */
  _serviceStartingIn25to35(schedule) {
    const now = new Date();
    const day = now.getDay();
    const minutesNow = now.getHours() * 60 + now.getMinutes();

    for (const s of schedule) {
      if (s.day !== day) continue;
      const startMin = s.startHour * 60 + (s.startMin || 0);
      const minutesUntil = startMin - minutesNow;
      if (minutesUntil >= 25 && minutesUntil <= 35) {
        return { startHour: s.startHour, startMin: s.startMin || 0 };
      }
    }
    return null;
  }

  async _tick() {
    try {
      const allChurches = this.db.prepare('SELECT * FROM churches').all();
      for (const church of allChurches) {
        await this._checkChurch(church).catch(e =>
          console.error(`[PreServiceCheck] Error for ${church.name}:`, e.message)
        );
      }
    } catch (e) {
      console.error('[PreServiceCheck] Tick error:', e.message);
    }
  }

  async _checkChurch(church) {
    const schedule = this._getSchedule(church.churchId);
    const upcoming = this._serviceStartingIn25to35(schedule);
    if (!upcoming) return;

    // Deduplicate — skip if we've already run a check in the past 2 hours
    const lastCheck = this.lastPreServiceCheckAt.get(church.churchId);
    if (lastCheck && (Date.now() - lastCheck) < 2 * 60 * 60 * 1000) return;
    this.lastPreServiceCheckAt.set(church.churchId, Date.now());

    // Build human-readable service time string
    const dummy = new Date();
    dummy.setHours(upcoming.startHour, upcoming.startMin, 0, 0);
    const timeDisplay = dummy.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    console.log(`[PreServiceCheck] ${church.name} — service at ${timeDisplay}, sending check`);

    // Send command to church client via WS and await result
    let result = null;
    let failReason = 'offline'; // 'offline' | 'timeout' | 'error'
    const churchRuntime = this.churches?.get(church.churchId);
    try {
      if (churchRuntime?.ws?.readyState === 1) {
        const crypto = require('crypto');
        const msgId = crypto.randomUUID();
        const resultPromise = new Promise((resolve) => {
          const timer = setTimeout(() => { cleanup(); resolve({ _timeout: true }); }, 10000);
          const handler = (msg) => {
            if (msg.type === 'command_result' && msg.churchId === church.churchId && msg.messageId === msgId) {
              cleanup();
              resolve(msg.error ? { _error: msg.error } : msg.result);
            }
          };
          const cleanup = () => {
            clearTimeout(timer);
            const idx = this._resultListeners.indexOf(handler);
            if (idx !== -1) this._resultListeners.splice(idx, 1);
          };
          this._resultListeners.push(handler);
        });
        churchRuntime.ws.send(JSON.stringify({ type: 'command', command: 'system.preServiceCheck', params: {}, id: msgId }));
        const raw = await resultPromise;
        if (raw?._timeout) { failReason = 'timeout'; }
        else if (raw?._error) { failReason = 'error'; }
        else { result = raw; }
      }
    } catch (e) {
      failReason = 'error';
      console.error(`[PreServiceCheck] sendCommand error for ${church.name}:`, e.message);
    }

    // Enrich with server-side device version checks
    if (result && this.versionConfig && churchRuntime) {
      result.checks = this._enrichWithVersionChecks(result.checks || [], churchRuntime.status);
      result.pass = result.pass && !result.checks.some(c => !c.pass);
    }

    // Persist result to DB for portal display
    this._persistResult(church.churchId, result, 'auto');

    // Send via Telegram — use tallyBot if available, or raw API
    const botToken = this.defaultBotToken;
    if (!botToken) return;

    // Find TD chat IDs for this church
    let tds = [];
    try {
      tds = this.db.prepare(
        'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1'
      ).all(church.churchId);
    } catch { /* table may not exist yet */ }

    const chatIds = tds.map(td => td.telegram_chat_id).filter(Boolean);
    if (!chatIds.length) return;

    // Format notification with clear reason
    let msg;
    if (!result) {
      const reasonText = failReason === 'timeout'
        ? 'Tally app is connected but took too long to respond — it may be busy'
        : failReason === 'error'
          ? 'Tally app returned an error during the check'
          : 'Tally app is not connected — make sure it\'s running on the tech booth computer';
      msg = `⚠️ ${church.name} — Pre-service check could not complete\n${reasonText}`;
    } else if (result.pass === false) {
      const issues = Array.isArray(result.checks) ? result.checks.filter(c => !c.pass) : [];
      const count = issues.length;
      const lines = issues.map(c => `• ${c.name}${c.detail ? ': ' + c.detail : ''}`).join('\n');
      msg = `⚠️ ${church.name} — ${count} issue${count !== 1 ? 's' : ''} before ${timeDisplay} service:\n${lines || '(no details)'}`;
    } else {
      msg = `✅ ${church.name} — All systems go for ${timeDisplay} service`;
    }

    for (const chatId of chatIds) {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: String(chatId), text: msg }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        console.error('[PreServiceCheck] Telegram send error:', e.message);
      }
    }
  }
  /**
   * Persist a check result to DB for portal visibility.
   * @param {string} churchId
   * @param {object|null} result - { pass, checks } from client
   * @param {string} triggerType - 'auto' or 'manual'
   * @param {string} [instanceName] - instance name for room-based filtering
   */
  _persistResult(churchId, result, triggerType = 'auto', instanceName = null) {
    if (!this.db || !result) return;
    try {
      const crypto = require('crypto');
      const sessionId = this.sessionRecap?.getActiveSessionId(churchId) || null;
      this.db.prepare(`
        INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at, instance_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), churchId, sessionId,
        result.pass ? 1 : 0, JSON.stringify(result.checks || []),
        triggerType, new Date().toISOString(), instanceName
      );
    } catch (e) {
      console.error('[PreServiceCheck] DB persist error:', e.message);
    }
  }

  /**
   * Run a manual pre-service check for a church (triggered from portal).
   * @param {string} churchId
   * @param {string} [instanceName] - optional instance to target (for room-based checks)
   * @returns {Promise<object|null>} Check result
   */
  async runManualCheck(churchId, instanceName = null) {
    const churchRuntime = this.churches?.get(churchId);
    // Pick the specific instance socket if requested, else fall back to default
    let targetWs = churchRuntime?.ws;
    if (instanceName && churchRuntime?.sockets) {
      targetWs = churchRuntime.sockets.get(instanceName) || targetWs;
    }
    if (!targetWs || targetWs.readyState !== 1) {
      return null;
    }

    const crypto = require('crypto');
    const msgId = crypto.randomUUID();

    // Set up listener BEFORE sending command
    const resultPromise = new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(null); }, 10000);
      const handler = (msg) => {
        if (msg.type === 'command_result' && msg.churchId === churchId && msg.messageId === msgId) {
          cleanup();
          resolve(msg.error ? null : msg.result);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        const idx = this._resultListeners.indexOf(handler);
        if (idx !== -1) this._resultListeners.splice(idx, 1);
      };
      this._resultListeners.push(handler);
    });

    // Send command to client
    targetWs.send(JSON.stringify({
      type: 'command', command: 'system.preServiceCheck', params: {}, id: msgId,
    }));

    const result = await resultPromise;
    if (result && this.versionConfig && churchRuntime) {
      result.checks = this._enrichWithVersionChecks(result.checks || [], churchRuntime.status);
      result.pass = result.pass && !result.checks.some(c => !c.pass);
    }
    this._persistResult(churchId, result, 'manual', instanceName);
    return result;
  }

  /**
   * Append server-side device version checks to the pre-service check results.
   * Reads current version strings from the church's live status object and
   * compares them against versionConfig minimums.
   */
  _enrichWithVersionChecks(checks, status) {
    if (!this.versionConfig || !status) return checks;

    const enriched = [...checks];
    const encType = status.encoder?.type || 'unknown';
    const mixerType = status.mixer?.type || 'unknown';

    const devices = [
      { label: 'OBS Version',            type: 'obs',                   version: status.obs?.version },
      { label: 'ProPresenter Version',    type: 'proPresenter',          version: status.proPresenter?.version },
      { label: 'vMix Version',            type: 'vmix',                  version: status.vmix?.version },
      { label: 'ATEM Firmware',           type: 'atem_protocol',         version: status.atem?.protocolVersion },
      { label: `${encType} Firmware`,     type: `encoder_${encType}`,    version: status.encoder?.firmwareVersion },
      { label: `${mixerType} Firmware`,   type: `mixer_${mixerType}`,    version: status.mixer?.firmware },
    ];

    for (const d of devices) {
      if (!d.version) continue;
      const result = this.versionConfig.checkVersion(d.type, d.version);
      if (!result.checked) continue;
      enriched.push({
        name: d.label,
        pass: result.meetsRequirement,
        detail: result.outdated
          ? `v${result.current} (minimum: v${result.minimum})`
          : `v${result.current} ✓`,
      });
    }
    return enriched;
  }
}

module.exports = { PreServiceCheck };
