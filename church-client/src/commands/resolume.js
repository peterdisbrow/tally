const { toInt } = require('./helpers');

async function resolumeStatus(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const status = await agent.resolume.getStatus();

  if (!status || !status.running) {
    return '🎆 Resolume Arena — ❌ Offline\n\nResolume is not responding. Check that it is running.';
  }

  const lines = [
    '🎆 Resolume Arena — ✅ Running',
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
  return running ? '🎆 Resolume Arena — ✅ Running' : '🎆 Resolume Arena — ❌ Not reachable';
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
};
