/**
 * Generic Switcher command handlers — type-agnostic switching operations.
 *
 * These work across ATEM, OBS, and vMix by resolving the target switcher
 * from the SwitcherManager via params.switcherId or params.role.
 */

function resolveSwitcher(agent, params) {
  const mgr = agent.switcherManager;
  if (!mgr || mgr.size === 0) throw new Error('No switchers configured');

  if (params.switcherId) {
    const sw = mgr.get(params.switcherId);
    if (!sw) throw new Error(`Switcher "${params.switcherId}" not found`);
    return sw;
  }

  if (params.role) {
    const sw = mgr.getByRole(params.role);
    if (!sw) throw new Error(`No switcher with role "${params.role}" found`);
    return sw;
  }

  // Default: primary switcher
  const sw = mgr.getPrimary();
  if (!sw) throw new Error('No primary switcher found');
  return sw;
}

async function switcherCut(agent, params) {
  const sw = resolveSwitcher(agent, params);
  const me = Number(params.me) || 0;
  if (params.input != null) {
    await sw.setProgram(params.input, me);
    return `[${sw.id}] Cut to input ${params.input}`;
  }
  await sw.cut(me);
  return `[${sw.id}] Cut executed`;
}

async function switcherSetProgram(agent, params) {
  const sw = resolveSwitcher(agent, params);
  if (params.input == null) throw new Error('input is required');
  const me = Number(params.me) || 0;
  await sw.setProgram(params.input, me);
  return `[${sw.id}] Program set to ${params.input}`;
}

async function switcherSetPreview(agent, params) {
  const sw = resolveSwitcher(agent, params);
  if (params.input == null) throw new Error('input is required');
  const me = Number(params.me) || 0;
  await sw.setPreview(params.input, me);
  return `[${sw.id}] Preview set to ${params.input}`;
}

async function switcherAutoTransition(agent, params) {
  const sw = resolveSwitcher(agent, params);
  const me = Number(params.me) || 0;
  await sw.autoTransition(me);
  return `[${sw.id}] Auto transition executed`;
}

async function switcherList(agent) {
  const mgr = agent.switcherManager;
  if (!mgr || mgr.size === 0) return 'No switchers configured';

  const lines = [];
  for (const sw of mgr.all()) {
    const s = sw.getStatus();
    const status = s.connected ? '✅' : '❌';
    const pgm = s.programInput != null ? ` PGM:${s.programInput}` : '';
    const pvw = s.previewInput != null ? ` PVW:${s.previewInput}` : '';
    lines.push(`${status} ${s.id} (${s.type}, role:${s.role})${pgm}${pvw}`);
  }
  return lines.join('\n');
}

async function switcherStatus(agent, params) {
  const sw = resolveSwitcher(agent, params);
  const s = sw.getStatus();
  const lines = [
    `${s.connected ? '✅' : '❌'} ${s.name || s.id} — ${s.type} (role: ${s.role})`,
    `Program: ${s.programInput ?? 'N/A'}`,
    `Preview: ${s.previewInput ?? 'N/A'}`,
  ];
  if (s.model) lines.push(`Model: ${s.model}`);
  if (s.streaming) lines.push('🔴 Streaming');
  if (s.recording) lines.push('⏺ Recording');
  if (Object.keys(s.inputLabels || {}).length > 0) {
    const labels = Object.entries(s.inputLabels).map(([id, name]) => `  ${id}: ${name}`);
    lines.push(`Inputs:\n${labels.join('\n')}`);
  }
  return lines.join('\n');
}

module.exports = {
  'switcher.cut': switcherCut,
  'switcher.setProgram': switcherSetProgram,
  'switcher.setPreview': switcherSetPreview,
  'switcher.auto': switcherAutoTransition,
  'switcher.list': switcherList,
  'switcher.status': switcherStatus,
};
