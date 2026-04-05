/**
 * TriCaster-specific command handlers.
 *
 * Generic switching (cut, setProgram, setPreview, auto) is handled by
 * the switcher.js commands — these cover TriCaster-only features:
 * macro triggering, DDR control, record/stream toggling.
 */

function resolveTriCaster(agent, params) {
  const mgr = agent.switcherManager;
  if (!mgr) throw new Error('No switchers configured');

  if (params.switcherId) {
    const sw = mgr.get(params.switcherId);
    if (!sw || sw.type !== 'tricaster') throw new Error(`TriCaster "${params.switcherId}" not found`);
    return sw;
  }

  const sw = mgr.getFirstByType('tricaster');
  if (!sw) throw new Error('No TriCaster configured');
  return sw;
}

async function tricasterMacro(agent, params) {
  const tc = resolveTriCaster(agent, params);
  if (!params.macro) throw new Error('macro name is required');
  await tc.triggerMacro(params.macro);
  return `[${tc.id}] Macro triggered: ${params.macro}`;
}

async function tricasterDdr(agent, params) {
  const tc = resolveTriCaster(agent, params);
  const ddr = params.ddr || 'ddr1';
  const action = params.action || 'play_toggle';
  await tc.ddrControl(ddr, action);
  return `[${tc.id}] DDR ${ddr}: ${action}`;
}

async function tricasterRecord(agent, params) {
  const tc = resolveTriCaster(agent, params);
  const force = params.state != null ? (params.state === true || params.state === 'true' || params.state === '1') : null;
  await tc.recordToggle(force);
  return `[${tc.id}] Recording toggled`;
}

async function tricasterStream(agent, params) {
  const tc = resolveTriCaster(agent, params);
  const force = params.state != null ? (params.state === true || params.state === 'true' || params.state === '1') : null;
  await tc.streamToggle(force);
  return `[${tc.id}] Streaming toggled`;
}

async function tricasterStatus(agent, params) {
  const tc = resolveTriCaster(agent, params);
  const s = tc.getStatus();
  const lines = [
    `${s.connected ? '✅' : '❌'} ${s.name || s.id} — TriCaster (role: ${s.role})`,
    `Product: ${s.productName || 'Unknown'} ${s.productVersion || ''}`,
    `Program: ${s.programInput ?? 'N/A'}`,
    `Preview: ${s.previewInput ?? 'N/A'}`,
  ];
  if (s.sessionName) lines.push(`Session: ${s.sessionName}`);
  if (s.streaming) lines.push('Streaming');
  if (s.recording) lines.push('Recording');
  if (Object.keys(s.inputLabels || {}).length > 0) {
    const labels = Object.entries(s.inputLabels).map(([id, name]) => `  ${id}: ${name}`);
    lines.push(`Inputs:\n${labels.join('\n')}`);
  }
  return lines.join('\n');
}

module.exports = {
  'tricaster.macro': tricasterMacro,
  'tricaster.ddr': tricasterDdr,
  'tricaster.record': tricasterRecord,
  'tricaster.stream': tricasterStream,
  'tricaster.status': tricasterStatus,
};
