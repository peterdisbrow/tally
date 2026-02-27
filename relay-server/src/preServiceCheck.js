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
  constructor({ db, scheduleEngine, churches, defaultBotToken, andrewChatId, sessionRecap } = {}) {
    this.lastPreServiceCheckAt = new Map(); // churchId → timestamp (ms)
    this._timer = null;
    this.db = db || null;
    this.scheduleEngine = scheduleEngine || null;
    this.churches = churches || null;
    this.sessionRecap = sessionRecap || null;
    this.tallyBot = null;
    this.sendCommand = null;
    this.defaultBotToken = defaultBotToken || process.env.ALERT_BOT_TOKEN;
    this.andrewChatId = andrewChatId || process.env.ANDREW_TELEGRAM_CHAT_ID;
    this._resultListeners = [];
    this._ensureTable();
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
   */
  start() {
    this._timer = setInterval(() => this._tick(), 5 * 60 * 1000);
    console.log('[PreServiceCheck] Started — polling every 5 min');
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
    try {
      const churchRuntime = this.churches?.get(church.churchId);
      if (churchRuntime?.ws?.readyState === 1) {
        const crypto = require('crypto');
        const msgId = crypto.randomUUID();
        const resultPromise = new Promise((resolve) => {
          const timer = setTimeout(() => { cleanup(); resolve(null); }, 10000);
          const handler = (msg) => {
            if (msg.type === 'command_result' && msg.churchId === church.churchId && msg.messageId === msgId) {
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
        churchRuntime.ws.send(JSON.stringify({ type: 'command', command: 'system.preServiceCheck', params: {}, id: msgId }));
        result = await resultPromise;
      }
    } catch (e) {
      console.error(`[PreServiceCheck] sendCommand error for ${church.name}:`, e.message);
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

    // Format notification
    let msg;
    if (!result) {
      msg = `⚠️ ${church.name} — Could not run pre-service check (client offline or no response)`;
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
   */
  _persistResult(churchId, result, triggerType = 'auto') {
    if (!this.db || !result) return;
    try {
      const crypto = require('crypto');
      const sessionId = this.sessionRecap?.getActiveSessionId(churchId) || null;
      this.db.prepare(`
        INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), churchId, sessionId,
        result.pass ? 1 : 0, JSON.stringify(result.checks || []),
        triggerType, new Date().toISOString()
      );
    } catch (e) {
      console.error('[PreServiceCheck] DB persist error:', e.message);
    }
  }

  /**
   * Run a manual pre-service check for a church (triggered from portal).
   * @param {string} churchId
   * @returns {Promise<object|null>} Check result
   */
  async runManualCheck(churchId) {
    const churchRuntime = this.churches?.get(churchId);
    if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
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
    churchRuntime.ws.send(JSON.stringify({
      type: 'command', command: 'system.preServiceCheck', params: {}, id: msgId,
    }));

    const result = await resultPromise;
    this._persistResult(churchId, result, 'manual');
    return result;
  }
}

module.exports = { PreServiceCheck };
