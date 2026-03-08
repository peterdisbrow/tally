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

module.exports = {
  'videohub.route': videohubRoute,
  'videohub.getRoutes': videohubGetRoutes,
  'videohub.setInputLabel': videohubSetInputLabel,
  'videohub.setOutputLabel': videohubSetOutputLabel,
  'videohub.getInputLabels': videohubGetInputLabels,
  'videohub.getOutputLabels': videohubGetOutputLabels,
};
