/**
 * ChatEngine - Unified chat across Electron app, Telegram, and admin dashboard
 *
 * Messages are persisted in the shared DB runtime and linked to active service
 * sessions. Storage is handled here; broadcasting is wired by server.js.
 */

const { v4: uuidv4 } = require('uuid');

const { createQueryClient } = require('./db');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

class ChatEngine {
  /**
   * @param {object} dbOrClient
   * @param {object} opts
   * @param {object} opts.sessionRecap - SessionRecap instance for session linking
   * @param {object} [opts.config]
   */
  constructor(dbOrClient, opts = {}) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient, opts);
    this.sessionRecap = opts.sessionRecap || null;
    if (this.db) {
      this._ensureTableSync();
      this.ready = Promise.resolve();
    } else {
      this.ready = this.client ? this._init() : Promise.resolve();
    }

    // These are set after construction by server.js
    this._broadcastToChurch = null;      // (churchId, msg) => void
    this._broadcastToControllers = null; // (msg) => void
    this._notifyTelegram = null;         // (churchId, msg) => void
  }

  _resolveClient(dbOrClient, opts = {}) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: opts.config || SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client) throw new Error('[ChatEngine] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTable();
  }

  _ensureTableSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        session_id TEXT,
        room_id TEXT,
        timestamp TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL
      )
    `);

    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_chat_church_ts ON chat_messages (church_id, timestamp)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages (session_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages (church_id, room_id, timestamp)');
    } catch {
      // indexes may already exist
    }

    try {
      this.db.exec('ALTER TABLE chat_messages ADD COLUMN room_id TEXT');
    } catch {
      // column already exists
    }
  }

  /**
   * Wire broadcast functions after all systems are initialized.
   */
  setBroadcasters({ broadcastToChurch, broadcastToControllers, broadcastToMobile, notifyTelegram }) {
    if (broadcastToChurch) this._broadcastToChurch = broadcastToChurch;
    if (broadcastToControllers) this._broadcastToControllers = broadcastToControllers;
    if (broadcastToMobile) this._broadcastToMobile = broadcastToMobile;
    if (notifyTelegram) this._notifyTelegram = notifyTelegram;
  }

  async _ensureTable() {
    const client = this._requireClient();
    await client.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        session_id TEXT,
        room_id TEXT,
        timestamp TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL
      )
    `);

    try {
      await client.exec('CREATE INDEX IF NOT EXISTS idx_chat_church_ts ON chat_messages (church_id, timestamp)');
      await client.exec('CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages (session_id)');
      await client.exec('CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages (church_id, room_id, timestamp)');
    } catch {
      // indexes may already exist
    }

    try {
      await client.exec('ALTER TABLE chat_messages ADD COLUMN room_id TEXT');
    } catch {
      // column already exists
    }
  }

  // --- SAVE & RETRIEVE ------------------------------------------------------

  /**
   * Save a chat message and return the full saved object.
   * @param {object} opts
   * @param {string} opts.churchId
   * @param {string} opts.senderName
   * @param {string} opts.senderRole - 'td' | 'admin' | 'system'
   * @param {string} opts.source     - 'telegram' | 'app' | 'dashboard'
   * @param {string} opts.message
   * @returns {Promise<object>} The saved message with id, timestamp, session_id
   */
  saveMessage({ churchId, senderName, senderRole, source, message, roomId }) {
    if (this.db) {
      const id = uuidv4();
      const timestamp = new Date().toISOString();
      const sessionId = this.sessionRecap?.getActiveSessionId(churchId) || null;

      this.db.prepare(
        `INSERT INTO chat_messages (id, church_id, session_id, room_id, timestamp, sender_name, sender_role, source, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, churchId, sessionId, roomId || null, timestamp, senderName, senderRole, source, message);

      return {
        id,
        church_id: churchId,
        session_id: sessionId,
        room_id: roomId || null,
        timestamp,
        sender_name: senderName,
        sender_role: senderRole,
        source,
        message,
      };
    }

    return this._saveMessageAsync({ churchId, senderName, senderRole, source, message, roomId });
  }

  async _saveMessageAsync({ churchId, senderName, senderRole, source, message, roomId }) {
    await this.ready;
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    const sessionId = this.sessionRecap?.getActiveSessionId(churchId) || null;

    await this._requireClient().run(
      `INSERT INTO chat_messages (id, church_id, session_id, room_id, timestamp, sender_name, sender_role, source, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, churchId, sessionId, roomId || null, timestamp, senderName, senderRole, source, message]
    );

    return {
      id,
      church_id: churchId,
      session_id: sessionId,
      room_id: roomId || null,
      timestamp,
      sender_name: senderName,
      sender_role: senderRole,
      source,
      message,
    };
  }

  /**
   * Get chat messages for a church.
   * @param {string} churchId
   * @param {object} opts
   * @param {string} [opts.since]     - ISO timestamp, return only messages after this
   * @param {number} [opts.limit=50]  - Max messages to return
   * @param {string} [opts.sessionId] - Filter by session ID
   * @returns {Promise<Array>} Messages ordered by timestamp ASC
   */
  getMessages(churchId, { since, limit, sessionId, roomId, latest } = {}) {
    if (this.db) {
      const conditions = ['church_id = ?'];
      const params = [churchId];

      if (roomId) {
        conditions.push('(room_id = ? OR room_id IS NULL)');
        params.push(roomId);
      }

      if (since) {
        conditions.push('timestamp > ?');
        params.push(since);
      }

      if (sessionId) {
        conditions.push('session_id = ?');
        params.push(sessionId);
      }

      const maxMessages = Math.min(parseInt(limit, 10) || 50, 200);
      params.push(maxMessages);

      if (latest) {
        const rows = this.db.prepare(
          `SELECT * FROM chat_messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`
        ).all(...params);
        return rows.reverse();
      }

      return this.db.prepare(
        `SELECT * FROM chat_messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp ASC LIMIT ?`
      ).all(...params);
    }

    return this._getMessagesAsync(churchId, { since, limit, sessionId, roomId, latest });
  }

  async _getMessagesAsync(churchId, { since, limit, sessionId, roomId, latest } = {}) {
    await this.ready;
    const conditions = ['church_id = ?'];
    const params = [churchId];

    if (roomId) {
      conditions.push('(room_id = ? OR room_id IS NULL)');
      params.push(roomId);
    }

    if (since) {
      conditions.push('timestamp > ?');
      params.push(since);
    }

    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }

    const maxMessages = Math.min(parseInt(limit, 10) || 50, 200);
    params.push(maxMessages);

    if (latest) {
      const rows = await this._requireClient().query(
        `SELECT * FROM chat_messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`,
        params
      );
      return rows.reverse();
    }

    return this._requireClient().query(
      `SELECT * FROM chat_messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp ASC LIMIT ?`,
      params
    );
  }

  // --- CONVERSATION HISTORY (for AI memory) --------------------------------

  /**
   * Get recent conversation formatted for the Anthropic Messages API.
   * Returns alternating user/assistant turns suitable for the `messages[]` param.
   *
   * @param {string} churchId
   * @param {object} [opts]
   * @param {number} [opts.limit=10]          - Max messages to fetch
   * @param {number} [opts.maxAgeMinutes=30]  - Only include messages this recent
   * @returns {Promise<Array<{role: string, content: string}>>}
   */
  getRecentConversation(churchId, { limit = 10, maxAgeMinutes = 30, roomId } = {}) {
    if (this.db) {
      const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

      const conditions = ['church_id = ?', 'timestamp > ?'];
      const queryParams = [churchId, cutoff];
      if (roomId) {
        conditions.push('(room_id = ? OR room_id IS NULL)');
        queryParams.push(roomId);
      }
      queryParams.push(limit);

      const rows = this.db.prepare(
        `SELECT sender_role, message
         FROM chat_messages
         WHERE ${conditions.join(' AND ')}
         ORDER BY timestamp DESC
         LIMIT ?`
      ).all(...queryParams);

      return this._buildConversation(rows);
    }

    return this._getRecentConversationAsync(churchId, { limit, maxAgeMinutes, roomId });
  }

  async _getRecentConversationAsync(churchId, { limit = 10, maxAgeMinutes = 30, roomId } = {}) {
    await this.ready;
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

    const conditions = ['church_id = ?', 'timestamp > ?'];
    const queryParams = [churchId, cutoff];
    if (roomId) {
      conditions.push('(room_id = ? OR room_id IS NULL)');
      queryParams.push(roomId);
    }
    queryParams.push(limit);

    const rows = await this._requireClient().query(
      `SELECT sender_role, message
       FROM chat_messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY timestamp DESC
       LIMIT ?`,
      queryParams
    );

    return this._buildConversation(rows);
  }

  _buildConversation(rows) {
    if (!rows.length) return [];

    rows.reverse();

    const mapped = [];
    for (const row of rows) {
      if (row.sender_role === 'system') {
        const msg = row.message.trim();
        if (/^[✅❌⚠️📤🎛️🎥📺🔄]/.test(msg)) continue;
        if (msg.startsWith('Uploading') || msg.startsWith('Parsing') || msg.startsWith('Applying')) continue;
        mapped.push({ role: 'assistant', content: msg });
      } else {
        mapped.push({ role: 'user', content: row.message });
      }
    }

    if (!mapped.length) return [];

    const merged = [mapped[0]];
    for (let i = 1; i < mapped.length; i++) {
      const prev = merged[merged.length - 1];
      if (mapped[i].role === prev.role) {
        prev.content += '\n' + mapped[i].content;
      } else {
        merged.push(mapped[i]);
      }
    }

    while (merged.length && merged[0].role !== 'user') {
      merged.shift();
    }

    if (merged.length > 2 && merged[merged.length - 1].role === 'user') {
      merged.pop();
    } else if (merged.length === 1 && merged[0].role === 'user') {
      merged.pop();
    }

    return merged;
  }

  // --- RETENTION / PRUNING --------------------------------------------------

  /**
   * Delete chat messages older than `retentionDays`.
   * Called nightly by the server scheduler.
   * @param {number} [retentionDays=30]
   * @returns {Promise<{ deleted: number }>}
   */
  pruneOldMessages(retentionDays = 30) {
    if (this.db) {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const result = this.db.prepare('DELETE FROM chat_messages WHERE timestamp < ?').run(cutoff);
      if (result.changes > 0) {
        console.log(`[ChatEngine] Pruned ${result.changes} messages older than ${retentionDays} days`);
      }
      return { deleted: result.changes };
    }

    return this._pruneOldMessagesAsync(retentionDays);
  }

  async _pruneOldMessagesAsync(retentionDays = 30) {
    await this.ready;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = await this._requireClient().run(
      'DELETE FROM chat_messages WHERE timestamp < ?',
      [cutoff]
    );
    if (result.changes > 0) {
      console.log(`[ChatEngine] Pruned ${result.changes} messages older than ${retentionDays} days`);
    }
    return { deleted: result.changes };
  }

  // --- BROADCAST ------------------------------------------------------------

  /**
   * Broadcast a saved message to all surfaces EXCEPT the originating source.
   * @param {object} savedMessage - Message object from saveMessage()
   */
  broadcastChat(savedMessage) {
    const wsMsg = { type: 'chat', ...savedMessage };

    if (savedMessage.source !== 'app' && this._broadcastToChurch) {
      try { this._broadcastToChurch(savedMessage.church_id, wsMsg); } catch (e) {
        console.warn('[ChatEngine] Failed to broadcast to church:', e.message);
      }
    }

    if (this._broadcastToControllers) {
      try { this._broadcastToControllers(wsMsg); } catch (e) {
        console.warn('[ChatEngine] Failed to broadcast to controllers:', e.message);
      }
    }

    if (savedMessage.source !== 'app' && this._broadcastToMobile) {
      try { this._broadcastToMobile(savedMessage.church_id, wsMsg); } catch (e) {
        console.warn('[ChatEngine] Failed to broadcast to mobile:', e.message);
      }
    }

    if (savedMessage.source !== 'telegram' && this._notifyTelegram) {
      try { this._notifyTelegram(savedMessage.church_id, savedMessage); } catch (e) {
        console.warn('[ChatEngine] Failed to notify Telegram:', e.message);
      }
    }
  }
}

module.exports = { ChatEngine };
