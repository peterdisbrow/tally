/**
 * Alert Engine — Severity classification, escalation ladder, Telegram notifications
 */

const { v4: uuidv4 } = require('uuid');

// Alert types that always bypass deduplication and send immediately
const CRITICAL_BYPASS_TYPES = new Set([
  'stream_stopped',
  'signal_loss',
  'encoder_offline',
]);

const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const ALERT_CLASSIFICATIONS = {
  'stream_started': 'INFO',
  'recording_started': 'INFO',
  'service_ended': 'INFO',
  'fps_low': 'WARNING',
  'bitrate_low': 'WARNING',
  'cpu_high': 'WARNING',
  'stream_stopped': 'CRITICAL',
  'atem_stream_stopped': 'CRITICAL',
  'vmix_stream_stopped': 'CRITICAL',
  'encoder_stream_stopped': 'CRITICAL',
  'stream_platform_health': 'WARNING',
  'atem_disconnected': 'CRITICAL',
  'recording_failed': 'CRITICAL',
  'obs_disconnected': 'WARNING',
  'companion_disconnected': 'WARNING',
  'vmix_disconnected': 'WARNING',
  'encoder_disconnected': 'WARNING',
  'hyperdeck_disconnected': 'WARNING',
  'mixer_disconnected': 'WARNING',
  'ptz_disconnected': 'WARNING',
  'propresenter_disconnected': 'WARNING',
  'audio_silence': 'WARNING',
  'audio_muted': 'CRITICAL',
  'firmware_outdated': 'WARNING',
  'multiple_systems_down': 'EMERGENCY',
  'no_td_response': 'EMERGENCY',
  // Signal failover classifications
  'failover_suspected_black': 'WARNING',
  'failover_atem_lost': 'WARNING',
  'failover_confirmed_outage': 'CRITICAL',
  'failover_executed': 'EMERGENCY',
  'failover_source_recovering': 'INFO',
  'failover_recovery_executed': 'INFO',
  'failover_recovery_failed': 'CRITICAL',
  'failover_command_failed': 'EMERGENCY',
};

const DIAGNOSIS_TEMPLATES = {
  'stream_stopped': {
    likely_cause: 'Internet fluctuation or encoder/software crash',
    confidence: 85,
    steps: ['Check your streaming software — is it still running?', 'Restart the stream from your encoder or Tally', 'If still down, check your internet connection'],
    canAutoFix: false,
  },
  'atem_disconnected': {
    likely_cause: 'ATEM lost network connection',
    confidence: 90,
    steps: ['Check ethernet cable on ATEM', 'Ping ATEM IP from production computer', 'Power cycle ATEM if needed'],
    canAutoFix: false,
  },
  'recording_failed': {
    likely_cause: 'Storage full or recording drive disconnected',
    confidence: 70,
    steps: ['Check available disk space', 'Verify recording drive is mounted', 'Try starting recording manually'],
    canAutoFix: false,
  },
  'fps_low': {
    likely_cause: 'CPU overloaded or encoding settings too high',
    confidence: 80,
    steps: ['Check CPU usage on streaming machine', 'Lower resolution or encoding preset', 'Close unnecessary applications'],
    canAutoFix: false,
  },
  'bitrate_low': {
    likely_cause: 'Network bandwidth insufficient for current settings',
    confidence: 75,
    steps: ['Check internet speed', 'Close other bandwidth-heavy applications', 'Consider lowering stream quality'],
    canAutoFix: false,
  },
  'cpu_high': {
    likely_cause: 'Too many sources or effects active on streaming software',
    confidence: 85,
    steps: ['Close unnecessary applications', 'Disable unused sources/scenes', 'Reduce output resolution'],
    canAutoFix: false,
  },
  'obs_disconnected': {
    likely_cause: 'OBS crashed or WebSocket plugin issue',
    confidence: 80,
    steps: ['Check if OBS is still running', 'Restart OBS if needed', 'Verify WebSocket server is enabled in OBS settings'],
    canAutoFix: false,
  },
  'companion_disconnected': {
    likely_cause: 'Companion app crashed or network issue',
    confidence: 75,
    steps: ['Check if Companion is running on the booth computer', 'Restart Companion app if needed', 'Verify Companion HTTP API is enabled on port 8000'],
    canAutoFix: false,
  },
  'vmix_disconnected': {
    likely_cause: 'vMix lost connection or Web Controller disabled',
    confidence: 80,
    steps: ['Check if vMix is running', 'Verify Web Controller is enabled in vMix Settings', 'Check network connectivity'],
    canAutoFix: false,
  },
  'audio_silence': {
    likely_cause: 'Audio signal lost — mixer may be muted or disconnected',
    confidence: 65,
    steps: ['Check mixer master fader and mute status', 'Verify audio routing from mixer to encoder', 'Check physical audio cable connections'],
    canAutoFix: false,
  },
  'multiple_systems_down': {
    likely_cause: 'Possible network outage or power issue at venue',
    confidence: 90,
    steps: ['Check network switch/router', 'Verify power to production rack', 'Contact someone on-site immediately'],
    canAutoFix: false,
  },
  'recording_not_started': {
    likely_cause: 'Recording was not started before service',
    confidence: 95,
    steps: ['Start recording via Tally', 'Check ATEM recording settings'],
    canAutoFix: false,
  },
  'encoder_disconnected': {
    likely_cause: 'Hardware encoder lost network connection or powered off',
    confidence: 85,
    steps: ['Check encoder power and network cables', 'Verify encoder IP address is correct', 'Try power-cycling the encoder'],
    canAutoFix: false,
  },
  'hyperdeck_disconnected': {
    likely_cause: 'HyperDeck lost network connection or powered off',
    confidence: 85,
    steps: ['Check HyperDeck network cable connection', 'Verify HyperDeck IP address on front panel', 'Power cycle HyperDeck if needed'],
    canAutoFix: false,
  },
  'mixer_disconnected': {
    likely_cause: 'Audio console lost network connection',
    confidence: 85,
    steps: ['Check network cable on mixer', 'Verify mixer IP address and port', 'Check if another application has taken the OSC port'],
    canAutoFix: false,
  },
  'ptz_disconnected': {
    likely_cause: 'PTZ camera lost network connection',
    confidence: 85,
    steps: ['Check PTZ camera network cable', 'Verify camera IP address', 'Power cycle camera if needed'],
    canAutoFix: false,
  },
  'propresenter_disconnected': {
    likely_cause: 'ProPresenter closed or network API disabled',
    confidence: 80,
    steps: ['Check if ProPresenter is running', 'Verify Network API is enabled in ProPresenter preferences', 'Check network connectivity to presentation computer'],
    canAutoFix: false,
  },
  'atem_stream_stopped': {
    likely_cause: 'ATEM streaming encoder stopped — network issue or service disruption',
    confidence: 85,
    steps: ['Check ATEM streaming settings', 'Verify streaming service key is still valid', 'Check internet connection to ATEM'],
    canAutoFix: false,
  },
  'vmix_stream_stopped': {
    likely_cause: 'vMix stream stopped — software crash or network issue',
    confidence: 85,
    steps: ['Check if vMix is still running', 'Restart stream from vMix interface', 'Check internet connection'],
    canAutoFix: false,
  },
  'encoder_stream_stopped': {
    likely_cause: 'Hardware encoder stream stopped — network or configuration issue',
    confidence: 85,
    steps: ['Check encoder status lights/display', 'Verify stream key and destination URL', 'Check internet connection to encoder'],
    canAutoFix: false,
  },
  'stream_platform_health': {
    likely_cause: 'Stream may not be reaching destination platform properly',
    confidence: 70,
    steps: ['Check platform dashboard (YouTube Studio / Facebook Live)', 'Verify stream key is correct', 'Check internet connection quality'],
    canAutoFix: false,
  },
  'firmware_outdated': {
    likely_cause: 'Device firmware or software version is below recommended minimum',
    confidence: 95,
    steps: ['Check the version shown in your church portal equipment table', 'Visit the manufacturer website for the latest update', 'Schedule a maintenance window to update — never update during a service'],
    canAutoFix: false,
  },
  'failover_confirmed_outage': {
    likely_cause: 'Source signal lost — possible upstream power or hardware failure',
    confidence: 90,
    steps: ['Check source equipment power', 'Verify SDI/HDMI signal chain', 'Failover will engage automatically if unacknowledged'],
    canAutoFix: true,
  },
  'failover_executed': {
    likely_cause: 'Automated failover triggered after source outage was confirmed',
    confidence: 95,
    steps: ['Check and restore original source equipment', 'Verify source signal is stable', 'Reply with /recover command when ready to switch back'],
    canAutoFix: false,
  },
  'failover_command_failed': {
    likely_cause: 'Failover command could not be sent to the switcher or router',
    confidence: 85,
    steps: ['Check ATEM/VideoHub connection', 'Manually switch to backup source immediately', 'Check network between Tally and switcher'],
    canAutoFix: false,
  },
};

class AlertEngine {
  constructor(db, scheduleEngine, options = {}) {
    this.db = db;
    this.scheduleEngine = scheduleEngine;
    this.andrewChatId = options.andrewChatId || process.env.ANDREW_TELEGRAM_CHAT_ID;
    this.defaultBotToken = options.defaultBotToken || process.env.ALERT_BOT_TOKEN;
    this.activeAlerts = new Map(); // alertId → { church, alertType, context, severity, sentAt, escalationTimer }
    // Optional: OnCallRotation instance injected after construction
    this.onCallRotation = options.onCallRotation || null;
    // Optional: ResellerSystem for white-labeling brand names
    this.resellerSystem = options.resellerSystem || null;

    // ─── Deduplication state ──────────────────────────────────────────────────
    // dedupState: Map<"churchId::alertType" → { count, firstSeen, lastContext, timer }>
    this.dedupState = new Map();
    // Per-church, per-alertType dedup windows: Map<"churchId::alertType" → milliseconds>
    this.dedupWindows = new Map();

    this._ensureColumns();
    this._ensureAlertsTable();
  }

  /** Attach lifecycle emails engine for escalation emails */
  setLifecycleEmails(engine) {
    this.lifecycleEmails = engine;
  }

  /**
   * Get the brand name for a church (for white-labeling alert messages).
   * Falls back to "Tally" if no reseller.
   */
  _getBrandName(church) {
    if (!this.resellerSystem || !church.reseller_id) return 'Tally';
    try {
      const branding = this.resellerSystem.getBranding(church.reseller_id);
      return branding?.brandName || 'Tally';
    } catch { return 'Tally'; }
  }

  _ensureColumns() {
    const cols = { td_telegram_chat_id: 'TEXT', td_name: 'TEXT', alert_bot_token: 'TEXT' };
    for (const [col, type] of Object.entries(cols)) {
      try {
        this.db.prepare(`SELECT ${col} FROM churches LIMIT 1`).get();
      } catch {
        this.db.exec(`ALTER TABLE churches ADD COLUMN ${col} ${type} DEFAULT ''`);
      }
    }
  }

  _ensureAlertsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        context TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        escalated INTEGER DEFAULT 0,
        resolved INTEGER DEFAULT 0
      )
    `);

    // Migration: add session_id column for timeline linking
    try { this.db.prepare('SELECT session_id FROM alerts LIMIT 1').get(); }
    catch { this.db.exec('ALTER TABLE alerts ADD COLUMN session_id TEXT'); }
  }

  classifyAlert(alertType, context) {
    return ALERT_CLASSIFICATIONS[alertType] || 'WARNING';
  }

  getDiagnosis(alertType) {
    return DIAGNOSIS_TEMPLATES[alertType] || {
      likely_cause: 'Unknown issue',
      steps: ['Check system status in Tally', 'Contact support if issue persists'],
      canAutoFix: false,
    };
  }

  // ─── DEDUPLICATION ──────────────────────────────────────────────────────

  /**
   * Set a custom dedup window for a specific church + alert type.
   * @param {string} churchId
   * @param {string} alertType
   * @param {number} minutes — window in minutes
   */
  setDedupWindow(churchId, alertType, minutes) {
    const key = `${churchId}::${alertType}`;
    this.dedupWindows.set(key, minutes * 60 * 1000);
  }

  /**
   * Get the dedup window (ms) for a church + alert type combo.
   */
  _getDedupWindowMs(churchId, alertType) {
    const key = `${churchId}::${alertType}`;
    return this.dedupWindows.get(key) ?? DEFAULT_DEDUP_WINDOW_MS;
  }

  /**
   * Clear all dedup state for a church (e.g. on disconnect / cleanup).
   */
  clearDedupState(churchId) {
    for (const [key, entry] of this.dedupState.entries()) {
      if (key.startsWith(`${churchId}::`)) {
        if (entry.timer) clearTimeout(entry.timer);
        this.dedupState.delete(key);
      }
    }
    // Also remove any custom windows for this church
    for (const key of this.dedupWindows.keys()) {
      if (key.startsWith(`${churchId}::`)) {
        this.dedupWindows.delete(key);
      }
    }
  }

  /**
   * Returns true if the alert should bypass dedup and send immediately.
   */
  _shouldBypassDedup(alertType) {
    if (CRITICAL_BYPASS_TYPES.has(alertType)) return true;
    const severity = this.classifyAlert(alertType);
    return severity === 'EMERGENCY';
  }

  /**
   * Check dedup state. Returns:
   *   { action: 'send' }         — first occurrence or bypass, proceed to send
   *   { action: 'deduplicated' } — suppressed, counter incremented
   */
  _checkDedup(church, alertType, context) {
    if (this._shouldBypassDedup(alertType)) {
      return { action: 'send' };
    }

    const key = `${church.churchId}::${alertType}`;
    const existing = this.dedupState.get(key);

    if (existing) {
      // Already within window — increment counter
      existing.count += 1;
      existing.lastContext = context;
      return { action: 'deduplicated' };
    }

    // First occurrence — set up dedup entry with a flush timer
    const windowMs = this._getDedupWindowMs(church.churchId, alertType);
    const entry = {
      count: 1,
      firstSeen: Date.now(),
      lastContext: context,
      church,
      timer: null,
    };

    entry.timer = setTimeout(() => {
      this._flushDedupEntry(key);
    }, windowMs);

    this.dedupState.set(key, entry);
    return { action: 'send' };
  }

  /**
   * Called when a dedup window expires. If count > 1, send a batched summary.
   */
  async _flushDedupEntry(key) {
    const entry = this.dedupState.get(key);
    if (!entry) return;
    this.dedupState.delete(key);

    if (entry.count <= 1) return; // Only one occurrence — already sent immediately

    const [churchId, alertType] = key.split('::');
    const windowMs = this._getDedupWindowMs(churchId, alertType);
    const windowMin = Math.round(windowMs / 60000);
    const severity = ALERT_CLASSIFICATIONS[alertType] || 'WARNING';
    const icon = severity === 'CRITICAL' || severity === 'EMERGENCY' ? '🔴' : severity === 'WARNING' ? '⚠️' : 'ℹ️';
    const summary = `${icon} ${alertType.replace(/_/g, ' ')} (${entry.count} occurrences in last ${windowMin} min)`;

    const botToken = entry.church.alert_bot_token || this.defaultBotToken;
    if (!botToken) return;

    const tdChatId = entry.church.td_telegram_chat_id;
    if (tdChatId) {
      await this.sendTelegramMessage(tdChatId, botToken, summary);
    }
  }

  async sendAlert(church, alertType, context = {}, sessionId = null, recoveryResult = null) {
    const severity = this.classifyAlert(alertType, context);
    const alertId = uuidv4();
    const now = new Date().toISOString();
    const diagnosis = this.getDiagnosis(alertType);

    // Include diagnosis + recovery result in stored context for portal display
    const enrichedContext = {
      ...context,
      diagnosis,
      ...(recoveryResult ? { recovery: recoveryResult } : {}),
    };

    // Log to DB (with optional session_id for timeline linking)
    this.db.prepare(
      'INSERT INTO alerts (id, church_id, alert_type, severity, context, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(alertId, church.churchId, alertType, severity, JSON.stringify(enrichedContext), now, sessionId);

    const ts = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    console.log(`[${now}] ALERT [${severity}] ${church.name}: ${alertType}`);

    if (severity === 'INFO') return { alertId, severity, action: 'logged' };

    // Only alert during service windows (unless EMERGENCY)
    if (severity !== 'EMERGENCY' && this.scheduleEngine && !this.scheduleEngine.isServiceWindow(church.churchId)) {
      console.log(`  ↳ Outside service window — logged only`);
      return { alertId, severity, action: 'logged_outside_window' };
    }

    // ─── Deduplication check ────────────────────────────────────────────────
    const dedupResult = this._checkDedup(church, alertType, context);
    if (dedupResult.action === 'deduplicated') {
      console.log(`  ↳ Deduplicated — suppressed (count incremented)`);
      return { alertId, severity, action: 'deduplicated' };
    }

    const botToken = church.alert_bot_token || this.defaultBotToken;
    if (!botToken) {
      console.warn('  ↳ No bot token configured — cannot send Telegram alert');
      return { alertId, severity, action: 'no_bot_token' };
    }

    // Build message (white-labeled with brand name if reseller church)
    const icon = severity === 'EMERGENCY' ? '🚨' : severity === 'CRITICAL' ? '🔴' : '⚠️';
    const brandName = this._getBrandName(church);
    const alertTitle = brandName !== 'Tally'
      ? `${icon} *${brandName} — ${alertType.replace(/_/g, ' ')} at ${church.name}*`
      : `${icon} *${severity}: ${alertType.replace(/_/g, ' ').toUpperCase()}*`;
    const msgLines = [alertTitle];
    if (brandName === 'Tally') msgLines.push(`Church: ${church.name}`);
    msgLines.push(`Time: ${ts}`, '', `💡 Likely cause: ${diagnosis.likely_cause}`);
    diagnosis.steps.forEach((s, i) => msgLines.push(`${i + 1}. ${s}`));
    // Include recovery status if available
    if (recoveryResult && recoveryResult.attempted) {
      if (recoveryResult.success) {
        msgLines.push('', `✅ *Tally auto-recovered:* ${recoveryResult.command || 'recovery action'} succeeded.`);
      } else {
        msgLines.push('', `❌ *Auto-recovery failed:* ${recoveryResult.command || 'recovery action'} did not resolve the issue. Manual intervention needed.`);
      }
    } else {
      msgLines.push('', diagnosis.canAutoFix ? '🤖 Auto-recovery will be attempted.' : '👋 Manual intervention needed.');
    }
    msgLines.push('', `Reply /ack_${alertId.slice(0, 8)} to acknowledge.`);
    const msg = msgLines.join('\n');

    // Determine on-call TD chat ID
    // Priority: on-call rotation > church td_telegram_chat_id
    let tdChatId = church.td_telegram_chat_id;
    if (this.onCallRotation) {
      try {
        const onCallTd = this.onCallRotation.getOnCallTD(church.churchId);
        if (onCallTd?.telegramChatId) {
          tdChatId = onCallTd.telegramChatId;
          console.log(`  ↳ Paging on-call TD: ${onCallTd.name}`);
        }
      } catch (e) {
        console.warn('  ↳ On-call lookup failed, falling back to default TD:', e.message);
      }
    }

    // Send to TD
    if (tdChatId) {
      await this.sendTelegramMessage(tdChatId, botToken, msg);
    }

    // EMERGENCY → also notify Andrew immediately
    if (severity === 'EMERGENCY' && this.andrewChatId) {
      await this.sendTelegramMessage(this.andrewChatId, botToken, `[ESCALATED] ${msg}`);
    }

    // Send Slack alert if configured
    await this.sendSlackAlert(church, alertType, severity, context, diagnosis);

    // CRITICAL → start escalation timer
    if (severity === 'CRITICAL') {
      const timer = setTimeout(async () => {
        const alert = this.activeAlerts.get(alertId);
        if (alert && !alert.acknowledged) {
          console.log(`  ↳ No ack after 5min — escalating to Andrew`);
          this.db.prepare('UPDATE alerts SET escalated = 1 WHERE id = ?').run(alertId);
          if (this.andrewChatId) {
            await this.sendTelegramMessage(this.andrewChatId, botToken,
              `🚨 ESCALATED (no TD response in 5 min)\n\n${msg}`);
          }
          // Also send escalation email as backup
          if (this.lifecycleEmails) {
            this.lifecycleEmails.sendUrgentAlertEscalation(church, { alertType, context, alertId }).catch(() => {});
          }
        }
      }, 300_000);

      this.activeAlerts.set(alertId, { church, alertType, context, severity, sentAt: now, escalationTimer: timer, acknowledged: false });
    }

    return { alertId, severity, action: 'notified' };
  }

  // ─── SLACK INTEGRATION ───────────────────────────────────────────────────

  async sendSlackAlert(church, alertType, severity, context, diagnosis) {
    if (!church.slack_webhook_url) return;

    const color = (severity === 'CRITICAL' || severity === 'EMERGENCY') ? '#dc2626'
                : severity === 'WARNING' ? '#f59e0b'
                : '#22c55e';
    const icon = severity === 'EMERGENCY' ? '🚨' : severity === 'CRITICAL' ? '🔴' : '⚠️';

    const payload = {
      username: 'Tally',
      icon_emoji: ':satellite:',
      channel: church.slack_channel || undefined,
      attachments: [{
        color,
        title: `${icon} ${alertType.replace(/_/g, ' ').toUpperCase()} — ${church.name}`,
        text: `*Likely cause:* ${diagnosis.likely_cause}\n${(diagnosis.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
        footer: `Tally | ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
        fields: Object.entries(context || {}).slice(0, 4).map(([k, v]) => ({
          title: k,
          value: String(v),
          short: true,
        })),
      }],
    };

    try {
      await fetch(church.slack_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error('Slack alert failed:', e.message);
    }
  }

  async sendSlackAcknowledgment(church, alertType, responder) {
    if (!church.slack_webhook_url) return;
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const payload = {
      username: 'Tally',
      icon_emoji: ':satellite:',
      channel: church.slack_channel || undefined,
      attachments: [{
        color: '#3b82f6',
        title: `🔵 ACKNOWLEDGED: ${alertType.replace(/_/g, ' ')} — ${church.name}`,
        text: `Acknowledged by ${responder || 'TD'} at ${time}`,
        footer: `Tally | ${time}`,
      }],
    };
    try {
      await fetch(church.slack_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error('Slack acknowledgment failed:', e.message);
    }
  }

  async sendSlackResolution(church, alertType) {
    if (!church.slack_webhook_url) return;
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const payload = {
      username: 'Tally',
      icon_emoji: ':satellite:',
      channel: church.slack_channel || undefined,
      attachments: [{
        color: '#22c55e',
        title: `✅ RESOLVED: ${alertType.replace(/_/g, ' ')} — ${church.name}`,
        text: `Auto-recovered successfully at ${time}`,
        footer: `Tally | ${time}`,
      }],
    };
    try {
      await fetch(church.slack_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error('Slack resolution failed:', e.message);
    }
  }

  async sendTelegramMessage(chatId, botToken, message) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`Telegram API error: ${resp.status} ${body}`);
      }
    } catch (e) {
      console.error(`Telegram send failed: ${e.message}`);
    }
  }

  async acknowledgeAlert(alertId, responder) {
    const alert = this.activeAlerts.get(alertId);
    if (alert) {
      alert.acknowledged = true;
      if (alert.escalationTimer) clearTimeout(alert.escalationTimer);
      this.activeAlerts.delete(alertId);

      // Send Slack acknowledgment on ack (not resolution — ack ≠ resolved)
      try {
        const dbChurch = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(alert.church.churchId);
        if (dbChurch?.slack_webhook_url) {
          await this.sendSlackAcknowledgment({ ...alert.church, ...dbChurch }, alert.alertType, responder);
        }
      } catch (e) {
        console.warn('Slack ack notification failed:', e.message);
      }
    }
    this.db.prepare('UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?')
      .run(new Date().toISOString(), responder, alertId);
    console.log(`Alert ${alertId} acknowledged by ${responder}`);
    return { acknowledged: true };
  }

  // Find alert by short ID prefix (for /ack_XXXXXXXX commands)
  findAlertByPrefix(prefix) {
    // Sanitize: only allow hex characters in alert ID prefix
    const sanitized = String(prefix).replace(/[^a-f0-9-]/gi, '');
    if (!sanitized) return null;
    const row = this.db.prepare("SELECT id FROM alerts WHERE id LIKE ? AND acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(sanitized + '%');
    return row ? row.id : null;
  }
}

module.exports = { AlertEngine, ALERT_CLASSIFICATIONS, DIAGNOSIS_TEMPLATES, CRITICAL_BYPASS_TYPES, DEFAULT_DEDUP_WINDOW_MS };
