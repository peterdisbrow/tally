/**
 * Alert Engine — Severity classification, escalation ladder, Telegram notifications
 */

const { v4: uuidv4 } = require('uuid');

const ALERT_CLASSIFICATIONS = {
  'stream_started': 'INFO',
  'recording_started': 'INFO',
  'service_ended': 'INFO',
  'fps_low': 'WARNING',
  'bitrate_low': 'WARNING',
  'cpu_high': 'WARNING',
  'stream_stopped': 'CRITICAL',
  'atem_disconnected': 'CRITICAL',
  'recording_failed': 'CRITICAL',
  'obs_disconnected': 'WARNING',
  'companion_disconnected': 'WARNING',
  'multiple_systems_down': 'EMERGENCY',
  'no_td_response': 'EMERGENCY',
};

const DIAGNOSIS_TEMPLATES = {
  'stream_stopped': {
    likely_cause: 'Internet fluctuation or encoder crash',
    steps: ['Check OBS — is it still running?', 'Click "Start Streaming" in Tally', 'If still down, restart your router'],
    canAutoFix: true,
  },
  'atem_disconnected': {
    likely_cause: 'ATEM lost network connection',
    steps: ['Check ethernet cable on ATEM', 'Ping ATEM IP from production computer', 'Power cycle ATEM if needed'],
    canAutoFix: false,
  },
  'recording_failed': {
    likely_cause: 'Storage full or recording drive disconnected',
    steps: ['Check available disk space', 'Verify recording drive is mounted', 'Try starting recording manually'],
    canAutoFix: false,
  },
  'fps_low': {
    likely_cause: 'CPU overloaded or encoding settings too high',
    steps: ['Check CPU usage in OBS', 'Tally will auto-reduce bitrate', 'If persistent, lower resolution in OBS settings'],
    canAutoFix: true,
  },
  'bitrate_low': {
    likely_cause: 'Network bandwidth insufficient for current settings',
    steps: ['Check internet speed', 'Close other bandwidth-heavy applications', 'Consider lowering stream quality'],
    canAutoFix: true,
  },
  'cpu_high': {
    likely_cause: 'Too many OBS sources or effects active',
    steps: ['Close unnecessary applications', 'Disable unused OBS sources', 'Reduce output resolution'],
    canAutoFix: false,
  },
  'obs_disconnected': {
    likely_cause: 'OBS crashed or WebSocket plugin issue',
    steps: ['Check if OBS is still running', 'Restart OBS if needed', 'Verify WebSocket server is enabled in OBS settings'],
    canAutoFix: false,
  },
  'companion_disconnected': {
    likely_cause: 'Companion app crashed or network issue',
    steps: ['Check if Companion is running on the booth computer', 'Restart Companion app if needed', 'Verify Companion HTTP API is enabled on port 8000'],
    canAutoFix: false,
  },
  'vmix_disconnected': {
    likely_cause: 'vMix lost connection or Web Controller disabled',
    steps: ['Check if vMix is running', 'Verify Web Controller is enabled in vMix Settings', 'Check network connectivity'],
    canAutoFix: false,
  },
  'audio_silence': {
    likely_cause: 'Audio signal lost — mixer may be muted or disconnected',
    steps: ['Check mixer master fader and mute status', 'Verify audio routing from mixer to encoder', 'Check physical audio cable connections'],
    canAutoFix: false,
  },
  'multiple_systems_down': {
    likely_cause: 'Possible network outage or power issue at venue',
    steps: ['Check network switch/router', 'Verify power to production rack', 'Contact someone on-site immediately'],
    canAutoFix: false,
  },
  'recording_not_started': {
    likely_cause: 'Recording was not started before service',
    steps: ['Start recording via Tally', 'Check ATEM recording settings'],
    canAutoFix: true,
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
    this._ensureColumns();
    this._ensureAlertsTable();
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
          console.log(`  ↳ No ack after 90s — escalating to Andrew`);
          this.db.prepare('UPDATE alerts SET escalated = 1 WHERE id = ?').run(alertId);
          if (this.andrewChatId) {
            await this.sendTelegramMessage(this.andrewChatId, botToken,
              `🚨 ESCALATED (no TD response in 90s)\n\n${msg}`);
          }
        }
      }, 90_000);

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
      username: 'Tally by ATEM School',
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

  async sendSlackResolution(church, alertType) {
    if (!church.slack_webhook_url) return;
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const payload = {
      username: 'Tally by ATEM School',
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

      // Send Slack resolution on ack
      try {
        const dbChurch = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(alert.church.churchId);
        if (dbChurch?.slack_webhook_url) {
          await this.sendSlackResolution({ ...alert.church, ...dbChurch }, alert.alertType);
        }
      } catch (e) {
        console.warn('Slack ack resolution failed:', e.message);
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

module.exports = { AlertEngine, ALERT_CLASSIFICATIONS };
