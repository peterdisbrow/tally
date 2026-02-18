/**
 * Pre-Service Auto-Check
 * Every 5 min, check if any church has a service starting in 25–35 min
 * and hasn't been pre-checked yet. Sends system.preServiceCheck to the
 * church client and notifies the TD via Telegram with results.
 */

class PreServiceCheck {
  constructor() {
    this.lastPreServiceCheckAt = new Map(); // churchId → timestamp (ms)
    this._timer = null;
    this.db = null;
    this.churches = null;
    this.tallyBot = null;
    this.sendCommand = null;
  }

  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Map} churches - in-memory church runtime map from server.js
   * @param {object} tallyBot - TallyBot instance (may be null)
   * @param {function} sendCommand - (churchId, command, params) → Promise<result|null>
   */
  start(db, churches, tallyBot, sendCommand) {
    this.db = db;
    this.churches = churches;
    this.tallyBot = tallyBot;
    this.sendCommand = sendCommand;

    this._timer = setInterval(() => this._tick(), 5 * 60 * 1000);
    console.log('[PreServiceCheck] Started — polling every 5 min');
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

    // Send command to church client and await result
    let result = null;
    try {
      result = await this.sendCommand(church.churchId, 'system.preServiceCheck', {});
    } catch (e) {
      console.error(`[PreServiceCheck] sendCommand error for ${church.name}:`, e.message);
    }

    if (!this.tallyBot) return;

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
      await this.tallyBot.sendMessage(String(chatId), msg).catch(e =>
        console.error('[PreServiceCheck] Telegram send error:', e.message)
      );
    }
  }
}

module.exports = { PreServiceCheck };
