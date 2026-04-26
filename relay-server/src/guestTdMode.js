/**
 * Guest TD Mode
 *
 * Allows an admin to issue 24-hour guest tokens for visiting or temporary TDs.
 * Guest TDs get the same alert access as regular TDs, scoped to their church only.
 *
 * Table: guest_tokens
 *   token TEXT PRIMARY KEY        -- e.g. "GUEST-ABC123"
 *   churchId TEXT
 *   name TEXT                     -- display name of the guest
 *   createdAt TEXT
 *   expiresAt TEXT
 *   usedByChat INTEGER            -- Telegram chat ID of the registered guest (0 if unused)
 */

const crypto = require('crypto');
const { createQueryClient } = require('./db');

const GUEST_TOKEN_SELECT = `
  token,
  COALESCE(church_id, churchId) AS "churchId",
  COALESCE(church_id, churchId) AS "church_id",
  name,
  createdAt AS "createdAt",
  expiresAt AS "expiresAt",
  usedByChat AS "usedByChat"
`;

class GuestTdMode {
  /**
   * @param {object} dbOrClient - better-sqlite3 database instance or shared query client
   * @param {object} [options]
   * @param {string} [options.adminName]
   * @param {string} [options.botToken]
   * @param {object} [options.config]
   */
  constructor(dbOrClient, { adminName = 'the administrator', botToken = null, config } = {}) {
    this.client = this._resolveClient(dbOrClient, config);
    this.adminName = adminName;
    this.botToken = botToken;
    this.ready = this._init();
  }

  _resolveClient(dbOrClient, config) {
    if (dbOrClient && typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: config || {
        driver: 'sqlite',
        isSqlite: true,
        isPostgres: false,
        databaseUrl: '',
      },
      sqliteDb: dbOrClient,
    });
  }

  async _init() {
    await this._ensureTable();
    await this._cleanupExpired({ skipReady: true });
  }

  async _ensureTable() {
    await this.client.exec(`
      CREATE TABLE IF NOT EXISTS guest_tokens (
        token TEXT PRIMARY KEY,
        church_id TEXT,
        churchId TEXT NOT NULL,
        name TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        usedByChat TEXT DEFAULT ''
      )
    `);
    try {
      await this.client.exec('ALTER TABLE guest_tokens ADD COLUMN church_id TEXT');
    } catch (err) { /* already exists */ console.debug("[guestTdMode] intentional swallow:", err); }
    try {
      await this.client.run(`
        UPDATE guest_tokens
        SET church_id = churchId
        WHERE (church_id IS NULL OR church_id = '')
          AND churchId IS NOT NULL
      `);
    } catch (err) {
      console.debug('[GuestTdMode migrations] backfill church_id error:', err?.message);
    }

    // Migration: clean up orphaned portal tokens (gtd_ prefix) that used an incompatible schema.
    try {
      const legacy = await this.client.query("SELECT token FROM guest_tokens WHERE token LIKE 'gtd_%'");
      if (legacy.length) {
        const result = await this.client.run("DELETE FROM guest_tokens WHERE token LIKE 'gtd_%'");
        console.log(`[GuestTdMode] Cleaned up ${result.changes} legacy portal token(s)`);
      }
    } catch (err) {
      console.debug('[GuestTdMode migrations] legacy gtd_ cleanup error:', err?.message);
    }
  }

  async _cleanupExpired(options = {}) {
    const { skipReady = false } = options;
    try {
      if (!skipReady) await this.ready;
      const deleted = await this.client.run(
        'DELETE FROM guest_tokens WHERE expiresAt < ?',
        [new Date().toISOString()]
      );
      if (deleted.changes > 0) {
        console.log(`[GuestTdMode] Cleaned up ${deleted.changes} expired guest token(s)`);
      }
      return { deleted: deleted.changes };
    } catch (e) {
      console.error('[GuestTdMode] Cleanup error:', e.message);
      return { deleted: 0 };
    }
  }

  /** Start daily cleanup */
  startCleanupTimer() {
    setInterval(() => {
      this._cleanupExpired().catch((error) => {
        console.error('[GuestTdMode] Cleanup timer error:', error.message);
      });
    }, 24 * 60 * 60 * 1000);
  }

  async getToken(token) {
    await this.ready;
    return this.client.queryOne(
      `SELECT ${GUEST_TOKEN_SELECT}
       FROM guest_tokens
       WHERE token = ?`,
      [token]
    );
  }

  /**
   * Generate a 24-hour guest token for a church.
   * @param {string} churchId
   * @param {string} churchName
   * @returns {Promise<{ token, expiresAt, expiresFormatted }>}
   */
  async generateToken(churchId, churchName) {
    await this.ready;
    const token = 'GUEST-' + crypto.randomBytes(12).toString('hex').toUpperCase();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await this.client.run(
      `INSERT INTO guest_tokens (token, church_id, churchId, name, createdAt, expiresAt, usedByChat)
       VALUES (?, ?, ?, ?, ?, ?, '')`,
      [token, churchId, churchId, `${churchName} Guest`, now.toISOString(), expiresAt.toISOString()]
    );

    const expiresFormatted = expiresAt.toLocaleString('en-US', {
      weekday: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });

    console.log(`[GuestTdMode] Generated token ${token.slice(0, 4)}**** for ${churchName}`);
    return { token, expiresAt: expiresAt.toISOString(), expiresFormatted };
  }

  /**
   * Validate and look up a guest token.
   * @param {string} token
   * @returns {Promise<{ valid: boolean, guestRow?: object, expired?: boolean }>}
   */
  async validateToken(token) {
    const row = await this.getToken(token);
    if (!row) return { valid: false };

    if (new Date(row.expiresAt) < new Date()) {
      return { valid: false, expired: true, guestRow: row };
    }

    return { valid: true, guestRow: row };
  }

  /**
   * Register a guest TD against a token.
   * @returns {Promise<{ success: boolean, churchId?: string, token?: string, message: string }>}
   */
  async registerGuest(token, chatId, name) {
    const { valid, expired, guestRow } = await this.validateToken(token);
    if (!valid) {
      if (expired) return { success: false, message: `This guest token has expired. Contact ${this.adminName} to get a new one.` };
      return { success: false, message: 'Invalid guest token. Check the token and try again.' };
    }

    if (guestRow.usedByChat && guestRow.usedByChat !== String(chatId)) {
      return { success: false, message: 'This token has already been used by someone else.' };
    }

    await this.client.run(
      'UPDATE guest_tokens SET name = ?, usedByChat = ? WHERE token = ?',
      [name, String(chatId), token]
    );

    const expiresAt = new Date(guestRow.expiresAt);
    const expiresFormatted = expiresAt.toLocaleString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });

    return {
      success: true,
      churchId: guestRow.churchId,
      token,
      message: `Registered as guest TD. Access expires ${expiresFormatted}.`,
    };
  }

  /**
   * Find a guest entry by Telegram chat ID.
   * Returns null if not found or expired.
   */
  async findActiveGuestByChatId(chatId) {
    await this.ready;
    return this.client.queryOne(
      `SELECT ${GUEST_TOKEN_SELECT}
       FROM guest_tokens
       WHERE usedByChat = ? AND expiresAt > ?`,
      [String(chatId), new Date().toISOString()]
    );
  }

  /**
   * Immediately revoke a guest token.
   * @returns {Promise<{ revoked: boolean, token: string }>}
   */
  async revokeToken(token) {
    await this.ready;
    const result = await this.client.run('DELETE FROM guest_tokens WHERE token = ?', [token]);
    const revoked = result.changes > 0;
    if (revoked) console.log(`[GuestTdMode] Revoked token ${token.slice(0, 4)}****`);
    return { revoked, token };
  }

  /**
   * Revoke a guest token and notify the guest via Telegram if they claimed it.
   * @returns {Promise<{ revoked: boolean, token: string }>}
   */
  async revokeAndNotify(token) {
    const row = await this.getToken(token);
    const result = await this.revokeToken(token);
    if (result.revoked && row?.usedByChat) {
      const botToken = this.botToken || process.env.TALLY_BOT_TOKEN;
      if (botToken) {
        await this._notifyRevokedGuest(row, botToken);
      }
    }
    return result;
  }

  async _notifyRevokedGuest(guestRow, botToken) {
    if (!guestRow.usedByChat || !botToken) return;
    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: guestRow.usedByChat,
          text: `🚫 Your guest access has been revoked. Contact ${this.adminName} if you need continued access.`,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) console.warn(`[GuestTdMode] Revoke notify failed: ${resp.status}`);
    } catch (e) {
      console.error(`[GuestTdMode] Revoke notify error: ${e.message}`);
    }
  }

  static formatRemainingTime(expiresAt) {
    const msLeft = new Date(expiresAt) - Date.now();
    if (msLeft <= 0) return 'Expired';
    const totalMinutes = Math.floor(msLeft / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours >= 48) {
      const days = Math.floor(hours / 24);
      return `${days}d remaining`;
    }
    if (hours >= 1) return `${hours}h ${minutes}m remaining`;
    return `${minutes}m remaining`;
  }

  async listActiveTokens() {
    await this.ready;
    return this.client.query(
      `SELECT ${GUEST_TOKEN_SELECT}
       FROM guest_tokens
       WHERE expiresAt > ?
       ORDER BY createdAt DESC`,
      [new Date().toISOString()]
    );
  }

  async listTokensForChurch(churchId) {
    await this.ready;
    return this.client.query(
      `SELECT ${GUEST_TOKEN_SELECT}
       FROM guest_tokens
       WHERE churchId = ? AND expiresAt > ?
       ORDER BY createdAt DESC`,
      [churchId, new Date().toISOString()]
    );
  }

  /**
   * Generate a token with custom expiry. Used by the church portal.
   * @returns {Promise<{ token: string, name: string, expiresAt: string }>}
   */
  async generateTokenWithOptions(churchId, churchName, { label, expiresInHours = 24 } = {}) {
    await this.ready;
    const token = 'GUEST-' + crypto.randomBytes(12).toString('hex').toUpperCase();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000);
    const name = label || `${churchName} Guest`;

    await this.client.run(
      'INSERT INTO guest_tokens (token, church_id, churchId, name, createdAt, expiresAt, usedByChat) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [token, churchId, churchId, name, now.toISOString(), expiresAt.toISOString(), '']
    );

    console.log(`[GuestTdMode] Generated token ${token.slice(0, 4)}**** for ${churchName} (${expiresInHours}h)`);
    return { token, name, expiresAt: expiresAt.toISOString() };
  }

  async notifyExpiredGuest(guestRow, botToken) {
    if (!guestRow.usedByChat || !botToken) return;
    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: guestRow.usedByChat,
          text: `⏰ Your guest access has expired. Contact ${this.adminName} to renew if needed.`,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) console.warn(`[GuestTdMode] Notify failed: ${resp.status}`);
    } catch (e) {
      console.error(`[GuestTdMode] Notify error: ${e.message}`);
    }
  }
}

module.exports = { GuestTdMode };
