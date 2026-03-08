const { toInt } = require('./helpers');

// ─── MIXER CAPABILITIES ─────────────────────────────────────────────────────

const MIXER_CAPABILITIES = {
  X32:    { compressor: 'full', gate: 'full', hpf: 'full', eq: 'full', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: 'full', saveScene: 'partial', channelStrip: 'full', preampGain: 'full', phantom: 'full', pan: 'full', channelColor: 'full', channelIcon: 'full', sendLevel: 'full', busAssign: 'full', dcaAssign: 'full', metering: 'full', sceneSaveVerify: 'full' },
  M32:    { compressor: 'full', gate: 'full', hpf: 'full', eq: 'full', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: 'full', saveScene: 'partial', channelStrip: 'full', preampGain: 'full', phantom: 'full', pan: 'full', channelColor: 'full', channelIcon: 'full', sendLevel: 'full', busAssign: 'full', dcaAssign: 'full', metering: 'full', sceneSaveVerify: 'full' },
  SQ:      { compressor: false, gate: false, hpf: 'full', eq: 'partial', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: 'full', dcaControl: 'full', muteGroup: 'full', pan: 'full', softKey: 'full' },
  SQ5:     { compressor: false, gate: false, hpf: 'full', eq: 'partial', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: 'full', dcaControl: 'full', muteGroup: 'full', pan: 'full', softKey: 'full' },
  SQ6:     { compressor: false, gate: false, hpf: 'full', eq: 'partial', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: 'full', dcaControl: 'full', muteGroup: 'full', pan: 'full', softKey: 'full' },
  SQ7:     { compressor: false, gate: false, hpf: 'full', eq: 'partial', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: 'full', dcaControl: 'full', muteGroup: 'full', pan: 'full', softKey: 'full' },
  DLIVE:   { compressor: false, gate: false, hpf: 'full', eq: false, fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: false, dcaControl: 'full', muteGroup: false, pan: 'full', softKey: false },
  AVANTIS: { compressor: false, gate: false, hpf: 'full', eq: false, fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: false, dcaControl: 'full', muteGroup: false, pan: 'full', softKey: false },
  CL:      { compressor: false, gate: false, hpf: false, eq: false, fader: 'partial', channelName: false, muteMaster: 'partial', clearSolos: false, saveScene: false, channelStrip: 'partial' },
  QL:     { compressor: false, gate: false, hpf: false, eq: false, fader: 'partial', channelName: false, muteMaster: 'partial', clearSolos: false, saveScene: false, channelStrip: 'partial' },
  TF:     { compressor: false, gate: false, hpf: false, eq: false, fader: false, channelName: false, muteMaster: false, clearSolos: false, saveScene: false, channelStrip: false },
};

function mixerCan(agent, feature) {
  const model = (agent.mixer?.model || '').toUpperCase();
  const caps = MIXER_CAPABILITIES[model];
  if (!caps) return 'full'; // unknown model — don't block
  return caps[feature] || false;
}

function requireMixerCapability(agent, feature, friendlyName) {
  const cap = mixerCan(agent, feature);
  if (cap === false) {
    const model = agent.mixer?.model || 'this mixer';
    throw new Error(`${friendlyName} is not supported on ${model} via its remote protocol — set this at the console directly`);
  }
  return cap; // 'full' or 'partial'
}

/** Pretty brand name for display. */
function mixerBrandName(type, model) {
  const t = (type || '').toLowerCase();
  const m = (model || '').trim();
  switch (t) {
    case 'behringer': case 'x32':   return m ? `Behringer ${m}` : 'Behringer X32';
    case 'midas':                    return m ? `Midas ${m}` : 'Midas M32';
    case 'allenheath':               return m ? `Allen & Heath ${m}` : 'Allen & Heath SQ';
    case 'avantis':                  return m ? `Allen & Heath ${m}` : 'Allen & Heath Avantis';
    case 'dlive':                    return m ? `Allen & Heath ${m}` : 'Allen & Heath dLive';
    case 'yamaha':                   return m ? `Yamaha ${m}` : 'Yamaha CL/QL';
    default:                         return m || type || 'Audio Console';
  }
}

/** Simple ASCII fader bar. */
function faderBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

async function mixerStatus(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const status = await agent.mixer.getStatus();
  const name = mixerBrandName(status.type, status.model);

  if (!status.online) {
    return `🎛️ ${name} — ❌ Offline\n\nConsole is not responding. Check power and network connection.`;
  }

  const faderPct = Math.round((status.mainFader ?? 0) * 100);
  const lines = [
    `🎛️ ${name} — ✅ Online`,
    '',
    status.mainMuted
      ? '🔇 Main output: MUTED'
      : `🔊 Main output: Active`,
    `📊 Main fader: ${faderBar(faderPct)} ${faderPct}%`,
    status.scene != null ? `🎬 Scene: ${status.scene}` : null,
    status.firmware ? `📟 Firmware: ${status.firmware}` : null,
  ].filter(l => l != null);

  return lines.join('\n');
}

async function mixerMute(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const ch = params.channel;
  if (ch === 'master' || ch === undefined) {
    await agent.mixer.muteMaster();
    return 'Master output muted';
  }
  await agent.mixer.muteChannel(ch);
  return `Channel ${ch} muted`;
}

async function mixerUnmute(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const ch = params.channel;
  if (ch === 'master' || ch === undefined) {
    await agent.mixer.unmuteMaster();
    return 'Master output unmuted';
  }
  await agent.mixer.unmuteChannel(ch);
  return `Channel ${ch} unmuted`;
}

async function mixerChannelStatus(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const ch = params.channel;
  if (!ch) throw new Error('channel parameter required');
  const status = await agent.mixer.getChannelStatus(ch);
  const faderPct = Math.round((status.fader ?? 0) * 100);
  const lines = [
    `🎚️ Channel ${ch}`,
    status.muted ? '🔇 Muted' : '🔊 Active',
    `📊 Fader: ${faderBar(faderPct)} ${faderPct}%`,
    status.name ? `🏷️ Name: ${status.name}` : null,
  ].filter(l => l != null);
  return lines.join('\n');
}

async function mixerRecallScene(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const scene = params.scene;
  if (scene == null) throw new Error('scene parameter required');
  await agent.mixer.recallScene(scene);
  return `Scene ${scene} recalled`;
}

async function mixerClearSolos(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'clearSolos', 'Solo clear');
  await agent.mixer.clearSolos();
  return 'All solos cleared';
}

async function mixerIsOnline(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const online = await agent.mixer.isOnline();
  const name = mixerBrandName(agent.config?.mixer?.type, agent.config?.mixer?.model);
  return online ? `🎛️ ${name} — ✅ Online` : `🎛️ ${name} — ❌ Not reachable`;
}

function mixerCapabilities(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const model = (agent.mixer.model || 'unknown').toUpperCase();
  const caps = MIXER_CAPABILITIES[model];
  if (!caps) return { model, note: 'Unknown mixer model — all features assumed available' };
  const lines = [`🎛️ ${model} — remote capabilities:`];
  for (const [feature, level] of Object.entries(caps)) {
    const icon = level === 'full' ? '✅' : level === 'partial' ? '⚠️' : '❌';
    const label = level === 'full' ? 'Supported' : level === 'partial' ? 'Partial (may warn)' : 'Not available';
    lines.push(`  ${icon} ${feature}: ${label}`);
  }
  return lines.join('\n');
}

async function mixerSetFader(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'fader', 'Fader control');
  const { channel, level } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (level == null) throw new Error('level parameter required (0.0–1.0)');
  await agent.mixer.setFader(channel, level);
  return `Channel ${channel} fader set to ${Math.round(parseFloat(level) * 100)}%`;
}

async function mixerSetChannelName(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'channelName', 'Channel name');
  const { channel, name } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (!name) throw new Error('name parameter required');
  await agent.mixer.setChannelName(channel, name);
  return `Channel ${channel} renamed to "${name}"`;
}

async function mixerSetHpf(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'hpf', 'HPF');
  const { channel, enabled, frequency } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setHpf(channel, { enabled: enabled !== false, frequency: frequency || 80 });
  return `Channel ${channel} HPF ${enabled === false ? 'disabled' : `set to ${frequency || 80} Hz`}`;
}

async function mixerSetEq(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'eq', 'EQ');
  const { channel, enabled, bands } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setEq(channel, { enabled: enabled !== false, bands: bands || [] });
  return `Channel ${channel} EQ ${enabled === false ? 'disabled' : 'updated'}`;
}

async function mixerSetCompressor(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'compressor', 'Compressor');
  const { channel, ...compParams } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setCompressor(channel, compParams);
  return `Channel ${channel} compressor ${compParams.enabled === false ? 'disabled' : 'updated'}`;
}

async function mixerSetGate(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'gate', 'Gate');
  const { channel, ...gateParams } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setGate(channel, gateParams);
  return `Channel ${channel} gate ${gateParams.enabled === false ? 'disabled' : 'updated'}`;
}

async function mixerSetFullChannelStrip(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'channelStrip', 'Channel strip');
  const { channel, ...strip } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setFullChannelStrip(channel, strip);
  return `Channel ${channel} (${strip.name || 'unnamed'}) — full strip applied`;
}

async function mixerSaveScene(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'saveScene', 'Scene save');
  const { scene, name } = params;
  if (scene == null) throw new Error('scene number required');
  await agent.mixer.saveScene(scene, name);
  return `Scene ${scene}${name ? ` ("${name}")` : ''} save attempted`;
}

// ─── NEW X32/M32 MIXER COMMANDS ──────────────────────────────────────────────

async function mixerSetPreampGain(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'preampGain', 'Preamp gain');
  const { channel, gain } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (gain == null) throw new Error('gain parameter required (dB, -18 to +18)');
  const gainDb = parseFloat(gain);
  if (isNaN(gainDb)) throw new Error('gain must be a number in dB');
  await agent.mixer.setPreampGain(channel, gainDb);
  return `Channel ${channel} preamp trim set to ${gainDb > 0 ? '+' : ''}${gainDb} dB`;
}

async function mixerSetPhantom(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'phantom', 'Phantom power');
  const { channel, enabled } = params;
  if (channel == null) throw new Error('channel parameter required');
  const on = enabled !== false && enabled !== 0 && enabled !== 'false';
  await agent.mixer.setPhantom(channel, on);
  return `Channel ${channel} phantom power ${on ? '⚡ ON' : 'OFF'}`;
}

async function mixerSetPan(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'pan', 'Pan');
  const { channel, pan } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (pan == null) throw new Error('pan parameter required (-1.0 left to +1.0 right, 0 = center)');
  const panVal = parseFloat(pan);
  if (isNaN(panVal)) throw new Error('pan must be a number (-1.0 to +1.0)');
  if (panVal < -1 || panVal > 1) throw new Error('pan out of range (-1.0 to +1.0)');
  await agent.mixer.setPan(channel, panVal);
  const label = panVal < -0.01 ? `${Math.round(panVal * 100)}% L` :
                panVal > 0.01  ? `${Math.round(panVal * 100)}% R` : 'Center';
  return `Channel ${channel} pan set to ${label}`;
}

async function mixerSetChannelColor(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'channelColor', 'Channel color');
  const { channel, color } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (color == null) throw new Error('color parameter required (name like "red" or index 0–15)');
  await agent.mixer.setChannelColor(channel, color);
  return `Channel ${channel} color set to ${color}`;
}

async function mixerSetChannelIcon(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'channelIcon', 'Channel icon');
  const { channel, icon } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (icon == null) throw new Error('icon parameter required (name like "mic" or index 1–74)');
  await agent.mixer.setChannelIcon(channel, icon);
  return `Channel ${channel} icon set to ${icon}`;
}

async function mixerSetSendLevel(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'sendLevel', 'Send level');
  const { channel, bus, level } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (bus == null) throw new Error('bus parameter required (1–16)');
  if (level == null) throw new Error('level parameter required (0.0–1.0)');

  const busNum = Number(bus);
  if (!Number.isInteger(busNum) || busNum < 1 || busNum > 16) {
    throw new Error('bus must be an integer in range 1–16');
  }

  const levelNum = Number(level);
  if (!Number.isFinite(levelNum) || levelNum < 0 || levelNum > 1) {
    throw new Error('level must be a number in range 0.0–1.0');
  }

  await agent.mixer.setSendLevel(channel, busNum, levelNum);
  return `Channel ${channel} → Bus ${busNum} send level set to ${Math.round(levelNum * 100)}%`;
}

async function mixerAssignToBus(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'busAssign', 'Bus assignment');
  const { channel, bus, enabled } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (bus == null) throw new Error('bus parameter required (1–16)');
  const on = enabled !== false && enabled !== 0 && enabled !== 'false';
  await agent.mixer.assignToBus(channel, parseInt(bus), on);
  return `Channel ${channel} → Bus ${bus}: ${on ? '✅ assigned' : '❌ removed'}`;
}

async function mixerAssignToDca(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'dcaAssign', 'DCA assignment');
  const { channel, dca, enabled } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (dca == null) throw new Error('dca parameter required (1–8)');
  const on = enabled !== false && enabled !== 0 && enabled !== 'false';
  await agent.mixer.assignToDca(channel, parseInt(dca), on);
  return `Channel ${channel} → DCA ${dca}: ${on ? '✅ assigned' : '❌ removed'}`;
}

async function mixerGetMeters(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'metering', 'Metering');
  const channels = params.channels ? (Array.isArray(params.channels) ? params.channels.map(Number) : [parseInt(params.channels)]) : undefined;
  const meters = await agent.mixer.getMeters(channels);
  const lines = ['📊 Channel meters:'];
  for (const m of meters) {
    const pct = Math.round((m.fader ?? 0) * 100);
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    lines.push(`  Ch ${String(m.channel).padStart(2)}: ${bar} ${pct}% ${m.muted ? '🔇' : '🔊'}`);
  }
  return lines.join('\n');
}

async function mixerVerifySceneSave(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'sceneSaveVerify', 'Scene verification');
  const { scene } = params;
  if (scene == null) throw new Error('scene number required');
  const result = await agent.mixer.verifySceneSave(parseInt(scene));
  if (result.exists) {
    return `✅ Scene ${result.sceneNumber} verified: "${result.name}"`;
  }
  return `⚠️ Scene ${result.sceneNumber}: no name found (may not exist or save may have failed)`;
}

// ─── DCA / MUTE GROUP / SOFTKEY ──────────────────────────────────────────────

async function mixerMuteDca(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'dcaControl', 'DCA control');
  const { dca } = params;
  if (dca == null) throw new Error('dca number required');
  await agent.mixer.muteDca(parseInt(dca));
  return `DCA ${dca} muted`;
}

async function mixerUnmuteDca(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'dcaControl', 'DCA control');
  const { dca } = params;
  if (dca == null) throw new Error('dca number required');
  await agent.mixer.unmuteDca(parseInt(dca));
  return `DCA ${dca} unmuted`;
}

async function mixerSetDcaFader(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'dcaControl', 'DCA control');
  const { dca, level } = params;
  if (dca == null) throw new Error('dca number required');
  if (level == null) throw new Error('level required (0.0–1.0)');
  const lvl = Math.max(0, Math.min(1, parseFloat(level)));
  await agent.mixer.setDcaFader(parseInt(dca), lvl);
  return `DCA ${dca} fader set to ${Math.round(lvl * 100)}%`;
}

async function mixerActivateMuteGroup(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'muteGroup', 'Mute groups');
  const { group } = params;
  if (group == null) throw new Error('group number required');
  await agent.mixer.activateMuteGroup(parseInt(group));
  return `Mute group ${group} activated`;
}

async function mixerDeactivateMuteGroup(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'muteGroup', 'Mute groups');
  const { group } = params;
  if (group == null) throw new Error('group number required');
  await agent.mixer.deactivateMuteGroup(parseInt(group));
  return `Mute group ${group} deactivated`;
}

async function mixerPressSoftKey(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'softKey', 'SoftKeys');
  const { key } = params;
  if (key == null) throw new Error('softkey number required');
  await agent.mixer.pressSoftKey(parseInt(key));
  return `SoftKey ${key} pressed`;
}

/**
 * Batch setup: apply full channel strips to all specified channels,
 * then optionally save a new scene.  Receives the output from the AI
 * setup assistant.
 */
async function mixerSetupFromPatchList(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const { channels, saveScene: doSave, sceneName } = params;
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('No channels provided');
  }

  // Pre-calculate which features are gated so we can report skipped ops
  const stripCap = mixerCan(agent, 'channelStrip');
  const skippedFeatures = [];
  if (mixerCan(agent, 'compressor') === false) skippedFeatures.push('compressor');
  if (mixerCan(agent, 'gate') === false) skippedFeatures.push('gate');
  if (mixerCan(agent, 'hpf') === false) skippedFeatures.push('HPF');
  if (mixerCan(agent, 'eq') === false) skippedFeatures.push('EQ');
  if (mixerCan(agent, 'channelName') === false) skippedFeatures.push('name');

  const results = [];
  for (const ch of channels) {
    try {
      if (stripCap === false) {
        throw new Error('Channel strip not supported on this mixer');
      }
      await agent.mixer.setFullChannelStrip(ch.channel, ch);
      results.push({ channel: ch.channel, name: ch.name, ok: true });
    } catch (e) {
      results.push({ channel: ch.channel, name: ch.name, ok: false, error: e.message });
    }
    // Pace UDP sends — 30ms between channels prevents buffer overflow
    await new Promise(r => setTimeout(r, 30));
  }

  // Optionally save as a new scene
  if (doSave) {
    const sceneCap = mixerCan(agent, 'saveScene');
    if (sceneCap === false) {
      results.push({ scene: 'save', ok: false, error: 'Scene save not supported on this mixer' });
    } else {
      try {
        const sceneNum = 90; // Use scene slot 90 as "AI Setup" slot
        const label = sceneName || `AI Setup ${new Date().toLocaleDateString()}`;
        await agent.mixer.saveScene(sceneNum, label);
        results.push({ scene: sceneNum, name: label, ok: true });
      } catch (e) {
        results.push({ scene: 'save', ok: false, error: e.message });
      }
    }
  }

  // Also save locally as a JSON preset for recall
  const fs = require('fs');
  const path = require('path');
  const presetDir = path.join(process.env.HOME || '/tmp', '.church-av', 'mixer-presets');
  try {
    fs.mkdirSync(presetDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(
      path.join(presetDir, `setup-${ts}.json`),
      JSON.stringify({ created: new Date().toISOString(), channels }, null, 2)
    );
  } catch { /* non-critical — don't fail the whole setup */ }

  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  const lines = [`✅ Mixer setup complete: ${ok} applied, ${fail} failed`];
  if (fail > 0) lines.push(`⚠️ Failed: ${results.filter(r => !r.ok).map(r => r.channel != null ? `Ch${r.channel}` : r.scene).join(', ')}`);
  if (skippedFeatures.length > 0) {
    lines.push(`ℹ️ Skipped on ${agent.mixer.model || 'this mixer'}: ${skippedFeatures.join(', ')} — set these at the console`);
  }
  return lines.join('\n');
}

module.exports = {
  mixerBrandName,
  'mixer.status': mixerStatus,
  'mixer.mute': mixerMute,
  'mixer.unmute': mixerUnmute,
  'mixer.channelStatus': mixerChannelStatus,
  'mixer.recallScene': mixerRecallScene,
  'mixer.clearSolos': mixerClearSolos,
  'mixer.isOnline': mixerIsOnline,
  'mixer.setFader': mixerSetFader,
  'mixer.setChannelName': mixerSetChannelName,
  'mixer.setHpf': mixerSetHpf,
  'mixer.setEq': mixerSetEq,
  'mixer.setCompressor': mixerSetCompressor,
  'mixer.setGate': mixerSetGate,
  'mixer.setFullChannelStrip': mixerSetFullChannelStrip,
  'mixer.saveScene': mixerSaveScene,
  'mixer.setPreampGain': mixerSetPreampGain,
  'mixer.setPhantom': mixerSetPhantom,
  'mixer.setPan': mixerSetPan,
  'mixer.setChannelColor': mixerSetChannelColor,
  'mixer.setChannelIcon': mixerSetChannelIcon,
  'mixer.setSendLevel': mixerSetSendLevel,
  'mixer.assignToBus': mixerAssignToBus,
  'mixer.assignToDca': mixerAssignToDca,
  'mixer.getMeters': mixerGetMeters,
  'mixer.verifySceneSave': mixerVerifySceneSave,
  'mixer.setupFromPatchList': mixerSetupFromPatchList,
  'mixer.capabilities': mixerCapabilities,
  'mixer.muteDca': mixerMuteDca,
  'mixer.unmuteDca': mixerUnmuteDca,
  'mixer.setDcaFader': mixerSetDcaFader,
  'mixer.activateMuteGroup': mixerActivateMuteGroup,
  'mixer.deactivateMuteGroup': mixerDeactivateMuteGroup,
  'mixer.pressSoftKey': mixerPressSoftKey,
};
