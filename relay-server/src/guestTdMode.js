/**
 * Guest TD Mode
 *
 * Allows Andrew to issue 24-hour guest tokens for visiting or temporary TDs.
 * Guest TDs get the same alert access as regular TDs, scoped to their church only.
 *
 * SQLite table: guest_tokens
 *   token TEXT PRIMARY KEY        -- e.g. "GUEST-ABC123"
 *   churchId TEXT
 *   name TEXT                     -- display name of the guest
 *   createdAt TEXT
 *   expiresAt TEXT
 *   usedByChat INTEGER            -- Telegram chat ID of the registered guest (0 if unused)
 */

const crypto = require('crypto');

class GuestTdMode {
  constructor(db) {
    this.db = db;
    this._ensureTable();
    this._cleanupExpired();
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guest_tokens (
        token TEXT PRIMARY KEY,
        churchId TEXT NOT NULL,
        name TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        usedByChat TEXT DEFAULT ''
      )
    `);
  }

  /** Remove expired tokens (called on startup and daily) */
  _cleanupExpired() {
    try {
      const deleted = this.db.prepare(
        `DELETE FROM guest_tokens WHERE expiresAt < ?`
      ).run(new Date().toISOString());
      if (deleted.changes > 0) {
        console.log(`[GuestTdMode] Cleaned up ${deleted.changes} expired guest token(s)`);
      }
    } catch (e) {
      console.error('[GuestTdMode] Cleanup error:', e.message);
    }
  }

  /** Start daily cleanup */
  startCleanupTimer() {
    setInterval(() => this._cleanupExpired(), 24 * 60 * 60 * 1000);
  }

  /**
   * Generate a 24-hour guest token for a church.
   * @param {string} churchId
   * @param {string} churchName - for display
   * @returns {{ token, expiresAt, expiresFormatted }}
   */
  generateToken(churchId, churchName) {
    const token = 'GUEST-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    this.db.prepare(`
      INSERT INTO guest_tokens (token, churchId, name, createdAt, expiresAt, usedByChat)
      VALUES (?, ?, ?, ?, ?, '')
    `).run(token, churchId, churchName + ' Guest', now.toISOString(), expiresAt.toISOString());

    const expiresFormatted = expiresAt.toLocaleString('en-US', {
      weekday: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });

    console.log(`[GuestTdMode] Generated token ${token} for ${churchName}`);
    return { token, expiresAt: expiresAt.toISOString(), expiresFormatted };
  }

  /**
   * Validate and look up a guest token.
   * @param {string} token
   * @returns {{ valid: boolean, guestRow?: object, expired?: boolean }}
   */
  validateToken(token) {
    const row = this.db.prepare(`SELECT * FROM guest_tokens WHERE token = ?`).get(token);
    if (!row) return { valid: false };

    if (new Date(row.expiresAt) < new Date()) {
      return { valid: false, expired: true, guestRow: row };
    }

    return { valid: true, guestRow: row };
  }

  /**
   * Register a guest TD against a token.
   * @param {string} token
   * @param {string} chatId - Telegram chat ID
   * @param {string} name   - Display name
   * @returns {{ success: boolean, churchId?: string, message: string }}
   */
  registerGuest(token, chatId, name) {
    const { valid, expired, guestRow } = this.validateToken(token);
    if (!valid) {
      if (expired) return { success: false, message: 'This guest token has expired. Contact Andrew to get a new one.' };
      return { success: false, message: 'Invalid guest token. Check the token and try again.' };
    }

    if (guestRow.usedByChat && guestRow.usedByChat !== String(chatId)) {
      return { success: false, message: 'This token has already been used by someone else.' };
    }

    // Update name and claim the token
    this.db.prepare(`UPDATE guest_tokens SET name = ?, usedByChat = ? WHERE token = ?`)
      .run(name, String(chatId), token);

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
  findActiveGuestByChatId(chatId) {
    const row = this.db.prepare(`
      SELECT * FROM guest_tokens
      WHERE usedByChat = ? AND expiresAt > ?
    `).get(String(chatId), new Date().toISOString());
    return row || null;
  }

  /**
   * Immediately revoke a guest token.
   * @returns {{ revoked: boolean, token: string }}
   */
  revokeToken(token) {
    const result = this.db.prepare(`DELETE FROM guest_tokens WHERE token = ?`).run(token);
    const revoked = result.changes > 0;
    if (revoked) console.log(`[GuestTdMode] Revoked token ${token}`);
    return { revoked, token };
  }

  /**
   * List all active guest tokens (for admin review).
   */
  listActiveTokens() {
    return this.db.prepare(`
      SELECT * FROM guest_tokens WHERE expiresAt > ? ORDER BY createdAt DESC
    `).all(new Date().toISOString());
  }

  /**
   * Notify a guest that their access has expired.
   * Call this from a cleanup pass or expiry check.
   */
  async notifyExpiredGuest(guestRow, botToken) {
    if (!guestRow.usedByChat || !botToken) return;
    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: guestRow.usedByChat,
          text: `⏰ Your guest access has expired. Contact Andrew to renew if needed.`,
        }),
      });
      if (!resp.ok) console.warn(`[GuestTdMode] Notify failed: ${resp.status}`);
    } catch (e) {
      console.error(`[GuestTdMode] Notify error: ${e.message}`);
    }
  }
}

module.exports = { GuestTdMode };
