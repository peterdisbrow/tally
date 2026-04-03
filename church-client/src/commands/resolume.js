const { toInt } = require('./helpers');

async function resolumeStatus(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const status = await agent.resolume.getStatus();

  if (!status || !status.running) {
    return '🎞️ Resolume Arena — ❌ Offline\n\nResolume is not responding. Check that it is running.';
  }

  const lines = [
    '🎞️ Resolume Arena — ✅ Running',
    '',
    `📐 Composition: ${status.layerCount} layers · ${status.columnCount} columns`,
    status.bpm ? `🥁 BPM: ${status.bpm}` : null,
    '',
  ];

  if (status.playing.length) {
    lines.push('▶️  Now playing:');
    for (const p of status.playing) {
      lines.push(`   ${p.layer}: ${p.clip}`);
    }
  } else {
    lines.push('⏸️  Nothing playing');
  }

  return lines.filter(l => l != null).join('\n');
}

async function resolumePlayClip(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  if (params.name) {
    const result = await agent.resolume.playClipByName(params.name);
    return `Playing clip "${result.clip}" on layer "${result.layer}"`;
  }
  const layer = toInt(params.layer, 'layer');
  const clip  = toInt(params.clip,  'clip');
  await agent.resolume.playClip(layer, clip);
  return `Playing clip (layer ${layer}, clip ${clip})`;
}

async function resolumeStopClip(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const clip  = toInt(params.clip,  'clip');
  await agent.resolume.stopClip(layer, clip);
  return `Stopped clip (layer ${layer}, clip ${clip})`;
}

async function resolumeTriggerColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  if (params.name) {
    const colName = await agent.resolume.triggerColumnByName(params.name);
    return `Triggered column "${colName}"`;
  }
  const column = toInt(params.column, 'column');
  await agent.resolume.triggerColumn(column);
  return `Triggered column ${column}`;
}

async function resolumeClearAll(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.clearAll();
  return 'Resolume cleared — visual blackout';
}

async function resolumeSetLayerOpacity(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const val = await agent.resolume.setLayerOpacity(params.layer, params.value);
  return `Layer ${params.layer} opacity set to ${Math.round(val * 100)}%`;
}

async function resolumeSetMasterOpacity(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const val = await agent.resolume.setMasterOpacity(params.value);
  return `Master opacity set to ${Math.round(val * 100)}%`;
}

async function resolumeSetBpm(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const bpm = await agent.resolume.setBpm(params.bpm);
  return `BPM set to ${bpm}`;
}

async function resolumeGetLayers(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layers = await agent.resolume.getLayers();
  if (!layers.length) return 'No layers found';
  return layers.map((l, i) => `${l.id || i + 1}. ${l.name?.value || 'Unnamed'}`).join('\n');
}

async function resolumeGetColumns(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const columns = await agent.resolume.getColumns();
  if (!columns.length) return 'No columns found';
  return columns.map((c, i) => `${c.id || i + 1}. ${c.name?.value || 'Unnamed'}`).join('\n');
}

async function resolumeIsRunning(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const running = await agent.resolume.isRunning();
  return running ? '🎞️ Resolume Arena — ✅ Running' : '🎞️ Resolume Arena — ❌ Not reachable';
}

async function resolumeVersion(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const version = await agent.resolume.getVersion();
  if (!version) return 'Resolume version not available (not reachable)';
  return version;
}

async function resolumeGetBpm(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const bpm = await agent.resolume.getBpm();
  if (bpm == null) return 'BPM data not available';
  return `Current BPM: ${bpm}`;
}

// ─── RESOLUME EXTENDED COMMANDS ──────────────────────────────────────────────

async function resolumePlayClipByName(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('clip name required');
  const result = await agent.resolume.playClipByName(name);
  return `Playing clip "${result.clip}" on layer "${result.layer}"`;
}

async function resolumeTriggerColumnByName(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('column name required');
  await agent.resolume.triggerColumnByName(name);
  return `Triggered column "${name}"`;
}

// ─── COMPANION PARITY: Layer Bypass (Solo/Mute) ──────────────────────────

async function resolumeSetLayerBypass(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const bypassed = params.bypassed !== false && params.bypassed !== 'false';
  await agent.resolume.setLayerBypass(layer, bypassed);
  return `Layer ${layer} ${bypassed ? 'muted (bypassed)' : 'unmuted'}`;
}

async function resolumeSetLayerSolo(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const solo = params.solo !== false && params.solo !== 'false';
  await agent.resolume.setLayerSolo(layer, solo);
  return `Layer ${layer} solo ${solo ? 'on' : 'off'}`;
}

// ─── COMPANION PARITY: Clip Speed & Transport ────────────────────────────

async function resolumeSetClipSpeed(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const clip = toInt(params.clip, 'clip');
  const speed = await agent.resolume.setClipSpeed(layer, clip, params.speed || 1);
  return `Clip speed set to ${speed}x (layer ${layer}, clip ${clip})`;
}

async function resolumePauseClip(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const clip = toInt(params.clip, 'clip');
  await agent.resolume.pauseClip(layer, clip);
  return `Clip paused (layer ${layer}, clip ${clip})`;
}

async function resolumeRestartClip(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const clip = toInt(params.clip, 'clip');
  await agent.resolume.restartClip(layer, clip);
  return `Clip restarted (layer ${layer}, clip ${clip})`;
}

// ─── COMPANION PARITY: Effect Parameters ─────────────────────────────────

async function resolumeSetLayerEffectParam(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const effect = toInt(params.effect, 'effect');
  if (!params.param) throw new Error('param name required');
  await agent.resolume.setLayerEffectParam(layer, effect, params.param, params.value);
  return `Layer ${layer} effect ${effect} "${params.param}" set to ${params.value}`;
}

async function resolumeSetLayerEffectBypassed(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const effect = toInt(params.effect, 'effect');
  const bypassed = params.bypassed !== false && params.bypassed !== 'false';
  await agent.resolume.setLayerEffectBypassed(layer, effect, bypassed);
  return `Layer ${layer} effect ${effect} ${bypassed ? 'bypassed' : 'active'}`;
}

// ─── COMPANION PARITY: Deck Switching ────────────────────────────────────

async function resolumeSelectDeck(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const deck = toInt(params.deck, 'deck');
  await agent.resolume.selectDeck(deck);
  return `Deck ${deck} selected`;
}

// ─── COMPANION PARITY: Layer Blend Mode ──────────────────────────────────

async function resolumeSetLayerBlendMode(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const mode = String(params.mode || '').trim();
  if (!mode) throw new Error('blend mode required');
  await agent.resolume.setLayerBlendMode(layer, mode);
  return `Layer ${layer} blend mode set to "${mode}"`;
}

// ─── COMPANION PARITY: Crossfader ───────────────────────────────────────

async function resolumeSetCrossfader(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const value = await agent.resolume.setCrossfader(params.value);
  return `Crossfader set to ${Math.round(value * 100)}%`;
}

// ─── COMPANION PARITY: Composition Speed ────────────────────────────────

async function resolumeSetCompositionSpeed(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const speed = await agent.resolume.setCompositionSpeed(params.speed || 1);
  return `Composition speed set to ${speed}x`;
}

// ─── COMPANION PARITY: Layer Select ─────────────────────────────────────

async function resolumeSelectLayer(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  await agent.resolume.selectLayer(layer);
  return `Layer ${layer} selected`;
}

// ─── COMPANION PARITY: Clip Thumbnail ───────────────────────────────────

async function resolumeGetClipThumbnail(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const clip = toInt(params.clip, 'clip');
  const b64 = await agent.resolume.getClipThumbnail(layer, clip);
  if (!b64) return 'Thumbnail not available';
  return { type: 'screenshot', data: b64, source: `resolume-L${layer}C${clip}` };
}

// ─── COMPANION PARITY: Clip Opacity & Volume ───────────────────────────

async function resolumeSetClipOpacity(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const clip = toInt(params.clip, 'clip');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setClipOpacity(layer, clip, value, mode);
  return `Clip opacity ${mode} to ${result} (layer ${layer}, clip ${clip})`;
}

async function resolumeSetClipVolume(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const clip = toInt(params.clip, 'clip');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setClipVolume(layer, clip, value, mode);
  return `Clip volume ${mode} to ${result} (layer ${layer}, clip ${clip})`;
}

// ─── COMPANION PARITY: Composition Master/Opacity/Volume ────────────────

async function resolumeSetCompositionMaster(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setCompositionMaster(value, mode);
  return `Composition master ${mode} to ${result}`;
}

async function resolumeSetCompositionOpacity(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setCompositionOpacity(value, mode);
  return `Composition opacity ${mode} to ${result}`;
}

async function resolumeSetCompositionVolume(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setCompositionVolume(value, mode);
  return `Composition volume ${mode} to ${result}`;
}

// ─── COMPANION PARITY: Tempo Tap & Resync ───────────────────────────────

async function resolumeTempoTap(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.tempoTap();
  return 'Tempo tap triggered';
}

async function resolumeTempoResync(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.tempoResync();
  return 'Tempo resync triggered';
}

// ─── COMPANION PARITY: Extended Layer Controls ──────────────────────────

async function resolumeSetLayerVolume(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setLayerVolume(layer, value, mode);
  return `Layer ${layer} volume ${mode} to ${result}`;
}

async function resolumeSetLayerMaster(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setLayerMaster(layer, value, mode);
  return `Layer ${layer} master ${mode} to ${result}`;
}

async function resolumeSetLayerTransitionDuration(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setLayerTransitionDuration(layer, value, mode);
  return `Layer ${layer} transition duration ${mode} to ${result}`;
}

async function resolumeLayerNextColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  await agent.resolume.layerNextColumn(layer);
  return `Layer ${layer} advanced to next column`;
}

async function resolumeLayerPreviousColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  await agent.resolume.layerPreviousColumn(layer);
  return `Layer ${layer} moved to previous column`;
}

async function resolumeClearLayer(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layer = toInt(params.layer, 'layer');
  await agent.resolume.clearLayer(layer);
  return `Layer ${layer} cleared`;
}

// ─── COMPANION PARITY: Layer Groups ─────────────────────────────────────

async function resolumeSetLayerGroupBypass(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  const bypassed = params.bypassed !== false && params.bypassed !== 'false';
  await agent.resolume.setLayerGroupBypass(group, bypassed);
  return `Layer group ${group} ${bypassed ? 'bypassed' : 'active'}`;
}

async function resolumeClearLayerGroup(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  await agent.resolume.clearLayerGroup(group);
  return `Layer group ${group} cleared`;
}

async function resolumeSetLayerGroupSolo(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  const solo = params.solo !== false && params.solo !== 'false';
  await agent.resolume.setLayerGroupSolo(group, solo);
  return `Layer group ${group} solo ${solo ? 'on' : 'off'}`;
}

async function resolumeSelectLayerGroup(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  await agent.resolume.selectLayerGroup(group);
  return `Layer group ${group} selected`;
}

async function resolumeLayerGroupNextColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  await agent.resolume.layerGroupNextColumn(group);
  return `Layer group ${group} advanced to next column`;
}

async function resolumeLayerGroupPreviousColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  await agent.resolume.layerGroupPreviousColumn(group);
  return `Layer group ${group} moved to previous column`;
}

async function resolumeTriggerLayerGroupColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  const column = toInt(params.column, 'column');
  await agent.resolume.triggerLayerGroupColumn(group, column);
  return `Layer group ${group} column ${column} triggered`;
}

async function resolumeSelectLayerGroupColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  const column = toInt(params.column, 'column');
  await agent.resolume.selectLayerGroupColumn(group, column);
  return `Layer group ${group} column ${column} selected`;
}

async function resolumeSetLayerGroupMaster(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setLayerGroupMaster(group, value, mode);
  return `Layer group ${group} master ${mode} to ${result}`;
}

async function resolumeSetLayerGroupOpacity(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setLayerGroupOpacity(group, value, mode);
  return `Layer group ${group} opacity ${mode} to ${result}`;
}

async function resolumeSetLayerGroupVolume(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setLayerGroupVolume(group, value, mode);
  return `Layer group ${group} volume ${mode} to ${result}`;
}

async function resolumeSetLayerGroupSpeed(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const group = toInt(params.group, 'group');
  const value = Number(params.value);
  const mode = params.mode || 'set';
  const result = await agent.resolume.setLayerGroupSpeed(group, value, mode);
  return `Layer group ${group} speed ${mode} to ${result}`;
}

// ─── COMPANION PARITY: Deck Navigation ──────────────────────────────────

async function resolumeSelectNextDeck(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.selectNextDeck();
  return 'Next deck selected';
}

async function resolumeSelectPreviousDeck(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.selectPreviousDeck();
  return 'Previous deck selected';
}

// ─── COMPANION PARITY: Column Control ───────────────────────────────────

async function resolumeSelectColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const column = toInt(params.column, 'column');
  await agent.resolume.selectColumn(column);
  return `Column ${column} selected`;
}

async function resolumeNextColumn(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.nextColumn();
  return 'Advanced to next column';
}

async function resolumePreviousColumn(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.previousColumn();
  return 'Moved to previous column';
}

module.exports = {
  'resolume.status': resolumeStatus,
  'resolume.playClip': resolumePlayClip,
  'resolume.stopClip': resolumeStopClip,
  'resolume.triggerColumn': resolumeTriggerColumn,
  'resolume.clearAll': resolumeClearAll,
  'resolume.setLayerOpacity': resolumeSetLayerOpacity,
  'resolume.setMasterOpacity': resolumeSetMasterOpacity,
  'resolume.setBpm': resolumeSetBpm,
  'resolume.getLayers': resolumeGetLayers,
  'resolume.getColumns': resolumeGetColumns,
  'resolume.isRunning': resolumeIsRunning,
  'resolume.version': resolumeVersion,
  'resolume.getBpm': resolumeGetBpm,
  'resolume.playClipByName': resolumePlayClipByName,
  'resolume.triggerColumnByName': resolumeTriggerColumnByName,

  // Companion parity: layer bypass (solo/mute)
  'resolume.setLayerBypass': resolumeSetLayerBypass,
  'resolume.setLayerSolo': resolumeSetLayerSolo,

  // Companion parity: clip speed & transport
  'resolume.setClipSpeed': resolumeSetClipSpeed,
  'resolume.pauseClip': resolumePauseClip,
  'resolume.restartClip': resolumeRestartClip,

  // Companion parity: effect parameters
  'resolume.setLayerEffectParam': resolumeSetLayerEffectParam,
  'resolume.setLayerEffectBypassed': resolumeSetLayerEffectBypassed,

  // Companion parity: deck switching
  'resolume.selectDeck': resolumeSelectDeck,

  // Companion parity: layer blend mode
  'resolume.setLayerBlendMode': resolumeSetLayerBlendMode,

  // Companion parity: crossfader
  'resolume.setCrossfader': resolumeSetCrossfader,

  // Companion parity: composition speed
  'resolume.setCompositionSpeed': resolumeSetCompositionSpeed,

  // Companion parity: layer select
  'resolume.selectLayer': resolumeSelectLayer,

  // Companion parity: clip thumbnail
  'resolume.getClipThumbnail': resolumeGetClipThumbnail,

  // Companion parity: clip opacity & volume
  'resolume.setClipOpacity': resolumeSetClipOpacity,
  'resolume.setClipVolume': resolumeSetClipVolume,

  // Companion parity: composition master/opacity/volume
  'resolume.setCompositionMaster': resolumeSetCompositionMaster,
  'resolume.setCompositionOpacity': resolumeSetCompositionOpacity,
  'resolume.setCompositionVolume': resolumeSetCompositionVolume,

  // Companion parity: tempo tap & resync
  'resolume.tempoTap': resolumeTempoTap,
  'resolume.tempoResync': resolumeTempoResync,

  // Companion parity: extended layer controls
  'resolume.setLayerVolume': resolumeSetLayerVolume,
  'resolume.setLayerMaster': resolumeSetLayerMaster,
  'resolume.setLayerTransitionDuration': resolumeSetLayerTransitionDuration,
  'resolume.layerNextColumn': resolumeLayerNextColumn,
  'resolume.layerPreviousColumn': resolumeLayerPreviousColumn,
  'resolume.clearLayer': resolumeClearLayer,

  // Companion parity: layer groups
  'resolume.setLayerGroupBypass': resolumeSetLayerGroupBypass,
  'resolume.clearLayerGroup': resolumeClearLayerGroup,
  'resolume.setLayerGroupSolo': resolumeSetLayerGroupSolo,
  'resolume.selectLayerGroup': resolumeSelectLayerGroup,
  'resolume.layerGroupNextColumn': resolumeLayerGroupNextColumn,
  'resolume.layerGroupPreviousColumn': resolumeLayerGroupPreviousColumn,
  'resolume.triggerLayerGroupColumn': resolumeTriggerLayerGroupColumn,
  'resolume.selectLayerGroupColumn': resolumeSelectLayerGroupColumn,
  'resolume.setLayerGroupMaster': resolumeSetLayerGroupMaster,
  'resolume.setLayerGroupOpacity': resolumeSetLayerGroupOpacity,
  'resolume.setLayerGroupVolume': resolumeSetLayerGroupVolume,
  'resolume.setLayerGroupSpeed': resolumeSetLayerGroupSpeed,

  // Companion parity: deck navigation
  'resolume.selectNextDeck': resolumeSelectNextDeck,
  'resolume.selectPreviousDeck': resolumeSelectPreviousDeck,

  // Companion parity: column control
  'resolume.selectColumn': resolumeSelectColumn,
  'resolume.nextColumn': resolumeNextColumn,
  'resolume.previousColumn': resolumePreviousColumn,
};
