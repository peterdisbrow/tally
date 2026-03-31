/**
 * tally-context.js
 *
 * Unified tiered context builder for all AI calls.
 * Replaces the split between ai-parser.js inline context hints
 * and diagnostic-context.js.
 *
 * Tier 1 (OPERATIONAL) — injected into every AI call:
 *   Device connections, program/preview, streaming/recording,
 *   top 5 active alerts, failover state name, health score,
 *   engineer profile, configured devices.
 *
 * Tier 2 (DIAGNOSTIC) — questions, troubleshooting, health < 70, failover != HEALTHY:
 *   Everything in Tier 1 PLUS last 15 alerts with full details/timestamps/causes,
 *   session timeline (20 events), failover transitions (10), church memory full entries,
 *   incident chains, device telemetry, known issues.
 *
 * Auto-upgrade: if health score < 70 or failover state is not HEALTHY,
 * automatically use Tier 2 even for commands.
 */

'use strict';

// ─── Helpers ────────────────────────────────────────────────────────────────────

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

// ─── Tier 1: Operational Context ────────────────────────────────────────────────
// Compact status snapshot for every AI call (~200-500 tokens).

function _buildOperationalContext(status, opts) {
  const sections = [];

  // ── Device status snapshot ──
  if (status) {
    const lines = ['CURRENT DEVICE STATUS:'];

    // Multi-switcher
    if (status.switchers && Object.keys(status.switchers).length > 0) {
      for (const [swId, sw] of Object.entries(status.switchers)) {
        const typeLabel = (sw.type || 'switcher').toUpperCase();
        let swLine = `  ${typeLabel} "${sw.name || swId}" [${sw.role || 'primary'}]: ${sw.connected ? 'connected' : 'DISCONNECTED'}`;
        if (sw.connected) {
          if (sw.model) swLine += ` (${sw.model})`;
          swLine += `, pgm=input ${sw.programInput || '?'}, pvw=input ${sw.previewInput || '?'}`;
          if (sw.streaming) swLine += ', streaming';
          if (sw.recording) swLine += ', recording';
        }
        lines.push(swLine);
      }
    } else if (status.atem?.connected != null) {
      let atemLine = `  ATEM: ${status.atem.connected ? 'connected' : 'DISCONNECTED'}`;
      if (status.atem.connected) {
        if (status.atem.model) atemLine += ` (${status.atem.model})`;
        atemLine += `, pgm=input ${status.atem.programInput || '?'}, pvw=input ${status.atem.previewInput || '?'}`;
        if (status.atem.streaming) atemLine += `, streaming${status.atem.streamingBitrate ? ' ' + status.atem.streamingBitrate + 'kbps' : ''}`;
        if (status.atem.recording) atemLine += ', recording';
      }
      lines.push(atemLine);
    }

    // ATEM extended state (input labels, audio routing)
    if (status.atem?.connected) {
      if (status.atem.inputLabels && Object.keys(status.atem.inputLabels).length) {
        const labels = Object.entries(status.atem.inputLabels).map(([k, v]) => `${k}=${v}`).join(', ');
        lines.push(`  ATEM Labels: ${labels}`);
      }
      if (status.audio_via_atem || status.audioViaAtem) lines.push('  audio_via_atem=true');
    }

    if (status.encoder?.connected != null) {
      let encLine = `  Encoder: ${status.encoder.connected ? 'connected' : 'DISCONNECTED'}`;
      if (status.encoder.connected) {
        if (status.encoder.type) encLine += ` (${status.encoder.type})`;
        encLine += `, ${status.encoder.live || status.encoder.streaming ? 'LIVE' : 'idle'}`;
        if (status.encoder.bitrateKbps) encLine += `, ${status.encoder.bitrateKbps}kbps`;
        if (status.encoder.fps) encLine += `, ${status.encoder.fps}fps`;
      }
      lines.push(encLine);
    }

    if (status.obs?.connected != null) {
      let obsLine = `  OBS: ${status.obs.connected ? 'connected' : 'DISCONNECTED'}`;
      if (status.obs.connected) {
        obsLine += `, ${status.obs.streaming ? 'streaming' : 'idle'}`;
        if (status.obs.bitrate) obsLine += `, ${status.obs.bitrate}kbps`;
        if (status.obs.fps) obsLine += `, ${status.obs.fps}fps`;
        if (status.obs.currentScene) obsLine += `, scene="${status.obs.currentScene}"`;
        if (status.obs.recording) obsLine += ', recording';
      }
      lines.push(obsLine);
      if (status.obs?.connected && status.obs.scenes?.length) {
        lines.push(`  OBS scenes: ${status.obs.scenes.join(', ')}`);
      }
    }

    if (status.vmix?.connected != null) {
      let vmixLine = `  vMix: ${status.vmix.connected ? 'connected' : 'DISCONNECTED'}`;
      if (status.vmix.connected) {
        vmixLine += `, ${status.vmix.streaming ? 'streaming' : 'idle'}`;
        if (status.vmix.recording) vmixLine += ', recording';
        if (status.vmix.edition) vmixLine += ` (${status.vmix.edition})`;
        if (status.vmix.activeInput) vmixLine += `, active=${status.vmix.activeInput}`;
        if (status.vmix.masterVolume != null) vmixLine += `, vol=${status.vmix.masterVolume}`;
        if (status.vmix.masterMuted) vmixLine += ', MUTED';
      }
      lines.push(vmixLine);
    }

    if (status.mixer?.connected != null) {
      let mixLine = `  Audio Mixer: ${status.mixer.connected ? 'connected' : 'DISCONNECTED'}`;
      if (status.mixer.type) mixLine += ` (${status.mixer.type})`;
      if (status.mixer.model) mixLine += ` ${status.mixer.model}`;
      if (status.mixer.mainMuted) mixLine += ' — MAIN MUTED';
      lines.push(mixLine);
      if (status.mixer?.connected && status.mixer.channelNames && Object.keys(status.mixer.channelNames).length) {
        const chNames = Object.entries(status.mixer.channelNames).map(([k, v]) => `ch${k}=${v}`).join(', ');
        lines.push(`  Channels: ${chNames}`);
      }
    }

    if (status.hyperdeck?.connected != null) {
      lines.push(`  HyperDeck: ${status.hyperdeck.connected ? 'connected' : 'DISCONNECTED'}${status.hyperdeck.recording ? ', recording' : ''}`);
    }
    // Array format HyperDecks
    const hyperdeckArr = status.hyperdecks || [];
    if (hyperdeckArr.length > 0) {
      const hdParts = hyperdeckArr.map((hd, i) => {
        if (!hd) return null;
        let info = `deck${i + 1}=${hd.connected ? (hd.recording ? 'recording' : hd.playing ? 'playing' : 'idle') : 'disconnected'}`;
        if (hd.connected && hd.diskPercent != null) info += ` disk=${hd.diskPercent}%`;
        return info;
      }).filter(Boolean);
      if (hdParts.length) lines.push(`  HyperDecks: ${hdParts.join(', ')}`);
    }

    const ptzConnected = (status.ptz || []).filter(c => c?.connected);
    if (ptzConnected.length > 0) {
      lines.push(`  PTZ: ${ptzConnected.length} camera${ptzConnected.length > 1 ? 's' : ''} connected`);
    }

    if (status.proPresenter?.connected != null) {
      let ppLine = `  ProPresenter: ${status.proPresenter.connected ? 'connected' : 'DISCONNECTED'}`;
      if (status.proPresenter.connected) {
        ppLine += `, slide ${status.proPresenter.slideIndex != null ? status.proPresenter.slideIndex + 1 : '?'}/${status.proPresenter.slideTotal || '?'}`;
        if (status.proPresenter.presentationName) ppLine += ` ("${status.proPresenter.presentationName}")`;
        if (status.proPresenter.activeLook) ppLine += `, look="${status.proPresenter.activeLook}"`;
      }
      lines.push(ppLine);
    }

    if (status.companion?.connected) {
      const cc = status.companion.connectionCount || 0;
      const connLabels = (status.companion.connections || []).map(c => c.label).filter(Boolean).join(', ');
      lines.push(`  Companion: ${cc} module${cc > 1 ? 's' : ''}${connLabels ? ' (' + connLabels + ')' : ''}`);
      // Live variable values
      const vars = status.companion?.variables;
      if (vars && Object.keys(vars).length > 0) {
        const varParts = [];
        for (const [conn, varObj] of Object.entries(vars)) {
          const entries = Object.entries(varObj).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(', ');
          if (entries) varParts.push(`${conn}: ${entries}`);
        }
        if (varParts.length) lines.push(`  Companion vars: ${varParts.join('; ')}`);
      }
    }

    // VideoHubs
    const vhArr = status.videoHubs || [];
    if (vhArr.length > 0) {
      const vhConnected = vhArr.filter(h => h?.connected).length;
      lines.push(`  VideoHub: ${vhConnected}/${vhArr.length} connected`);
    } else if (status.videohub?.connected) {
      lines.push('  VideoHub: connected');
    }

    if (status.resolume?.connected != null) {
      let resLine = `  Resolume: ${status.resolume.connected ? 'connected' : 'DISCONNECTED'}`;
      if (status.resolume.version) resLine += ` (${status.resolume.version})`;
      lines.push(resLine);
    }

    if (status.ecamm?.connected) {
      lines.push(`  Ecamm: ${status.ecamm.live ? 'live' : 'idle'}${status.ecamm.recording ? ', recording' : ''}`);
    }
    if (status.dante?.connected) lines.push('  Dante: connected');
    if (status.ndi?.connected) lines.push('  NDI: connected');

    // Web Presenter extended info
    const wpStatus = status.webPresenter || (status.encoder?.type?.toLowerCase() === 'blackmagic' ? status.encoder : null);
    if (wpStatus?.connected) {
      let wpInfo = '  WebPresenter: use blackmagic.* commands for platform/bitrate/format config';
      if (wpStatus.platform) wpInfo += `, platform=${wpStatus.platform}`;
      if (wpStatus.quality) wpInfo += `, quality=${wpStatus.quality}`;
      lines.push(wpInfo);
    }

    // Backup encoder
    if (status.backupEncoder?.configured) {
      const be = status.backupEncoder;
      lines.push(`  Backup encoder: ${be.type || 'unknown'}, ${be.connected ? 'connected' : 'DISCONNECTED'}${be.live ? ', live' : ''}`);
    }

    // Smart plugs
    const plugs = status.smartPlugs || [];
    if (plugs.length > 0) {
      const plugParts = plugs.map(p => `${p.name || p.ip}=${p.on ? 'ON' : 'OFF'}${p.power ? ` ${p.power}W` : ''}`);
      lines.push(`  Smart plugs: ${plugParts.join(', ')}`);
    }

    // Audio silence
    if (status.audio?.silenceDetected) {
      lines.push('  \u26a0 Audio silence detected');
    }

    // Device health telemetry
    if (status.health) {
      const h = status.health;
      const healthParts = [];
      if (h.relay?.latencyMs != null) healthParts.push(`relay=${h.relay.latencyMs}ms`);
      if (h.atem?.latencyMs != null) healthParts.push(`atem=${h.atem.latencyMs}ms`);
      if (h.atem?.reconnects > 0) healthParts.push(`atem_reconnects=${h.atem.reconnects}`);
      if (h.encoder?.reconnects > 0) healthParts.push(`encoder_reconnects=${h.encoder.reconnects}`);
      if (h.obs?.reconnects > 0) healthParts.push(`obs_reconnects=${h.obs.reconnects}`);
      if (healthParts.length) lines.push(`  Device health: ${healthParts.join(', ')}`);
    }

    // System uptime
    if (status.system?.uptime > 0) {
      lines.push(`  System uptime: ${Math.floor(status.system.uptime / 60)}min`);
    }

    sections.push(lines.join('\n'));
  }

  // ── Top 5 active alerts ──
  if (opts.recentAlerts?.length > 0) {
    const alertParts = opts.recentAlerts.slice(0, 5).map(a => {
      const alertStatus = a.resolved ? 'resolved' : a.acknowledged_at ? 'acked' : 'ACTIVE';
      return `${a.alert_type}(${a.severity})[${alertStatus}]`;
    });
    sections.push(`RECENT ALERTS: ${alertParts.join(', ')}`);
  }

  // ── Health score ──
  if (opts.healthScore != null) {
    sections.push(`HEALTH SCORE: ${opts.healthScore}/100`);
  }

  // ── Signal failover state ──
  if (opts.failoverState && opts.failoverState !== 'HEALTHY') {
    sections.push(`\u26a0 FAILOVER STATE: ${opts.failoverState}`);
  }

  // ── Engineer profile ──
  if (opts.engineerProfile && Object.keys(opts.engineerProfile).length) {
    const ep = opts.engineerProfile;
    const parts = [];
    if (ep.streamPlatform && ep.streamPlatform !== 'None') parts.push(`Streams to: ${ep.streamPlatform}`);
    if (ep.expectedViewers) parts.push(`Expected viewers: ${ep.expectedViewers}`);
    if (ep.operatorLevel) parts.push(`Operator: ${ep.operatorLevel}`);
    if (ep.backupEncoder) parts.push(`Backup encoder: ${ep.backupEncoder}`);
    if (ep.backupSwitcher) parts.push(`Backup switcher: ${ep.backupSwitcher}`);
    if (ep.specialNotes) parts.push(`Notes: ${ep.specialNotes}`);
    if (parts.length) sections.push(`ENGINEER PROFILE: ${parts.join('. ')}`);
  }

  // ── Configured devices summary ──
  if (opts.configuredDevices?.length > 0) {
    const DEVICE_DISPLAY_NAMES = {
      atem: 'ATEM', companion: 'Companion', encoder: 'Encoder',
      proPresenter: 'ProPresenter', vmix: 'vMix', resolume: 'Resolume',
      mixer: 'Audio Mixer', hyperdeck: 'HyperDeck', ptz: 'PTZ',
      videohub: 'VideoHub', obs: 'OBS', ecamm: 'Ecamm',
      dante: 'Dante', ndi: 'NDI',
    };
    const connectedSet = new Set();
    if (status?.atem?.connected) connectedSet.add('atem');
    if (status?.obs?.connected) connectedSet.add('obs');
    if (status?.vmix?.connected) connectedSet.add('vmix');
    if (status?.encoder?.connected) connectedSet.add('encoder');
    if (status?.proPresenter?.connected) connectedSet.add('proPresenter');
    if (status?.companion?.connected) connectedSet.add('companion');
    if (status?.mixer?.connected) connectedSet.add('mixer');
    if (status?.hyperdeck?.connected) connectedSet.add('hyperdeck');
    if ((status?.ptz || []).some(c => c?.connected)) connectedSet.add('ptz');
    if (status?.videohub?.connected) connectedSet.add('videohub');
    if (status?.resolume?.connected) connectedSet.add('resolume');
    if (status?.ecamm?.connected) connectedSet.add('ecamm');
    if (status?.dante?.connected) connectedSet.add('dante');
    if (status?.ndi?.connected) connectedSet.add('ndi');

    const parts = opts.configuredDevices.map(key => {
      const name = DEVICE_DISPLAY_NAMES[key] || key;
      return connectedSet.has(key) ? `${name}=Connected` : `${name}=Disconnected`;
    });
    sections.push(`CONFIGURED DEVICES: ${parts.join(', ')}`);

    const allKnown = Object.keys(DEVICE_DISPLAY_NAMES);
    const notConfigured = allKnown.filter(k => !opts.configuredDevices.includes(k));
    if (notConfigured.length) {
      sections.push(`NOT CONFIGURED (do not mention): ${notConfigured.map(k => DEVICE_DISPLAY_NAMES[k]).join(', ')}`);
    }
  }

  // ── Church memory summary ──
  if (opts.memorySummary) sections.push(opts.memorySummary);

  // ── Planning Center service plan context ──
  if (opts.planningCenter && opts.churchId) {
    try {
      const pcoContext = opts.planningCenter.buildAIContext(opts.churchId);
      if (pcoContext) sections.push(pcoContext);
    } catch { /* planningCenter may not be available */ }
  }

  // ── Document context ──
  if (opts.documentContext) sections.push(`[Docs: ${opts.documentContext}]`);

  // ── Church / room label ──
  if (opts.churchName || opts.roomId) {
    const parts = [];
    if (opts.churchName) parts.push(`Church: ${opts.churchName}`);
    if (opts.roomId) parts.push(`Room: ${opts.roomId}${opts.roomName ? ` (${opts.roomName})` : ''}`);
    sections.unshift(parts.join('. '));
  }

  return sections.join('\n\n');
}


// ─── Tier 2: Diagnostic Context (additive) ─────────────────────────────────────
// Adds deep history on top of Tier 1. Uses the DB directly.

function _buildDiagnosticExtras(churchId, db, churches, signalFailover) {
  const sections = [];

  // ── Full recent alerts (last 15 with details) ──
  try {
    const alerts = db.prepare(
      `SELECT alert_type, severity, context, created_at, acknowledged_at, resolved
       FROM alerts WHERE church_id = ? ORDER BY created_at DESC LIMIT 15`
    ).all(churchId);

    if (alerts.length > 0) {
      const lines = ['RECENT ALERTS (last 15):'];
      for (const a of alerts) {
        const age = _relativeTime(a.created_at);
        const alertStatus = a.resolved ? 'resolved' : a.acknowledged_at ? 'acked' : 'ACTIVE';
        let detail = `  ${age} \u2014 ${a.alert_type} (${a.severity}) [${alertStatus}]`;
        try {
          const ctx = JSON.parse(a.context || '{}');
          if (ctx.diagnosis?.likely_cause) {
            detail += ` \u2014 ${ctx.diagnosis.likely_cause}`;
          }
        } catch { /* ignore parse errors */ }
        lines.push(detail);
      }
      sections.push(lines.join('\n'));
    }
  } catch { /* alerts table may not exist */ }

  // ── Current/recent service session + timeline ──
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
            const evtStatus = e.auto_resolved ? 'auto-fixed' : e.resolved ? 'resolved' : 'unresolved';
            const detail = e.details ? ` \u2014 ${e.details.slice(0, 80)}` : '';
            lines.push(`    ${time}: ${type} (${evtStatus})${detail}`);
          }
        }
      } catch { /* service_events may not exist */ }

      sections.push(lines.join('\n'));
    }
  } catch { /* service_sessions may not exist */ }

  // ── Signal failover state + transitions ──
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

      if (state?.stateLog?.length > 0) {
        const logLines = ['FAILOVER STATE LOG (recent transitions):'];
        const recentLog = state.stateLog.slice(-10);
        for (const entry of recentLog) {
          const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
          logLines.push(`  ${time}: ${entry.from} \u2192 ${entry.to} (${entry.trigger})`);
        }
        sections.push(logLines.join('\n'));
      }
    } catch { /* signalFailover might not have state */ }
  }

  // ── Church memory (learned observations) ──
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

  // ── Engineer profile from DB (detailed) ──
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
            lines.push(`    - ${issue.issue} (${issue.frequency || 'unknown freq'})${issue.workaround ? ' \u2192 ' + issue.workaround : ''}`);
          }
        }
        if (profile.servicePattern) lines.push(`  Service pattern: ${profile.servicePattern}`);
        sections.push(lines.join('\n'));
      }
    }
  } catch { /* ignore parse errors */ }

  return sections.join('\n\n');
}


// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build context for AI system prompt injection.
 *
 * @param {object} status — live device status object (from church.status)
 * @param {'operational'|'diagnostic'} tier — context tier
 * @param {object} opts — additional context data
 * @param {string} [opts.churchId] — church ID (needed for DB queries in diagnostic tier)
 * @param {string} [opts.churchName]
 * @param {string} [opts.roomId]
 * @param {string} [opts.roomName]
 * @param {Array} [opts.recentAlerts] — top 5 recent alerts (pre-fetched)
 * @param {number} [opts.healthScore] — health score 0-100
 * @param {string} [opts.failoverState] — failover state name
 * @param {object} [opts.engineerProfile] — parsed engineer profile
 * @param {Array} [opts.configuredDevices] — configured device type keys
 * @param {string} [opts.memorySummary] — compiled church memory summary
 * @param {string} [opts.documentContext] — relevant knowledge base chunk
 * @param {string} [opts.incidentChains] — incident chain context
 * @param {object} [opts.planningCenter] — PlanningCenter instance (for PCO service plan context)
 * @param {object} [opts.db] — better-sqlite3 database instance (required for diagnostic tier)
 * @param {Map} [opts.churches] — runtime church map (required for diagnostic tier)
 * @param {object} [opts.signalFailover] — SignalFailover instance (optional, for diagnostic tier)
 * @returns {string} formatted context block for system prompt injection
 */
function buildContext(status, tier, opts = {}) {
  // Auto-upgrade: degrade to diagnostic tier when system is unhealthy
  let effectiveTier = tier;
  if (tier === 'operational') {
    if ((opts.healthScore != null && opts.healthScore < 70) ||
        (opts.failoverState && opts.failoverState !== 'HEALTHY')) {
      effectiveTier = 'diagnostic';
    }
  }

  // Tier 1: operational context (always included)
  const operational = _buildOperationalContext(status, opts);

  if (effectiveTier === 'operational') {
    return operational;
  }

  // Tier 2: diagnostic context (adds deep history)
  const parts = [operational];

  if (opts.db && opts.churchId) {
    const diagnosticExtras = _buildDiagnosticExtras(
      opts.churchId,
      opts.db,
      opts.churches || new Map(),
      opts.signalFailover || null
    );
    if (diagnosticExtras) parts.push(diagnosticExtras);
  }

  // Incident chains (pre-computed, passed in from server.js)
  if (opts.incidentChains) {
    parts.push(`INCIDENT CHAINS:\n${opts.incidentChains}`);
  }

  return parts.join('\n\n');
}


module.exports = { buildContext };
