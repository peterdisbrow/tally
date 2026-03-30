const { toInt } = require('./helpers');
const path = require('path');
const fs = require('fs');

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

// ─── COMPANION PARITY: Select/Take Workflow ────────────────────────────

async function videohubSelectDestination(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const dest = toInt(params.destination, 'destination');
  hub.selectDestination(dest);
  const label = hub._outputLabels.get(dest) || `Output ${dest}`;
  return `Selected destination ${dest} (${label})`;
}

async function videohubRouteToSelected(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  if (hub._selectedDestination === null) throw new Error('No destination selected');
  const source = toInt(params.source, 'source');
  hub.queueSource(source);
  const srcLabel = hub._inputLabels.get(source) || `Input ${source}`;
  const dstLabel = hub._outputLabels.get(hub._selectedDestination) || `Output ${hub._selectedDestination}`;
  return `Queued source ${source} (${srcLabel}) → destination ${hub._selectedDestination} (${dstLabel}). Use videohub.take to execute.`;
}

async function videohubTake(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const dest = hub._selectedDestination;
  const src = hub._pendingSource;
  const ok = await hub.take();
  if (!ok) throw new Error('Video Hub did not acknowledge route take');
  return `Take executed: input ${src} → output ${dest}`;
}

async function videohubClearSelection(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  hub.clearSelection();
  return 'Selection cleared';
}

// ─── COMPANION PARITY: Route Intelligence ───────────────────────────────

async function videohubRouteRouted(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const fromOutput = toInt(params.fromOutput, 'fromOutput');
  const toOutput = toInt(params.toOutput, 'toOutput');
  const ok = await hub.routeRouted(fromOutput, toOutput);
  if (!ok) throw new Error('Video Hub did not acknowledge route change');
  const sourceInput = hub._routes.get(toOutput);
  const srcLabel = hub._inputLabels.get(sourceInput) || `Input ${sourceInput}`;
  return `Copied route from output ${fromOutput}: input ${sourceInput} (${srcLabel}) → output ${toOutput}`;
}

async function videohubRouteToPrevious(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const output = toInt(params.output, 'output');
  const ok = await hub.routeToPrevious(output);
  if (!ok) throw new Error('Video Hub did not acknowledge route revert');
  const currentInput = hub._routes.get(output);
  const srcLabel = hub._inputLabels.get(currentInput) || `Input ${currentInput}`;
  return `Output ${output} reverted to previous source: input ${currentInput} (${srcLabel})`;
}

// ─── COMPANION PARITY: Serial Port Management ──────────────────────────

async function videohubSetSerialLabel(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const index = toInt(params.index, 'index');
  const label = params.label;
  if (!label) throw new Error('label is required');
  const ok = await hub.setSerialLabel(index, label);
  if (!ok) throw new Error('Video Hub did not acknowledge serial label change');
  return `Serial port ${index} labeled "${label}"`;
}

async function videohubLockSerial(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const output = toInt(params.output, 'output');
  const state = params.state || 'O';
  if (!['O', 'L', 'U'].includes(state)) throw new Error('state must be O, L, or U');
  const ok = await hub.lockSerial(output, state);
  if (!ok) throw new Error('Video Hub did not acknowledge serial lock change');
  const stateNames = { O: 'locked (owned)', L: 'locked (other)', U: 'unlocked' };
  return `Serial port ${output} ${stateNames[state]}`;
}

async function videohubUnlockSerial(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const output = toInt(params.output, 'output');
  const ok = await hub.unlockSerial(output);
  if (!ok) throw new Error('Video Hub did not acknowledge serial unlock');
  return `Serial port ${output} unlocked`;
}

// ─── COMPANION PARITY: Route File Save/Load ────────────────────────────

function _getRouteFilePath(agent, name, roomId) {
  const baseDir = agent.dataDir || '/tmp/tallyconnect/videohub-routes';
  const dir = roomId ? path.join(baseDir, 'videohub-routes', roomId) : path.join(baseDir, 'videohub-routes');
  return { dir, filePath: path.join(dir, `${name}.json`) };
}

async function videohubSaveRouteFile(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const name = params.name;
  if (!name) throw new Error('name is required');

  const routes = {};
  for (const [output, input] of hub._routes) {
    routes[String(output)] = input;
  }
  const labels = {};
  for (const [index, label] of hub._outputLabels) {
    labels[String(index)] = label;
  }

  const data = {
    routes,
    labels,
    savedAt: new Date().toISOString(),
  };

  const { dir, filePath } = _getRouteFilePath(agent, name, params.roomId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return `Route file saved: ${filePath} (${Object.keys(routes).length} routes)`;
}

async function videohubLoadRouteFile(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const name = params.name;
  if (!name) throw new Error('name is required');

  const { filePath } = _getRouteFilePath(agent, name, params.roomId);
  if (!fs.existsSync(filePath)) throw new Error(`Route file not found: ${filePath}`);

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!data.routes || typeof data.routes !== 'object') throw new Error('Invalid route file format');

  const routes = Object.entries(data.routes).map(([output, input]) => ({
    output: parseInt(output),
    input: parseInt(input),
  }));

  if (routes.length === 0) throw new Error('Route file contains no routes');

  const ok = await hub.setBulkRoutes(routes);
  if (!ok) throw new Error('Video Hub did not acknowledge bulk route load');
  return `Route file loaded: ${filePath} (${routes.length} routes applied, saved ${data.savedAt})`;
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

  // Companion parity: select/take workflow
  'videohub.selectDestination': videohubSelectDestination,
  'videohub.routeToSelected': videohubRouteToSelected,
  'videohub.take': videohubTake,
  'videohub.clearSelection': videohubClearSelection,

  // Companion parity: route intelligence
  'videohub.routeRouted': videohubRouteRouted,
  'videohub.routeToPrevious': videohubRouteToPrevious,

  // Companion parity: serial port management
  'videohub.setSerialLabel': videohubSetSerialLabel,
  'videohub.lockSerial': videohubLockSerial,
  'videohub.unlockSerial': videohubUnlockSerial,

  // Companion parity: route file save/load
  'videohub.saveRouteFile': videohubSaveRouteFile,
  'videohub.loadRouteFile': videohubLoadRouteFile,
};
