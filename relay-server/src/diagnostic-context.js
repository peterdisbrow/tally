'use strict';

/**
 * diagnostic-context.js
 *
 * Builds rich context for the Sonnet diagnostic pipeline.
 * Gathers alerts, session history, failover state, device status,
 * and church memory into a formatted text block for system prompt injection.
 *
 * This context is what gives Sonnet the "full picture" for meaningful
 * troubleshooting — Haiku's command path never sees this data.
 */

// ─── Context builder ─────────────────────────────────────────────────────────

/**
 * Build a diagnostic context block for Sonnet.
 *
 * @param {string} churchId
 * @param {object} db - SQLite database instance (better-sqlite3)
 * @param {Map} churches - runtime church map (churchId → { status, name, ... })
 * @param {object} [signalFailover] - SignalFailover instance (optional)
 * @returns {string} Formatted context text for system prompt injection (~500-1500 tokens)
 */
function buildDiagnosticContext(churchId, db, churches, signalFailover) {
  const sections = [];
  const church = churches.get(churchId);

  // ── 1. Current device status snapshot ───────────────────────────────────
  if (church?.status) {
    const s = church.status;
    const lines = ['CURRENT DEVICE STATUS:'];

    if (s.atem?.connected != null) {
      let atemLine = `  ATEM: ${s.atem.connected ? 'connected' : 'DISCONNECTED'}`;
      if (s.atem.connected) {
        if (s.atem.model) atemLine += ` (${s.atem.model})`;
        atemLine += `, pgm=input ${s.atem.programInput || '?'}`;
        if (s.atem.streaming) atemLine += `, streaming ${s.atem.streamingBitrate ? s.atem.streamingBitrate + 'kbps' : ''}`;
        if (s.atem.recording) atemLine += ', recording';
      }
      lines.push(atemLine);
    }

    if (s.encoder?.connected != null) {
      let encLine = `  Encoder: ${s.encoder.connected ? 'connected' : 'DISCONNECTED'}`;
      if (s.encoder.connected) {
        if (s.encoder.type) encLine += ` (${s.encoder.type})`;
        encLine += `, ${s.encoder.live || s.encoder.streaming ? 'LIVE' : 'idle'}`;
        if (s.encoder.bitrateKbps) encLine += `, ${s.encoder.bitrateKbps}kbps`;
        if (s.encoder.fps) encLine += `, ${s.encoder.fps}fps`;
      }
      lines.push(encLine);
    }

    if (s.obs?.connected != null) {
      let obsLine = `  OBS: ${s.obs.connected ? 'connected' : 'DISCONNECTED'}`;
      if (s.obs.connected) {
        obsLine += `, ${s.obs.streaming ? 'streaming' : 'idle'}`;
        if (s.obs.bitrate) obsLine += `, ${s.obs.bitrate}kbps`;
        if (s.obs.recording) obsLine += ', recording';
      }
      lines.push(obsLine);
    }

    if (s.vmix?.connected != null) {
      lines.push(`  vMix: ${s.vmix.connected ? 'connected' : 'DISCONNECTED'}${s.vmix.streaming ? ', streaming' : ''}`);
    }

    if (s.mixer?.connected != null) {
      let mixLine = `  Audio Mixer: ${s.mixer.connected ? 'connected' : 'DISCONNECTED'}`;
      if (s.mixer.type) mixLine += ` (${s.mixer.type})`;
      if (s.mixer.mainMuted) mixLine += ' — MAIN MUTED';
      lines.push(mixLine);
    }

    if (s.hyperdeck?.connected != null) {
      lines.push(`  HyperDeck: ${s.hyperdeck.connected ? 'connected' : 'DISCONNECTED'}${s.hyperdeck.recording ? ', recording' : ''}`);
    }

    const ptzConnected = (s.ptz || []).filter(c => c?.connected);
    if (ptzConnected.length > 0) {
      lines.push(`  PTZ: ${ptzConnected.length} camera${ptzConnected.length > 1 ? 's' : ''} connected`);
    }

    if (s.proPresenter?.connected != null) {
      let ppLine = `  ProPresenter: ${s.proPresenter.connected ? 'connected' : 'DISCONNECTED'}`;
      if (s.proPresenter.connected && s.proPresenter.presentationName) {
        ppLine += ` — "${s.proPresenter.presentationName}" slide ${s.proPresenter.slideIndex || '?'}`;
      }
      lines.push(ppLine);
    }

    if (s.companion?.connected) {
      lines.push(`  Companion: connected (${s.companion.connectionCount || 0} modules)`);
    }

    if (s.audio?.silenceDetected) {
      lines.push('  ⚠ Audio silence detected');
    }

    sections.push(lines.join('\n'));
  }

  // ── 2. Recent alerts ────────────────────────────────────────────────────
  try {
    const alerts = db.prepare(
      `SELECT alert_type, severity, context, created_at, acknowledged_at, resolved
       FROM alerts WHERE church_id = ? ORDER BY created_at DESC LIMIT 15`
    ).all(churchId);

    if (alerts.length > 0) {
      const lines = ['RECENT ALERTS (last 15):'];
      for (const a of alerts) {
        const age = _relativeTime(a.created_at);
        const status = a.resolved ? 'resolved' : a.acknowledged_at ? 'acked' : 'ACTIVE';
        let detail = `  ${age} — ${a.alert_type} (${a.severity}) [${status}]`;

        // Extract likely_cause from context JSON if available
        try {
          const ctx = JSON.parse(a.context || '{}');
          if (ctx.diagnosis?.likely_cause) {
            detail += ` — ${ctx.diagnosis.likely_cause}`;
          }
        } catch { /* ignore parse errors */ }

        lines.push(detail);
      }
      sections.push(lines.join('\n'));
    }
  } catch { /* alerts table may not exist */ }

  // ── 3. Current/recent service session ───────────────────────────────────
  try {
    const session = db.prepare(
      `SELECT * FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT 1`
    ).get(churchId);

    if (session) {
      const started = new Date(session.started_at);
      const dur = session.duration_minutes || Math.round((Date.now() - started.getTime()) / 60000);
      const lines = [`CURRENT/LAST SESSION (${session.ended_at ? 'ended' : 'active'}):`];
      lines.push(`  Started: ${started.toLocaleString()}, Duration: ${dur}min`);
      if (session.grade) lines.push(`  Grade: ${session.grade}`);
      if (session.stream_runtime_minutes > 0) lines.push(`  Stream time: ${session.stream_runtime_minutes}min`);
      if (session.alert_count > 0) lines.push(`  Alerts: ${session.alert_count} (${session.auto_recovered_count || 0} auto-fixed, ${session.escalated_count || 0} escalated)`);
      if (session.audio_silence_count > 0) lines.push(`  Audio silences: ${session.audio_silence_count}`);
      if (session.peak_viewers != null) lines.push(`  Peak viewers: ${session.peak_viewers}`);

      // Session events (timeline)
      try {
        const events = db.prepare(
          'SELECT event_type, details, timestamp, auto_resolved, resolved FROM service_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT 20'
        ).all(session.id);

        if (events.length > 0) {
          lines.push('  Timeline:');
          for (const e of events) {
            const time = new Date(e.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            const type = (e.event_type || '').replace(/_/g, ' ');
            const status = e.auto_resolved ? 'auto-fixed' : e.resolved ? 'resolved' : 'unresolved';
            const detail = e.details ? ` — ${e.details.slice(0, 80)}` : '';
            lines.push(`    ${time}: ${type} (${status})${detail}`);
          }
        }
      } catch { /* service_events may not exist */ }

      sections.push(lines.join('\n'));
    }
  } catch { /* service_sessions may not exist */ }

  // ── 4. Signal failover state ────────────────────────────────────────────
  if (signalFailover) {
    try {
      const state = signalFailover.getState(churchId);
      if (state && state.state !== 'HEALTHY') {
        const lines = [`SIGNAL FAILOVER STATE: ${state.state}`];
        if (state.bitrateBaseline) lines.push(`  Bitrate baseline: ${state.bitrateBaseline}kbps`);
        if (state.outageStartedAt) {
          const elapsed = Math.round((Date.now() - state.outageStartedAt) / 1000);
          lines.push(`  Outage duration: ${elapsed}s`);
        }
        sections.push(lines.join('\n'));
      }

      // Always include recent state transitions if any
      if (state?.stateLog?.length > 0) {
        const logLines = ['FAILOVER STATE LOG (recent transitions):'];
        const recentLog = state.stateLog.slice(-10); // last 10
        for (const entry of recentLog) {
          const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
          logLines.push(`  ${time}: ${entry.from} → ${entry.to} (${entry.trigger})`);
        }
        sections.push(logLines.join('\n'));
      }
    } catch { /* signalFailover might not have state for this church */ }
  }

  // ── 5. Church memory (learned observations) ─────────────────────────────
  try {
    const memories = db.prepare(
      `SELECT category, summary, confidence, observation_count, last_seen
       FROM church_memory WHERE church_id = ? AND active = 1
       ORDER BY confidence DESC LIMIT 10`
    ).all(churchId);

    if (memories.length > 0) {
      const lines = ['LEARNED OBSERVATIONS:'];
      for (const m of memories) {
        const cat = (m.category || '').replace(/_/g, ' ');
        lines.push(`  [${cat}] ${m.summary} (confidence: ${m.confidence}%, seen ${m.observation_count || 1}x)`);
      }
      sections.push(lines.join('\n'));
    }
  } catch { /* church_memory may not exist */ }

  // ── 6. Engineer profile ─────────────────────────────────────────────────
  try {
    const churchRow = db.prepare('SELECT engineer_profile FROM churches WHERE churchId = ?').get(churchId);
    if (churchRow?.engineer_profile) {
      const profile = JSON.parse(churchRow.engineer_profile);
      if (Object.keys(profile).length > 0) {
        const lines = ['ENGINEER PROFILE:'];
        if (profile.operatorLevel) lines.push(`  Operator level: ${profile.operatorLevel}`);
        if (profile.deviceSetup) {
          const setup = profile.deviceSetup;
          const devices = Object.entries(setup).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
          if (devices.length) lines.push(`  Equipment: ${devices.join(', ')}`);
        }
        if (profile.knownIssues?.length) {
          lines.push('  Known issues:');
          for (const issue of profile.knownIssues.slice(0, 3)) {
            lines.push(`    - ${issue.issue} (${issue.frequency || 'unknown freq'})${issue.workaround ? ' → ' + issue.workaround : ''}`);
          }
        }
        if (profile.servicePattern) lines.push(`  Service pattern: ${profile.servicePattern}`);
        sections.push(lines.join('\n'));
      }
    }
  } catch { /* ignore parse errors */ }

  // ── Assemble ────────────────────────────────────────────────────────────
  if (sections.length === 0) {
    return 'No diagnostic data available for this church.';
  }

  return sections.join('\n\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _relativeTime(isoString) {
  if (!isoString) return 'unknown';
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

module.exports = { buildDiagnosticContext };
