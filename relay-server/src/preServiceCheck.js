const { getPrimarySocket, getSocketForInstance } = require('./runtimeSockets');
const { createQueryClient } = require('./db');
const { runWithConcurrency } = require('./asyncPool');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

const CREATE_PRESERVICE_CHECK_RESULTS_SQL = `
  CREATE TABLE IF NOT EXISTS preservice_check_results (
    id TEXT PRIMARY KEY,
    church_id TEXT NOT NULL,
    session_id TEXT,
    pass INTEGER DEFAULT 0,
    checks_json TEXT DEFAULT '[]',
    trigger_type TEXT DEFAULT 'auto',
    created_at TEXT NOT NULL
  )
`;

const CHURCH_SELECT_SQL = `
  SELECT churchId AS "churchId", name, service_times, timezone
  FROM churches
`;
const MAX_CHECK_CONCURRENCY = Math.max(1, Number(process.env.PRE_SERVICE_CHECK_MAX_CONCURRENCY || 4));

function isDuplicateColumnError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('duplicate column name') || message.includes('already exists');
}

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
   * @param {string} [opts.adminChatId] - Admin contact Telegram chat ID
   * @param {object} [opts.sessionRecap] - SessionRecap instance for session ID linking
   */
  constructor({ db, scheduleEngine, churches, defaultBotToken, adminChatId, sessionRecap, versionConfig } = {}) {
    this.lastPreServiceCheckAt = new Map(); // compositeKey (churchId::instanceName) → timestamp (ms)
    this._timer = null;
    this.db = db && typeof db.prepare === 'function' ? db : null;
    this.client = this._resolveClient(db);
    this.scheduleEngine = scheduleEngine || null;
    this.churches = churches || null;
    this.sessionRecap = sessionRecap || null;
    this.versionConfig = versionConfig || null;
    this.tallyBot = null;
    this.sendCommand = null;
    this.defaultBotToken = defaultBotToken || process.env.ALERT_BOT_TOKEN;
    this.adminChatId = adminChatId || process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.ANDREW_TELEGRAM_CHAT_ID;
    this._resultListeners = [];
    this._tickPromise = null;
    if (this.db) {
      this._ensureTableSync();
      // Restore last-check timestamps from DB so relay restarts don't re-fire
      // checks that already ran within the dedup window.
      this._restoreLastCheckTimes();
      this.ready = Promise.resolve();
    } else {
      this.ready = this._init();
    }
  }

  _resolveClient(dbOrClient) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client) throw new Error('[PreServiceCheck] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTable();
    await this._restoreLastCheckTimesAsync();
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

  async _restoreLastCheckTimesAsync() {
    try {
      const rows = await this._requireClient().query(
        `SELECT church_id, MAX(created_at) AS last_at
         FROM preservice_check_results
         GROUP BY church_id`,
        []
      );
      for (const row of rows) {
        if (row.last_at) {
          const ts = new Date(row.last_at).getTime();
          if (!Number.isNaN(ts)) this.lastPreServiceCheckAt.set(row.church_id, ts);
        }
      }
      if (rows.length > 0) {
        console.log(`[PreServiceCheck] Restored last-check times for ${rows.length} church(es) from DB`);
      }
    } catch (e) {
      console.warn('[PreServiceCheck] Could not restore last-check times:', e.message);
    }
  }

  _ensureTableSync() {
    if (!this.db) return;
    this.db.exec(CREATE_PRESERVICE_CHECK_RESULTS_SQL);
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_preservice_church ON preservice_check_results(church_id, created_at DESC)');
    } catch { /* already exists */ }
    // Migration: add instance_name for room-based filtering
    try { this.db.prepare('SELECT instance_name FROM preservice_check_results LIMIT 1').get(); }
    catch { try { this.db.exec('ALTER TABLE preservice_check_results ADD COLUMN instance_name TEXT'); } catch { /* already exists */ } }
    // Migration: add room_id for room-based filtering
    try { this.db.prepare('SELECT room_id FROM preservice_check_results LIMIT 1').get(); }
    catch { try { this.db.exec('ALTER TABLE preservice_check_results ADD COLUMN room_id TEXT'); } catch { /* already exists */ } }
  }

  async _ensureTable() {
    const client = this._requireClient();
    await client.exec(CREATE_PRESERVICE_CHECK_RESULTS_SQL);
    try {
      await client.exec('CREATE INDEX IF NOT EXISTS idx_preservice_church ON preservice_check_results(church_id, created_at DESC)');
    } catch { /* already exists */ }

    try {
      await client.queryOne('SELECT instance_name FROM preservice_check_results LIMIT 1');
    } catch {
      try {
        await client.exec('ALTER TABLE preservice_check_results ADD COLUMN instance_name TEXT');
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    }

    try {
      await client.queryOne('SELECT room_id FROM preservice_check_results LIMIT 1');
    } catch {
      try {
        await client.exec('ALTER TABLE preservice_check_results ADD COLUMN room_id TEXT');
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    }
  }

  /**
   * Get the latest pre-service check result for a church.
   * @param {string} churchId
   * @returns {object|null}
   */
  getLatestResult(churchId, instanceName) {
    if (this.db) return this._getLatestResultSync(churchId, instanceName);
    return this._getLatestResultAsync(churchId, instanceName);
  }

  _getLatestResultSync(churchId, instanceName) {
    try {
      let row;
      if (instanceName) {
        row = this.db.prepare(
          'SELECT * FROM preservice_check_results WHERE church_id = ? AND (instance_name = ? OR instance_name IS NULL) ORDER BY created_at DESC LIMIT 1'
        ).get(churchId, instanceName);
      } else {
        row = this.db.prepare(
          'SELECT * FROM preservice_check_results WHERE church_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(churchId);
      }
      if (!row) return null;
      return { ...row, checks: JSON.parse(row.checks_json || '[]') };
    } catch { return null; }
  }

  async _getLatestResultAsync(churchId, instanceName) {
    try {
      await this.ready;
      let row;
      if (instanceName) {
        row = await this._requireClient().queryOne(
          'SELECT * FROM preservice_check_results WHERE church_id = ? AND (instance_name = ? OR instance_name IS NULL) ORDER BY created_at DESC LIMIT 1',
          [churchId, instanceName]
        );
      } else {
        row = await this._requireClient().queryOne(
          'SELECT * FROM preservice_check_results WHERE church_id = ? ORDER BY created_at DESC LIMIT 1',
          [churchId]
        );
      }
      if (!row) return null;
      return { ...row, checks: JSON.parse(row.checks_json || '[]') };
    } catch {
      return null;
    }
  }

  _resolveRoomId(churchId, instanceName) {
    if (!instanceName) return null;
    const churchRuntime = this.churches?.get(churchId);
    const roomInstanceMap = churchRuntime?.roomInstanceMap || null;
    if (!roomInstanceMap) return null;
    for (const [roomId, mappedInstance] of Object.entries(roomInstanceMap)) {
      if (mappedInstance === instanceName) return roomId;
    }
    return null;
  }

  /**
   * Start the pre-service check timer.
   * Also runs an immediate startup sweep so checks missed during a relay
   * restart (e.g., relay crashed right in the 25–35 min window) fire
   * without waiting up to 5 minutes for the first tick.
   */
  start() {
    this._timer = setInterval(() => { void this._tick(); }, 5 * 60 * 1000);
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
    if (this.db) {
      try {
        const row = this.db.prepare('SELECT service_times FROM churches WHERE churchId = ?').get(churchId);
        if (!row || !row.service_times) return [];
        return JSON.parse(row.service_times);
      } catch { return []; }
    }

    return this._getScheduleAsync(churchId);
  }

  async _getScheduleAsync(churchId) {
    try {
      await this.ready;
      const row = await this._requireClient().queryOne(
        'SELECT service_times FROM churches WHERE churchId = ?',
        [churchId]
      );
      if (!row || !row.service_times) return [];
      return JSON.parse(row.service_times);
    } catch { return []; }
  }

  /** Returns { startHour, startMin } if service starts in 25–35 min, else null */
  _serviceStartingIn25to35(schedule) {
    const now = new Date();
    const day = now.getDay();
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const nowWeekMinutes = day * 24 * 60 + minutesNow;
    const WEEK_MINUTES = 7 * 24 * 60;

    for (const s of schedule) {
      const startMin = s.startHour * 60 + (s.startMin || 0);
      let minutesUntil = s.day * 24 * 60 + startMin - nowWeekMinutes;
      if (minutesUntil < 0) minutesUntil += WEEK_MINUTES;
      if (minutesUntil >= 25 && minutesUntil <= 35) {
        return { startHour: s.startHour, startMin: s.startMin || 0 };
      }
    }
    return null;
  }

  async _tick() {
    if (this._tickPromise) return this._tickPromise;
    this._tickPromise = (async () => {
      try {
        await this.ready;
        const allChurches = this.db
          ? this.db.prepare(CHURCH_SELECT_SQL).all()
          : await this._requireClient().query(CHURCH_SELECT_SQL, []);
        await runWithConcurrency(allChurches, MAX_CHECK_CONCURRENCY, async (church) => {
          await this._checkChurch(church).catch(e =>
            console.error(`[PreServiceCheck] Error for ${church.name}:`, e.message)
          );
        });
      } catch (e) {
        console.error('[PreServiceCheck] Tick error:', e.message);
      } finally {
        this._tickPromise = null;
      }
    })();
    return this._tickPromise;
  }

  async _checkChurch(church) {
    let schedule = [];
    if (church?.service_times) {
      try {
        schedule = JSON.parse(church.service_times);
      } catch {
        schedule = [];
      }
    } else {
      schedule = await this._getSchedule(church.churchId);
    }
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
      const targetWs = getPrimarySocket(churchRuntime);
      if (targetWs) {
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
        targetWs.send(JSON.stringify({ type: 'command', command: 'system.preServiceCheck', params: {}, id: msgId }));
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
    await this._persistResult(church.churchId, result, 'auto');

    // Send via Telegram — use tallyBot if available, or raw API
    const botToken = this.defaultBotToken;
    if (!botToken) return;

    // Find TD chat IDs for this church
    let tds = [];
    try {
      if (this.db) {
        tds = this.db.prepare(
          'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1'
        ).all(church.churchId);
      } else {
        tds = await this._requireClient().query(
          'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1',
          [church.churchId]
        );
      }
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
  _persistResult(churchId, result, triggerType = 'auto', instanceName = null, roomId = null) {
    if (this.db) return this._persistResultSync(churchId, result, triggerType, instanceName, roomId);
    return this._persistResultAsync(churchId, result, triggerType, instanceName, roomId);
  }

  _persistResultSync(churchId, result, triggerType = 'auto', instanceName = null, roomId = null) {
    if (!this.db || !result) return;
    try {
      const crypto = require('crypto');
      const sessionId = this.sessionRecap?.getActiveSessionId(churchId, instanceName) || null;
      this.db.prepare(`
        INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at, instance_name, room_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), churchId, sessionId,
        result.pass ? 1 : 0, JSON.stringify(result.checks || []),
        triggerType, new Date().toISOString(), instanceName, roomId
      );
    } catch (e) {
      console.error('[PreServiceCheck] DB persist error:', e.message);
    }
  }

  async _persistResultAsync(churchId, result, triggerType = 'auto', instanceName = null, roomId = null) {
    if (!result) return;
    try {
      await this.ready;
      const crypto = require('crypto');
      const sessionId = this.sessionRecap?.getActiveSessionId(churchId, instanceName) || null;
      await this._requireClient().run(
        `INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at, instance_name, room_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          churchId,
          sessionId,
          result.pass ? 1 : 0,
          JSON.stringify(result.checks || []),
          triggerType,
          new Date().toISOString(),
          instanceName,
          roomId,
        ]
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
    await this.ready;
    const churchRuntime = this.churches?.get(churchId);
    const targetWs = getSocketForInstance(churchRuntime, instanceName);
    if (!targetWs) {
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
    const roomId = this._resolveRoomId(churchId, instanceName);
    await this._persistResult(churchId, result, 'manual', instanceName, roomId);
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
