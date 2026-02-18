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
    steps: ['Check if Companion is running', 'Restart Companion if needed'],
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
    this._ensureColumns();
    this._ensureAlertsTable();
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

  async sendAlert(church, alertType, context = {}) {
    const severity = this.classifyAlert(alertType, context);
    const alertId = uuidv4();
    const now = new Date().toISOString();
    const diagnosis = this.getDiagnosis(alertType);

    // Log to DB
    this.db.prepare(
      'INSERT INTO alerts (id, church_id, alert_type, severity, context, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(alertId, church.churchId, alertType, severity, JSON.stringify(context), now);

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

    // Build message
    const icon = severity === 'EMERGENCY' ? '🚨' : severity === 'CRITICAL' ? '🔴' : '⚠️';
    const msg = [
      `${icon} **${severity}: ${alertType.replace(/_/g, ' ').toUpperCase()}**`,
      `Church: ${church.name}`,
      `Time: ${ts}`,
      '',
      `💡 Likely cause: ${diagnosis.likely_cause}`,
      ...diagnosis.steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      diagnosis.canAutoFix ? '🤖 Auto-recovery will be attempted.' : '👋 Manual intervention needed.',
      '',
      `Reply /ack_${alertId.slice(0, 8)} to acknowledge.`,
    ].join('\n');

    // Send to TD
    if (church.td_telegram_chat_id) {
      await this.sendTelegramMessage(church.td_telegram_chat_id, botToken, msg);
    }

    // EMERGENCY → also notify Andrew immediately
    if (severity === 'EMERGENCY' && this.andrewChatId) {
      await this.sendTelegramMessage(this.andrewChatId, botToken, `[ESCALATED] ${msg}`);
    }

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
    }
    this.db.prepare('UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?')
      .run(new Date().toISOString(), responder, alertId);
    console.log(`Alert ${alertId} acknowledged by ${responder}`);
    return { acknowledged: true };
  }

  // Find alert by short ID prefix (for /ack_XXXXXXXX commands)
  findAlertByPrefix(prefix) {
    const row = this.db.prepare("SELECT id FROM alerts WHERE id LIKE ? AND acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(prefix + '%');
    return row ? row.id : null;
  }
}

module.exports = { AlertEngine, ALERT_CLASSIFICATIONS };
