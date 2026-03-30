const { toInt } = require('./helpers');

async function videohubRoute(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const ok = await hub.setRoute(params.output, params.input);
  if (!ok) throw new Error('Video Hub did not acknowledge route change');
  return `Routed input ${params.input} → output ${params.output}`;
}

async function videohubGetRoutes(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  return await hub.getRoutes();
}

async function videohubSetInputLabel(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const ok = await hub.setInputLabel(params.index, params.label);
  if (!ok) throw new Error('Video Hub did not acknowledge input label change');
  return `Input ${params.index} labeled "${params.label}"`;
}

async function videohubSetOutputLabel(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const ok = await hub.setOutputLabel(params.index, params.label);
  if (!ok) throw new Error('Video Hub did not acknowledge output label change');
  return `Output ${params.index} labeled "${params.label}"`;
}

async function videohubGetInputLabels(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const labels = await hub.getInputLabels();
  if (!labels.length) return 'No input labels found';
  return labels.map(l => `${l.index}: ${l.label}`).join('\n');
}

async function videohubGetOutputLabels(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const labels = await hub.getOutputLabels();
  if (!labels.length) return 'No output labels found';
  return labels.map(l => `${l.index}: ${l.label}`).join('\n');
}

// ─── COMPANION PARITY: Lock/Unlock Output ────────────────────────────────

async function videohubLockOutput(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const output = toInt(params.output, 'output');
  const ok = await hub.lockOutput(output);
  if (!ok) throw new Error('Video Hub did not acknowledge lock');
  return `Output ${output} locked`;
}

async function videohubUnlockOutput(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const output = toInt(params.output, 'output');
  const ok = await hub.unlockOutput(output);
  if (!ok) throw new Error('Video Hub did not acknowledge unlock');
  return `Output ${output} unlocked`;
}

async function videohubGetOutputLocks(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const locks = await hub.getOutputLocks();
  if (!locks.length) return 'No output lock data available';
  return locks.map(l => `${l.output}: ${l.label} [${l.locked ? 'LOCKED' : 'unlocked'}]`).join('\n');
}

// ─── COMPANION PARITY: Serial Port Routing ───────────────────────────────

async function videohubSetSerialRoute(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const ok = await hub.setSerialRoute(params.output, params.input);
  if (!ok) throw new Error('Video Hub did not acknowledge serial route change');
  return `Serial port: input ${params.input} → output ${params.output}`;
}

// ─── COMPANION PARITY: Processing Unit Routing ──────────────────────────

async function videohubSetProcessingRoute(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const ok = await hub.setProcessingRoute(params.output, params.input);
  if (!ok) throw new Error('Video Hub did not acknowledge processing route change');
  return `Processing unit: input ${params.input} → output ${params.output}`;
}

// ─── COMPANION PARITY: Monitoring Output Routing ────────────────────────

async function videohubSetMonitoringRoute(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const ok = await hub.setMonitoringRoute(params.output, params.input);
  if (!ok) throw new Error('Video Hub did not acknowledge monitoring route change');
  return `Monitoring output: input ${params.input} → output ${params.output}`;
}

// ─── COMPANION PARITY: Bulk Route Load ──────────────────────────────────

async function videohubBulkRoute(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const routes = params.routes;
  if (!Array.isArray(routes) || routes.length === 0) throw new Error('routes array required');
  const ok = await hub.setBulkRoutes(routes);
  if (!ok) throw new Error('Video Hub did not acknowledge bulk route change');
  return `${routes.length} routes applied`;
}

// ─── COMPANION PARITY: Route Take (Preview then Take) ───────────────────

async function videohubRouteTake(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  // Route take simply sets the route — VideoHub protocol doesn't have a
  // separate preview/take concept, but this provides a semantic alias for
  // workflows that stage a route change before executing it.
  const ok = await hub.setRoute(params.output, params.input);
  if (!ok) throw new Error('Video Hub did not acknowledge route take');
  return `Route take: input ${params.input} → output ${params.output}`;
}

module.exports = {
  'videohub.route': videohubRoute,
  'videohub.getRoutes': videohubGetRoutes,
  'videohub.setInputLabel': videohubSetInputLabel,
  'videohub.setOutputLabel': videohubSetOutputLabel,
  'videohub.getInputLabels': videohubGetInputLabels,
  'videohub.getOutputLabels': videohubGetOutputLabels,

  // Companion parity: lock/unlock
  'videohub.lockOutput': videohubLockOutput,
  'videohub.unlockOutput': videohubUnlockOutput,
  'videohub.getOutputLocks': videohubGetOutputLocks,

  // Companion parity: serial/processing/monitoring routing
  'videohub.setSerialRoute': videohubSetSerialRoute,
  'videohub.setProcessingRoute': videohubSetProcessingRoute,
  'videohub.setMonitoringRoute': videohubSetMonitoringRoute,

  // Companion parity: bulk route & route take
  'videohub.bulkRoute': videohubBulkRoute,
  'videohub.routeTake': videohubRouteTake,
};
