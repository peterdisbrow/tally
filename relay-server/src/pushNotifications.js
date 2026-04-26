/**
 * Push Notification Service — Firebase Cloud Messaging (FCM) integration
 * for iOS/Android mobile push notifications.
 *
 * Integrates with alertEngine.js dispatch pipeline to send push notifications
 * when alerts fire, respecting user notification preferences.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { createQueryClient } = require('./db');

// ─── NOTIFICATION CATEGORIES ────────────────────────────────────────────────
// Maps to UNNotificationCategory identifiers on iOS
const NOTIFICATION_CATEGORIES = {
  STREAM_DOWN: {
    actions: [
      { id: 'restart_stream', title: 'Restart Stream', options: { foreground: true } },
      { id: 'view_dashboard', title: 'View Dashboard', options: { foreground: true } },
    ],
  },
  DEVICE_OFFLINE: {
    actions: [
      { id: 'power_cycle', title: 'Power Cycle', options: { foreground: true } },
      { id: 'view_details', title: 'View Details', options: { foreground: true } },
    ],
  },
  AUDIO_ISSUE: {
    actions: [
      { id: 'unmute', title: 'Unmute', options: { foreground: true } },
      { id: 'view_mixer', title: 'View Mixer', options: { foreground: true } },
    ],
  },
  FAILOVER: {
    actions: [
      { id: 'view_status', title: 'View Status', options: { foreground: true } },
      { id: 'call_support', title: 'Call Support', options: { foreground: true } },
    ],
  },
  STREAM_HEALTH: {
    actions: [
      { id: 'view_dashboard', title: 'View Dashboard', options: { foreground: true } },
    ],
  },
  SERVICE_REMINDER: {
    actions: [
      { id: 'run_precheck', title: 'Run Pre-Check', options: { foreground: true } },
      { id: 'open_dashboard', title: 'Open Dashboard', options: { foreground: true } },
    ],
  },
  SYSTEM_ALERT: {
    actions: [
      { id: 'view_details', title: 'View Details', options: { foreground: true } },
    ],
  },
};

// ─── ALERT TYPE → NOTIFICATION CATEGORY MAPPING ─────────────────────────────
const ALERT_CATEGORY_MAP = {
  stream_stopped: 'STREAM_DOWN',
  atem_stream_stopped: 'STREAM_DOWN',
  vmix_stream_stopped: 'STREAM_DOWN',
  encoder_stream_stopped: 'STREAM_DOWN',
  atem_disconnected: 'DEVICE_OFFLINE',
  obs_disconnected: 'DEVICE_OFFLINE',
  companion_disconnected: 'DEVICE_OFFLINE',
  vmix_disconnected: 'DEVICE_OFFLINE',
  encoder_disconnected: 'DEVICE_OFFLINE',
  hyperdeck_disconnected: 'DEVICE_OFFLINE',
  mixer_disconnected: 'DEVICE_OFFLINE',
  ptz_disconnected: 'DEVICE_OFFLINE',
  propresenter_disconnected: 'DEVICE_OFFLINE',
  audio_silence: 'AUDIO_ISSUE',
  audio_muted: 'AUDIO_ISSUE',
  failover_executed: 'FAILOVER',
  failover_command_failed: 'FAILOVER',
  failover_confirmed_outage: 'FAILOVER',
  failover_recovery_failed: 'FAILOVER',
  fps_low: 'STREAM_HEALTH',
  bitrate_low: 'STREAM_HEALTH',
  stream_platform_health: 'STREAM_HEALTH',
  yt_broadcast_unhealthy: 'STREAM_HEALTH',
  yt_broadcast_offline: 'STREAM_DOWN',
  fb_broadcast_unhealthy: 'STREAM_HEALTH',
  fb_broadcast_offline: 'STREAM_DOWN',
  cpu_high: 'SYSTEM_ALERT',
  multiple_systems_down: 'SYSTEM_ALERT',
  recording_failed: 'SYSTEM_ALERT',
  firmware_outdated: 'SYSTEM_ALERT',
};

// ─── SEVERITY → FCM PRIORITY MAPPING ────────────────────────────────────────
const SEVERITY_PRIORITY = {
  EMERGENCY: 'critical',
  CRITICAL: 'high',
  WARNING: 'default',
  INFO: 'low',
};

// ─── iOS INTERRUPTION LEVELS ─────────────────────────────────────────────────
const SEVERITY_INTERRUPTION = {
  EMERGENCY: 'critical',
  CRITICAL: 'time-sensitive',
  WARNING: 'active',
  INFO: 'passive',
};

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

class PushNotificationService {
  /**
   * @param {object} opts
   * @param {object} opts.db - better-sqlite3 database instance or shared query client
   * @param {object} [opts.firebaseApp] - Initialized firebase-admin app instance
   * @param {Function} [opts.log] - Logging function
   */
  constructor({ db, firebaseApp = null, log = console.log } = {}) {
    this.db = db && typeof db.prepare === 'function' ? db : null;
    this.client = this._resolveClient(db);
    this.firebaseApp = firebaseApp;
    this.messaging = null;
    this.log = log;

    if (firebaseApp) {
      try {
        this.messaging = firebaseApp.messaging();
        this.log('[Push] Firebase Cloud Messaging initialized');
      } catch (e) {
        this.log(`[Push] FCM initialization failed: ${e.message}`);
      }
    } else {
      this.log('[Push] No Firebase app provided — push notifications disabled');
    }

    if (this.db) {
      this._ensureTablesSync();
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
    if (!this.client && !this.db) throw new Error('[Push] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTables();
  }

  // ─── DATABASE SETUP ─────────────────────────────────────────────────────────

  _ensureTablesSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mobile_devices (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        user_id TEXT,
        device_token TEXT NOT NULL,
        platform TEXT DEFAULT 'ios',
        device_name TEXT,
        app_version TEXT,
        last_seen TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (church_id) REFERENCES churches(churchId)
      )
    `);

    // Unique constraint: one token per church (prevents duplicate registrations)
    try { this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_devices_token ON mobile_devices(device_token)'); }
    catch (err) { /* already exists */ console.debug("[pushNotifications] intentional swallow:", err); }

    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_mobile_devices_church ON mobile_devices(church_id)'); }
    catch (err) { /* already exists */ console.debug("[pushNotifications] intentional swallow:", err); }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mobile_notification_prefs (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        user_id TEXT,
        enabled INTEGER DEFAULT 1,
        severity_threshold TEXT DEFAULT 'CRITICAL',
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        per_device_alerts TEXT DEFAULT '{}',
        per_room_filtering TEXT DEFAULT '{}',
        sound TEXT DEFAULT 'default',
        service_reminders INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(church_id, user_id)
      )
    `);
  }

  async _ensureTables() {
    const client = this._requireClient();
    const nowDefault = client.driver === 'postgres' ? 'CURRENT_TIMESTAMP' : "(datetime('now'))";
    await client.exec(`
      CREATE TABLE IF NOT EXISTS mobile_devices (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        user_id TEXT,
        device_token TEXT NOT NULL,
        platform TEXT DEFAULT 'ios',
        device_name TEXT,
        app_version TEXT,
        last_seen TEXT,
        created_at TEXT DEFAULT ${nowDefault},
        FOREIGN KEY (church_id) REFERENCES churches(churchId)
      )
    `);

    try { await client.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_devices_token ON mobile_devices(device_token)'); }
    catch (err) { /* already exists */ console.debug("[pushNotifications] intentional swallow:", err); }

    try { await client.exec('CREATE INDEX IF NOT EXISTS idx_mobile_devices_church ON mobile_devices(church_id)'); }
    catch (err) { /* already exists */ console.debug("[pushNotifications] intentional swallow:", err); }

    await client.exec(`
      CREATE TABLE IF NOT EXISTS mobile_notification_prefs (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        user_id TEXT,
        enabled INTEGER DEFAULT 1,
        severity_threshold TEXT DEFAULT 'CRITICAL',
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        per_device_alerts TEXT DEFAULT '{}',
        per_room_filtering TEXT DEFAULT '{}',
        sound TEXT DEFAULT 'default',
        service_reminders INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT ${nowDefault},
        UNIQUE(church_id, user_id)
      )
    `);
  }

  async _one(sql, params = []) {
    if (this.db) return this.db.prepare(sql).get(...params) || null;
    await this.ready;
    return this._requireClient().queryOne(sql, params);
  }

  async _all(sql, params = []) {
    if (this.db) return this.db.prepare(sql).all(...params);
    await this.ready;
    return this._requireClient().query(sql, params);
  }

  async _run(sql, params = []) {
    if (this.db) return this.db.prepare(sql).run(...params);
    await this.ready;
    return this._requireClient().run(sql, params);
  }

  // ─── DEVICE REGISTRATION ──────────────────────────────────────────────────

  /**
   * Register a device for push notifications.
   * @param {object} opts
   * @param {string} opts.churchId
   * @param {string} [opts.userId]
   * @param {string} opts.deviceToken - FCM/APNs token
   * @param {string} [opts.platform] - 'ios' | 'android'
   * @param {string} [opts.deviceName]
   * @param {string} [opts.appVersion]
   * @returns {{ deviceId: string, created: boolean }}
   */
  registerDevice({ churchId, userId = null, deviceToken, platform = 'ios', deviceName = null, appVersion = null }) {
    if (this.db) {
      return this._registerDeviceSync({ churchId, userId, deviceToken, platform, deviceName, appVersion });
    }
    return this._registerDeviceAsync({ churchId, userId, deviceToken, platform, deviceName, appVersion });
  }

  _registerDeviceSync({ churchId, userId = null, deviceToken, platform = 'ios', deviceName = null, appVersion = null }) {
    if (!churchId || !deviceToken) throw new Error('churchId and deviceToken required');

    // Check if this token is already registered (possibly for a different church — re-assign)
    const existing = this.db.prepare('SELECT id, church_id FROM mobile_devices WHERE device_token = ?').get(deviceToken);
    const now = new Date().toISOString();

    if (existing) {
      // Update existing record (token may have changed church/user)
      this.db.prepare(`
        UPDATE mobile_devices SET church_id = ?, user_id = ?, platform = ?, device_name = ?, app_version = ?, last_seen = ?
        WHERE id = ?
      `).run(churchId, userId, platform, deviceName, appVersion, now, existing.id);
      this.log(`[Push] Device re-registered: ${existing.id} for church ${churchId}`);
      return { deviceId: existing.id, created: false };
    }

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO mobile_devices (id, church_id, user_id, device_token, platform, device_name, app_version, last_seen, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, churchId, userId, deviceToken, platform, deviceName, appVersion, now, now);

    this.log(`[Push] Device registered: ${id} (${platform}) for church ${churchId}`);
    return { deviceId: id, created: true };
  }

  async _registerDeviceAsync({ churchId, userId = null, deviceToken, platform = 'ios', deviceName = null, appVersion = null }) {
    await this.ready;
    if (!churchId || !deviceToken) throw new Error('churchId and deviceToken required');

    const existing = await this._one('SELECT id, church_id FROM mobile_devices WHERE device_token = ?', [deviceToken]);
    const now = new Date().toISOString();

    if (existing) {
      await this._run(`
        UPDATE mobile_devices SET church_id = ?, user_id = ?, platform = ?, device_name = ?, app_version = ?, last_seen = ?
        WHERE id = ?
      `, [churchId, userId, platform, deviceName, appVersion, now, existing.id]);
      this.log(`[Push] Device re-registered: ${existing.id} for church ${churchId}`);
      return { deviceId: existing.id, created: false };
    }

    const id = uuidv4();
    await this._run(`
      INSERT INTO mobile_devices (id, church_id, user_id, device_token, platform, device_name, app_version, last_seen, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, churchId, userId, deviceToken, platform, deviceName, appVersion, now, now]);

    this.log(`[Push] Device registered: ${id} (${platform}) for church ${churchId}`);
    return { deviceId: id, created: true };
  }

  /**
   * Unregister a device (on logout or token refresh).
   * @param {string} deviceToken
   * @param {string} churchId - Scoped to church for safety
   * @returns {{ removed: boolean }}
   */
  unregisterDevice(deviceToken, churchId) {
    if (this.db) return this._unregisterDeviceSync(deviceToken, churchId);
    return this._unregisterDeviceAsync(deviceToken, churchId);
  }

  _unregisterDeviceSync(deviceToken, churchId) {
    const result = this.db.prepare('DELETE FROM mobile_devices WHERE device_token = ? AND church_id = ?').run(deviceToken, churchId);
    if (result.changes > 0) {
      this.log(`[Push] Device unregistered for church ${churchId}`);
    }
    return { removed: result.changes > 0 };
  }

  async _unregisterDeviceAsync(deviceToken, churchId) {
    await this.ready;
    const result = await this._run('DELETE FROM mobile_devices WHERE device_token = ? AND church_id = ?', [deviceToken, churchId]);
    if (result.changes > 0) {
      this.log(`[Push] Device unregistered for church ${churchId}`);
    }
    return { removed: result.changes > 0 };
  }

  /**
   * Update the last_seen timestamp for a device (called on app launch / WebSocket connect).
   */
  touchDevice(deviceToken) {
    if (this.db) return this._touchDeviceSync(deviceToken);
    return this._touchDeviceAsync(deviceToken);
  }

  _touchDeviceSync(deviceToken) {
    this.db.prepare('UPDATE mobile_devices SET last_seen = ? WHERE device_token = ?')
      .run(new Date().toISOString(), deviceToken);
  }

  async _touchDeviceAsync(deviceToken) {
    await this.ready;
    await this._run('UPDATE mobile_devices SET last_seen = ? WHERE device_token = ?', [new Date().toISOString(), deviceToken]);
  }

  /**
   * Get all registered devices for a church.
   */
  getDevicesForChurch(churchId) {
    if (this.db) return this.db.prepare('SELECT * FROM mobile_devices WHERE church_id = ? ORDER BY last_seen DESC').all(churchId);
    return this._getDevicesForChurchAsync(churchId);
  }

  async _getDevicesForChurchAsync(churchId) {
    return this._all('SELECT * FROM mobile_devices WHERE church_id = ? ORDER BY last_seen DESC', [churchId]);
  }

  // ─── NOTIFICATION PREFERENCES ─────────────────────────────────────────────

  /**
   * Get notification preferences for a user at a church.
   * Returns defaults if no prefs exist.
   */
  getPrefs(churchId, userId = null) {
    if (this.db) return this._getPrefsSync(churchId, userId);
    return this._getPrefsAsync(churchId, userId);
  }

  _getPrefsSync(churchId, userId = null) {
    const row = this.db.prepare(
      'SELECT * FROM mobile_notification_prefs WHERE church_id = ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))'
    ).get(churchId, userId, userId);

    if (!row) {
      return {
        enabled: true,
        severityThreshold: 'CRITICAL',
        quietHoursStart: null,
        quietHoursEnd: null,
        perDeviceAlerts: {},
        perRoomFiltering: {},
        sound: 'default',
        serviceReminders: true,
      };
    }

    return {
      enabled: !!row.enabled,
      severityThreshold: row.severity_threshold || 'CRITICAL',
      quietHoursStart: row.quiet_hours_start || null,
      quietHoursEnd: row.quiet_hours_end || null,
      perDeviceAlerts: _safeJsonParse(row.per_device_alerts, {}),
      perRoomFiltering: _safeJsonParse(row.per_room_filtering, {}),
      sound: row.sound || 'default',
      serviceReminders: row.service_reminders !== 0,
    };
  }

  async _getPrefsAsync(churchId, userId = null) {
    const row = await this._one(
      'SELECT * FROM mobile_notification_prefs WHERE church_id = ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))',
      [churchId, userId, userId]
    );

    if (!row) {
      return {
        enabled: true,
        severityThreshold: 'CRITICAL',
        quietHoursStart: null,
        quietHoursEnd: null,
        perDeviceAlerts: {},
        perRoomFiltering: {},
        sound: 'default',
        serviceReminders: true,
      };
    }

    return {
      enabled: !!row.enabled,
      severityThreshold: row.severity_threshold || 'CRITICAL',
      quietHoursStart: row.quiet_hours_start || null,
      quietHoursEnd: row.quiet_hours_end || null,
      perDeviceAlerts: _safeJsonParse(row.per_device_alerts, {}),
      perRoomFiltering: _safeJsonParse(row.per_room_filtering, {}),
      sound: row.sound || 'default',
      serviceReminders: row.service_reminders !== 0,
    };
  }

  /**
   * Update notification preferences for a user at a church.
   */
  updatePrefs(churchId, userId = null, prefs = {}) {
    if (this.db) return this._updatePrefsSync(churchId, userId, prefs);
    return this._updatePrefsAsync(churchId, userId, prefs);
  }

  _updatePrefsSync(churchId, userId = null, prefs = {}) {
    const existing = this.db.prepare(
      'SELECT id FROM mobile_notification_prefs WHERE church_id = ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))'
    ).get(churchId, userId, userId);

    const now = new Date().toISOString();
    const enabled = prefs.enabled !== undefined ? (prefs.enabled ? 1 : 0) : 1;
    const severityThreshold = prefs.severityThreshold || 'CRITICAL';
    const quietHoursStart = prefs.quietHoursStart || null;
    const quietHoursEnd = prefs.quietHoursEnd || null;
    const perDeviceAlerts = JSON.stringify(prefs.perDeviceAlerts || {});
    const perRoomFiltering = JSON.stringify(prefs.perRoomFiltering || {});
    const sound = prefs.sound || 'default';
    const serviceReminders = prefs.serviceReminders !== undefined ? (prefs.serviceReminders ? 1 : 0) : 1;

    if (existing) {
      this.db.prepare(`
        UPDATE mobile_notification_prefs
        SET enabled = ?, severity_threshold = ?, quiet_hours_start = ?, quiet_hours_end = ?,
            per_device_alerts = ?, per_room_filtering = ?, sound = ?, service_reminders = ?, updated_at = ?
        WHERE id = ?
      `).run(enabled, severityThreshold, quietHoursStart, quietHoursEnd,
        perDeviceAlerts, perRoomFiltering, sound, serviceReminders, now, existing.id);
    } else {
      const id = uuidv4();
      this.db.prepare(`
        INSERT INTO mobile_notification_prefs
          (id, church_id, user_id, enabled, severity_threshold, quiet_hours_start, quiet_hours_end,
           per_device_alerts, per_room_filtering, sound, service_reminders, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, churchId, userId, enabled, severityThreshold, quietHoursStart, quietHoursEnd,
        perDeviceAlerts, perRoomFiltering, sound, serviceReminders, now);
    }

    return this.getPrefs(churchId, userId);
  }

  async _updatePrefsAsync(churchId, userId = null, prefs = {}) {
    await this.ready;
    const existing = await this._one(
      'SELECT id FROM mobile_notification_prefs WHERE church_id = ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))',
      [churchId, userId, userId]
    );

    const now = new Date().toISOString();
    const enabled = prefs.enabled !== undefined ? (prefs.enabled ? 1 : 0) : 1;
    const severityThreshold = prefs.severityThreshold || 'CRITICAL';
    const quietHoursStart = prefs.quietHoursStart || null;
    const quietHoursEnd = prefs.quietHoursEnd || null;
    const perDeviceAlerts = JSON.stringify(prefs.perDeviceAlerts || {});
    const perRoomFiltering = JSON.stringify(prefs.perRoomFiltering || {});
    const sound = prefs.sound || 'default';
    const serviceReminders = prefs.serviceReminders !== undefined ? (prefs.serviceReminders ? 1 : 0) : 1;

    if (existing) {
      await this._run(`
        UPDATE mobile_notification_prefs
        SET enabled = ?, severity_threshold = ?, quiet_hours_start = ?, quiet_hours_end = ?,
            per_device_alerts = ?, per_room_filtering = ?, sound = ?, service_reminders = ?, updated_at = ?
        WHERE id = ?
      `, [enabled, severityThreshold, quietHoursStart, quietHoursEnd,
        perDeviceAlerts, perRoomFiltering, sound, serviceReminders, now, existing.id]);
    } else {
      const id = uuidv4();
      await this._run(`
        INSERT INTO mobile_notification_prefs
          (id, church_id, user_id, enabled, severity_threshold, quiet_hours_start, quiet_hours_end,
           per_device_alerts, per_room_filtering, sound, service_reminders, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, churchId, userId, enabled, severityThreshold, quietHoursStart, quietHoursEnd,
        perDeviceAlerts, perRoomFiltering, sound, serviceReminders, now]);
    }

    return this._getPrefsAsync(churchId, userId);
  }

  // ─── ALERT DISPATCH ───────────────────────────────────────────────────────

  /**
   * Send a push notification for an alert event.
   * Called from alertEngine.js after Telegram/Slack dispatch.
   *
   * @param {string} churchId
   * @param {object} alertEvent - { alertId, alertType, severity, context, diagnosis }
   * @returns {Promise<{ sent: number, skipped: number, failed: number }>}
   */
  async sendAlert(churchId, alertEvent) {
    await this.ready;
    const { alertType, severity, context = {}, diagnosis = {} } = alertEvent;

    if (severity === 'INFO') return { sent: 0, skipped: 0, failed: 0 };

    const devices = await this.getDevicesForChurch(churchId);
    if (!devices.length) return { sent: 0, skipped: 0, failed: 0 };

    const results = { sent: 0, skipped: 0, failed: 0 };
    const category = ALERT_CATEGORY_MAP[alertType] || 'SYSTEM_ALERT';
    const priority = SEVERITY_PRIORITY[severity] || 'default';
    const interruptionLevel = SEVERITY_INTERRUPTION[severity] || 'active';

    // Build human-readable notification content
    const roomName = context._instanceName || context.roomName || '';
    const title = roomName
      ? `${_alertTitle(alertType)} — ${roomName}`
      : _alertTitle(alertType);
    const body = diagnosis?.likely_cause || `${alertType.replace(/_/g, ' ')} detected`;

    // Group by user to check prefs per-user
    const userDeviceMap = new Map();
    for (const device of devices) {
      const key = device.user_id || '__church_default__';
      if (!userDeviceMap.has(key)) userDeviceMap.set(key, []);
      userDeviceMap.get(key).push(device);
    }

    for (const [userId, userDevices] of userDeviceMap) {
      const prefs = await this.getPrefs(churchId, userId === '__church_default__' ? null : userId);

      // Check: enabled?
      if (!prefs.enabled) {
        results.skipped += userDevices.length;
        continue;
      }

      // Check: severity threshold
      if (!_meetsSeverityThreshold(severity, prefs.severityThreshold)) {
        results.skipped += userDevices.length;
        continue;
      }

      // Check: quiet hours
      if (_isQuietHours(prefs.quietHoursStart, prefs.quietHoursEnd) && severity !== 'EMERGENCY') {
        results.skipped += userDevices.length;
        continue;
      }

      // Check: per-room filtering
      const roomId = context._roomId || null;
      if (roomId && Object.keys(prefs.perRoomFiltering).length > 0) {
        if (prefs.perRoomFiltering[roomId] === false) {
          results.skipped += userDevices.length;
          continue;
        }
      }

      // Send to each device
      for (const device of userDevices) {
        try {
          await this._sendToDevice(device, {
            title, body, category, priority, interruptionLevel, severity,
            alertType, alertId: alertEvent.alertId, churchId, roomId, roomName,
            canAutoFix: diagnosis?.canAutoFix || false,
          });
          results.sent++;
        } catch (e) {
          this.log(`[Push] Failed to send to device ${device.id}: ${e.message}`);
          // Remove invalid tokens
          if (_isInvalidTokenError(e)) {
            await this._run('DELETE FROM mobile_devices WHERE id = ?', [device.id]);
            this.log(`[Push] Removed invalid device token: ${device.id}`);
          }
          results.failed++;
        }
      }
    }

    if (results.sent > 0) {
      this.log(`[Push] Alert ${alertType} sent to ${results.sent} device(s) for church ${churchId}`);
    }
    return results;
  }

  // ─── SILENT NOTIFICATION (background data update) ─────────────────────────

  /**
   * Send a silent notification to update app data in the background.
   * Used for widget refresh, health score changes, non-urgent status.
   */
  async sendSilent(churchId, data = {}) {
    await this.ready;
    const devices = await this.getDevicesForChurch(churchId);
    if (!devices.length || !this.messaging) return { sent: 0 };

    let sent = 0;
    const tokens = devices.map(d => d.device_token);

    try {
      const message = {
        data: { ...stringifyValues(data), silent: 'true' },
        apns: {
          payload: {
            aps: {
              'content-available': 1,
            },
          },
        },
        tokens,
      };
      const response = await this.messaging.sendEachForMulticast(message);
      sent = response.successCount;
      await this._cleanupFailedTokens(response, devices);
    } catch (e) {
      this.log(`[Push] Silent notification failed for church ${churchId}: ${e.message}`);
    }
    return { sent };
  }

  // ─── SERVICE REMINDER ─────────────────────────────────────────────────────

  /**
   * Send a pre-service reminder push notification.
   * Called by the schedule engine at T-30 minutes before service.
   *
   * @param {string} churchId
   * @param {object} serviceInfo - { name, startsAt, rundownSummary }
   */
  async sendServiceReminder(churchId, serviceInfo = {}) {
    await this.ready;
    const devices = await this.getDevicesForChurch(churchId);
    if (!devices.length) return { sent: 0, skipped: 0 };

    const results = { sent: 0, skipped: 0 };
    const serviceName = serviceInfo.name || 'Upcoming Service';
    const title = `${serviceName} starts in 30 minutes`;
    const body = serviceInfo.rundownSummary || 'Tap to run pre-service check and review the rundown.';

    for (const device of devices) {
      const prefs = await this.getPrefs(churchId, device.user_id);
      if (!prefs.enabled || !prefs.serviceReminders) {
        results.skipped++;
        continue;
      }

      try {
        await this._sendToDevice(device, {
          title,
          body,
          category: 'SERVICE_REMINDER',
          priority: 'default',
          interruptionLevel: 'active',
          severity: 'INFO',
          alertType: 'service_reminder',
          churchId,
          serviceStartsAt: serviceInfo.startsAt || null,
          rundownId: serviceInfo.rundownId || null,
        });
        results.sent++;
      } catch (e) {
        this.log(`[Push] Service reminder failed for device ${device.id}: ${e.message}`);
        if (_isInvalidTokenError(e)) {
          await this._run('DELETE FROM mobile_devices WHERE id = ?', [device.id]);
        }
      }
    }

    if (results.sent > 0) {
      this.log(`[Push] Service reminder sent to ${results.sent} device(s) for church ${churchId}`);
    }
    return results;
  }

  // ─── INTERNAL ─────────────────────────────────────────────────────────────

  /**
   * Send a single notification to a device via FCM.
   */
  async _sendToDevice(device, payload) {
    if (!this.messaging) {
      this.log('[Push] FCM not initialized — notification not sent');
      return;
    }

    const {
      title, body, category, priority, interruptionLevel, severity,
      alertType, alertId, churchId, roomId, roomName,
      canAutoFix, serviceStartsAt, rundownId,
    } = payload;

    // Build FCM message
    const message = {
      token: device.device_token,
      notification: {
        title,
        body,
      },
      data: stringifyValues({
        type: alertType,
        churchId,
        roomId: roomId || '',
        roomName: roomName || '',
        severity: severity || '',
        alertId: alertId || '',
        canAutoFix: canAutoFix ? 'true' : 'false',
        category,
        deepLink: `tallyconnect://dashboard/${roomId || ''}`,
        ...(serviceStartsAt ? { serviceStartsAt } : {}),
        ...(rundownId ? { rundownId } : {}),
      }),
      apns: {
        headers: {
          'apns-priority': priority === 'critical' ? '10' : priority === 'high' ? '10' : '5',
        },
        payload: {
          aps: {
            category,
            'interruption-level': interruptionLevel,
            'relevance-score': severity === 'EMERGENCY' ? 1.0 : severity === 'CRITICAL' ? 0.9 : 0.5,
            sound: _getSound(severity, priority),
          },
        },
      },
      android: {
        priority: priority === 'critical' || priority === 'high' ? 'high' : 'normal',
        notification: {
          channelId: `tally_${(priority === 'critical' || priority === 'high') ? 'urgent' : 'default'}`,
          priority: priority === 'critical' ? 'max' : priority === 'high' ? 'high' : 'default',
        },
      },
    };

    return this.messaging.send(message);
  }

  /**
   * Clean up tokens that FCM reports as invalid after a multicast send.
   */
  async _cleanupFailedTokens(response, devices) {
    if (!response.responses) return;
    for (const [idx, resp] of response.responses.entries()) {
      if (!resp.success && resp.error && _isInvalidTokenError(resp.error)) {
        const device = devices[idx];
        if (device) {
          await this._run('DELETE FROM mobile_devices WHERE id = ?', [device.id]);
          this.log(`[Push] Cleaned up invalid token: ${device.id}`);
        }
      }
    }
  }

  /**
   * Get stats about registered devices and notification delivery.
   */
  getStats(churchId) {
    if (this.db) return this._getStatsSync(churchId);
    return this._getStatsAsync(churchId);
  }

  _getStatsSync(churchId) {
    const deviceCount = this.db.prepare('SELECT COUNT(*) as cnt FROM mobile_devices WHERE church_id = ?').get(churchId)?.cnt || 0;
    const platforms = this.db.prepare('SELECT platform, COUNT(*) as cnt FROM mobile_devices WHERE church_id = ? GROUP BY platform').all(churchId);
    return { deviceCount, platforms };
  }

  async _getStatsAsync(churchId) {
    await this.ready;
    const deviceCount = (await this._one('SELECT COUNT(*) as cnt FROM mobile_devices WHERE church_id = ?', [churchId]))?.cnt || 0;
    const platforms = await this._all('SELECT platform, COUNT(*) as cnt FROM mobile_devices WHERE church_id = ? GROUP BY platform', [churchId]);
    return { deviceCount, platforms };
  }
}

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

function _alertTitle(alertType) {
  const titles = {
    stream_stopped: 'Stream Stopped',
    atem_stream_stopped: 'ATEM Stream Stopped',
    vmix_stream_stopped: 'vMix Stream Stopped',
    encoder_stream_stopped: 'Encoder Stream Stopped',
    atem_disconnected: 'ATEM Disconnected',
    obs_disconnected: 'OBS Disconnected',
    companion_disconnected: 'Companion Disconnected',
    vmix_disconnected: 'vMix Disconnected',
    encoder_disconnected: 'Encoder Disconnected',
    hyperdeck_disconnected: 'HyperDeck Disconnected',
    mixer_disconnected: 'Mixer Disconnected',
    ptz_disconnected: 'PTZ Camera Disconnected',
    propresenter_disconnected: 'ProPresenter Disconnected',
    audio_silence: 'Audio Silence Detected',
    audio_muted: 'Audio Muted',
    failover_executed: 'Failover Executed',
    failover_command_failed: 'Failover Failed',
    failover_confirmed_outage: 'Signal Outage Confirmed',
    failover_recovery_failed: 'Failover Recovery Failed',
    fps_low: 'Low Frame Rate',
    bitrate_low: 'Low Bitrate',
    cpu_high: 'High CPU Usage',
    multiple_systems_down: 'Multiple Systems Down',
    recording_failed: 'Recording Failed',
    yt_broadcast_unhealthy: 'YouTube Stream Unhealthy',
    yt_broadcast_offline: 'YouTube Stream Offline',
    fb_broadcast_unhealthy: 'Facebook Stream Unhealthy',
    fb_broadcast_offline: 'Facebook Stream Offline',
    stream_platform_health: 'Stream Health Issue',
    firmware_outdated: 'Firmware Update Available',
  };
  return titles[alertType] || alertType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _meetsSeverityThreshold(alertSeverity, threshold) {
  const levels = { EMERGENCY: 4, CRITICAL: 3, WARNING: 2, INFO: 1, ALL: 0 };
  const alertLevel = levels[alertSeverity] ?? 1;
  const thresholdLevel = levels[threshold] ?? 3;
  return alertLevel >= thresholdLevel;
}

function _isQuietHours(start, end) {
  if (!start || !end) return false;
  const now = new Date();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  // Handle overnight quiet hours (e.g. 22:00 - 07:00)
  if (startMinutes > endMinutes) {
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

function _isInvalidTokenError(error) {
  const code = error?.code || error?.errorInfo?.code || '';
  return code === 'messaging/invalid-registration-token' ||
         code === 'messaging/registration-token-not-registered' ||
         code === 'messaging/invalid-argument';
}

function _getSound(severity, priority) {
  if (severity === 'EMERGENCY' || priority === 'critical') {
    return { name: 'critical_alert.caf', critical: 1, volume: 1.0 };
  }
  if (severity === 'CRITICAL' || priority === 'high') {
    return 'default';
  }
  return 'default';
}

/**
 * Stringify all values in an object (FCM data payloads must be string-only).
 */
function stringifyValues(obj) {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined && val !== null) {
      result[key] = String(val);
    }
  }
  return result;
}

function _safeJsonParse(str, fallback = {}) {
  try { return JSON.parse(str || '{}'); }
  catch { return fallback; }
}

module.exports = {
  PushNotificationService,
  NOTIFICATION_CATEGORIES,
  ALERT_CATEGORY_MAP,
  SEVERITY_PRIORITY,
  SEVERITY_INTERRUPTION,
};
