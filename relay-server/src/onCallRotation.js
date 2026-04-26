/**
 * On-Call TD Rotation
 *
 * SQLite table: td_oncall
 * Integrates with TallyBot via this.onCallRotation property.
 *
 * Expected API (called by telegramBot.js):
 *   getCurrentOnCall(churchId)         -> TD row | null
 *   getOnCallTD(churchId)              -> TD row | null
 *   formatOnCallStatus(churchId, db)   -> string
 *   setOnCall(churchId, tdName)        -> { success, message }
 *   addOrUpdateTD(opts)                -> void
 *   initiateSwap(churchId, requesterChatId, targetName) -> { success, message, target?, requester? }
 *   findPendingSwapForTarget(chatId)   -> swap | null
 *   confirmSwap(swapKey)               -> { success, message, target?, sundayStr? }
 *
 * Admin commands (wired in handleAdminCommand in telegramBot.js):
 *   "list tds [church]"
 *   "set oncall [church] [name]"
 *
 * TD commands (wired in handleTDCommand):
 *   /oncall - shows current on-call for their church
 *   /swap [name] - request an on-call swap
 *   /confirmswap - accept a pending swap request
 */

const crypto = require('crypto');

const { createQueryClient } = require('./db');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

const ON_CALL_SELECT = `
  id,
  churchId AS "churchId",
  name,
  telegramChatId AS "telegramChatId",
  telegramUserId AS "telegramUserId",
  phone,
  weekOf AS "weekOf",
  isPrimary AS "isPrimary"
`;

const CHURCH_TD_SELECT = `
  id,
  church_id AS "churchId",
  name,
  telegram_chat_id AS "telegramChatId",
  telegram_user_id AS "telegramUserId",
  active
`;

class OnCallRotation {
  /**
   * @param {object} dbOrClient
   * @param {object} [options]
   * @param {object} [options.config]
   */
  constructor(dbOrClient, options = {}) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient, options);
    this.tallyBot = null;
    // In-memory: swapKey -> { churchId, requesterChatId, targetChatId, requesterName, targetName, weekKey }
    this._pendingSwaps = new Map();
    this.ready = this.client ? this._init() : Promise.resolve();
  }

  _resolveClient(dbOrClient, options = {}) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: options.config || SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client) throw new Error('[OnCallRotation] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTable();
  }

  _resolveReadableClient(dbOrClient) {
    if (!dbOrClient) return this._requireClient();
    if (dbOrClient === this.client || dbOrClient === this.db) return this._requireClient();
    return this._resolveClient(dbOrClient, { config: SQLITE_FALLBACK_CONFIG });
  }

  _nameLike(name) {
    return `%${String(name || '').trim().toLowerCase()}%`;
  }

  // --- DB SETUP -------------------------------------------------------------

  async _ensureTable() {
    const client = this._requireClient();
    const idColumn = client.driver === 'postgres'
      ? 'BIGSERIAL PRIMARY KEY'
      : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    await client.exec(`
      CREATE TABLE IF NOT EXISTS td_oncall (
        id               ${idColumn},
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

  // --- ISO WEEK HELPER ------------------------------------------------------

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

  // --- PUBLIC API -----------------------------------------------------------

  /**
   * Get current on-call TD for a church.
   * Priority: current week -> isPrimary -> first registered
   */
  async getCurrentOnCall(churchId) {
    await this.ready;
    const client = this._requireClient();
    const weekKey = this._currentWeekKey();

    let td = await client.queryOne(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ? AND weekOf = ?
       ORDER BY id ASC
       LIMIT 1`,
      [churchId, weekKey]
    );
    if (td) return td;

    td = await client.queryOne(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ? AND isPrimary = 1
       ORDER BY id ASC
       LIMIT 1`,
      [churchId]
    );
    if (td) return td;

    return client.queryOne(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ?
       ORDER BY id ASC
       LIMIT 1`,
      [churchId]
    );
  }

  /** Alias used by telegramBot.js */
  async getOnCallTD(churchId) {
    return this.getCurrentOnCall(churchId);
  }

  async listTDs(churchId) {
    await this.ready;
    return this._requireClient().query(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ?
       ORDER BY isPrimary DESC, id ASC`,
      [churchId]
    );
  }

  /**
   * Format a human-readable on-call status for a church.
   * Called by telegramBot.js handleAdminCommand and handleTDCommand.
   */
  async formatOnCallStatus(churchId, dbOrClient) {
    await this.ready;
    const client = this._resolveReadableClient(dbOrClient);
    const weekKey = this._currentWeekKey();
    const allTDs = await client.query(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ?
       ORDER BY isPrimary DESC, id ASC`,
      [churchId]
    );

    if (!allTDs.length) return '_(no TDs registered)_';

    return allTDs.map((td) => {
      const flags = [];
      if (td.weekOf === weekKey) flags.push('on-call this week');
      if (td.isPrimary) flags.push('primary');
      const flagStr = flags.length ? `  [${flags.join(', ')}]` : '';
      const phone = td.phone ? ` - ${td.phone}` : '';
      return `• *${td.name}*${phone}${flagStr}`;
    }).join('\n');
  }

  /**
   * Set a TD as on-call for the current week.
   * @param {string} churchId
   * @param {string} tdName - partial name match
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async setOnCall(churchId, tdName) {
    await this.ready;
    const client = this._requireClient();
    const weekKey = this._currentWeekKey();
    const nameLike = this._nameLike(tdName);

    let td = await client.queryOne(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ? AND LOWER(name) LIKE ?
       ORDER BY id ASC
       LIMIT 1`,
      [churchId, nameLike]
    );

    if (!td) {
      try {
        const ctd = await client.queryOne(
          `SELECT ${CHURCH_TD_SELECT}
           FROM church_tds
           WHERE church_id = ? AND LOWER(name) LIKE ? AND active = 1
           ORDER BY id ASC
           LIMIT 1`,
          [churchId, nameLike]
        );
        if (ctd) {
          await client.run(
            'INSERT INTO td_oncall (churchId, name, telegramChatId, telegramUserId, weekOf) VALUES (?, ?, ?, ?, ?)',
            [churchId, ctd.name, ctd.telegramChatId || '', ctd.telegramUserId || '', '']
          );
          td = await client.queryOne(
            `SELECT ${ON_CALL_SELECT}
             FROM td_oncall
             WHERE churchId = ? AND name = ?
             ORDER BY id DESC
             LIMIT 1`,
            [churchId, ctd.name]
          );
        }
      } catch (err) {
        // church_tds may not exist yet
        console.debug('[onCallRotation] church_tds lookup error:', err?.message);
      }
    }

    if (!td) {
      const trimmedName = tdName.trim();
      await client.run(
        'INSERT INTO td_oncall (churchId, name, weekOf) VALUES (?, ?, ?)',
        [churchId, trimmedName, '']
      );
      td = await client.queryOne(
        `SELECT ${ON_CALL_SELECT}
         FROM td_oncall
         WHERE churchId = ? AND name = ?
         ORDER BY id DESC
         LIMIT 1`,
        [churchId, trimmedName]
      );
    }

    await client.run(
      "UPDATE td_oncall SET weekOf = '' WHERE churchId = ? AND weekOf = ?",
      [churchId, weekKey]
    );
    await client.run('UPDATE td_oncall SET weekOf = ? WHERE id = ?', [weekKey, td.id]);

    return { success: true, message: `*${td.name}* is now on-call for week ${weekKey}` };
  }

  /**
   * Called when a new TD registers via /register to add them to rotation.
   */
  async addOrUpdateTD({ churchId, name, telegramChatId, telegramUserId, phone = '', isPrimary = 0 }) {
    await this.ready;
    const client = this._requireClient();

    try {
      const existing = await client.queryOne(
        `SELECT ${ON_CALL_SELECT}
         FROM td_oncall
         WHERE churchId = ? AND (telegramUserId = ? OR name = ?)
         LIMIT 1`,
        [churchId, String(telegramUserId || ''), name]
      );

      if (existing) {
        await client.run(
          'UPDATE td_oncall SET telegramChatId = ?, telegramUserId = ?, name = ?, phone = ? WHERE id = ?',
          [String(telegramChatId || ''), String(telegramUserId || ''), name, phone || '', existing.id]
        );
        return existing.id;
      }

      await client.run(
        'INSERT INTO td_oncall (churchId, name, telegramChatId, telegramUserId, phone, isPrimary) VALUES (?, ?, ?, ?, ?, ?)',
        [churchId, name, String(telegramChatId || ''), String(telegramUserId || ''), phone || '', isPrimary]
      );

      const inserted = await client.queryOne(
        `SELECT ${ON_CALL_SELECT}
         FROM td_oncall
         WHERE churchId = ? AND name = ?
         ORDER BY id DESC
         LIMIT 1`,
        [churchId, name]
      );
      return inserted?.id ?? null;
    } catch (e) {
      console.error('[OnCallRotation] addOrUpdateTD error:', e.message);
      return null;
    }
  }

  // --- SWAP REQUESTS --------------------------------------------------------

  /**
   * Initiate an on-call swap request.
   * @param {string} churchId
   * @param {string} requesterChatId - Telegram chat ID of the requester
   * @param {string} targetName - name to search for
   * @returns {Promise<{ success: boolean, message: string, target?: object, requester?: object }>}
   */
  async initiateSwap(churchId, requesterChatId, targetName) {
    await this.ready;
    const client = this._requireClient();

    const requesterTd = await client.queryOne(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ? AND telegramChatId = ?
       LIMIT 1`,
      [churchId, String(requesterChatId)]
    );

    if (!requesterTd) {
      return { success: false, message: "You're not registered in the on-call rotation for this church." };
    }

    const targetTd = await client.queryOne(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ? AND LOWER(name) LIKE ? AND telegramChatId != ?
       ORDER BY id ASC
       LIMIT 1`,
      [churchId, this._nameLike(targetName), String(requesterChatId)]
    );

    if (!targetTd) {
      return {
        success: false,
        message: `No TD found named "${targetName}" in this church's rotation.`,
      };
    }

    if (!targetTd.telegramChatId) {
      return {
        success: false,
        message: `${targetTd.name} doesn't have a Telegram chat registered - can't send them a swap request.`,
      };
    }

    const swapKey = crypto.randomBytes(12).toString('hex');
    const weekKey = this._currentWeekKey();

    this._pendingSwaps.set(swapKey, {
      swapKey,
      churchId,
      weekKey,
      requesterChatId: String(requesterChatId),
      targetChatId: String(targetTd.telegramChatId),
      requesterName: requesterTd.name,
      targetName: targetTd.name,
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
   * @returns {Promise<{ success: boolean, message: string, target?: object, sundayStr?: string }>}
   */
  async confirmSwap(swapKey) {
    await this.ready;
    const client = this._requireClient();
    const swap = this._pendingSwaps.get(swapKey);
    if (!swap) {
      return { success: false, message: 'Swap request not found or already expired.' };
    }

    const weekKey = this._currentWeekKey();
    this._pendingSwaps.delete(swapKey);

    const targetTd = await client.queryOne(
      `SELECT ${ON_CALL_SELECT}
       FROM td_oncall
       WHERE churchId = ? AND telegramChatId = ?
       LIMIT 1`,
      [swap.churchId, swap.targetChatId]
    );

    if (!targetTd) {
      return { success: false, message: 'Could not find target TD in rotation.' };
    }

    await client.run(
      "UPDATE td_oncall SET weekOf = '' WHERE churchId = ? AND weekOf = ?",
      [swap.churchId, weekKey]
    );
    await client.run('UPDATE td_oncall SET weekOf = ? WHERE id = ?', [weekKey, targetTd.id]);

    const sundayStr = this._nextSundayStr();

    return {
      success: true,
      message: `Swap confirmed - *${targetTd.name}* is now on-call starting ${sundayStr}.`,
      target: { name: targetTd.name },
      sundayStr,
    };
  }
}

module.exports = { OnCallRotation };
