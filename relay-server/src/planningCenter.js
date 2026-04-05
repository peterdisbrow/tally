/**
 * Planning Center Integration
 *
 * Full integration with Planning Center Online (PCO) Services API:
 *   - OAuth 2.0 authorization flow (replaces PAT-only auth)
 *   - Token storage and automatic refresh
 *   - Service plan sync: service types, plans, items, team assignments
 *   - Cached plan data in pc_plans table
 *   - ProPresenter cross-reference for missing song detection
 *   - AI context builder for Tally Engineer queries
 *
 * Auth: OAuth 2.0 (preferred) with Personal Access Token fallback.
 * PCO API: https://api.planningcenteronline.com/services/v2
 */

'use strict';

const crypto = require('crypto');
const { createQueryClient } = require('./db');

const PC_API_BASE = 'https://api.planningcenteronline.com/services/v2';
const PC_OAUTH_AUTHORIZE = 'https://api.planningcenteronline.com/oauth/authorize';
const PC_OAUTH_TOKEN = 'https://api.planningcenteronline.com/oauth/token';
const PC_OAUTH_REVOKE = 'https://api.planningcenteronline.com/oauth/revoke';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Refresh tokens 5 minutes before expiry
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

const CHURCH_CACHE_SELECT = `
  SELECT
    churchId AS "churchId",
    name,
    service_times AS "service_times",
    pc_app_id,
    pc_secret,
    pc_service_type_id,
    pc_sync_enabled,
    pc_writeback_enabled,
    pc_last_synced,
    pc_oauth_access_token,
    pc_oauth_refresh_token,
    pc_oauth_token_expires,
    pc_oauth_connected_at,
    pc_oauth_org_name,
    pc_service_type_ids
  FROM churches
`;

function parseJson(value, fallback = []) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

class PlanningCenter {
  /**
   * @param {import('better-sqlite3').Database|object} dbOrClient
   */
  constructor(dbOrClient) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient);
    this._scheduleEngine = null;
    this._syncTimer = null;
    this._pendingOAuthStates = new Map(); // state → {churchId, codeVerifier, createdAt}
    this._churchCache = new Map(); // churchId -> row
    this._planCache = new Map(); // planId -> row
    this._pendingWrites = new Set();

    if (this.db) {
      this._ensureColumnsSync();
      this._ensurePcPlansTableSync();
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
    if (!this.client && !this.db) throw new Error('[PlanningCenter] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureColumns();
    await this._ensurePcPlansTable();
    await this._loadCache();
  }

  _isDuplicateColumnError(error) {
    return /duplicate column|already exists/i.test(String(error?.message || ''));
  }

  async _query(sql, params = []) {
    if (this.db) return this.db.prepare(sql).all(...params);
    return this._requireClient().query(sql, params);
  }

  async _one(sql, params = []) {
    if (this.db) return this.db.prepare(sql).get(...params) || null;
    return this._requireClient().queryOne(sql, params);
  }

  async _run(sql, params = []) {
    if (this.db) return this.db.prepare(sql).run(...params);
    return this._requireClient().run(sql, params);
  }

  async _exec(sql) {
    if (this.db) return this.db.exec(sql);
    return this._requireClient().exec(sql);
  }

  _setChurchCache(row) {
    if (!row?.churchId) return row;
    this._churchCache.set(row.churchId, { ...row });
    return this._churchCache.get(row.churchId);
  }

  _updateChurchCache(churchId, updates = {}) {
    const existing = this._churchCache.get(churchId) || { churchId };
    const next = { ...existing, ...updates, churchId };
    this._churchCache.set(churchId, next);
    return next;
  }

  _getChurchCached(churchId) {
    return this._churchCache.get(churchId) || null;
  }

  _setPlanCache(row) {
    if (!row?.id) return row;
    this._planCache.set(row.id, { ...row });
    return this._planCache.get(row.id);
  }

  _deletePlanCache(planId) {
    this._planCache.delete(planId);
  }

  _queueWrite(promise) {
    const tracked = Promise.resolve(promise)
      .then(() => ({ ok: true }))
      .catch((error) => {
        console.error('[PlanningCenter] Persist write failed:', error.message);
        return { ok: false, error };
      })
      .finally(() => {
        this._pendingWrites.delete(tracked);
      });
    this._pendingWrites.add(tracked);
    return tracked;
  }

  async flushWrites() {
    await this.ready;
    const pending = [...this._pendingWrites];
    if (!pending.length) return;
    const results = await Promise.all(pending);
    const failure = results.find((result) => !result?.ok);
    if (failure) throw failure.error;
  }

  async _loadCache() {
    const [churchRows, planRows] = await Promise.all([
      this._query(CHURCH_CACHE_SELECT),
      this._query('SELECT * FROM pc_plans'),
    ]);
    this._churchCache.clear();
    this._planCache.clear();
    for (const row of churchRows) this._setChurchCache(row);
    for (const row of planRows) this._setPlanCache(row);
  }

  _getChurch(churchId) {
    if (this.db) {
      return this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId) || null;
    }
    return this._getChurchCached(churchId);
  }

  _getSyncEnabledChurches() {
    if (this.db) {
      return this.db.prepare('SELECT churchId, name FROM churches WHERE pc_sync_enabled = 1').all();
    }
    return [...this._churchCache.values()]
      .filter((church) => church.pc_sync_enabled)
      .map((church) => ({ churchId: church.churchId, name: church.name }));
  }

  async _persistChurchUpdate(sql, params, churchId, cacheUpdates = {}) {
    await this._run(sql, params);
    this._updateChurchCache(churchId, cacheUpdates);
  }

  async _deletePlansForChurch(churchId) {
    await this._run('DELETE FROM pc_plans WHERE church_id = ?', [churchId]);
    for (const [planId, row] of this._planCache.entries()) {
      if (row.church_id === churchId) this._planCache.delete(planId);
    }
  }

  async _upsertPlan(row) {
    const params = [
      row.id,
      row.church_id,
      row.service_type_id,
      row.title,
      row.sort_date,
      row.items_json,
      row.team_json,
      row.times_json,
      row.notes_json,
      row.last_fetched,
      row.pco_updated_at,
    ];

    if (this.db) {
      this.db.prepare(`
        INSERT OR REPLACE INTO pc_plans (
          id, church_id, service_type_id, title, sort_date,
          items_json, team_json, times_json, notes_json, last_fetched, pco_updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...params);
    } else if (this._requireClient().driver === 'postgres') {
      await this._requireClient().run(`
        INSERT INTO pc_plans (
          id, church_id, service_type_id, title, sort_date,
          items_json, team_json, times_json, notes_json, last_fetched, pco_updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          church_id = EXCLUDED.church_id,
          service_type_id = EXCLUDED.service_type_id,
          title = EXCLUDED.title,
          sort_date = EXCLUDED.sort_date,
          items_json = EXCLUDED.items_json,
          team_json = EXCLUDED.team_json,
          times_json = EXCLUDED.times_json,
          notes_json = EXCLUDED.notes_json,
          last_fetched = EXCLUDED.last_fetched,
          pco_updated_at = EXCLUDED.pco_updated_at
      `, params);
    } else {
      await this._requireClient().run(`
        INSERT OR REPLACE INTO pc_plans (
          id, church_id, service_type_id, title, sort_date,
          items_json, team_json, times_json, notes_json, last_fetched, pco_updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, params);
    }

    this._setPlanCache(row);
  }

  _toPlanSummary(row) {
    const items = parseJson(row.items_json, []);
    const team = parseJson(row.team_json, []);
    return {
      id: row.id,
      title: row.title,
      sortDate: row.sort_date,
      serviceTypeId: row.service_type_id,
      itemCount: items.length,
      teamCount: team.length,
      lastFetched: row.last_fetched,
    };
  }

  _toCachedPlan(row) {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.church_id,
      title: row.title,
      sortDate: row.sort_date,
      serviceTypeId: row.service_type_id,
      items: parseJson(row.items_json, []),
      team: parseJson(row.team_json, []),
      times: parseJson(row.times_json, []),
      notes: parseJson(row.notes_json, []),
      lastFetched: row.last_fetched,
    };
  }

  /** Inject the ScheduleEngine so syncs update it directly. */
  setScheduleEngine(scheduleEngine) {
    this._scheduleEngine = scheduleEngine;
  }

  // ─── DATABASE SCHEMA ─────────────────────────────────────────────────────────

  _ensureColumnsSync() {
    const cols = {
      // Legacy PAT columns (kept for backward compat)
      pc_app_id:              'TEXT',
      pc_secret:              'TEXT',
      pc_service_type_id:     'TEXT',
      pc_sync_enabled:        'INTEGER DEFAULT 0',
      pc_writeback_enabled:   'INTEGER DEFAULT 0',
      pc_last_synced:         'TEXT',
      // OAuth columns
      pc_oauth_access_token:  'TEXT',
      pc_oauth_refresh_token: 'TEXT',
      pc_oauth_token_expires: 'TEXT',
      pc_oauth_connected_at:  'TEXT',
      pc_oauth_org_name:      'TEXT',
      pc_service_type_ids:    'TEXT',  // JSON array (multi-service-type support)
    };
    for (const [col, type] of Object.entries(cols)) {
      try {
        this.db.prepare(`SELECT ${col} FROM churches LIMIT 1`).get();
      } catch {
        this.db.exec(`ALTER TABLE churches ADD COLUMN ${col} ${type}`);
      }
    }
  }

  async _ensureColumns() {
    const cols = {
      pc_app_id: 'TEXT',
      pc_secret: 'TEXT',
      pc_service_type_id: 'TEXT',
      pc_sync_enabled: 'INTEGER DEFAULT 0',
      pc_writeback_enabled: 'INTEGER DEFAULT 0',
      pc_last_synced: 'TEXT',
      pc_oauth_access_token: 'TEXT',
      pc_oauth_refresh_token: 'TEXT',
      pc_oauth_token_expires: 'TEXT',
      pc_oauth_connected_at: 'TEXT',
      pc_oauth_org_name: 'TEXT',
      pc_service_type_ids: 'TEXT',
    };
    for (const [col, type] of Object.entries(cols)) {
      try {
        await this._one(`SELECT ${col} FROM churches LIMIT 1`);
      } catch {
        try {
          await this._exec(`ALTER TABLE churches ADD COLUMN ${col} ${type}`);
        } catch (error) {
          if (!this._isDuplicateColumnError(error)) throw error;
        }
      }
    }
  }

  _ensurePcPlansTableSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pc_plans (
        id              TEXT PRIMARY KEY,
        church_id       TEXT NOT NULL,
        service_type_id TEXT NOT NULL,
        title           TEXT,
        sort_date       TEXT,
        items_json      TEXT,
        team_json       TEXT,
        times_json      TEXT,
        notes_json      TEXT,
        last_fetched    TEXT,
        pco_updated_at  TEXT,
        FOREIGN KEY (church_id) REFERENCES churches(churchId)
      )
    `);

    // Create index if not exists
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_plans_church_date ON pc_plans(church_id, sort_date)`);
    } catch { /* index may already exist */ }
  }

  async _ensurePcPlansTable() {
    await this._exec(`
      CREATE TABLE IF NOT EXISTS pc_plans (
        id              TEXT PRIMARY KEY,
        church_id       TEXT NOT NULL,
        service_type_id TEXT NOT NULL,
        title           TEXT,
        sort_date       TEXT,
        items_json      TEXT,
        team_json       TEXT,
        times_json      TEXT,
        notes_json      TEXT,
        last_fetched    TEXT,
        pco_updated_at  TEXT,
        FOREIGN KEY (church_id) REFERENCES churches(churchId)
      )
    `);

    try {
      await this._exec(`CREATE INDEX IF NOT EXISTS idx_pc_plans_church_date ON pc_plans(church_id, sort_date)`);
    } catch { /* index may already exist */ }
  }

  // ─── OAUTH 2.0 FLOW ──────────────────────────────────────────────────────────

  /**
   * Generate an OAuth authorization URL for a church to connect Planning Center.
   * Uses PKCE (Proof Key for Code Exchange) for security.
   *
   * @param {string} churchId
   * @param {string} redirectUri - The callback URL registered with PCO
   * @returns {{authUrl: string, state: string}}
   */
  generateOAuthUrl(churchId, redirectUri) {
    const clientId = process.env.PCO_CLIENT_ID;
    if (!clientId) throw new Error('PCO_CLIENT_ID environment variable not set');

    // Generate PKCE code verifier and challenge
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // State = churchId + CSRF nonce
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = Buffer.from(JSON.stringify({ churchId, nonce })).toString('base64url');

    // Store pending state for verification on callback
    this._pendingOAuthStates.set(state, {
      churchId,
      codeVerifier,
      createdAt: Date.now(),
    });

    // Clean up old pending states (>15 min)
    for (const [key, val] of this._pendingOAuthStates) {
      if (Date.now() - val.createdAt > 15 * 60 * 1000) {
        this._pendingOAuthStates.delete(key);
      }
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'services people',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return {
      authUrl: `${PC_OAUTH_AUTHORIZE}?${params.toString()}`,
      state,
    };
  }

  /**
   * Handle the OAuth callback — exchange authorization code for tokens.
   *
   * @param {string} code - Authorization code from PCO
   * @param {string} state - State parameter for CSRF verification
   * @param {string} redirectUri - Must match the one used in generateOAuthUrl
   * @returns {Promise<{success: boolean, churchId: string, orgName?: string, error?: string}>}
   */
  async handleOAuthCallback(code, state, redirectUri) {
    const clientId = process.env.PCO_CLIENT_ID;
    const clientSecret = process.env.PCO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return { success: false, churchId: null, error: 'PCO OAuth credentials not configured' };
    }

    // Verify state
    const pending = this._pendingOAuthStates.get(state);
    if (!pending) {
      return { success: false, churchId: null, error: 'Invalid or expired OAuth state' };
    }
    this._pendingOAuthStates.delete(state);

    const { churchId, codeVerifier } = pending;

    try {
      // Exchange code for tokens
      const tokenResp = await fetch(PC_OAUTH_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!tokenResp.ok) {
        const errBody = await tokenResp.text();
        console.warn(`[PlanningCenter] OAuth token exchange failed: ${tokenResp.status} ${errBody.slice(0, 200)}`);
        return { success: false, churchId, error: `Token exchange failed (${tokenResp.status})` };
      }

      const tokenData = await tokenResp.json();
      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 7200) * 1000).toISOString();
      const connectedAt = new Date().toISOString();

      // Store tokens
      await this._persistChurchUpdate(`
        UPDATE churches SET
          pc_oauth_access_token = ?,
          pc_oauth_refresh_token = ?,
          pc_oauth_token_expires = ?,
          pc_oauth_connected_at = ?,
          pc_sync_enabled = 1
        WHERE churchId = ?
      `, [
        tokenData.access_token,
        tokenData.refresh_token,
        expiresAt,
        connectedAt,
        churchId,
      ], churchId, {
        pc_oauth_access_token: tokenData.access_token,
        pc_oauth_refresh_token: tokenData.refresh_token,
        pc_oauth_token_expires: expiresAt,
        pc_oauth_connected_at: connectedAt,
        pc_sync_enabled: 1,
      });

      // Fetch org name from PCO
      let orgName = null;
      try {
        const meResp = await fetch('https://api.planningcenteronline.com/people/v2/me', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'TallyConnect (https://tallyconnect.com)',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (meResp.ok) {
          const meData = await meResp.json();
          orgName = meData.data?.attributes?.organization_name ||
                    meData.data?.attributes?.name || null;
        }
      } catch { /* non-fatal */ }

      if (orgName) {
        await this._persistChurchUpdate(
          'UPDATE churches SET pc_oauth_org_name = ? WHERE churchId = ?',
          [orgName, churchId],
          churchId,
          { pc_oauth_org_name: orgName }
        );
      }

      console.log(`[PlanningCenter] OAuth connected for church ${churchId}${orgName ? ` (${orgName})` : ''}`);
      return { success: true, churchId, orgName };
    } catch (e) {
      console.error(`[PlanningCenter] OAuth callback error: ${e.message}`);
      return { success: false, churchId, error: e.message };
    }
  }

  /**
   * Disconnect Planning Center OAuth for a church.
   * Revokes the token at PCO and clears local storage.
   *
   * @param {string} churchId
   * @returns {Promise<{disconnected: boolean}>}
   */
  async disconnect(churchId) {
    const church = this._getChurch(churchId);

    // Try to revoke at PCO (best effort)
    if (church?.pc_oauth_access_token) {
      try {
        const clientId = process.env.PCO_CLIENT_ID;
        const clientSecret = process.env.PCO_CLIENT_SECRET;
        if (clientId && clientSecret) {
          await fetch(PC_OAUTH_REVOKE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              token: church.pc_oauth_access_token,
            }),
            signal: AbortSignal.timeout(5000),
          });
        }
      } catch { /* best effort revoke */ }
    }

    // Clear all OAuth columns
    await this._persistChurchUpdate(`
      UPDATE churches SET
        pc_oauth_access_token = NULL,
        pc_oauth_refresh_token = NULL,
        pc_oauth_token_expires = NULL,
        pc_oauth_connected_at = NULL,
        pc_oauth_org_name = NULL,
        pc_service_type_ids = NULL
      WHERE churchId = ?
    `, [churchId], churchId, {
      pc_oauth_access_token: null,
      pc_oauth_refresh_token: null,
      pc_oauth_token_expires: null,
      pc_oauth_connected_at: null,
      pc_oauth_org_name: null,
      pc_service_type_ids: null,
    });

    // Clear cached plans
    await this._deletePlansForChurch(churchId);

    console.log(`[PlanningCenter] Disconnected OAuth for church ${churchId}`);
    return { disconnected: true };
  }

  // ─── TOKEN MANAGEMENT ────────────────────────────────────────────────────────

  /**
   * Get valid auth headers for a church.
   * Checks OAuth first, falls back to PAT. Auto-refreshes OAuth tokens.
   *
   * @param {string} churchId
   * @returns {Promise<{headers: object, authType: string}|null>}
   */
  async _getAuthHeaders(churchId) {
    const church = this._getChurch(churchId);
    if (!church) return null;

    // Try OAuth first
    if (church.pc_oauth_access_token && church.pc_oauth_refresh_token) {
      let accessToken = church.pc_oauth_access_token;

      // Check if token needs refresh
      if (church.pc_oauth_token_expires) {
        const expiresAt = new Date(church.pc_oauth_token_expires).getTime();
        if (Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER_MS) {
          accessToken = await this._refreshOAuthToken(churchId, church.pc_oauth_refresh_token);
          if (!accessToken) {
            // Refresh failed — try PAT fallback
            return this._getPATHeaders(church);
          }
        }
      }

      return {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'TallyConnect (https://tallyconnect.com)',
          'X-PCO-API-Version': '2018-11-01',
        },
        authType: 'oauth',
      };
    }

    // Fall back to PAT
    return this._getPATHeaders(church);
  }

  /**
   * Build auth headers from PAT credentials (legacy).
   * @param {object} church - DB row
   * @returns {{headers: object, authType: string}|null}
   */
  _getPATHeaders(church) {
    if (!church.pc_app_id || !church.pc_secret) return null;
    const credentials = Buffer.from(`${church.pc_app_id}:${church.pc_secret}`).toString('base64');
    return {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'User-Agent': 'TallyConnect (https://tallyconnect.com)',
        'X-PCO-API-Version': '2018-11-01',
      },
      authType: 'pat',
    };
  }

  /**
   * Refresh an OAuth access token using the refresh token.
   *
   * @param {string} churchId
   * @param {string} refreshToken
   * @returns {Promise<string|null>} New access token, or null on failure
   */
  async _refreshOAuthToken(churchId, refreshToken) {
    const clientId = process.env.PCO_CLIENT_ID;
    const clientSecret = process.env.PCO_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    try {
      const resp = await fetch(PC_OAUTH_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        const body = await resp.text();
        console.warn(`[PlanningCenter] Token refresh failed for ${churchId}: ${resp.status} ${body.slice(0, 100)}`);

        // If refresh token is revoked/expired, mark church as disconnected
        if (resp.status === 401 || resp.status === 400) {
          await this._persistChurchUpdate(`
            UPDATE churches SET
              pc_oauth_access_token = NULL,
              pc_oauth_token_expires = NULL
            WHERE churchId = ?
          `, [churchId], churchId, {
            pc_oauth_access_token: null,
            pc_oauth_token_expires: null,
          });
          console.warn(`[PlanningCenter] OAuth token expired/revoked for ${churchId} — marked disconnected`);
        }
        return null;
      }

      const data = await resp.json();
      const expiresAt = new Date(Date.now() + (data.expires_in || 7200) * 1000).toISOString();

      // Update stored tokens
      await this._persistChurchUpdate(`
        UPDATE churches SET
          pc_oauth_access_token = ?,
          pc_oauth_refresh_token = ?,
          pc_oauth_token_expires = ?
        WHERE churchId = ?
      `, [data.access_token, data.refresh_token || refreshToken, expiresAt, churchId], churchId, {
        pc_oauth_access_token: data.access_token,
        pc_oauth_refresh_token: data.refresh_token || refreshToken,
        pc_oauth_token_expires: expiresAt,
      });

      console.log(`[PlanningCenter] Token refreshed for church ${churchId}`);
      return data.access_token;
    } catch (e) {
      console.warn(`[PlanningCenter] Token refresh error for ${churchId}: ${e.message}`);
      return null;
    }
  }

  // ─── PLANNING CENTER API ─────────────────────────────────────────────────────

  /**
   * Internal helper: make a PC API request with error handling for rate limits and auth failures.
   * @param {string} url
   * @param {object} headers
   * @param {object} [options] - Additional fetch options (method, body, etc.)
   * @returns {Promise<Response>}
   */
  async _pcFetch(url, headers, options = {}) {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
      ...options,
    });

    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 429) {
        throw new Error(`Planning Center rate limit exceeded (429): ${body.slice(0, 100)}`);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`Planning Center auth failure (${resp.status}): ${body.slice(0, 100)}`);
      }
      if (resp.status === 404) {
        throw new Error(`Planning Center resource not found (404): ${body.slice(0, 100)}`);
      }
      throw new Error(`Planning Center API error (${resp.status}): ${body.slice(0, 100)}`);
    }

    return resp;
  }

  /**
   * Fetch all pages from a paginated PCO endpoint.
   * @param {string} baseUrl
   * @param {object} headers
   * @param {number} [maxPages=5]
   * @returns {Promise<Array>}
   */
  async _pcFetchAll(baseUrl, headers, maxPages = 5) {
    const allData = [];
    let url = baseUrl;
    let page = 0;

    while (url && page < maxPages) {
      const resp = await this._pcFetch(url, headers);
      const json = await resp.json();
      const items = json.data || [];
      allData.push(...items);

      // Follow next link if present
      url = json.links?.next || json.meta?.next?.href || null;
      page++;
    }

    return allData;
  }

  // ─── SERVICE TYPES ────────────────────────────────────────────────────────────

  /**
   * Fetch available service types from Planning Center.
   * @param {string} churchId
   * @returns {Promise<Array<{id, name, frequency, lastPlanFrom}>>}
   */
  async getServiceTypes(churchId) {
    const auth = await this._getAuthHeaders(churchId);
    if (!auth) throw new Error('No Planning Center auth configured');

    const url = `${PC_API_BASE}/service_types`;
    const resp = await this._pcFetch(url, auth.headers);
    const data = await resp.json();

    return (data.data || []).map(st => ({
      id: st.id,
      name: st.attributes?.name || 'Unknown',
      frequency: st.attributes?.frequency || null,
      lastPlanFrom: st.attributes?.last_plan_from || null,
    }));
  }

  // ─── PLAN SYNC ────────────────────────────────────────────────────────────────

  /**
   * Fetch upcoming service plans from Planning Center.
   * Supports both OAuth and PAT auth.
   *
   * @param {string} appId
   * @param {string} secret
   * @param {string} serviceTypeId
   * @returns {Promise<Array<{planId, date, dayOfWeek, dayName, startHour, startMin, startTime, title}>>}
   */
  async getUpcomingServices(appId, secret, serviceTypeId) {
    const credentials = Buffer.from(`${appId}:${secret}`).toString('base64');
    const url = `${PC_API_BASE}/service_types/${serviceTypeId}/plans?filter=future&per_page=10&order=sort_date`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Planning Center API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    const plans = data.data || [];

    return plans.map(plan => {
      const sortDate = plan.attributes?.sort_date;
      if (!sortDate) return null;
      const date = new Date(sortDate);
      return {
        planId:    plan.id,
        date:      date.toISOString(),
        dayOfWeek: date.getDay(),
        dayName:   DAYS[date.getDay()],
        startHour: date.getHours(),
        startMin:  date.getMinutes(),
        startTime: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
        title:     plan.attributes?.title || `Service (${date.toLocaleDateString()})`,
      };
    }).filter(Boolean);
  }

  /**
   * Convenience wrapper — loads credentials from DB for a church.
   * @param {string} churchId
   */
  async getUpcomingServicesForChurch(churchId) {
    const church = this._getChurch(churchId);
    if (!church) throw new Error('Church not found');
    if (!church.pc_app_id || !church.pc_secret || !church.pc_service_type_id) {
      throw new Error('Planning Center credentials not configured for this church');
    }
    return this.getUpcomingServices(church.pc_app_id, church.pc_secret, church.pc_service_type_id);
  }

  /**
   * Fetch full plan data (items, team, times) for a specific plan.
   * Stores in pc_plans table for caching.
   *
   * @param {string} churchId
   * @param {string} serviceTypeId
   * @param {string} planId
   * @returns {Promise<{plan: object, items: Array, team: Array, times: Array}>}
   */
  async fetchFullPlan(churchId, serviceTypeId, planId) {
    const auth = await this._getAuthHeaders(churchId);
    if (!auth) throw new Error('No Planning Center auth configured');

    const baseUrl = `${PC_API_BASE}/service_types/${serviceTypeId}/plans/${planId}`;

    // Fetch plan details
    const planResp = await this._pcFetch(baseUrl, auth.headers);
    const planData = await planResp.json();
    const plan = planData.data;

    // Fetch items with song/arrangement sideloading
    const itemsUrl = `${baseUrl}/items?include=song,arrangement,item_notes,key&per_page=100`;
    const itemsResp = await this._pcFetch(itemsUrl, auth.headers);
    const itemsData = await itemsResp.json();
    const rawItems = itemsData.data || [];
    const included = itemsData.included || [];

    // Build lookup map for included resources
    const includedMap = new Map();
    for (const inc of included) {
      includedMap.set(`${inc.type}:${inc.id}`, inc);
    }

    // Normalize items
    const items = rawItems.map(item => {
      const attrs = item.attributes || {};
      const result = {
        id: item.id,
        sequence: attrs.sequence,
        itemType: attrs.item_type || 'item',
        title: attrs.title || '',
        servicePosition: attrs.service_position || 'during',
        lengthSeconds: attrs.length || null,
        description: attrs.description || null,
        notes: [],
      };

      // Resolve song relationship
      const songRel = item.relationships?.song?.data;
      if (songRel) {
        const song = includedMap.get(`Song:${songRel.id}`);
        if (song) {
          result.songId = songRel.id;
          result.songTitle = song.attributes?.title || null;
          result.ccliNumber = song.attributes?.ccli_number || null;
          result.author = song.attributes?.author || null;
        }
      }

      // Resolve arrangement relationship
      const arrRel = item.relationships?.arrangement?.data;
      if (arrRel) {
        const arr = includedMap.get(`Arrangement:${arrRel.id}`);
        if (arr) {
          result.arrangementKey = arr.attributes?.chord_chart_key || null;
          result.arrangementBpm = arr.attributes?.bpm || null;
          result.arrangementName = arr.attributes?.name || null;
        }
      }

      // Resolve key relationship
      const keyRel = item.relationships?.key?.data;
      if (keyRel) {
        const key = includedMap.get(`Key:${keyRel.id}`);
        if (key) {
          result.arrangementKey = result.arrangementKey || key.attributes?.name || null;
        }
      }

      // Collect item notes from included
      const noteRels = item.relationships?.item_notes?.data || [];
      for (const noteRef of noteRels) {
        const note = includedMap.get(`ItemNote:${noteRef.id}`);
        if (note) {
          result.notes.push(note.attributes?.content || '');
        }
      }

      return result;
    });

    // Fetch team members
    const teamUrl = `${baseUrl}/team_members?include=team&per_page=100`;
    const teamResp = await this._pcFetch(teamUrl, auth.headers);
    const teamData = await teamResp.json();
    const rawTeam = teamData.data || [];
    const teamIncluded = teamData.included || [];

    const teamMap = new Map();
    for (const t of teamIncluded) {
      if (t.type === 'Team') teamMap.set(t.id, t);
    }

    const team = rawTeam.map(member => {
      const attrs = member.attributes || {};
      const teamRel = member.relationships?.team?.data;
      const teamObj = teamRel ? teamMap.get(teamRel.id) : null;

      return {
        id: member.id,
        name: attrs.name || '',
        teamName: teamObj?.attributes?.name || '',
        position: attrs.team_position_name || '',
        status: attrs.status || 'U',
        statusLabel: attrs.status === 'C' ? 'Confirmed'
          : attrs.status === 'D' ? 'Declined'
          : 'Unconfirmed',
        photoUrl: attrs.photo_thumbnail || null,
      };
    });

    // Fetch plan times
    const timesUrl = `${baseUrl}/plan_times?per_page=50`;
    const timesResp = await this._pcFetch(timesUrl, auth.headers);
    const timesData = await timesResp.json();
    const rawTimes = timesData.data || [];

    const times = rawTimes.map(t => {
      const attrs = t.attributes || {};
      return {
        id: t.id,
        name: attrs.name || '',
        timeType: attrs.time_type || 'service',
        startsAt: attrs.starts_at || null,
        endsAt: attrs.ends_at || null,
      };
    });

    // Cache in pc_plans table
    const now = new Date().toISOString();
    await this._upsertPlan({
      id: planId,
      church_id: churchId,
      service_type_id: serviceTypeId,
      title: plan.attributes?.title || '',
      sort_date: plan.attributes?.sort_date || '',
      items_json: JSON.stringify(items),
      team_json: JSON.stringify(team),
      times_json: JSON.stringify(times),
      notes_json: JSON.stringify([]),
      last_fetched: now,
      pco_updated_at: plan.attributes?.updated_at || now,
    });

    return { plan: plan.attributes, items, team, times };
  }

  /**
   * Sync all upcoming plans for a church across all configured service types.
   * Fetches full item/team/time data for each plan.
   *
   * @param {string} churchId
   * @returns {Promise<{synced: number, plans: Array}>}
   */
  async syncFullPlans(churchId) {
    const church = this._getChurch(churchId);
    if (!church) throw new Error('Church not found');

    // Support both new multi-type array and legacy single type
    let serviceTypeIds = [];
    if (church.pc_service_type_ids) {
      try { serviceTypeIds = JSON.parse(church.pc_service_type_ids); } catch { /* ignore */ }
    }
    if (!serviceTypeIds.length && church.pc_service_type_id) {
      serviceTypeIds = [church.pc_service_type_id];
    }
    if (!serviceTypeIds.length) {
      throw new Error('No service types configured for Planning Center sync');
    }

    const auth = await this._getAuthHeaders(churchId);
    if (!auth) throw new Error('No Planning Center auth configured');

    const syncedPlans = [];

    for (const stId of serviceTypeIds) {
      try {
        // Fetch future plans for this service type
        const plansUrl = `${PC_API_BASE}/service_types/${stId}/plans?filter=future&per_page=10&order=sort_date`;
        const plansResp = await this._pcFetch(plansUrl, auth.headers);
        const plansData = await plansResp.json();
        const plans = plansData.data || [];

        // Fetch full data for each plan (limit to next 4 weeks)
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() + 28);

        for (const plan of plans) {
          const sortDate = plan.attributes?.sort_date;
          if (!sortDate) continue;
          if (new Date(sortDate) > cutoff) continue;

          // Check if we need to re-fetch (compare pco_updated_at)
          const cached = this.db
            ? this.db.prepare('SELECT pco_updated_at FROM pc_plans WHERE id = ?').get(plan.id)
            : this._planCache.get(plan.id) || null;
          const pcoUpdatedAt = plan.attributes?.updated_at || '';

          if (cached && cached.pco_updated_at === pcoUpdatedAt) {
            // No changes, skip full fetch but include in results
            syncedPlans.push({ planId: plan.id, skipped: true });
            continue;
          }

          try {
            const fullPlan = await this.fetchFullPlan(churchId, stId, plan.id);
            syncedPlans.push({
              planId: plan.id,
              title: fullPlan.plan?.title || '',
              date: fullPlan.plan?.sort_date || '',
              itemCount: fullPlan.items.length,
              teamCount: fullPlan.team.length,
            });
          } catch (e) {
            console.warn(`[PlanningCenter] Failed to fetch plan ${plan.id}: ${e.message}`);
          }
        }
      } catch (e) {
        console.warn(`[PlanningCenter] Failed to sync service type ${stId}: ${e.message}`);
      }
    }

    // Update last synced
    const lastSynced = new Date().toISOString();
    await this._persistChurchUpdate(
      'UPDATE churches SET pc_last_synced = ? WHERE churchId = ?',
      [lastSynced, churchId],
      churchId,
      { pc_last_synced: lastSynced }
    );

    console.log(`[PlanningCenter] Full plan sync: ${syncedPlans.length} plan(s) for church ${churchId}`);
    return { synced: syncedPlans.length, plans: syncedPlans };
  }

  // ─── SCHEDULE SYNC ────────────────────────────────────────────────────────────

  /**
   * Sync one church's schedule from Planning Center.
   * On success: updates scheduleEngine with deduplicated (day, time) entries.
   * On failure: logs a warning and leaves existing schedule intact.
   * @param {string} churchId
   * @returns {Promise<{synced: number, services: Array}>}
   */
  async syncChurch(churchId) {
    const church = this._getChurch(churchId);
    if (!church) throw new Error(`Church ${churchId} not found`);

    if (!church.pc_sync_enabled) {
      throw new Error(`Planning Center sync is disabled for "${church.name}"`);
    }

    // Check for any auth (OAuth or PAT)
    const auth = await this._getAuthHeaders(churchId);
    if (!auth) {
      throw new Error(`Church "${church.name}" has no Planning Center credentials configured`);
    }

    console.log(`[PlanningCenter] Syncing schedule for ${church.name}...`);

    // Support multi-service-type
    let serviceTypeIds = [];
    if (church.pc_service_type_ids) {
      try { serviceTypeIds = JSON.parse(church.pc_service_type_ids); } catch { /* ignore */ }
    }
    if (!serviceTypeIds.length && church.pc_service_type_id) {
      serviceTypeIds = [church.pc_service_type_id];
    }
    if (!serviceTypeIds.length) {
      throw new Error('No service types configured');
    }

    const allServices = [];

    for (const stId of serviceTypeIds) {
      try {
        const url = `${PC_API_BASE}/service_types/${stId}/plans?filter=future&per_page=10&order=sort_date`;
        const resp = await this._pcFetch(url, auth.headers);
        const data = await resp.json();
        const plans = data.data || [];

        for (const plan of plans) {
          const sortDate = plan.attributes?.sort_date;
          if (!sortDate) continue;
          const date = new Date(sortDate);
          allServices.push({
            planId:    plan.id,
            date:      date.toISOString(),
            dayOfWeek: date.getDay(),
            dayName:   DAYS[date.getDay()],
            startHour: date.getHours(),
            startMin:  date.getMinutes(),
            startTime: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
            title:     plan.attributes?.title || `Service (${date.toLocaleDateString()})`,
          });
        }
      } catch (e) {
        console.warn(`[PlanningCenter] Failed to fetch service type ${stId}: ${e.message}`);
      }
    }

    if (!allServices.length) {
      console.log(`[PlanningCenter] No upcoming services found for ${church.name}`);
      return { synced: 0, services: [] };
    }

    // Deduplicate by day+time (multiple upcoming instances of same recurring service)
    const seen = new Set();
    const serviceTimes = [];

    for (const svc of allServices) {
      const key = `${svc.dayOfWeek}:${svc.startHour}:${svc.startMin}`;
      if (!seen.has(key)) {
        seen.add(key);
        serviceTimes.push({
          day:          svc.dayOfWeek,
          startHour:    svc.startHour,
          startMin:     svc.startMin,
          durationHours: 2,          // default; override manually if needed
          source:       'planning_center',
        });
      }
    }

    // Apply to scheduleEngine (or DB directly as fallback)
    if (this._scheduleEngine) {
      await this._scheduleEngine.setSchedule(churchId, serviceTimes);
      this._updateChurchCache(churchId, { service_times: JSON.stringify(serviceTimes) });
    } else {
      await this._persistChurchUpdate(
        'UPDATE churches SET service_times = ? WHERE churchId = ?',
        [JSON.stringify(serviceTimes), churchId],
        churchId,
        { service_times: JSON.stringify(serviceTimes) }
      );
    }

    // Persist last-synced timestamp
    const lastSynced = new Date().toISOString();
    await this._persistChurchUpdate(
      'UPDATE churches SET pc_last_synced = ? WHERE churchId = ?',
      [lastSynced, churchId],
      churchId,
      { pc_last_synced: lastSynced }
    );

    // Also sync full plan data if OAuth is available
    if (auth.authType === 'oauth') {
      this.syncFullPlans(churchId).catch(e =>
        console.warn(`[PlanningCenter] Full plan sync failed for ${church.name}: ${e.message}`)
      );
    }

    console.log(`[PlanningCenter] ✅ ${church.name}: synced ${serviceTimes.length} unique service time(s)`);
    return { synced: serviceTimes.length, services: serviceTimes };
  }

  /**
   * Sync all churches that have pc_sync_enabled = 1.
   * Failures are caught per-church so one bad credential doesn't block others.
   */
  async syncAll() {
    const churches = this._getSyncEnabledChurches();
    if (!churches.length) return;

    console.log(`[PlanningCenter] Running sync for ${churches.length} church(es)...`);

    for (const church of churches) {
      try {
        await this.syncChurch(church.churchId);
      } catch (e) {
        console.warn(`[PlanningCenter] ⚠️ Sync failed for ${church.name}: ${e.message} — keeping existing schedule`);
      }
    }
  }

  // ─── CACHED PLAN QUERIES ─────────────────────────────────────────────────────

  /**
   * Get upcoming cached plans for a church.
   * @param {string} churchId
   * @param {number} [limit=5]
   * @returns {Array<{id, title, sortDate, serviceTypeId, itemCount, teamCount, lastFetched}>}
   */
  getCachedPlans(churchId, limit = 5) {
    if (this.db) {
      const rows = this.db.prepare(`
        SELECT id, title, sort_date, service_type_id, items_json, team_json, last_fetched
        FROM pc_plans
        WHERE church_id = ? AND sort_date >= date('now')
        ORDER BY sort_date ASC
        LIMIT ?
      `).all(churchId, limit);
      return rows.map((row) => this._toPlanSummary(row));
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const threshold = todayStart.getTime();
    return [...this._planCache.values()]
      .filter((row) => row.church_id === churchId)
      .filter((row) => {
        const sortTime = Date.parse(row.sort_date || '');
        return Number.isFinite(sortTime) && sortTime >= threshold;
      })
      .sort((a, b) => String(a.sort_date || '').localeCompare(String(b.sort_date || '')))
      .slice(0, limit)
      .map((row) => this._toPlanSummary(row));
  }

  /**
   * Get a specific cached plan with full item and team data.
   * @param {string} planId
   * @returns {{id, title, sortDate, items: Array, team: Array, times: Array, lastFetched}|null}
   */
  getCachedPlan(planId) {
    const row = this.db
      ? this.db.prepare('SELECT * FROM pc_plans WHERE id = ?').get(planId)
      : this._planCache.get(planId) || null;
    return this._toCachedPlan(row);
  }

  /**
   * Get the next upcoming service plan for a church (cached).
   * @param {string} churchId
   * @returns {{id, title, sortDate, items: Array, team: Array, times: Array}|null}
   */
  getNextPlanCached(churchId) {
    if (this.db) {
      const row = this.db.prepare(`
        SELECT * FROM pc_plans
        WHERE church_id = ? AND sort_date >= datetime('now', '-2 hours')
        ORDER BY sort_date ASC
        LIMIT 1
      `).get(churchId);
      return this._toCachedPlan(row);
    }

    const threshold = Date.now() - (2 * 60 * 60 * 1000);
    const row = [...this._planCache.values()]
      .filter((plan) => plan.church_id === churchId)
      .filter((plan) => {
        const sortTime = Date.parse(plan.sort_date || '');
        return Number.isFinite(sortTime) && sortTime >= threshold;
      })
      .sort((a, b) => String(a.sort_date || '').localeCompare(String(b.sort_date || '')))[0] || null;
    return this._toCachedPlan(row);
  }

  // ─── PROPRESENTER CROSS-REFERENCE ────────────────────────────────────────────

  /**
   * Compare PCO service order songs with a ProPresenter playlist.
   * Returns matches, missing songs, and extras.
   *
   * @param {string} planId - PCO plan ID (from pc_plans cache)
   * @param {Array<{name: string}>} ppPlaylistItems - ProPresenter playlist items
   * @returns {{matches: Array, missing: Array, extras: Array, summary: string}}
   */
  crossReferencePP(planId, ppPlaylistItems) {
    const plan = this.getCachedPlan(planId);
    if (!plan) return { matches: [], missing: [], extras: [], summary: 'Plan not found in cache' };

    // Get song items from PCO plan
    const pcoSongs = plan.items.filter(i => i.itemType === 'song');
    const pcoMedia = plan.items.filter(i => i.itemType === 'media');
    const pcoTitles = [...pcoSongs, ...pcoMedia];

    // Normalize function for fuzzy matching
    const normalize = (s) => (s || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const ppNormalized = ppPlaylistItems.map(p => ({
      original: p.name,
      normalized: normalize(p.name),
    }));

    const matches = [];
    const missing = [];
    const matchedPP = new Set();

    for (const pcoItem of pcoTitles) {
      const pcoNorm = normalize(pcoItem.title);
      if (!pcoNorm) continue;

      // Try exact match first, then substring match
      let matched = false;
      for (let i = 0; i < ppNormalized.length; i++) {
        const pp = ppNormalized[i];
        if (matchedPP.has(i)) continue;

        if (pp.normalized === pcoNorm ||
            pp.normalized.includes(pcoNorm) ||
            pcoNorm.includes(pp.normalized) ||
            _levenshteinDistance(pp.normalized, pcoNorm) <= 3) {
          matches.push({
            pcoTitle: pcoItem.title,
            ppTitle: pp.original,
            itemType: pcoItem.itemType,
          });
          matchedPP.add(i);
          matched = true;
          break;
        }
      }

      if (!matched) {
        missing.push({
          title: pcoItem.title,
          itemType: pcoItem.itemType,
          key: pcoItem.arrangementKey || null,
        });
      }
    }

    // Find PP items not in PCO
    const extras = ppNormalized
      .filter((_, i) => !matchedPP.has(i))
      .map(p => ({ title: p.original }));

    const total = pcoTitles.length;
    const found = matches.length;
    const summary = missing.length === 0
      ? `All ${total} PCO items found in ProPresenter`
      : `${found}/${total} PCO items found. Missing: ${missing.map(m => `"${m.title}"`).join(', ')}`;

    return { matches, missing, extras, summary };
  }

  // ─── AI CONTEXT ──────────────────────────────────────────────────────────────

  /**
   * Build PCO context string for AI system prompts.
   * Used by tally-context.js to inject service plan awareness.
   *
   * @param {string} churchId
   * @returns {string} Context block for injection into AI prompts
   */
  buildAIContext(churchId) {
    const nextPlan = this.getNextPlanCached(churchId);
    if (!nextPlan) return '';

    const lines = ['PLANNING CENTER — NEXT SERVICE'];

    // Service info
    const sortDate = nextPlan.sortDate ? new Date(nextPlan.sortDate) : null;
    if (sortDate) {
      const dayName = DAYS[sortDate.getDay()];
      const timeStr = sortDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      lines.push(`Service: ${nextPlan.title || 'Untitled'} (${dayName} ${timeStr})`);
    } else {
      lines.push(`Service: ${nextPlan.title || 'Untitled'}`);
    }

    // Service order
    if (nextPlan.items.length > 0) {
      lines.push('');
      lines.push('Service Order:');
      for (const item of nextPlan.items) {
        let line = `  ${item.sequence || '?'}. [${item.itemType}] ${item.title}`;
        if (item.arrangementKey) line += ` (Key: ${item.arrangementKey})`;
        if (item.arrangementBpm) line += ` (${item.arrangementBpm} BPM)`;
        if (item.lengthSeconds) {
          const mins = Math.floor(item.lengthSeconds / 60);
          const secs = item.lengthSeconds % 60;
          line += ` — ${mins}:${String(secs).padStart(2, '0')}`;
        }
        lines.push(line);
      }
    }

    // Team assignments
    if (nextPlan.team.length > 0) {
      lines.push('');
      lines.push('Team:');
      for (const member of nextPlan.team) {
        const pos = member.position || member.teamName || 'Unassigned';
        lines.push(`  ${pos}: ${member.name} (${member.statusLabel})`);
      }
    }

    // Sync freshness
    if (nextPlan.lastFetched) {
      const fetchedAgo = Date.now() - new Date(nextPlan.lastFetched).getTime();
      const minsAgo = Math.round(fetchedAgo / 60000);
      lines.push('');
      lines.push(`Last synced: ${minsAgo < 60 ? `${minsAgo}m ago` : `${Math.round(minsAgo / 60)}h ago`}`);
    }

    return lines.join('\n');
  }

  // ─── CREDENTIALS ─────────────────────────────────────────────────────────────

  /**
   * Persist Planning Center credentials for a church.
   * Only updates fields that are provided (undefined = leave unchanged).
   * @param {string} churchId
   * @param {{appId?, secret?, serviceTypeId?, syncEnabled?, writebackEnabled?, serviceTypeIds?}} opts
   */
  setCredentials(churchId, { appId, secret, serviceTypeId, syncEnabled, writebackEnabled, serviceTypeIds }) {
    const updates = [];
    const params = [];
    const cacheUpdates = {};

    if (appId !== undefined) {
      updates.push('pc_app_id = ?');
      params.push(appId);
      cacheUpdates.pc_app_id = appId;
    }
    if (secret !== undefined) {
      updates.push('pc_secret = ?');
      params.push(secret);
      cacheUpdates.pc_secret = secret;
    }
    if (serviceTypeId !== undefined) {
      updates.push('pc_service_type_id = ?');
      params.push(serviceTypeId);
      cacheUpdates.pc_service_type_id = serviceTypeId;
    }
    if (syncEnabled !== undefined) {
      updates.push('pc_sync_enabled = ?');
      params.push(syncEnabled ? 1 : 0);
      cacheUpdates.pc_sync_enabled = syncEnabled ? 1 : 0;
    }
    if (writebackEnabled !== undefined) {
      updates.push('pc_writeback_enabled = ?');
      params.push(writebackEnabled ? 1 : 0);
      cacheUpdates.pc_writeback_enabled = writebackEnabled ? 1 : 0;
    }
    if (serviceTypeIds !== undefined) {
      updates.push('pc_service_type_ids = ?');
      params.push(JSON.stringify(serviceTypeIds));
      cacheUpdates.pc_service_type_ids = JSON.stringify(serviceTypeIds);
    }

    if (!updates.length) return;
    params.push(churchId);
    if (this.db) {
      this.db.prepare(`UPDATE churches SET ${updates.join(', ')} WHERE churchId = ?`).run(...params);
      return;
    }

    this._updateChurchCache(churchId, cacheUpdates);
    this._queueWrite(this._run(`UPDATE churches SET ${updates.join(', ')} WHERE churchId = ?`, params));
  }

  /**
   * Return safe public status (NEVER includes credentials/tokens).
   * @param {string} churchId
   * @returns {object|null}
   */
  getStatus(churchId) {
    const church = this._getChurch(churchId);
    if (!church) return null;

    // Determine auth type
    const hasOAuth = !!church.pc_oauth_connected_at;
    const hasPAT = !!church.pc_app_id;
    let authType = 'none';
    if (hasOAuth) authType = 'oauth';
    else if (hasPAT) authType = 'pat';

    // Check if OAuth token is still valid
    let oauthValid = false;
    if (hasOAuth && church.pc_oauth_token_expires) {
      oauthValid = new Date(church.pc_oauth_token_expires).getTime() > Date.now();
    }

    // Parse service type IDs
    let serviceTypeIds = [];
    if (church.pc_service_type_ids) {
      try { serviceTypeIds = JSON.parse(church.pc_service_type_ids); } catch { /* ignore */ }
    }
    if (!serviceTypeIds.length && church.pc_service_type_id) {
      serviceTypeIds = [church.pc_service_type_id];
    }

    // Compute next PC-sourced service
    let nextService = null;
    try {
      const times = parseJson(church.service_times, []);
      const pcTimes = times.filter(t => t.source === 'planning_center');
      if (pcTimes.length) {
        const now = new Date();
        const day = now.getDay();
        const minutesNow = now.getHours() * 60 + now.getMinutes();
        let bestMinutes = Infinity;

        for (const t of pcTimes) {
          const start = t.startHour * 60 + (t.startMin || 0);
          let daysUntil = (t.day - day + 7) % 7;
          let minsUntil = daysUntil * 1440 + (start - minutesNow);
          if (minsUntil <= 0) minsUntil += 7 * 1440;
          if (minsUntil < bestMinutes) {
            bestMinutes = minsUntil;
            nextService = {
              day:       DAYS[t.day],
              startTime: `${String(t.startHour).padStart(2, '0')}:${String(t.startMin || 0).padStart(2, '0')}`,
              minutesUntil: minsUntil,
            };
          }
        }
      }
    } catch { /* ignore parse errors */ }

    // Get cached plan count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const planCount = this.db
      ? (this.db.prepare(
        'SELECT COUNT(*) as count FROM pc_plans WHERE church_id = ? AND sort_date >= date(\'now\')'
      ).get(churchId)?.count || 0)
      : [...this._planCache.values()].filter((plan) => {
        if (plan.church_id !== churchId) return false;
        const sortTime = Date.parse(plan.sort_date || '');
        return Number.isFinite(sortTime) && sortTime >= todayStart.getTime();
      }).length;

    return {
      connected:      authType !== 'none',
      authType,
      oauthValid,
      orgName:        church.pc_oauth_org_name || null,
      connectedAt:    church.pc_oauth_connected_at || null,
      syncEnabled:    !!church.pc_sync_enabled,
      writebackEnabled: !!church.pc_writeback_enabled,
      serviceTypeIds,
      lastSynced:     church.pc_last_synced || null,
      nextService,
      cachedPlanCount: planCount,
    };
  }

  // ─── WRITE-BACK — Push session recaps & data to Planning Center ──────────

  /**
   * Internal helper: build auth headers for a church's PC credentials (legacy PAT).
   * @param {object} church - DB row with pc_app_id and pc_secret
   * @returns {{Authorization: string, 'Content-Type': string}}
   */
  _authHeaders(church) {
    const credentials = Buffer.from(`${church.pc_app_id}:${church.pc_secret}`).toString('base64');
    return {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Internal helper: load and validate a church for write-back operations.
   * Supports both OAuth and PAT auth.
   * @param {string} churchId
   * @returns {Promise<{church: object, headers: object}|{error: {written: boolean, reason: string}}>}
   */
  async _loadChurchForWriteback(churchId) {
    const church = this._getChurch(churchId);
    if (!church) return { error: { written: false, reason: 'Church not found' } };
    if (!church.pc_writeback_enabled) return { error: { written: false, reason: 'Write-back disabled' } };

    const auth = await this._getAuthHeaders(churchId);
    if (!auth) return { error: { written: false, reason: 'PC credentials not configured' } };

    return { church, headers: auth.headers };
  }

  /**
   * Push a full session recap to a Planning Center plan as a production note.
   *
   * @param {string} churchId
   * @param {string} planId  - The specific plan to write to
   * @param {object} recapData - Finalized session object from SessionRecap.endSession()
   * @returns {Promise<{written: boolean, planId?: string, reason?: string}>}
   */
  async pushSessionRecap(churchId, planId, recapData) {
    const loaded = await this._loadChurchForWriteback(churchId);
    if (loaded.error) return loaded.error;
    const { church, headers } = loaded;

    // Resolve service type ID
    const serviceTypeId = this._resolveServiceTypeId(church);
    if (!serviceTypeId) return { written: false, reason: 'No service type configured' };

    try {
      // Verify the plan exists
      const planUrl = `${PC_API_BASE}/service_types/${serviceTypeId}/plans/${planId}`;
      await this._pcFetch(planUrl, headers);

      // Build comprehensive note text
      const grade = recapData.grade || 'N/A';
      const durationMin = recapData.durationMinutes || recapData.duration_minutes || 0;
      const hours = Math.floor(durationMin / 60);
      const mins = durationMin % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      const alerts = recapData.alertCount || recapData.alert_count || 0;
      const autoFixed = recapData.autoRecovered || recapData.auto_recovered_count || 0;
      const escalated = recapData.escalated || recapData.escalated_count || 0;
      const peakViewers = recapData.peakViewers || recapData.peak_viewers;
      const streamTotal = recapData.streamTotalMinutes || recapData.stream_runtime_minutes || 0;
      const streamRan = recapData.streaming !== undefined ? recapData.streaming : (recapData.stream_ran || streamTotal > 0);
      const recordingConfirmed = recapData.recordingConfirmed || recapData.recording_confirmed || false;
      const audioSilence = recapData.audioSilenceCount || recapData.audio_silence_count || 0;
      const tdName = recapData.tdName || recapData.td_name || 'Unknown';

      const streamLine = streamRan ? `Yes (${streamTotal} min)` : 'No';
      const viewersLine = peakViewers != null ? `${peakViewers}` : 'N/A';

      const lines = [
        `--- Tally Production Report ---`,
        `Grade: ${grade}`,
        `Duration: ${durationStr}`,
        `TD: ${tdName}`,
        `Stream: ${streamLine}`,
        `Peak Viewers: ${viewersLine}`,
        `Recording: ${recordingConfirmed ? 'Confirmed' : 'Not confirmed'}`,
        `Alerts: ${alerts} (${autoFixed} auto-recovered, ${escalated} escalated)`,
        `Audio silences: ${audioSilence}`,
      ];

      // Append incident details if any
      const alertTypes = recapData.alertTypes || {};
      if (Object.keys(alertTypes).length > 0) {
        lines.push('');
        lines.push('Incidents:');
        for (const [type, count] of Object.entries(alertTypes)) {
          lines.push(`  - ${type}: ${count}`);
        }
      }

      lines.push(`---`);

      const noteText = lines.join('\n');

      // POST the note to the plan
      const noteUrl = `${PC_API_BASE}/service_types/${serviceTypeId}/plans/${planId}/notes`;
      await this._pcFetch(noteUrl, headers, {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'PlanNote',
            attributes: {
              content: noteText,
              category_name: 'Production',
            },
          },
        }),
      });

      console.log(`[PlanningCenter] Session recap pushed to plan ${planId} for ${church.name || churchId}`);
      return { written: true, planId };
    } catch (e) {
      console.warn(`[PlanningCenter] pushSessionRecap failed for ${church.name || churchId}: ${e.message}`);
      return { written: false, reason: e.message };
    }
  }

  /**
   * Update a Planning Center plan with actual start/end times (vs scheduled).
   *
   * @param {string} churchId
   * @param {string} planId
   * @param {{actualStart: string|Date, actualEnd: string|Date}} actualTimes
   * @returns {Promise<{updated: boolean, planId?: string, reason?: string}>}
   */
  async updateServiceTimes(churchId, planId, actualTimes) {
    const loaded = await this._loadChurchForWriteback(churchId);
    if (loaded.error) return { updated: false, reason: loaded.error.reason };
    const { church, headers } = loaded;

    const serviceTypeId = this._resolveServiceTypeId(church);
    if (!serviceTypeId) return { updated: false, reason: 'No service type configured' };

    try {
      const actualStart = actualTimes.actualStart instanceof Date
        ? actualTimes.actualStart.toISOString()
        : actualTimes.actualStart;
      const actualEnd = actualTimes.actualEnd instanceof Date
        ? actualTimes.actualEnd.toISOString()
        : actualTimes.actualEnd;

      const startTime = new Date(actualStart);
      const endTime = new Date(actualEnd);
      const startStr = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const endStr = endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

      const noteUrl = `${PC_API_BASE}/service_types/${serviceTypeId}/plans/${planId}/notes`;
      await this._pcFetch(noteUrl, headers, {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'PlanNote',
            attributes: {
              content: `--- Actual Service Times ---\nStart: ${startStr} (${actualStart})\nEnd: ${endStr} (${actualEnd})\n---`,
              category_name: 'Production',
            },
          },
        }),
      });

      console.log(`[PlanningCenter] Service times updated on plan ${planId} for ${church.name || churchId}`);
      return { updated: true, planId };
    } catch (e) {
      console.warn(`[PlanningCenter] updateServiceTimes failed for ${church.name || churchId}: ${e.message}`);
      return { updated: false, reason: e.message };
    }
  }

  /**
   * Sync volunteer/TD attendance to a Planning Center plan.
   *
   * @param {string} churchId
   * @param {string} planId
   * @param {Array<{token: string, name: string, churchId: string}>} activeTokens
   * @returns {Promise<{synced: boolean, matched: number, total: number, reason?: string}>}
   */
  async syncVolunteerAttendance(churchId, planId, activeTokens) {
    const loaded = await this._loadChurchForWriteback(churchId);
    if (loaded.error) return { synced: false, matched: 0, total: 0, reason: loaded.error.reason };
    const { church, headers } = loaded;

    const serviceTypeId = this._resolveServiceTypeId(church);
    if (!serviceTypeId) return { synced: false, matched: 0, total: 0, reason: 'No service type configured' };

    try {
      const teamUrl = `${PC_API_BASE}/service_types/${serviceTypeId}/plans/${planId}/team_members`;
      const teamResp = await this._pcFetch(teamUrl, headers);
      const teamData = await teamResp.json();
      const teamMembers = teamData.data || [];

      if (!teamMembers.length) {
        return { synced: true, matched: 0, total: 0 };
      }

      const activeNames = new Set(
        activeTokens
          .filter(t => t.churchId === churchId)
          .map(t => (t.name || '').toLowerCase().trim())
          .filter(Boolean)
      );

      let matched = 0;

      for (const member of teamMembers) {
        const memberName = (member.attributes?.name || '').toLowerCase().trim();
        if (!memberName) continue;

        const isActive = activeNames.has(memberName) ||
          [...activeNames].some(n => memberName.includes(n) || n.includes(memberName));

        if (isActive) {
          try {
            const memberUrl = `${PC_API_BASE}/service_types/${serviceTypeId}/plans/${planId}/team_members/${member.id}`;
            await this._pcFetch(memberUrl, headers, {
              method: 'PATCH',
              body: JSON.stringify({
                data: {
                  type: 'TeamMember',
                  id: member.id,
                  attributes: { status: 'C' },
                },
              }),
            });
            matched++;
          } catch (e) {
            console.warn(`[PlanningCenter] Could not confirm attendance for ${member.attributes?.name}: ${e.message}`);
          }
        }
      }

      console.log(`[PlanningCenter] Volunteer attendance synced: ${matched}/${teamMembers.length} matched for plan ${planId}`);
      return { synced: true, matched, total: teamMembers.length };
    } catch (e) {
      console.warn(`[PlanningCenter] syncVolunteerAttendance failed for ${church.name || churchId}: ${e.message}`);
      return { synced: false, matched: 0, total: 0, reason: e.message };
    }
  }

  /**
   * Fetch upcoming plans with service type info for a church.
   *
   * @param {string} churchId
   * @param {number} [days=7]
   * @returns {Promise<Array>}
   */
  async getUpcomingPlans(churchId, days = 7) {
    const auth = await this._getAuthHeaders(churchId);
    if (!auth) throw new Error('Planning Center credentials not configured for this church');

    const church = this._getChurch(churchId);
    if (!church) throw new Error('Church not found');

    let serviceTypeIds = [];
    if (church.pc_service_type_ids) {
      try { serviceTypeIds = JSON.parse(church.pc_service_type_ids); } catch { /* ignore */ }
    }
    if (!serviceTypeIds.length && church.pc_service_type_id) {
      serviceTypeIds = [church.pc_service_type_id];
    }
    if (!serviceTypeIds.length) throw new Error('No service types configured');

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);
    const allPlans = [];

    for (const stId of serviceTypeIds) {
      // Fetch service type name
      let serviceTypeName = 'Unknown';
      try {
        const stUrl = `${PC_API_BASE}/service_types/${stId}`;
        const stResp = await this._pcFetch(stUrl, auth.headers);
        const stData = await stResp.json();
        serviceTypeName = stData.data?.attributes?.name || 'Unknown';
      } catch { /* non-fatal */ }

      // Fetch future plans
      const url = `${PC_API_BASE}/service_types/${stId}/plans?filter=future&per_page=25&order=sort_date`;
      const resp = await this._pcFetch(url, auth.headers);
      const data = await resp.json();

      for (const plan of (data.data || [])) {
        const sortDate = plan.attributes?.sort_date;
        if (!sortDate) continue;
        const date = new Date(sortDate);
        if (date > cutoff) continue;
        allPlans.push({
          planId: plan.id,
          date: date.toISOString(),
          title: plan.attributes?.title || `Service (${date.toLocaleDateString()})`,
          serviceTypeName,
          serviceTypeId: stId,
          dayName: DAYS[date.getDay()],
          startTime: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
        });
      }
    }

    return allPlans;
  }

  // ─── WRITE-BACK — Push production notes to Planning Center ────────────────

  /**
   * Write production notes back to the most recent Planning Center plan.
   * Called after each service session ends (from scheduleEngine close callback).
   *
   * @param {string} churchId
   * @param {object} sessionData
   * @returns {Promise<{written: boolean, planId?: string}>}
   */
  async writeServiceNotes(churchId, sessionData) {
    const church = this._getChurch(churchId);
    if (!church) return { written: false, reason: 'Church not found' };

    if (!church.pc_writeback_enabled) return { written: false, reason: 'Write-back disabled' };

    const auth = await this._getAuthHeaders(churchId);
    if (!auth) return { written: false, reason: 'PC credentials not configured' };

    const serviceTypeId = this._resolveServiceTypeId(church);
    if (!serviceTypeId) return { written: false, reason: 'No service type configured' };

    try {
      // Find the most recent plan (past, today's)
      const url = `${PC_API_BASE}/service_types/${serviceTypeId}/plans?filter=past&per_page=1&order=-sort_date`;
      const resp = await this._pcFetch(url, auth.headers);
      const data = await resp.json();
      const plan = data.data?.[0];
      if (!plan) return { written: false, reason: 'No recent plan found' };

      // Build production notes
      const grade = sessionData.grade || 'N/A';
      const duration = sessionData.duration_minutes ? `${sessionData.duration_minutes} min` : 'Unknown';
      const alerts = sessionData.alert_count || 0;
      const autoFixed = sessionData.auto_recovered_count || 0;
      const stream = sessionData.stream_ran ? `Yes (${sessionData.stream_runtime_minutes || 0} min)` : 'No';
      const tdName = sessionData.td_name || 'Unknown';

      const noteText = [
        `--- Tally Production Report ---`,
        `Grade: ${grade}`,
        `Duration: ${duration}`,
        `TD: ${tdName}`,
        `Stream: ${stream}`,
        `Alerts: ${alerts} (${autoFixed} auto-recovered)`,
        `Audio silences: ${sessionData.audio_silence_count || 0}`,
        `Recording confirmed: ${sessionData.recording_confirmed ? 'Yes' : 'No'}`,
        `---`,
      ].join('\n');

      // POST a note to the plan
      const noteUrl = `${PC_API_BASE}/service_types/${serviceTypeId}/plans/${plan.id}/notes`;
      await this._pcFetch(noteUrl, auth.headers, {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'PlanNote',
            attributes: {
              content: noteText,
              category_name: 'Production',
            },
          },
        }),
      });

      console.log(`[PlanningCenter] ✅ Production notes written to plan ${plan.id} for ${church.name || churchId}`);
      return { written: true, planId: plan.id };
    } catch (e) {
      console.warn(`[PlanningCenter] ⚠️ Write-back failed for ${church.name || churchId}: ${e.message}`);
      return { written: false, reason: e.message };
    }
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────────

  /**
   * Resolve the primary service type ID for a church (legacy single or first from array).
   * @param {object} church - DB row
   * @returns {string|null}
   */
  _resolveServiceTypeId(church) {
    if (church.pc_service_type_ids) {
      try {
        const ids = JSON.parse(church.pc_service_type_ids);
        if (ids.length > 0) return ids[0];
      } catch { /* ignore */ }
    }
    return church.pc_service_type_id || null;
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  /** Start the 6-hour background sync. */
  start() {
    if (this._syncTimer) return;

    const runSync = () => this.syncAll().catch(e => console.error('[PlanningCenter] syncAll error:', e.message));

    // Immediate first run, then every 6 hours
    this.ready
      .then(() => this.syncAll())
      .catch(e => console.error('[PlanningCenter] initial sync error:', e.message));

    this._syncTimer = setInterval(
      runSync,
      6 * 60 * 60 * 1000
    );

    console.log('[PlanningCenter] Started — syncing every 6 hours');
  }

  stop() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }
}

// ─── UTILITY ────────────────────────────────────────────────────────────────────

/**
 * Simple Levenshtein distance for fuzzy song title matching.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[b.length][a.length];
}

module.exports = { PlanningCenter };
