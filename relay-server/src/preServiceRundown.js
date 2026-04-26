'use strict';

/**
 * preServiceRundown.js
 * Pre-Service Rundown Orchestrator — coordinates all check sources, assembles
 * the complete rundown object, generates AI summary via Claude Haiku, manages
 * countdown lifecycle (T-60 → T-30 → T-0 → live → post-service), handles
 * "All Clear" confirmation with logging, triggers escalation path, and
 * broadcasts rundown state via SSE to portal.
 *
 * Integrates with:
 *   - preServiceCheck.js (device health)
 *   - broadcastMonitor.js (stream readiness)
 *   - churchMemory.js (historical context)
 *   - scheduleEngine.js (service window timing)
 *   - viewerBaseline.js (viewer expectations)
 *   - rundownEngine.js (cue-based rundown templates)
 *   - tally-engineer.js (AI identity)
 */

const crypto = require('crypto');
const { buildBackgroundPrompt } = require('./tally-engineer');
const { hasOpenSocket } = require('./runtimeSockets');
const { SqliteQueryClient } = require('./db/queryClient');

// ─── ESCALATION LEVELS ──────────────────────────────────────────────────────

const ESCALATION_LEVELS = {
  NONE: 0,
  TD_REMINDER: 1,    // T-20: remind TD
  BACKUP_TD: 2,      // T-15: notify backup TD
  PASTOR: 3,          // T-10: notify pastor/admin
  UNCONFIRMED: 4,     // T-5: mark as unconfirmed start
};

const DEFAULT_ESCALATION_TIMING = {
  remind: 20,   // minutes before service
  backup: 15,
  pastor: 10,
  unconfirmed: 5,
};

class PreServiceRundown {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {object} opts.scheduleEngine
   * @param {object} opts.preServiceCheck
   * @param {object} opts.churchMemory
   * @param {object} opts.viewerBaseline
   * @param {object} [opts.rundownEngine]
   * @param {Map} opts.churches - in-memory church runtime map
   * @param {function} opts.broadcastToPortal - (churchId, data) => void
   * @param {function} [opts.postSystemChatMessage] - (churchId, msg, roomId?) => void
   * @param {function} [opts.makeCommandSender] - (church, roomId?) => sendCommand fn
   * @param {string} [opts.alertBotToken] - Telegram bot token
   */
  constructor(opts = {}) {
    this.db = opts.db && typeof opts.db.prepare === 'function'
      ? opts.db
      : (opts.queryClient?.db && typeof opts.queryClient.db.prepare === 'function' ? opts.queryClient.db : null);
    this.queryClient = opts.queryClient || (this.db ? new SqliteQueryClient(this.db) : null);
    this.scheduleEngine = opts.scheduleEngine;
    this.preServiceCheck = opts.preServiceCheck;
    this.churchMemory = opts.churchMemory;
    this.viewerBaseline = opts.viewerBaseline;
    this.rundownEngine = opts.rundownEngine || null;
    this.churches = opts.churches;
    this.broadcastToPortal = opts.broadcastToPortal;
    this.postSystemChatMessage = opts.postSystemChatMessage || (() => {});
    this.makeCommandSender = opts.makeCommandSender || null;
    this.alertBotToken = opts.alertBotToken || process.env.ALERT_BOT_TOKEN;

    // Active rundowns keyed by churchId
    this._active = new Map(); // churchId → rundown object
    // Re-check timers keyed by churchId
    this._timers = new Map();
    // Escalation timers
    this._escalationTimers = new Map();
    this._latestRundowns = new Map();
    this._escalationContacts = new Map();

    this.ready = this.db ? Promise.resolve() : this._ensureTables();
  }

  _compositeKey(churchId, instanceName = null, roomId = null) {
    const resolvedRoomId = roomId || this._resolveRoomId(churchId, instanceName);
    if (resolvedRoomId) return `${churchId}::room:${resolvedRoomId}`;
    if (instanceName) return `${churchId}::instance:${instanceName}`;
    return churchId;
  }

  _getRundown(churchId, instanceName = null, roomId = null) {
    const key = this._compositeKey(churchId, instanceName, roomId);
    return this._active.get(key) || null;
  }

  _setRundown(rundown) {
    rundown.church_id ??= rundown.churchId || null;
    rundown.instance_name ??= rundown.instanceName || null;
    rundown.room_id ??= rundown.roomId || null;
    rundown.service_time ??= rundown.serviceTime || null;
    rundown.overall_status ??= rundown.overallStatus || null;
    rundown.ai_summary ??= rundown.aiSummary || null;
    rundown.confirmed_by ??= rundown.confirmation?.confirmedBy || null;
    rundown.confirmed_at ??= rundown.confirmation?.confirmedAt || null;
    rundown.escalation_level ??= rundown.confirmation?.escalationLevel ?? 0;
    const key = this._compositeKey(rundown.churchId, rundown.instanceName, rundown.roomId);
    this._active.set(key, rundown);
    this._latestRundowns.set(key, rundown);
    return key;
  }

  _getChurchKeys(churchId) {
    return Array.from(this._active.keys()).filter(key => key === churchId || key.startsWith(`${churchId}::`));
  }

  _getConnectedContexts(churchId) {
    const runtime = this.churches?.get(churchId);
    const instances = runtime?.sockets?.size ? Array.from(runtime.sockets.keys()) : [];
    if (!instances.length) return [{ instanceName: null, roomId: null }];
    return instances.map(instanceName => ({
      instanceName,
      roomId: this._resolveRoomId(churchId, instanceName),
    }));
  }

  _ensureTables() {
    if (this.db) {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS preservice_rundowns (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        instance_name TEXT,
        room_id TEXT,
        service_time TEXT NOT NULL,
        overall_status TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        historical_json TEXT,
        ai_summary TEXT,
        confirmed_by TEXT,
        confirmed_at TEXT,
        escalation_level INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
      `);

      this.db.exec(`
      CREATE TABLE IF NOT EXISTS preservice_confirmations (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        rundown_id TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_via TEXT NOT NULL,
        check_snapshot_json TEXT NOT NULL,
        instance_name TEXT,
        room_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
      `);

      this.db.exec(`
      CREATE TABLE IF NOT EXISTS escalation_contacts (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        contact_type TEXT NOT NULL,
        contact_value TEXT NOT NULL,
        notify_on TEXT DEFAULT 'critical',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )
      `);

      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_preservice_rundowns_church ON preservice_rundowns(church_id, created_at DESC)'); } catch (err) { /* index may already exist */ console.debug('[preservice migrations] create idx_preservice_rundowns_church:', err?.message); }
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_escalation_contacts_church ON escalation_contacts(church_id, active)'); } catch (err) { /* index may already exist */ console.debug('[preservice migrations] create idx_escalation_contacts_church:', err?.message); }
      return;
    }

    const client = this._requireClient();
    const nowDefault = client.driver === 'postgres' ? 'CURRENT_TIMESTAMP' : "(datetime('now'))";
    return (async () => {
      await client.exec(`
      CREATE TABLE IF NOT EXISTS preservice_rundowns (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        instance_name TEXT,
        room_id TEXT,
        service_time TEXT NOT NULL,
        overall_status TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        historical_json TEXT,
        ai_summary TEXT,
        confirmed_by TEXT,
        confirmed_at TEXT,
        escalation_level INTEGER DEFAULT 0,
        created_at TEXT DEFAULT ${nowDefault}
      )
    `);

      await client.exec(`
      CREATE TABLE IF NOT EXISTS preservice_confirmations (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        rundown_id TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_via TEXT NOT NULL,
        check_snapshot_json TEXT NOT NULL,
        instance_name TEXT,
        room_id TEXT,
        created_at TEXT DEFAULT ${nowDefault}
      )
    `);

      await client.exec(`
      CREATE TABLE IF NOT EXISTS escalation_contacts (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        contact_type TEXT NOT NULL,
        contact_value TEXT NOT NULL,
        notify_on TEXT DEFAULT 'critical',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT ${nowDefault}
      )
    `);

      try { await client.exec('CREATE INDEX IF NOT EXISTS idx_preservice_rundowns_church ON preservice_rundowns(church_id, created_at DESC)'); } catch (err) { /* index may already exist */ console.debug('[preservice migrations pg] create idx_preservice_rundowns_church:', err?.message); }
      try { await client.exec('CREATE INDEX IF NOT EXISTS idx_escalation_contacts_church ON escalation_contacts(church_id, active)'); } catch (err) { /* index may already exist */ console.debug('[preservice migrations pg] create idx_escalation_contacts_church:', err?.message); }

      try {
        const rundownRows = await client.query(`
          SELECT r.*, c.name AS church_name
          FROM preservice_rundowns r
          LEFT JOIN churches c ON c.churchId = r.church_id
          ORDER BY r.created_at DESC
        `);
        for (const row of rundownRows || []) {
          const key = this._compositeKey(row.church_id, row.instance_name || null, row.room_id || null);
          if (this._latestRundowns.has(key)) continue;
          this._setRundown(this._hydrateRundownRow(row));
        }
      } catch (err) {
        console.error('[preservice cache hydrate] rundowns query error:', err);
      }

      try {
        const contacts = await client.query(
          'SELECT * FROM escalation_contacts WHERE active = 1 ORDER BY role, name',
        );
        this._replaceEscalationContactsCache(contacts);
      } catch (err) {
        console.error('[preservice cache hydrate] escalation contacts query error:', err);
      }
    })();
  }

  async _all(sql, params = []) {
    await this.ready;
    if (this.queryClient) return this.queryClient.query(sql, params);
    return this.db.prepare(sql).all(...params);
  }

  async _one(sql, params = []) {
    await this.ready;
    if (this.queryClient) return this.queryClient.queryOne(sql, params);
    return this.db.prepare(sql).get(...params) || null;
  }

  async _run(sql, params = []) {
    await this.ready;
    if (this.queryClient) return this.queryClient.run(sql, params);
    return this.db.prepare(sql).run(...params);
  }

  _requireClient() {
    if (!this.queryClient) {
      throw new Error('[PreServiceRundown] queryClient is required for async persistence.');
    }
    return this.queryClient;
  }

  _hydrateRundownRow(row) {
    let checks = {};
    let historical = {};
    try { checks = JSON.parse(row.checks_json || '{}'); } catch (err) { console.debug('[preservice hydrate] checks_json JSON parse error:', err?.message); }
    try { historical = JSON.parse(row.historical_json || '{}'); } catch (err) { console.debug('[preservice hydrate] historical_json JSON parse error:', err?.message); }

    return {
      ...row,
      churchId: row.church_id,
      churchName: row.church_name || row.church_id,
      instanceName: row.instance_name || null,
      roomId: row.room_id || null,
      serviceTime: row.service_time || null,
      overallStatus: row.overall_status || 'clear',
      checks,
      historical,
      aiSummary: row.ai_summary || null,
      confirmation: {
        confirmed: !!(row.confirmed_by || row.confirmed_at),
        confirmedBy: row.confirmed_by || null,
        confirmedAt: row.confirmed_at || null,
        escalationLevel: Number(row.escalation_level || 0),
      },
      generatedAt: row.created_at || null,
    };
  }

  _replaceEscalationContactsCache(rows) {
    this._escalationContacts.clear();
    for (const row of rows || []) {
      this._cacheEscalationContact(row);
    }
  }

  _cacheEscalationContact(row) {
    if (!row?.church_id) return;
    const contacts = (this._escalationContacts.get(row.church_id) || []).filter(contact => contact.id !== row.id);
    contacts.push({ ...row });
    contacts.sort((a, b) => String(a.role || '').localeCompare(String(b.role || '')) || String(a.name || '').localeCompare(String(b.name || '')));
    this._escalationContacts.set(row.church_id, contacts);
  }

  _removeEscalationContactFromCache(id) {
    for (const [churchId, contacts] of this._escalationContacts.entries()) {
      const next = contacts.filter(contact => contact.id !== id);
      if (next.length === contacts.length) continue;
      if (next.length) this._escalationContacts.set(churchId, next);
      else this._escalationContacts.delete(churchId);
    }
  }

  _resolveRoomId(churchId, instanceName) {
    if (!instanceName) return null;
    const churchRuntime = this.churches?.get(churchId);
    const roomInstanceMap = churchRuntime?.roomInstanceMap || null;
    if (!roomInstanceMap) return null;
    for (const [roomId, mappedInstance] of Object.entries(roomInstanceMap)) {
      if (mappedInstance === instanceName) return roomId;
    }
    return null;
  }

  // ─── RUNDOWN GENERATION ──────────────────────────────────────────────────────

  /**
   * Generate a full pre-service rundown for a church.
   * Orchestrates all check sources, assembles the rundown object, and persists.
   *
   * @param {string} churchId
   * @param {string} [instanceName]
   * @returns {object} The complete rundown object
   */
  async generate(churchId, instanceName, roomIdOverride = null) {
    const church = await this._one('SELECT * FROM churches WHERE churchId = ?', [churchId]);
    if (!church) return null;

    const churchRuntime = this.churches?.get(churchId);
    const roomId = roomIdOverride || this._resolveRoomId(churchId, instanceName) || church.room_id || churchRuntime?.roomId || null;

    // ── Timing ──────────────────────────────────────────────────────────────
    const nextService = this.scheduleEngine.getNextService(churchId);
    const minutesUntil = nextService?.minutesUntil ?? null;
    const serviceDay = nextService?.day ?? new Date().getDay();

    // Build service time ISO string
    let serviceTime = null;
    if (nextService) {
      const [h, m] = nextService.startTime.split(':').map(Number);
      const now = new Date();
      const target = new Date(now);
      const daysUntil = ((nextService.day - now.getDay()) + 7) % 7 || (minutesUntil > 0 ? 0 : 7);
      target.setDate(now.getDate() + daysUntil);
      target.setHours(h, m, 0, 0);
      serviceTime = target.toISOString();
    }

    // Determine phase
    let phase = 'pre-service';
    if (minutesUntil !== null) {
      if (minutesUntil <= 0) phase = 'live';
      else if (minutesUntil > 60) phase = 'waiting';
    }

    // ── Device checks ───────────────────────────────────────────────────────
    const deviceChecks = await this._assembleDeviceChecks(churchId, churchRuntime, instanceName);

    // ── Stream readiness ────────────────────────────────────────────────────
    const streamChecks = await this._assembleStreamChecks(churchId, churchRuntime, instanceName);

    // ── ProPresenter readiness ──────────────────────────────────────────────
    const propresenterChecks = this._assembleProPresenterChecks(churchRuntime);

    // ── Audio status ────────────────────────────────────────────────────────
    const audioChecks = this._assembleAudioChecks(churchRuntime);

    // ── Network status ──────────────────────────────────────────────────────
    const networkChecks = this._assembleNetworkChecks(churchRuntime);

    // ── Companion status ────────────────────────────────────────────────────
    const companionChecks = this._assembleCompanionChecks(churchRuntime);

    // ── Aggregate check status ──────────────────────────────────────────────
    const checks = {
      devices: { status: this._categoryStatus(deviceChecks), items: deviceChecks },
      stream: { status: this._categoryStatus(streamChecks), items: streamChecks },
      propresenter: { status: this._categoryStatus(propresenterChecks), items: propresenterChecks },
      audio: { status: this._categoryStatus(audioChecks), items: audioChecks },
      network: { status: this._categoryStatus(networkChecks), items: networkChecks },
      companion: { status: this._categoryStatus(companionChecks), items: companionChecks },
    };

    const overallStatus = this._overallStatus(checks);

    // ── Historical context ──────────────────────────────────────────────────
    const historical = await this._assembleHistorical(churchId, serviceDay);

    // ── Active cue rundown (from rundownEngine) ────────────────────────────
    let activeRundown = null;
    if (this.rundownEngine) {
      const active = this.rundownEngine.getActiveRundown(churchId, instanceName);
      if (active) {
        activeRundown = {
          name: active.rundown.name,
          currentStep: active.currentStep,
          totalSteps: (active.rundown.steps || []).length,
        };
      }
    }

    // ── Existing confirmation state ─────────────────────────────────────────
    const existing = this._getRundown(churchId, instanceName, roomId);
    const confirmation = existing?.confirmation || {
      confirmed: false,
      confirmedBy: null,
      confirmedAt: null,
      escalationLevel: ESCALATION_LEVELS.NONE,
    };

    // ── Build rundown object ────────────────────────────────────────────────
    const rundown = {
      id: existing?.id || crypto.randomUUID(),
      churchId,
      churchName: church.name,
      instanceName: instanceName || null,
      roomId,
      serviceTime,
      minutesUntilService: minutesUntil,
      phase,
      overallStatus,
      checks,
      historical,
      activeRundown,
      confirmation,
      aiSummary: existing?.aiSummary || null,
      generatedAt: new Date().toISOString(),
    };

    // Cache in memory
    this._setRundown(rundown);

    // Persist snapshot to DB
    this._persistRundown(rundown);

    // Broadcast to portal SSE
    if (this.broadcastToPortal) {
      this.broadcastToPortal(churchId, { type: 'rundown_update', data: rundown });
    }

    return rundown;
  }

  /**
   * Refresh an existing rundown (re-check without regenerating AI summary).
   */
  async refresh(churchId, instanceName = null, roomId = null) {
    const existing = this._getRundown(churchId, instanceName, roomId);
    const nextInstanceName = instanceName ?? existing?.instanceName ?? null;
    const nextRoomId = roomId ?? existing?.roomId ?? null;
    const rundown = await this.generate(churchId, nextInstanceName, nextRoomId);

    // Preserve AI summary from previous generation
    if (rundown && existing?.aiSummary && !rundown.aiSummary) {
      rundown.aiSummary = existing.aiSummary;
      this._setRundown(rundown);
    }

    return rundown;
  }

  /**
   * Generate the AI summary for a rundown (Claude Haiku).
   * Called separately so the initial rundown can broadcast without waiting for AI.
   */
  async generateAISummary(churchId, instanceName = null, roomId = null) {
    const rundown = this._getRundown(churchId, instanceName, roomId);
    if (!rundown) return null;

    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;

      const church = await this._one('SELECT * FROM churches WHERE churchId = ?', [churchId]);
      const operatorLevel = church?.operator_level || 'intermediate';

      const systemPrompt = buildBackgroundPrompt('pre_service_rundown') ||
        `You are Tally — a friendly church tech assistant. Generate a brief, conversational pre-service rundown for the tech director. Be warm but concise. Adapt to operator level: ${operatorLevel}. No markdown formatting. Keep it under 150 words.`;

      const context = [
        `Church: ${rundown.churchName}`,
        `Service: ${rundown.serviceTime ? new Date(rundown.serviceTime).toLocaleString() : 'upcoming'}`,
        `Minutes until service: ${rundown.minutesUntilService ?? 'unknown'}`,
        `Overall status: ${rundown.overallStatus}`,
        '',
        'Check results:',
        ...Object.entries(rundown.checks).map(([cat, data]) => {
          const items = data.items.map(i => `  ${i.pass ? '✓' : '✗'} ${i.name}${i.detail ? ': ' + i.detail : ''}`);
          return `${cat} (${data.status}): \n${items.join('\n')}`;
        }),
        '',
        'Historical:',
        `Last week grade: ${rundown.historical.lastWeekGrade || 'N/A'}`,
        `Recurring issues: ${rundown.historical.recurringIssues?.join(', ') || 'none'}`,
        `Service streak: ${rundown.historical.streak} clean in a row`,
        '',
        'Viewer baseline:',
        `Expected peak: ~${rundown.historical.viewerBaseline?.expectedPeak || 0} viewers`,
        `Platform split: ${JSON.stringify(rundown.historical.viewerBaseline?.platformSplit || {})}`,
        `Trend: ${rundown.historical.viewerBaseline?.trendPct || 0}% week-over-week`,
      ].join('\n');

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          system: systemPrompt,
          messages: [{ role: 'user', content: context }],
          temperature: 0.7,
          max_tokens: 300,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.error(`[PreServiceRundown] AI summary API error: ${resp.status}`);
        return null;
      }

      const data = await resp.json();
      const summary = data?.content?.[0]?.text?.trim() || null;

      if (summary) {
        rundown.aiSummary = summary;
        this._setRundown(rundown);

        // Broadcast update with summary
        if (this.broadcastToPortal) {
          this.broadcastToPortal(churchId, { type: 'rundown_update', data: rundown });
        }

        // Update DB
        try {
          await this._run('UPDATE preservice_rundowns SET ai_summary = ? WHERE id = ?', [summary, rundown.id]);
        } catch (err) {
          console.error('[preservice AI summary] save summary error:', err);
        }
      }

      return summary;
    } catch (e) {
      console.error(`[PreServiceRundown] AI summary error for ${churchId}:`, e.message);
      return null;
    }
  }

  // ─── CHECK ASSEMBLY ──────────────────────────────────────────────────────────

  async _assembleDeviceChecks(churchId, churchRuntime, instanceName) {
    const items = [];
    const status = churchRuntime?.status || {};

    // ATEM
    items.push({
      name: 'ATEM Switcher',
      pass: !!status.atem?.connected,
      detail: status.atem?.connected ? `Connected (${status.atem?.modelName || 'ATEM'})` : 'Not connected',
    });

    // OBS
    items.push({
      name: 'OBS Studio',
      pass: !!status.obs?.connected,
      detail: status.obs?.connected ? `v${status.obs.version || '?'}` : 'Not connected',
    });

    // Encoder
    if (status.encoder) {
      items.push({
        name: `Encoder (${status.encoder.type || 'unknown'})`,
        pass: !!status.encoder.connected,
        detail: status.encoder.connected ? 'Connected' : 'Not connected',
      });
    }

    // ProPresenter (also appears in its own category)
    items.push({
      name: 'ProPresenter',
      pass: !!status.proPresenter?.connected,
      detail: status.proPresenter?.connected ? `v${status.proPresenter.version || '?'}` : 'Not connected',
    });

    // Companion
    items.push({
      name: 'Companion',
      pass: !!status.companion?.connected,
      detail: status.companion?.connected ? 'Connected' : 'Not connected',
    });

    // Audio mixer
    if (status.audio || status.mixer) {
      const mixer = status.mixer || status.audio;
      items.push({
        name: `Audio Mixer (${mixer.type || 'unknown'})`,
        pass: !!mixer.connected,
        detail: mixer.connected ? 'Connected' : 'Not connected',
      });
    }

    // HyperDeck
    if (status.hyperdeck) {
      items.push({
        name: 'HyperDeck',
        pass: !!status.hyperdeck.connected,
        detail: status.hyperdeck.connected ? 'Connected' : 'Not connected',
      });
    }

    // PTZ Cameras
    if (status.ptzCameras) {
      const count = typeof status.ptzCameras === 'number' ? status.ptzCameras : (status.ptzCameras.count || 0);
      items.push({
        name: 'PTZ Cameras',
        pass: count > 0,
        detail: count > 0 ? `${count} camera${count !== 1 ? 's' : ''} online` : 'None detected',
      });
    }

    // Use latest preServiceCheck result for additional checks
    if (this.preServiceCheck) {
      const latest = await this.preServiceCheck.getLatestResult(churchId, instanceName);
      if (latest?.checks) {
        for (const check of latest.checks) {
          // Skip if we already have this check
          if (items.some(i => i.name === check.name)) continue;
          items.push({
            name: check.name,
            pass: !!check.pass,
            detail: check.detail || (check.pass ? 'OK' : 'Issue'),
          });
        }
      }
    }

    return items;
  }

  async _assembleStreamChecks(churchId, churchRuntime, instanceName) {
    const items = [];
    const broadcast = churchRuntime?.broadcastHealth || {};

    // YouTube
    if (broadcast.youtube) {
      const yt = broadcast.youtube;
      items.push({
        name: 'YouTube Stream',
        pass: yt.status === 'good' || yt.status === 'no_broadcast',
        detail: yt.live
          ? `Live — ${yt.concurrentViewers || 0} viewers, ${yt.resolution || '?'}@${yt.framerate || '?'}`
          : yt.status === 'no_broadcast' ? 'No active broadcast (ready to go live)' : `Status: ${yt.status}`,
      });
    }

    // Facebook
    if (broadcast.facebook) {
      const fb = broadcast.facebook;
      items.push({
        name: 'Facebook Stream',
        pass: fb.status === 'good' || fb.status === 'no_broadcast',
        detail: fb.live
          ? `Live on ${fb.pageName || 'Facebook'} — ${fb.liveViews || 0} viewers`
          : fb.status === 'no_broadcast' ? 'Ready' : `Status: ${fb.status}`,
      });
    }

    // OAuth token validity
    try {
      const row = await this._one('SELECT yt_access_token, yt_token_expires_at, fb_access_token FROM churches WHERE churchId = ?', [churchId]);

      if (row?.yt_access_token) {
        const expiresAt = row.yt_token_expires_at ? new Date(row.yt_token_expires_at) : null;
        const daysUntilExpiry = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null;
        items.push({
          name: 'YouTube OAuth Token',
          pass: daysUntilExpiry === null || daysUntilExpiry > 7,
          detail: daysUntilExpiry !== null
            ? (daysUntilExpiry > 7 ? `Valid (expires in ${daysUntilExpiry} days)` : `⚠ Expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}`)
            : 'Token present',
        });
      }

      if (row?.fb_access_token) {
        items.push({
          name: 'Facebook Token',
          pass: true,
          detail: 'Token present',
        });
      }
    } catch (err) {
      console.error('[preservice OAuth checks] token query error:', err);
    }

    // If no stream platforms configured
    if (items.length === 0) {
      items.push({
        name: 'Stream Platforms',
        pass: true,
        detail: 'No platforms configured',
      });
    }

    return items;
  }

  _assembleProPresenterChecks(churchRuntime) {
    const items = [];
    const pp = churchRuntime?.status?.proPresenter;

    if (!pp?.connected) {
      items.push({ name: 'ProPresenter Connection', pass: false, detail: 'Not connected' });
      return items;
    }

    items.push({ name: 'ProPresenter Connection', pass: true, detail: `v${pp.version || '?'}` });

    if (pp.presentationName) {
      items.push({ name: 'Presentation Loaded', pass: true, detail: pp.presentationName });
    }

    // Screen status
    if (pp.screens) {
      const audienceUp = pp.screens.audience !== false;
      items.push({ name: 'Audience Screen', pass: audienceUp, detail: audienceUp ? 'Active' : 'Inactive' });
    }

    return items;
  }

  _assembleAudioChecks(churchRuntime) {
    const items = [];
    const status = churchRuntime?.status || {};

    const mixer = status.mixer || status.audio;
    if (mixer?.connected) {
      items.push({ name: 'Audio Mixer', pass: true, detail: `${mixer.type || 'Mixer'} connected` });

      // Main mute check
      if (status.audio?.mainMuted !== undefined) {
        items.push({
          name: 'Main Mix',
          pass: !status.audio.mainMuted,
          detail: status.audio.mainMuted ? 'MUTED — unmute before service!' : 'Unmuted',
        });
      }
    } else if (status.atem?.connected && (status.audio_via_atem || !mixer)) {
      items.push({ name: 'Audio (via ATEM Fairlight)', pass: true, detail: 'Using ATEM built-in audio' });
    } else {
      items.push({ name: 'Audio Mixer', pass: false, detail: 'No mixer connected' });
    }

    // Audio silence flag
    if (status.audioSilence) {
      items.push({ name: 'Audio Signal', pass: false, detail: 'Silence detected on main mix' });
    }

    // Wireless mic info from Companion variables
    const vars = status.companion?.variables;
    if (vars) {
      for (const [connId, varObj] of Object.entries(vars)) {
        if (typeof varObj !== 'object') continue;
        // Look for Shure battery variables
        for (const [key, val] of Object.entries(varObj)) {
          if (/battery/i.test(key) && typeof val === 'number') {
            items.push({
              name: `Wireless Battery (${connId})`,
              pass: val > 30,
              detail: `${val}%${val <= 30 ? ' — LOW' : ''}`,
            });
          }
        }
      }
    }

    return items;
  }

  _assembleNetworkChecks(churchRuntime) {
    const items = [];

    // WebSocket connection status
    const connected = hasOpenSocket(churchRuntime);
    items.push({
      name: 'Relay Connection',
      pass: connected,
      detail: connected ? 'Connected to relay server' : 'Disconnected from relay',
    });

    return items;
  }

  _assembleCompanionChecks(churchRuntime) {
    const items = [];
    const comp = churchRuntime?.status?.companion;

    if (!comp?.connected) {
      items.push({ name: 'Companion', pass: false, detail: 'Not connected' });
      return items;
    }

    items.push({ name: 'Companion', pass: true, detail: 'Connected' });

    // Module health
    if (comp.connections && Array.isArray(comp.connections)) {
      const errorModules = comp.connections.filter(c => c.status === 'error');
      const offlineModules = comp.connections.filter(c => c.status === 'offline');
      if (errorModules.length > 0) {
        items.push({
          name: 'Companion Modules',
          pass: false,
          detail: `${errorModules.length} module${errorModules.length !== 1 ? 's' : ''} in error state`,
        });
      } else if (offlineModules.length > 0) {
        items.push({
          name: 'Companion Modules',
          pass: true,
          detail: `${offlineModules.length} offline, rest OK`,
        });
      } else {
        items.push({
          name: 'Companion Modules',
          pass: true,
          detail: `${comp.connections.length} module${comp.connections.length !== 1 ? 's' : ''} OK`,
        });
      }
    }

    return items;
  }

  // ─── STATUS COMPUTATION ──────────────────────────────────────────────────────

  _categoryStatus(items) {
    if (items.some(i => !i.pass)) return items.some(i => !i.pass && /muted|disconnect|error|critical/i.test(i.detail || '')) ? 'critical' : 'warning';
    return 'clear';
  }

  _overallStatus(checks) {
    const statuses = Object.values(checks).map(c => c.status);
    if (statuses.includes('critical')) return 'critical';
    if (statuses.includes('warning')) return 'warning';
    return 'clear';
  }

  // ─── HISTORICAL CONTEXT ──────────────────────────────────────────────────────

  async _assembleHistorical(churchId, serviceDay) {
    // Last week's session
    let lastWeekGrade = null;
    let lastWeekAlerts = 0;
    let streak = 0;

    try {
      const recentSessions = await this._all(
        "SELECT grade, alert_count, auto_recovered_count FROM service_sessions WHERE church_id = ? AND ended_at IS NOT NULL AND (session_type IS NULL OR session_type != 'test') ORDER BY ended_at DESC LIMIT 8",
        [churchId],
      );

      if (recentSessions.length > 0) {
        lastWeekGrade = recentSessions[0].grade || null;
        lastWeekAlerts = recentSessions[0].alert_count || 0;

        // Clean service streak (A or B grade)
        for (const s of recentSessions) {
          if (s.grade === 'A' || s.grade === 'B') streak++;
          else break;
        }
      }
    } catch (err) {
      console.error('[preservice historical] recent sessions query error:', err);
    }

    // Recurring issues from church memory
    const recurringIssues = [];
    try {
      const briefing = this.churchMemory ? await this.churchMemory.getPreServiceBriefing(churchId) : null;
      if (briefing?.recurringIssues) {
        for (const issue of briefing.recurringIssues) {
          recurringIssues.push(issue.summary || issue);
        }
      }
    } catch (err) {
      console.error('[preservice historical] church memory briefing error:', err);
    }

    // Viewer baseline
    let viewerBaseline = { expectedPeak: 0, expectedAtMinute10: 0, platformSplit: {}, trendPct: 0, sampleCount: 0 };
    try {
      if (this.viewerBaseline) {
        viewerBaseline = await this.viewerBaseline.getBaseline(churchId, serviceDay);
      }
    } catch (err) {
      console.error('[preservice historical] viewer baseline error:', err);
    }

    return {
      lastWeekGrade,
      lastWeekAlerts,
      recurringIssues,
      streak,
      viewerBaseline,
    };
  }

  // ─── CONFIRMATION ────────────────────────────────────────────────────────────

  /**
   * Confirm "All Clear" for a church's pre-service rundown.
   * @param {string} churchId
   * @param {string} confirmedBy - user name or "auto"
   * @param {string} confirmedVia - portal | electron | telegram | companion
   * @returns {object|null}
   */
  confirm(churchId, confirmedBy, confirmedVia = 'portal', instanceName = null, roomId = null) {
    const rundown = this._getRundown(churchId, instanceName, roomId);
    if (!rundown) return null;

    const now = new Date().toISOString();

    rundown.confirmation = {
      confirmed: true,
      confirmedBy,
      confirmedAt: now,
      escalationLevel: rundown.confirmation.escalationLevel,
    };
    this._setRundown(rundown);

    // Persist confirmation audit trail
    if (this.db) {
      try {
        this.db.prepare(`
        INSERT INTO preservice_confirmations (id, church_id, rundown_id, confirmed_by, confirmed_via, check_snapshot_json, instance_name, room_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), churchId, rundown.id, confirmedBy, confirmedVia,
        JSON.stringify(rundown.checks), rundown.instanceName, rundown.roomId, now
      );

      // Update rundown record
        this.db.prepare('UPDATE preservice_rundowns SET confirmed_by = ?, confirmed_at = ? WHERE id = ?')
          .run(confirmedBy, now, rundown.id);
      } catch (e) {
        console.error(`[PreServiceRundown] Confirmation persist error:`, e.message);
      }
    } else if (this.queryClient) {
      this._run(`
        INSERT INTO preservice_confirmations (id, church_id, rundown_id, confirmed_by, confirmed_via, check_snapshot_json, instance_name, room_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        crypto.randomUUID(), churchId, rundown.id, confirmedBy, confirmedVia,
        JSON.stringify(rundown.checks), rundown.instanceName, rundown.roomId, now,
      ]).catch((e) => console.error(`[PreServiceRundown] Confirmation persist error:`, e.message));

      this._run('UPDATE preservice_rundowns SET confirmed_by = ?, confirmed_at = ? WHERE id = ?', [confirmedBy, now, rundown.id])
        .catch((e) => console.error(`[PreServiceRundown] Confirmation persist error:`, e.message));
    }

    // Cancel escalation timer
    this._clearEscalationTimer(churchId, rundown.instanceName, rundown.roomId);

    // Broadcast confirmation
    if (this.broadcastToPortal) {
      this.broadcastToPortal(churchId, {
        type: 'rundown_confirmed',
        data: { confirmedBy, confirmedAt: now },
      });
    }

    // Set Companion variable
    this._setCompanionVariable(churchId, 'green');

    console.log(`[PreServiceRundown] ${rundown.churchName} confirmed All Clear by ${confirmedBy} via ${confirmedVia}`);
    return rundown;
  }

  /**
   * Check if a church has confirmed their rundown.
   */
  isConfirmed(churchId, instanceName = null, roomId = null) {
    return this._getRundown(churchId, instanceName, roomId)?.confirmation?.confirmed === true;
  }

  /**
   * Get the active rundown for a church (from memory cache).
   */
  getActiveRundown(churchId, instanceName = null, roomId = null) {
    return this._getRundown(churchId, instanceName, roomId);
  }

  /**
   * Get the latest persisted rundown from DB (for cold reads).
   */
  getLatestRundown(churchId, instanceName = null, roomId = null) {
    try {
      const cached = this._getRundown(churchId, instanceName, roomId);
      if (cached) return cached;
      const key = this._compositeKey(churchId, instanceName, roomId);
      if (this._latestRundowns.has(key)) return this._latestRundowns.get(key);
      if (!this.db) return null;
      let row;
      if (roomId) {
        row = this.db.prepare(
          'SELECT * FROM preservice_rundowns WHERE church_id = ? AND room_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(churchId, roomId);
      } else if (instanceName) {
        row = this.db.prepare(
          'SELECT * FROM preservice_rundowns WHERE church_id = ? AND instance_name = ? ORDER BY created_at DESC LIMIT 1'
        ).get(churchId, instanceName);
      } else {
        row = this.db.prepare(
          'SELECT * FROM preservice_rundowns WHERE church_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(churchId);
      }
      if (!row) return null;
      const rundown = this._hydrateRundownRow(row);
      this._setRundown(rundown);
      return rundown;
    } catch { return null; }
  }

  // ─── LIFECYCLE MANAGEMENT ────────────────────────────────────────────────────

  /**
   * Called when a service window opens. Starts the rundown lifecycle.
   * @param {string} churchId
   */
  async onServiceWindowOpen(churchId) {
    console.log(`[PreServiceRundown] Service window open for ${churchId} — starting rundown`);

    const church = await this._one('SELECT * FROM churches WHERE churchId = ?', [churchId]);
    if (!church) return;

    for (const context of this._getConnectedContexts(churchId)) {
      const { instanceName, roomId } = context;

      // Auto-activate any scheduled cue-based rundown from rundownEngine
      if (this.rundownEngine) {
        try {
          const dayOfWeek = new Date().getDay();
          const autoRundown = this.rundownEngine.getAutoActivateRundown(churchId, dayOfWeek, instanceName);
          if (autoRundown && !this.rundownEngine.getActiveRundown(churchId, instanceName)) {
            this.rundownEngine.activateRundownForScheduler(churchId, autoRundown.id, new Date().toISOString(), instanceName);
            console.log(`[PreServiceRundown] Auto-activated cue rundown "${autoRundown.name}" for ${church.name}${roomId ? ` (${roomId})` : ''}`);
          }
        } catch (e) {
          console.error(`[PreServiceRundown] Auto-activate cue rundown error:`, e.message);
        }
      }

      // Generate initial rundown
      const rundown = await this.generate(churchId, instanceName, roomId);
      if (!rundown) continue;

      // Generate AI summary in background
      this.generateAISummary(churchId, instanceName, roomId).then(summary => {
        if (summary) {
          this.postSystemChatMessage(
            churchId,
            `📋 Pre-Service Rundown\n\n${summary}\n\nTap "All Clear" in the portal when you've confirmed everything.`,
            roomId || null,
          );
        }
      }).catch(e => console.error(`[PreServiceRundown] AI summary error:`, e.message));

      this._sendTelegramRundown(churchId, rundown);
      this._setCompanionVariable(churchId, rundown.overallStatus === 'clear' ? 'green' : rundown.overallStatus === 'warning' ? 'yellow' : 'red');

      this._clearTimer(churchId, instanceName, roomId);
      const timer = setInterval(async () => {
        if (this.isConfirmed(churchId, instanceName, roomId) || !this.scheduleEngine.isServiceWindow(churchId)) {
          this._clearTimer(churchId, instanceName, roomId);
          return;
        }
        await this.refresh(churchId, instanceName, roomId);
      }, 5 * 60 * 1000);
      this._timers.set(this._compositeKey(churchId, instanceName, roomId), timer);

      this._startEscalation(churchId, instanceName, roomId).catch(e => {
        console.error(`[PreServiceRundown] Escalation init error:`, e.message);
      });
    }
  }

  /**
   * Called when a service window closes. Cleans up rundown state.
   */
  onServiceWindowClose(churchId) {
    console.log(`[PreServiceRundown] Service window closed for ${churchId} — cleaning up`);
    const keys = this._getChurchKeys(churchId);
    if (!keys.length) {
      this._clearTimer(churchId);
      this._clearEscalationTimer(churchId);
    }

    for (const key of keys) {
      const rundown = this._active.get(key);
      if (!rundown) continue;
      this._clearTimer(churchId, rundown.instanceName, rundown.roomId);
      this._clearEscalationTimer(churchId, rundown.instanceName, rundown.roomId);
      rundown.phase = 'post-service';
      this._setRundown(rundown);
      if (this.broadcastToPortal) {
        this.broadcastToPortal(churchId, {
          type: 'rundown_phase_change',
          data: { phase: 'post-service', roomId: rundown.roomId || null },
        });
      }
    }

    // Don't delete from _active — portal may still want to read post-service state
    // It will be overwritten on the next service window open
  }

  // ─── ESCALATION PATH ────────────────────────────────────────────────────────

  async _startEscalation(churchId, instanceName = null, roomId = null) {
    this._clearEscalationTimer(churchId, instanceName, roomId);

    const rundown = this._getRundown(churchId, instanceName, roomId);
    if (!rundown || !rundown.minutesUntilService) return;

    // Load escalation timing config
    let timing = DEFAULT_ESCALATION_TIMING;
    try {
      const row = await this._one('SELECT escalation_timing_json, escalation_enabled FROM churches WHERE churchId = ?', [churchId]);
      if (row?.escalation_enabled && row?.escalation_timing_json) {
        timing = { ...DEFAULT_ESCALATION_TIMING, ...JSON.parse(row.escalation_timing_json) };
      } else if (!row?.escalation_enabled) {
        return; // Escalation disabled for this church
      }
    } catch (err) {
      console.error('[preservice escalation] load timing config error:', err);
    }

    // Schedule escalation checks every minute
    const timer = setInterval(() => {
      if (this.isConfirmed(churchId, instanceName, roomId)) {
        this._clearEscalationTimer(churchId, instanceName, roomId);
        return;
      }

      const current = this._getRundown(churchId, instanceName, roomId);
      if (!current) return;

      const nextService = this.scheduleEngine.getNextService(churchId);
      const minutesUntil = nextService?.minutesUntil ?? Infinity;

      if (minutesUntil <= timing.unconfirmed && current.confirmation.escalationLevel < ESCALATION_LEVELS.UNCONFIRMED) {
        current.confirmation.escalationLevel = ESCALATION_LEVELS.UNCONFIRMED;
        console.log(`[PreServiceRundown] ${current.churchName} — T-${Math.round(minutesUntil)}: UNCONFIRMED START`);
        this._broadcastEscalation(churchId, ESCALATION_LEVELS.UNCONFIRMED, current.roomId);
      } else if (minutesUntil <= timing.pastor && current.confirmation.escalationLevel < ESCALATION_LEVELS.PASTOR) {
        current.confirmation.escalationLevel = ESCALATION_LEVELS.PASTOR;
        this._notifyEscalationContact(churchId, 'pastor', current);
        this._broadcastEscalation(churchId, ESCALATION_LEVELS.PASTOR, current.roomId);
      } else if (minutesUntil <= timing.backup && current.confirmation.escalationLevel < ESCALATION_LEVELS.BACKUP_TD) {
        current.confirmation.escalationLevel = ESCALATION_LEVELS.BACKUP_TD;
        this._notifyEscalationContact(churchId, 'backup_td', current);
        this._broadcastEscalation(churchId, ESCALATION_LEVELS.BACKUP_TD, current.roomId);
      } else if (minutesUntil <= timing.remind && current.confirmation.escalationLevel < ESCALATION_LEVELS.TD_REMINDER) {
        current.confirmation.escalationLevel = ESCALATION_LEVELS.TD_REMINDER;
        this._sendTdReminder(churchId, current);
        this._broadcastEscalation(churchId, ESCALATION_LEVELS.TD_REMINDER, current.roomId);
      }
    }, 60 * 1000);

    this._escalationTimers.set(this._compositeKey(churchId, instanceName, roomId), timer);
  }

  _broadcastEscalation(churchId, level, roomId = null) {
    const levelNames = { 1: 'TD Reminder', 2: 'Backup TD', 3: 'Pastor', 4: 'Unconfirmed Start' };
    if (this.broadcastToPortal) {
      this.broadcastToPortal(churchId, {
        type: 'rundown_escalation',
        data: { level, levelName: levelNames[level] || 'Unknown', roomId },
      });
    }
  }

  async _sendTdReminder(churchId, rundown) {
    // Send Telegram reminder to TDs
    const botToken = this.alertBotToken;
    if (!botToken) return;

    try {
      const tds = await this._all(
        'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1',
        [churchId],
      );

      const msg = `⏰ Reminder — ${rundown.churchName}\nPre-service rundown has not been confirmed.\nStatus: ${rundown.overallStatus.toUpperCase()}\nPlease review and tap "All Clear" in the portal.`;

      for (const td of tds) {
        if (!td.telegram_chat_id) continue;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: String(td.telegram_chat_id), text: msg }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    } catch (e) {
      console.error(`[PreServiceRundown] TD reminder error:`, e.message);
    }
  }

  async _notifyEscalationContact(churchId, role, rundown) {
    try {
      const contacts = await this._all(
        'SELECT * FROM escalation_contacts WHERE church_id = ? AND role = ? AND active = 1',
        [churchId, role],
      );

      if (contacts.length === 0) return;

      const statusEmoji = rundown.overallStatus === 'clear' ? '✅' : rundown.overallStatus === 'warning' ? '⚠️' : '🔴';
      const msg = `${statusEmoji} ${rundown.churchName} — Pre-service not confirmed\nRole: ${role.replace('_', ' ')}\nStatus: ${rundown.overallStatus}\nService starting soon. TD has not confirmed readiness.`;

      for (const contact of contacts) {
        if (contact.contact_type === 'telegram' && this.alertBotToken) {
          await fetch(`https://api.telegram.org/bot${this.alertBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(contact.contact_value), text: msg }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        }
        // Email/SMS channels can be added in Phase 4
      }

      console.log(`[PreServiceRundown] Escalation to ${role} for ${rundown.churchName}`);
    } catch (e) {
      console.error(`[PreServiceRundown] Escalation contact error:`, e.message);
    }
  }

  // ─── COMPANION VARIABLE ──────────────────────────────────────────────────────

  /**
   * Set tally_service_ready Companion custom variable.
   * @param {string} churchId
   * @param {'green'|'yellow'|'red'} value
   */
  _setCompanionVariable(churchId, value) {
    const churchRuntime = this.churches?.get(churchId);
    if (!churchRuntime || !this.makeCommandSender) return;

    try {
      const sendCommand = this.makeCommandSender(churchRuntime);
      sendCommand('companion.setCustomVariable', {
        name: 'tally_service_ready',
        value,
      }).catch(() => {});
    } catch (err) {
      console.error('[preservice setCompanionVariable] error:', err);
    }
  }

  // ─── ENHANCED TELEGRAM NOTIFICATION ──────────────────────────────────────────

  async _sendTelegramRundown(churchId, rundown) {
    const botToken = this.alertBotToken;
    if (!botToken) return;

    try {
      const tds = await this._all(
        'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1',
        [churchId],
      );

      if (tds.length === 0) return;

      // Build comprehensive rundown message
      const lines = [];
      const statusEmoji = rundown.overallStatus === 'clear' ? '✅' : rundown.overallStatus === 'warning' ? '⚠️' : '🔴';

      lines.push(`${statusEmoji} Pre-Service Rundown — ${rundown.churchName}`);
      if (rundown.minutesUntilService) {
        lines.push(`Service in ${rundown.minutesUntilService} minutes`);
      }
      lines.push('');

      // Check categories
      for (const [category, data] of Object.entries(rundown.checks)) {
        const catEmoji = data.status === 'clear' ? '✅' : data.status === 'warning' ? '⚠️' : '🔴';
        const passCount = data.items.filter(i => i.pass).length;
        lines.push(`${catEmoji} ${category}: ${passCount}/${data.items.length}`);

        // Show failing items
        const failing = data.items.filter(i => !i.pass);
        for (const item of failing) {
          lines.push(`  ❌ ${item.name}: ${item.detail || 'Issue'}`);
        }
      }

      // Historical context
      if (rundown.historical.lastWeekGrade) {
        lines.push('');
        lines.push(`📊 Last week: ${rundown.historical.lastWeekGrade} grade`);
      }
      if (rundown.historical.recurringIssues.length > 0) {
        lines.push(`⚠ Watch: ${rundown.historical.recurringIssues[0]}`);
      }
      if (rundown.historical.viewerBaseline?.expectedPeak > 0) {
        const vb = rundown.historical.viewerBaseline;
        lines.push(`👥 Expect ~${vb.expectedPeak} peak viewers`);
      }

      const msg = lines.join('\n');

      for (const td of tds) {
        if (!td.telegram_chat_id) continue;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: String(td.telegram_chat_id), text: msg }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    } catch (e) {
      console.error(`[PreServiceRundown] Telegram rundown error:`, e.message);
    }
  }

  // ─── PERSISTENCE ─────────────────────────────────────────────────────────────

  _persistRundown(rundown) {
    try {
      if (this.db) {
        this.db.prepare(`
        INSERT OR REPLACE INTO preservice_rundowns
          (id, church_id, instance_name, room_id, service_time, overall_status,
           checks_json, historical_json, ai_summary, confirmed_by, confirmed_at,
           escalation_level, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rundown.id, rundown.churchId, rundown.instanceName, rundown.roomId,
        rundown.serviceTime || '', rundown.overallStatus,
        JSON.stringify(rundown.checks), JSON.stringify(rundown.historical),
        rundown.aiSummary, rundown.confirmation?.confirmedBy || null,
        rundown.confirmation?.confirmedAt || null,
        rundown.confirmation?.escalationLevel || 0,
        rundown.generatedAt
      );
      } else if (this.queryClient) {
        this._run(`
        INSERT OR REPLACE INTO preservice_rundowns
          (id, church_id, instance_name, room_id, service_time, overall_status,
           checks_json, historical_json, ai_summary, confirmed_by, confirmed_at,
           escalation_level, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
          rundown.id, rundown.churchId, rundown.instanceName, rundown.roomId,
          rundown.serviceTime || '', rundown.overallStatus,
          JSON.stringify(rundown.checks), JSON.stringify(rundown.historical),
          rundown.aiSummary, rundown.confirmation?.confirmedBy || null,
          rundown.confirmation?.confirmedAt || null,
          rundown.confirmation?.escalationLevel || 0,
          rundown.generatedAt,
        ]).catch((e) => {
          console.error(`[PreServiceRundown] DB persist error:`, e.message);
        });
      }
    } catch (e) {
      console.error(`[PreServiceRundown] DB persist error:`, e.message);
    }
  }

  // ─── TIMER MANAGEMENT ────────────────────────────────────────────────────────

  _clearTimer(churchId, instanceName = null, roomId = null) {
    const key = this._compositeKey(churchId, instanceName, roomId);
    const timer = this._timers.get(key);
    if (timer) {
      clearInterval(timer);
      this._timers.delete(key);
    }
  }

  _clearEscalationTimer(churchId, instanceName = null, roomId = null) {
    const key = this._compositeKey(churchId, instanceName, roomId);
    const timer = this._escalationTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this._escalationTimers.delete(key);
    }
  }

  /**
   * Clean up all timers (for graceful shutdown).
   */
  shutdown() {
    for (const timer of this._timers.values()) clearInterval(timer);
    for (const timer of this._escalationTimers.values()) clearInterval(timer);
    this._timers.clear();
    this._escalationTimers.clear();
  }

  // ─── ESCALATION CONTACTS CRUD ────────────────────────────────────────────────

  getEscalationContacts(churchId) {
    try {
      if (this.db) {
        return this.db.prepare(
          'SELECT * FROM escalation_contacts WHERE church_id = ? AND active = 1 ORDER BY role'
        ).all(churchId);
      }
      return (this._escalationContacts.get(churchId) || []).map(contact => ({ ...contact }));
    } catch {
      return [];
    }
  }

  addEscalationContact(churchId, { role, name, contactType, contactValue, notifyOn }) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const row = {
      id,
      church_id: churchId,
      role,
      name,
      contact_type: contactType,
      contact_value: contactValue,
      notify_on: notifyOn || 'critical',
      active: 1,
      created_at: createdAt,
    };

    this._cacheEscalationContact(row);

    if (this.db) {
      this.db.prepare(`
        INSERT INTO escalation_contacts (id, church_id, role, name, contact_type, contact_value, notify_on, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(id, churchId, role, name, contactType, contactValue, notifyOn || 'critical', createdAt);
    } else if (this.queryClient) {
      this._run(`
        INSERT INTO escalation_contacts (id, church_id, role, name, contact_type, contact_value, notify_on, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `, [id, churchId, role, name, contactType, contactValue, notifyOn || 'critical', createdAt]).catch((e) => {
        console.error(`[PreServiceRundown] Escalation contact persist error:`, e.message);
      });
    }

    return row;
  }

  removeEscalationContact(id) {
    this._removeEscalationContactFromCache(id);
    if (this.db) {
      this.db.prepare('UPDATE escalation_contacts SET active = 0 WHERE id = ?').run(id);
    } else if (this.queryClient) {
      this._run('UPDATE escalation_contacts SET active = 0 WHERE id = ?', [id]).catch((e) => {
        console.error(`[PreServiceRundown] Escalation contact persist error:`, e.message);
      });
    }
  }
}

module.exports = { PreServiceRundown, ESCALATION_LEVELS };
