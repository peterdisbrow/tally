/**
 * ChatEngine — Unified chat across Electron app, Telegram, and admin dashboard
 *
 * Messages are persisted in SQLite and linked to active service sessions.
 * The engine handles storage and retrieval; broadcasting is wired by server.js.
 */

const { v4: uuidv4 } = require('uuid');

class ChatEngine {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} opts
   * @param {object} opts.sessionRecap - SessionRecap instance for session linking
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.sessionRecap = opts.sessionRecap || null;
    this._ensureTable();

    // These are set after construction by server.js
    this._broadcastToChurch = null;     // (churchId, msg) => void
    this._broadcastToControllers = null; // (msg) => void
    this._notifyTelegram = null;         // (churchId, msg) => void
  }

  /**
   * Wire broadcast functions after all systems are initialized.
   */
  setBroadcasters({ broadcastToChurch, broadcastToControllers, notifyTelegram }) {
    if (broadcastToChurch) this._broadcastToChurch = broadcastToChurch;
    if (broadcastToControllers) this._broadcastToControllers = broadcastToControllers;
    if (notifyTelegram) this._notifyTelegram = notifyTelegram;
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        session_id TEXT,
        timestamp TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL
      )
    `);

    // Indexes for efficient queries
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_chat_church_ts ON chat_messages (church_id, timestamp)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages (session_id)');
    } catch { /* indexes may already exist */ }
  }

  // ─── SAVE & RETRIEVE ────────────────────────────────────────────────────────

  /**
   * Save a chat message and return the full saved object.
   * @param {object} opts
   * @param {string} opts.churchId
   * @param {string} opts.senderName
   * @param {string} opts.senderRole - 'td' | 'admin' | 'system'
   * @param {string} opts.source     - 'telegram' | 'app' | 'dashboard'
   * @param {string} opts.message
   * @returns {object} The saved message with id, timestamp, session_id
   */
  saveMessage({ churchId, senderName, senderRole, source, message }) {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    const sessionId = this.sessionRecap?.getActiveSessionId(churchId) || null;

    this.db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, churchId, sessionId, timestamp, senderName, senderRole, source, message);

    return { id, church_id: churchId, session_id: sessionId, timestamp, sender_name: senderName, sender_role: senderRole, source, message };
  }

  /**
   * Get chat messages for a church.
   * @param {string} churchId
   * @param {object} opts
   * @param {string} [opts.since]     - ISO timestamp, return only messages after this
   * @param {number} [opts.limit=50]  - Max messages to return
   * @param {string} [opts.sessionId] - Filter by session ID
   * @returns {Array} Messages ordered by timestamp ASC
   */
  getMessages(churchId, { since, limit, sessionId } = {}) {
    const conditions = ['church_id = ?'];
    const params = [churchId];

    if (since) {
      conditions.push('timestamp > ?');
      params.push(since);
    }

    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }

    const maxMessages = Math.min(parseInt(limit) || 50, 200);
    params.push(maxMessages);

    return this.db.prepare(
      `SELECT * FROM chat_messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp ASC LIMIT ?`
    ).all(...params);
  }

  // ─── BROADCAST ──────────────────────────────────────────────────────────────

  /**
   * Broadcast a saved message to all surfaces EXCEPT the originating source.
   * @param {object} savedMessage - Message object from saveMessage()
   */
  broadcastChat(savedMessage) {
    const wsMsg = { type: 'chat', ...savedMessage };

    // 1. Send to church client via WebSocket (unless it came from the app)
    if (savedMessage.source !== 'app' && this._broadcastToChurch) {
      try { this._broadcastToChurch(savedMessage.church_id, wsMsg); } catch (e) {
        console.warn('[ChatEngine] Failed to broadcast to church:', e.message);
      }
    }

    // 2. Broadcast to all admin controllers
    if (this._broadcastToControllers) {
      try { this._broadcastToControllers(wsMsg); } catch (e) {
        console.warn('[ChatEngine] Failed to broadcast to controllers:', e.message);
      }
    }

    // 3. Notify via Telegram (unless it came from Telegram)
    if (savedMessage.source !== 'telegram' && this._notifyTelegram) {
      try { this._notifyTelegram(savedMessage.church_id, savedMessage); } catch (e) {
        console.warn('[ChatEngine] Failed to notify Telegram:', e.message);
      }
    }
  }
}

module.exports = { ChatEngine };
