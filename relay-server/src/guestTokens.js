/**
 * Guest TD Mode
 *
 * Andrew Telegram commands:
 *   "guest [church name]"       → generates GUEST-XXXXXX token, sends instructions
 *   "revoke guest [token]"      → deletes token immediately
 *
 * TD bot command:
 *   /register GUEST-XXXXXX     → registers the chat with that church for 24h
 *
 * Nightly cleanup: removes expired guest tokens + deactivates their church_tds entries
 */

const crypto = require('crypto');

class GuestTokens {
  constructor() {
    this.db = null;
    this.tallyBot = null;
    this._cleanupTimer = null;
  }

  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} tallyBot - TallyBot instance (may be null)
   */
  start(db, tallyBot) {
    this.db = db;
    this.tallyBot = tallyBot;

    this._ensureTable();
    this._ensureGuestExpiryColumn();
    this._registerBotCommands();
    this._scheduleNightlyCleanup();

    console.log('[GuestTokens] Started');
  }

  stop() {
    if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
  }

  // ─── DB SETUP ────────────────────────────────────────────────────────────

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guest_tokens (
        token          TEXT PRIMARY KEY,
        churchId       TEXT NOT NULL,
        guestName      TEXT DEFAULT '',
        createdAt      TEXT NOT NULL,
        expiresAt      TEXT NOT NULL,
        telegramChatId INTEGER
      )
    `);
  }

  _ensureGuestExpiryColumn() {
    // Add expires_at to church_tds so we can auto-expire guest sessions
    try {
      this.db.prepare('SELECT guest_expires_at FROM church_tds LIMIT 1').get();
    } catch {
      try {
        this.db.exec('ALTER TABLE church_tds ADD COLUMN guest_expires_at TEXT DEFAULT NULL');
      } catch { /* church_tds may not exist yet */ }
    }
  }

  // ─── TOKEN GENERATION ─────────────────────────────────────────────────────

  _generateToken() {
    // 6 uppercase alphanumeric characters
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude confusable chars
    let token = '';
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) {
      token += chars[b % chars.length];
    }
    return 'GUEST-' + token;
  }

  // ─── BOT COMMAND REGISTRATION ─────────────────────────────────────────────

  _registerBotCommands() {
    if (!this.tallyBot) return;

    // Admin: "guest [church name]"
    this.tallyBot.addAdminPlugin(async (chatId, text) => {
      const m = text.match(/^guest\s+(.+)$/i);
      if (!m) return false;

      const churchSearch = m[1].trim();
      const church = this.db.prepare(
        'SELECT * FROM churches WHERE name LIKE ? LIMIT 1'
      ).get(`%${churchSearch}%`);

      if (!church) {
        await this.tallyBot.sendMessage(chatId, `❌ Church "${churchSearch}" not found.`);
        return true;
      }

      const token = this._generateToken();
      const now      = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      this.db.prepare(
        'INSERT OR REPLACE INTO guest_tokens (token, churchId, guestName, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)'
      ).run(token, church.churchId, '', now, expiresAt);

      await this.tallyBot.sendMessage(chatId,
        `🎫 Guest token for *${church.name}*:\n\`/register ${token}\`\nExpires in 24 hours`,
        { parse_mode: 'Markdown' }
      );
      return true;
    });

    // Admin: "revoke guest [token]"
    this.tallyBot.addAdminPlugin(async (chatId, text) => {
      const m = text.match(/^revoke\s+guest\s+(GUEST-[A-Z0-9]+)$/i);
      if (!m) return false;

      const token = m[1].toUpperCase();
      const row = this.db.prepare('SELECT * FROM guest_tokens WHERE token = ?').get(token);

      if (!row) {
        await this.tallyBot.sendMessage(chatId, `❌ Token \`${token}\` not found.`, { parse_mode: 'Markdown' });
        return true;
      }

      // Deactivate any church_tds registered with this token
      if (row.telegramChatId) {
        try {
          this.db.prepare(
            'UPDATE church_tds SET active = 0 WHERE church_id = ? AND telegram_chat_id = ? AND guest_expires_at IS NOT NULL'
          ).run(row.churchId, String(row.telegramChatId));
        } catch { /* ignore */ }
      }

      this.db.prepare('DELETE FROM guest_tokens WHERE token = ?').run(token);

      await this.tallyBot.sendMessage(chatId,
        `✅ Token \`${token}\` revoked.`,
        { parse_mode: 'Markdown' }
      );
      return true;
    });

    // Guest TD registration: /register GUEST-XXXXXX
    this.tallyBot.setGuestRegisterHandler(async (userId, chatId, token, from) => {
      const row = this.db.prepare('SELECT * FROM guest_tokens WHERE token = ?').get(token);

      if (!row) {
        return this.tallyBot.sendMessage(chatId, '❌ Invalid or expired guest token.');
      }

      if (new Date(row.expiresAt) < new Date()) {
        this.db.prepare('DELETE FROM guest_tokens WHERE token = ?').run(token);
        return this.tallyBot.sendMessage(chatId, '❌ This guest token has expired. Ask for a new one.');
      }

      const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(row.churchId);
      if (!church) {
        return this.tallyBot.sendMessage(chatId, '❌ Church not found. Token may be stale.');
      }

      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Guest TD';
      const now  = new Date().toISOString();
      const expiresAt = row.expiresAt;

      // Register as a temporary TD
      try {
        this.db.prepare(
          'INSERT OR REPLACE INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active, guest_expires_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
        ).run(row.churchId, userId, chatId, name, now, expiresAt);
      } catch {
        // Fallback if column doesn't exist yet
        this.db.prepare(
          'INSERT OR REPLACE INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active) VALUES (?, ?, ?, ?, ?, 1)'
        ).run(row.churchId, userId, chatId, name, now);
      }

      // Mark token as claimed
      this.db.prepare('UPDATE guest_tokens SET telegramChatId = ? WHERE token = ?').run(chatId, token);

      const expireStr = new Date(expiresAt).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric',
      });

      return this.tallyBot.sendMessage(chatId,
        `✅ Welcome, *${name}*!\n\nYou have guest access to *${church.name}* until ${expireStr}.\nType \`help\` to see available commands.`,
        { parse_mode: 'Markdown' }
      );
    });
  }

  // ─── NIGHTLY CLEANUP ──────────────────────────────────────────────────────

  _scheduleNightlyCleanup() {
    // Check every hour — clean up at 2 AM
    this._cleanupTimer = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 2 && now.getMinutes() < 15) {
        this._cleanup().catch(e => console.error('[GuestTokens] Cleanup error:', e.message));
      }
    }, 60 * 60 * 1000);
  }

  async _cleanup() {
    const now = new Date().toISOString();

    // Deactivate expired guest church_tds entries
    try {
      const expired = this.db.prepare(
        'SELECT * FROM guest_tokens WHERE expiresAt < ?'
      ).all(now);

      for (const row of expired) {
        if (row.telegramChatId) {
          try {
            this.db.prepare(
              'UPDATE church_tds SET active = 0 WHERE church_id = ? AND telegram_chat_id = ? AND guest_expires_at IS NOT NULL'
            ).run(row.churchId, String(row.telegramChatId));
          } catch { /* ignore */ }
        }
      }
    } catch { /* guest_tokens may not have entries */ }

    // Also deactivate church_tds with expired guest_expires_at
    try {
      this.db.prepare(
        "UPDATE church_tds SET active = 0 WHERE guest_expires_at IS NOT NULL AND guest_expires_at < ?"
      ).run(now);
    } catch { /* column may not exist */ }

    // Delete expired guest tokens
    const result = this.db.prepare('DELETE FROM guest_tokens WHERE expiresAt < ?').run(now);
    if (result.changes > 0) {
      console.log(`[GuestTokens] Cleaned up ${result.changes} expired token(s)`);
    }
  }
}

module.exports = { GuestTokens };
