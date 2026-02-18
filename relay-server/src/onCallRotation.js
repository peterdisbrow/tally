/**
 * On-Call TD Rotation
 *
 * SQLite table: td_oncall
 * Integrates with TallyBot via this.onCallRotation property.
 *
 * Expected API (called by telegramBot.js):
 *   getCurrentOnCall(churchId)         → TD row | null
 *   getOnCallTD(churchId)              → TD row | null
 *   formatOnCallStatus(churchId, db)   → string
 *   setOnCall(churchId, tdName)        → { success, message }
 *   addOrUpdateTD(opts)                → void
 *   initiateSwap(churchId, requesterChatId, targetName) → { success, message, target?, requester? }
 *   findPendingSwapForTarget(chatId)   → swap | null
 *   confirmSwap(swapKey)               → { success, message, target?, sundayStr? }
 *
 * Admin commands (wired in handleAdminCommand in telegramBot.js):
 *   "list tds [church]"
 *   "set oncall [church] [name]"
 *
 * TD commands (wired in handleTDCommand):
 *   /oncall — shows current on-call for their church
 *   /swap [name] — request an on-call swap
 *   /confirmswap — accept a pending swap request
 */

const crypto = require('crypto');

class OnCallRotation {
  constructor() {
    this.db = null;
    this.tallyBot = null;
    // In-memory: swapKey → { churchId, requesterChatId, targetChatId, requesterName, targetName, weekKey }
    this._pendingSwaps = new Map();
  }

  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} tallyBot - TallyBot instance (may be null)
   */
  start(db, tallyBot) {
    this.db = db;
    this.tallyBot = tallyBot;
    this._ensureTable();
    console.log('[OnCallRotation] Started');
  }

  // ─── DB SETUP ────────────────────────────────────────────────────────────

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS td_oncall (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        churchId         TEXT NOT NULL,
        name             TEXT NOT NULL,
        telegramChatId   TEXT DEFAULT '',
        telegramUserId   TEXT DEFAULT '',
        phone            TEXT DEFAULT '',
        weekOf           TEXT DEFAULT '',
        isPrimary        INTEGER DEFAULT 0
      )
    `);
  }

  // ─── ISO WEEK HELPER ─────────────────────────────────────────────────────

  _currentWeekKey() {
    const now = new Date();
    const jan4 = new Date(now.getFullYear(), 0, 4);
    const startOfWeek1 = new Date(jan4);
    startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
    const weekNum = Math.floor(1 + (now - startOfWeek1) / (7 * 24 * 3600 * 1000));
    return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }

  _nextSundayStr() {
    const now = new Date();
    const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
    const sunday = new Date(now);
    sunday.setDate(now.getDate() + daysUntilSunday);
    return sunday.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────────

  /**
   * Get current on-call TD for a church.
   * Priority: current week → isPrimary → first registered
   */
  getCurrentOnCall(churchId) {
    const weekKey = this._currentWeekKey();

    let td = this.db.prepare(
      'SELECT * FROM td_oncall WHERE churchId = ? AND weekOf = ? ORDER BY id ASC LIMIT 1'
    ).get(churchId, weekKey);
    if (td) return td;

    td = this.db.prepare(
      'SELECT * FROM td_oncall WHERE churchId = ? AND isPrimary = 1 ORDER BY id ASC LIMIT 1'
    ).get(churchId);
    if (td) return td;

    return this.db.prepare(
      'SELECT * FROM td_oncall WHERE churchId = ? ORDER BY id ASC LIMIT 1'
    ).get(churchId) || null;
  }

  /** Alias used by telegramBot.js */
  getOnCallTD(churchId) {
    return this.getCurrentOnCall(churchId);
  }

  /**
   * Format a human-readable on-call status for a church.
   * Called by telegramBot.js handleAdminCommand and handleTDCommand.
   */
  formatOnCallStatus(churchId, db) {
    const weekKey = this._currentWeekKey();
    const allTDs = (db || this.db).prepare(
      'SELECT * FROM td_oncall WHERE churchId = ? ORDER BY isPrimary DESC, id ASC'
    ).all(churchId);

    if (!allTDs.length) return '_(no TDs registered)_';

    return allTDs.map(td => {
      const flags = [];
      if (td.weekOf === weekKey) flags.push('✅ on-call this week');
      if (td.isPrimary) flags.push('⭐ primary');
      const flagStr = flags.length ? `  [${flags.join(', ')}]` : '';
      const phone = td.phone ? ` — 📞 ${td.phone}` : '';
      return `• *${td.name}*${phone}${flagStr}`;
    }).join('\n');
  }

  /**
   * Set a TD as on-call for the current week.
   * @param {string} churchId
   * @param {string} tdName - partial name match
   * @returns {{ success: boolean, message: string }}
   */
  setOnCall(churchId, tdName) {
    const weekKey = this._currentWeekKey();

    // Find by name (partial match) in td_oncall
    let td = this.db.prepare(
      'SELECT * FROM td_oncall WHERE churchId = ? AND name LIKE ? LIMIT 1'
    ).get(churchId, `%${tdName}%`);

    if (!td) {
      // Also check church_tds
      try {
        const ctd = this.db.prepare(
          'SELECT * FROM church_tds WHERE church_id = ? AND name LIKE ? AND active = 1 LIMIT 1'
        ).get(churchId, `%${tdName}%`);
        if (ctd) {
          // Create entry in td_oncall
          const info = this.db.prepare(
            'INSERT INTO td_oncall (churchId, name, telegramChatId, telegramUserId, weekOf) VALUES (?, ?, ?, ?, ?)'
          ).run(churchId, ctd.name, ctd.telegram_chat_id || '', ctd.telegram_user_id || '', '');
          td = this.db.prepare('SELECT * FROM td_oncall WHERE id = ?').get(info.lastInsertRowid);
        }
      } catch { /* church_tds may not exist */ }
    }

    if (!td) {
      // Create new entry
      const info = this.db.prepare(
        'INSERT INTO td_oncall (churchId, name, weekOf) VALUES (?, ?, ?)'
      ).run(churchId, tdName.trim(), '');
      td = this.db.prepare('SELECT * FROM td_oncall WHERE id = ?').get(info.lastInsertRowid);
    }

    // Clear existing on-call for this week, then assign
    this.db.prepare(
      "UPDATE td_oncall SET weekOf = '' WHERE churchId = ? AND weekOf = ?"
    ).run(churchId, weekKey);

    this.db.prepare('UPDATE td_oncall SET weekOf = ? WHERE id = ?').run(weekKey, td.id);

    return { success: true, message: `*${td.name}* is now on-call for week ${weekKey}` };
  }

  /**
   * Called when a new TD registers via /register to add them to rotation.
   */
  addOrUpdateTD({ churchId, name, telegramChatId, telegramUserId, isPrimary = 0 }) {
    try {
      const existing = this.db.prepare(
        'SELECT * FROM td_oncall WHERE churchId = ? AND (telegramUserId = ? OR name = ?) LIMIT 1'
      ).get(churchId, String(telegramUserId), name);

      if (existing) {
        this.db.prepare(
          'UPDATE td_oncall SET telegramChatId = ?, telegramUserId = ?, name = ? WHERE id = ?'
        ).run(String(telegramChatId), String(telegramUserId), name, existing.id);
      } else {
        this.db.prepare(
          'INSERT INTO td_oncall (churchId, name, telegramChatId, telegramUserId, isPrimary) VALUES (?, ?, ?, ?, ?)'
        ).run(churchId, name, String(telegramChatId), String(telegramUserId), isPrimary);
      }
    } catch (e) {
      console.error('[OnCallRotation] addOrUpdateTD error:', e.message);
    }
  }

  // ─── SWAP REQUESTS ────────────────────────────────────────────────────────

  /**
   * Initiate an on-call swap request.
   * @param {string} churchId
   * @param {string} requesterChatId - Telegram chat ID of the requester
   * @param {string} targetName - name to search for
   * @returns {{ success, message, target?, requester? }}
   */
  initiateSwap(churchId, requesterChatId, targetName) {
    const requesterTd = this.db.prepare(
      'SELECT * FROM td_oncall WHERE churchId = ? AND telegramChatId = ? LIMIT 1'
    ).get(churchId, String(requesterChatId));

    if (!requesterTd) {
      return { success: false, message: "You're not registered in the on-call rotation for this church." };
    }

    const targetTd = this.db.prepare(
      'SELECT * FROM td_oncall WHERE churchId = ? AND name LIKE ? AND telegramChatId != ? LIMIT 1'
    ).get(churchId, `%${targetName}%`, String(requesterChatId));

    if (!targetTd) {
      return {
        success: false,
        message: `No TD found named "${targetName}" in this church's rotation.`,
      };
    }

    if (!targetTd.telegramChatId) {
      return {
        success: false,
        message: `${targetTd.name} doesn't have a Telegram chat registered — can't send them a swap request.`,
      };
    }

    const swapKey = crypto.randomBytes(4).toString('hex');
    const weekKey = this._currentWeekKey();

    this._pendingSwaps.set(swapKey, {
      swapKey,
      churchId,
      weekKey,
      requesterChatId: String(requesterChatId),
      targetChatId:    String(targetTd.telegramChatId),
      requesterName:   requesterTd.name,
      targetName:      targetTd.name,
    });

    // Auto-expire swap requests after 24h
    setTimeout(() => this._pendingSwaps.delete(swapKey), 24 * 60 * 60 * 1000);

    return {
      success: true,
      message: `Swap request sent to *${targetTd.name}*. They'll need to reply \`/confirmswap\` to accept.`,
      requester: { name: requesterTd.name, telegramChatId: requesterTd.telegramChatId },
      target: { name: targetTd.name, telegramChatId: targetTd.telegramChatId },
    };
  }

  /**
   * Find a pending swap request where the given chatId is the target.
   */
  findPendingSwapForTarget(chatId) {
    for (const swap of this._pendingSwaps.values()) {
      if (swap.targetChatId === String(chatId)) {
        return {
          ...swap,
          requester: {
            name: swap.requesterName,
            telegramChatId: swap.requesterChatId,
          },
        };
      }
    }
    return null;
  }

  /**
   * Confirm a pending swap.
   * @returns {{ success, message, target?, sundayStr? }}
   */
  confirmSwap(swapKey) {
    const swap = this._pendingSwaps.get(swapKey);
    if (!swap) {
      return { success: false, message: 'Swap request not found or already expired.' };
    }

    const weekKey = this._currentWeekKey();
    this._pendingSwaps.delete(swapKey);

    // Find the target in td_oncall and set them as on-call
    const targetTd = this.db.prepare(
      'SELECT * FROM td_oncall WHERE churchId = ? AND telegramChatId = ? LIMIT 1'
    ).get(swap.churchId, swap.targetChatId);

    if (!targetTd) {
      return { success: false, message: 'Could not find target TD in rotation.' };
    }

    // Clear existing on-call, assign to target
    this.db.prepare(
      "UPDATE td_oncall SET weekOf = '' WHERE churchId = ? AND weekOf = ?"
    ).run(swap.churchId, weekKey);
    this.db.prepare('UPDATE td_oncall SET weekOf = ? WHERE id = ?').run(weekKey, targetTd.id);

    const sundayStr = this._nextSundayStr();

    return {
      success: true,
      message: `Swap confirmed — *${targetTd.name}* is now on-call starting ${sundayStr}.`,
      target: { name: targetTd.name },
      sundayStr,
    };
  }
}

module.exports = { OnCallRotation };
