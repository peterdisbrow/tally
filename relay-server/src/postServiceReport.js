/**
 * Post-Service Report Generator
 *
 * After each service session ends, generates a detailed summary report:
 *   - Duration and uptime percentage
 *   - Failover events with timestamps
 *   - Device health summary (alerts by device type)
 *   - AI-powered recommendations (uses Claude if ANTHROPIC_API_KEY is set,
 *     falls back to rules-based recommendations)
 *
 * Reports are stored in `post_service_reports` table and made available
 * via GET /api/church/service-reports in the portal.
 */

const { v4: uuidv4 } = require('uuid');

class PostServiceReport {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} [opts]
   * @param {string} [opts.anthropicApiKey]
   * @param {object} [opts.lifecycleEmails]  LifecycleEmails instance for delivery
   */
  constructor(db, { anthropicApiKey, lifecycleEmails } = {}) {
    this.db = db;
    this.anthropicApiKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY || null;
    this.lifecycleEmails = lifecycleEmails || null;
    this._ensureSchema();
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_service_reports (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        duration_minutes INTEGER,
        uptime_pct REAL,
        grade TEXT,
        alert_count INTEGER DEFAULT 0,
        auto_recovered_count INTEGER DEFAULT 0,
        escalated_count INTEGER DEFAULT 0,
        failover_count INTEGER DEFAULT 0,
        peak_viewers INTEGER,
        stream_runtime_minutes INTEGER DEFAULT 0,
        device_health TEXT DEFAULT '{}',
        failover_events TEXT DEFAULT '[]',
        recommendations TEXT DEFAULT '[]',
        ai_summary TEXT,
        report_html TEXT
      )
    `);
  }

  // ─── MAIN ENTRY POINT ──────────────────────────────────────────────────────

  /**
   * Generate and store a post-service report for a completed session.
   * Returns the report object.
   *
   * @param {object} church   - DB church row
   * @param {object} session  - Finalized session from SessionRecap.endSession()
   * @returns {Promise<object>}
   */
  async generate(church, session) {
    const churchId = church.churchId;
    const sessionId = session.sessionId || null;

    // Gather session alerts from DB
    const alerts = this._getSessionAlerts(churchId, sessionId);
    const failoverEvents = this._getFailoverEvents(churchId, sessionId);

    // Compute uptime percentage
    const duration = session.durationMinutes || 0;
    const streamRuntime = session.streamTotalMinutes || 0;
    const uptimePct = duration > 0 ? Math.min(100, Math.round((streamRuntime / duration) * 100)) : null;

    // Device health: group alerts by device/type
    const deviceHealth = this._buildDeviceHealth(alerts);

    // Rules-based recommendations
    const recommendations = this._buildRecommendations(session, alerts, failoverEvents);

    // Optional AI summary
    let aiSummary = null;
    if (this.anthropicApiKey) {
      aiSummary = await this._generateAiSummary(church, session, alerts, failoverEvents, recommendations);
    }

    const reportHtml = this._buildReportHtml(church, session, {
      uptimePct, deviceHealth, failoverEvents, recommendations, aiSummary, alerts,
    });

    const report = {
      id: uuidv4(),
      church_id: churchId,
      session_id: sessionId,
      created_at: new Date().toISOString(),
      duration_minutes: duration,
      uptime_pct: uptimePct,
      grade: session.grade || null,
      alert_count: alerts.length,
      auto_recovered_count: session.autoRecovered || 0,
      escalated_count: session.escalated || 0,
      failover_count: failoverEvents.length,
      peak_viewers: session.peakViewers || null,
      stream_runtime_minutes: streamRuntime,
      device_health: JSON.stringify(deviceHealth),
      failover_events: JSON.stringify(failoverEvents),
      recommendations: JSON.stringify(recommendations),
      ai_summary: aiSummary,
      report_html: reportHtml,
    };

    this.db.prepare(`
      INSERT INTO post_service_reports
        (id, church_id, session_id, created_at, duration_minutes, uptime_pct, grade,
         alert_count, auto_recovered_count, escalated_count, failover_count,
         peak_viewers, stream_runtime_minutes, device_health, failover_events,
         recommendations, ai_summary, report_html)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.id, report.church_id, report.session_id, report.created_at,
      report.duration_minutes, report.uptime_pct, report.grade,
      report.alert_count, report.auto_recovered_count, report.escalated_count,
      report.failover_count, report.peak_viewers, report.stream_runtime_minutes,
      report.device_health, report.failover_events, report.recommendations,
      report.ai_summary, report.report_html
    );

    console.log(`[PostServiceReport] Generated report ${report.id} for ${churchId} (grade: ${report.grade})`);

    // Email to leadership if configured
    if (this.lifecycleEmails && church.leadership_emails) {
      const emails = church.leadership_emails.split(',').map(e => e.trim()).filter(e => e && e.includes('@'));
      for (const email of emails) {
        this._sendReportEmail(church, report, email).catch(err =>
          console.error(`[PostServiceReport] Email error for ${email}:`, err.message)
        );
      }
    }

    return report;
  }

  // ─── DATA GATHERING ─────────────────────────────────────────────────────────

  _getSessionAlerts(churchId, sessionId) {
    try {
      if (sessionId) {
        const rows = this.db.prepare(
          'SELECT * FROM alerts WHERE church_id = ? AND session_id = ? ORDER BY created_at ASC'
        ).all(churchId, sessionId);
        if (rows.length > 0) return rows;
      }
      // Fallback: last 4 hours of alerts
      const since = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      return this.db.prepare(
        'SELECT * FROM alerts WHERE church_id = ? AND created_at >= ? ORDER BY created_at ASC'
      ).all(churchId, since);
    } catch { return []; }
  }

  _getFailoverEvents(churchId, sessionId) {
    try {
      // Look for failover-type alerts
      const alerts = this._getSessionAlerts(churchId, sessionId);
      return alerts
        .filter(a => a.alert_type && (
          a.alert_type.includes('failover') ||
          a.alert_type.includes('signal_loss') ||
          a.alert_type.includes('black_screen') ||
          a.alert_type === 'stream_offline'
        ))
        .map(a => ({
          type: a.alert_type,
          severity: a.severity,
          timestamp: a.created_at,
          autoRecovered: !!a.resolved,
          context: (() => { try { return JSON.parse(a.context || '{}'); } catch { return {}; } })(),
        }));
    } catch { return []; }
  }

  // ─── ANALYSIS ───────────────────────────────────────────────────────────────

  _buildDeviceHealth(alerts) {
    const deviceAlerts = {};
    const DEVICE_PATTERNS = {
      atem: /atem|switcher/i,
      obs: /obs|recording/i,
      audio: /audio|silence|mixer/i,
      stream: /stream|bitrate|encoder/i,
      hyperdeck: /hyperdeck|deck/i,
      companion: /companion/i,
      camera: /camera|ptz/i,
      network: /network|connect|relay/i,
    };

    for (const alert of alerts) {
      const alertType = (alert.alert_type || '').toLowerCase();
      for (const [device, pattern] of Object.entries(DEVICE_PATTERNS)) {
        if (pattern.test(alertType)) {
          if (!deviceAlerts[device]) deviceAlerts[device] = { alerts: 0, critical: 0, autoFixed: 0 };
          deviceAlerts[device].alerts++;
          if (alert.severity === 'CRITICAL' || alert.severity === 'EMERGENCY') deviceAlerts[device].critical++;
          if (alert.resolved) deviceAlerts[device].autoFixed++;
          break;
        }
      }
    }

    return deviceAlerts;
  }

  _buildRecommendations(session, alerts, failoverEvents) {
    const recs = [];

    const alertCount = alerts.length;
    const criticals = alerts.filter(a => a.severity === 'CRITICAL' || a.severity === 'EMERGENCY');
    const audioAlerts = alerts.filter(a => a.alert_type && /audio|silence/i.test(a.alert_type));
    const streamAlerts = alerts.filter(a => a.alert_type && /stream|bitrate/i.test(a.alert_type));
    const networkAlerts = alerts.filter(a => a.alert_type && /network|connect/i.test(a.alert_type));

    if (alertCount === 0) {
      recs.push({ priority: 'info', text: 'Clean service — no alerts fired. Great job!' });
    }

    if (criticals.length > 2) {
      recs.push({
        priority: 'high',
        text: `${criticals.length} critical alerts during service. Consider scheduling a system health check before next service.`,
      });
    }

    if (audioAlerts.length >= 2) {
      recs.push({
        priority: 'medium',
        text: 'Repeated audio silence alerts. Check your mixer USB/Dante routing and confirm OBS audio sources are stable before next service.',
      });
    }

    if (streamAlerts.length >= 2) {
      recs.push({
        priority: 'medium',
        text: 'Multiple stream quality issues detected. Consider upgrading your upload bandwidth or switching to a wired connection for the encoder.',
      });
    }

    if (networkAlerts.length >= 1) {
      recs.push({
        priority: 'medium',
        text: 'Network connectivity issues occurred. Check your network switch and consider adding a UPS to protect networking gear.',
      });
    }

    if (failoverEvents.length >= 1) {
      recs.push({
        priority: 'high',
        text: `${failoverEvents.length} failover event(s) triggered. Review your failover thresholds in Settings and verify ATEM signal sources are stable.`,
      });
    }

    if (session.escalated > 0) {
      recs.push({
        priority: 'medium',
        text: `${session.escalated} alert(s) escalated to primary TD. Ensure your on-call TD has push notifications enabled.`,
      });
    }

    const uptime = session.streamTotalMinutes && session.durationMinutes
      ? Math.round((session.streamTotalMinutes / session.durationMinutes) * 100)
      : 100;
    if (uptime < 90 && session.streamTotalMinutes > 0) {
      recs.push({
        priority: 'high',
        text: `Stream uptime was ${uptime}% (${session.streamTotalMinutes} of ${session.durationMinutes} min). Investigate stream interruptions before next service.`,
      });
    }

    return recs;
  }

  // ─── AI SUMMARY ─────────────────────────────────────────────────────────────

  async _generateAiSummary(church, session, alerts, failoverEvents, recommendations) {
    if (!this.anthropicApiKey) return null;

    const prompt = `You are a church AV production expert. Summarize this service session in 2-3 sentences for a non-technical pastor or church leader.

Church: ${church.name}
Duration: ${session.durationMinutes} minutes
Stream runtime: ${session.streamTotalMinutes} minutes
Grade: ${session.grade}
Alerts: ${alerts.length} total (${alerts.filter(a => a.severity === 'CRITICAL' || a.severity === 'EMERGENCY').length} critical)
Auto-recovered: ${session.autoRecovered || 0}
Failover events: ${failoverEvents.length}
Peak viewers: ${session.peakViewers || 'unknown'}

Top recommendations:
${recommendations.slice(0, 3).map(r => `- ${r.text}`).join('\n') || 'None — clean service'}

Write a friendly, encouraging summary that: (1) states if the service went well or had issues, (2) notes the most important thing that happened, (3) gives one action item if needed. Keep it under 80 words. No technical jargon.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) return null;
      const data = await res.json();
      return data.content?.[0]?.text?.trim() || null;
    } catch (e) {
      console.warn('[PostServiceReport] AI summary failed:', e.message);
      return null;
    }
  }

  // ─── EMAIL DELIVERY ─────────────────────────────────────────────────────────

  async _sendReportEmail(church, report, toEmail) {
    if (!this.lifecycleEmails) return;

    const dateStr = new Date(report.created_at).toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    });
    const subject = `Service Report — ${church.name} · ${dateStr}`;
    const emailType = `service-report-${report.id}`;

    return this.lifecycleEmails.sendEmail({
      churchId: church.churchId,
      emailType,
      to: toEmail,
      subject,
      html: report.report_html,
      text: this._buildReportText(report),
    });
  }

  _buildReportText(report) {
    const recs = (() => { try { return JSON.parse(report.recommendations || '[]'); } catch { return []; } })();
    const failovers = (() => { try { return JSON.parse(report.failover_events || '[]'); } catch { return []; } })();

    return `POST-SERVICE REPORT — ${new Date(report.created_at).toLocaleDateString()}

Grade: ${report.grade || 'N/A'}
Duration: ${report.duration_minutes} min
Stream uptime: ${report.uptime_pct != null ? report.uptime_pct + '%' : 'N/A'}
Alerts: ${report.alert_count} (${report.auto_recovered_count} auto-recovered)
Failover events: ${report.failover_count}
${report.peak_viewers ? 'Peak viewers: ' + report.peak_viewers : ''}

${report.ai_summary ? 'SUMMARY\n' + report.ai_summary + '\n' : ''}

RECOMMENDATIONS
${recs.length ? recs.map(r => `[${r.priority.toUpperCase()}] ${r.text}`).join('\n') : 'No recommendations — clean service!'}

${failovers.length ? 'FAILOVER EVENTS\n' + failovers.map(f => `• ${f.type} at ${new Date(f.timestamp).toLocaleTimeString()} (${f.autoRecovered ? 'auto-recovered' : 'manual'})`).join('\n') : ''}

View full report in your church portal.`;
  }

  // ─── HTML REPORT ────────────────────────────────────────────────────────────

  _buildReportHtml(church, session, { uptimePct, deviceHealth, failoverEvents, recommendations, aiSummary, alerts }) {
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    const grade = session.grade || 'N/A';
    const gradeColor = grade.startsWith('A') ? '#22c55e' : grade.startsWith('B') ? '#eab308' : '#ef4444';

    const deviceRows = Object.entries(deviceHealth).map(([device, stats]) => {
      const health = stats.alerts === 0 ? '<span style="color:#22c55e">Clean</span>' : stats.critical > 0 ? `<span style="color:#ef4444">${stats.critical} critical</span>` : `<span style="color:#f59e0b">${stats.alerts} alerts</span>`;
      return `<tr><td style="padding:8px 12px;text-transform:capitalize">${device}</td><td style="padding:8px 12px">${health}</td><td style="padding:8px 12px;color:#94A3B8">${stats.autoFixed}/${stats.alerts} auto-fixed</td></tr>`;
    }).join('');

    const failoverRows = failoverEvents.map(f => {
      const t = new Date(f.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `<tr><td style="padding:8px 12px">${t}</td><td style="padding:8px 12px">${f.type || 'Failover'}</td><td style="padding:8px 12px">${f.autoRecovered ? '<span style="color:#22c55e">Auto-recovered</span>' : '<span style="color:#f59e0b">Manual</span>'}</td></tr>`;
    }).join('');

    const recItems = recommendations.map(r => {
      const color = r.priority === 'high' ? '#ef4444' : r.priority === 'medium' ? '#eab308' : '#22c55e';
      return `<li style="margin-bottom:8px;color:#333"><span style="font-weight:600;color:${color}">[${r.priority.toUpperCase()}]</span> ${r.text}</li>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Service Report — ${church.name}</title></head>
<body style="font-family:system-ui,sans-serif;background:#f8fafc;margin:0;padding:24px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">

  <div style="background:#09090B;padding:24px 28px;display:flex;align-items:center;justify-content:space-between">
    <div>
      <div style="color:#22c55e;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase">POST-SERVICE REPORT</div>
      <div style="color:#F8FAFC;font-size:20px;font-weight:700;margin-top:4px">${church.name}</div>
      <div style="color:#64748B;font-size:13px;margin-top:2px">${dateStr}</div>
    </div>
    <div style="background:${gradeColor}22;border:2px solid ${gradeColor};border-radius:50%;width:56px;height:56px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:${gradeColor}">${grade}</div>
  </div>

  <div style="padding:20px 28px">

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px">
      <div style="background:#f1f5f9;border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#09090B">${session.durationMinutes || 0}<span style="font-size:12px;font-weight:400;color:#64748B">min</span></div>
        <div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px">Duration</div>
      </div>
      <div style="background:#f1f5f9;border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:${uptimePct != null && uptimePct >= 95 ? '#22c55e' : uptimePct != null && uptimePct >= 80 ? '#eab308' : '#ef4444'}">${uptimePct != null ? uptimePct + '%' : 'N/A'}</div>
        <div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px">Stream Uptime</div>
      </div>
      <div style="background:#f1f5f9;border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:${alerts.length === 0 ? '#22c55e' : '#ef4444'}">${alerts.length}</div>
        <div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px">Alerts</div>
      </div>
    </div>

    ${aiSummary ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:24px"><div style="font-size:12px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">AI Summary</div><p style="margin:0;color:#333;font-size:14px;line-height:1.6">${aiSummary}</p></div>` : ''}

    ${failoverEvents.length > 0 ? `<div style="margin-bottom:24px"><div style="font-size:13px;font-weight:700;color:#09090B;margin-bottom:10px">Failover Events</div><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f1f5f9"><th style="padding:8px 12px;text-align:left;font-weight:600;color:#475569">Time</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#475569">Event</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#475569">Resolution</th></tr></thead><tbody>${failoverRows}</tbody></table></div>` : ''}

    ${Object.keys(deviceHealth).length > 0 ? `<div style="margin-bottom:24px"><div style="font-size:13px;font-weight:700;color:#09090B;margin-bottom:10px">Device Health</div><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f1f5f9"><th style="padding:8px 12px;text-align:left;font-weight:600;color:#475569">Device</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#475569">Status</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#475569">Auto-Fixed</th></tr></thead><tbody>${deviceRows}</tbody></table></div>` : ''}

    ${recommendations.length > 0 ? `<div style="margin-bottom:24px"><div style="font-size:13px;font-weight:700;color:#09090B;margin-bottom:10px">Recommendations for Next Service</div><ul style="margin:0;padding-left:20px">${recItems}</ul></div>` : ''}

  </div>

  <div style="background:#f8fafc;padding:16px 28px;text-align:center;border-top:1px solid #e2e8f0">
    <div style="font-size:12px;color:#94A3B8">Tally · AI-powered broadcast engineering for church</div>
  </div>

</div>
</body></html>`;
  }
}

module.exports = PostServiceReport;
