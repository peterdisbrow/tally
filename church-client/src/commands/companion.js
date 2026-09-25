/**
 * Companion command handlers. Every result reflects what Companion actually answered
 * (see src/companion.js) — a press on an empty slot, an unknown variable, a disabled
 * HTTP API or an unreachable Companion throws with a plain-English reason.
 */

'use strict';

function bridge(agent) {
  if (!agent.companion) throw new Error('Companion not configured (set its address in the Equipment tab)');
  return agent.companion;
}

function where(r) { return `page ${r.page}, row ${r.row}, column ${r.col}`; }

async function companionPress(agent, { page, row, col, column } = {}) {
  const r = await bridge(agent).pressButton(page, row, col ?? column);   // the booth Commands tab sends "column"
  return `Companion button pressed: ${r.text ? `"${r.text}" (${where(r)})` : where(r)}`;
}

async function companionPressNamed(agent, { name } = {}) {
  const r = await bridge(agent).pressNamed(name);
  return `Companion button "${r.text || name}" pressed (${where(r)})`;
}

async function companionGetGrid(agent, { page } = {}) {
  return bridge(agent).getButtonGrid(page || 1);
}

async function companionConnections(agent) {
  const list = await bridge(agent).getConnections();
  if (list === null) return 'This Companion version does not report its connections (needs Companion 5 or newer)';
  return list;
}

async function companionGetVariable(agent, { connection, variable } = {}) {
  if (!connection || !variable) throw new Error('connection and variable are required');
  const value = await bridge(agent).getVariable(connection, variable);
  if (value === null) throw new Error(`Companion has no variable ${connection}:${variable}`);
  return { connection, variable, value };
}

async function companionGetCustomVariable(agent, { name } = {}) {
  if (!name) throw new Error('name is required');
  const value = await bridge(agent).getCustomVariable(name);
  if (value === null) throw new Error(`Companion has no custom variable "${name}"`);
  return { name, value };
}

async function companionSetCustomVariable(agent, { name, value } = {}) {
  const v = await bridge(agent).setCustomVariable(name, value);
  return `Companion custom variable "${name}" set to "${v}" (confirmed)`;
}

async function companionWatchVariable(agent, { connection, variable } = {}) {
  if (!connection || !variable) throw new Error('connection and variable are required');
  const c = bridge(agent);
  const value = await c.getVariable(connection, variable);
  if (value === null) throw new Error(`Companion has no variable ${connection}:${variable} — not watching`);
  c.watchVariable(connection, variable);
  return `Now watching ${connection}:${variable} (currently "${value}")`;
}

function companionGetWatchedVariables(agent) {
  return bridge(agent).getWatchedVariables();
}

module.exports = {
  'companion.press': companionPress,
  'companion.pressButton': companionPress,
  'companion.pressNamed': companionPressNamed,
  'companion.getGrid': companionGetGrid,
  'companion.connections': companionConnections,
  'companion.getVariable': companionGetVariable,
  'companion.getCustomVariable': companionGetCustomVariable,
  'companion.setCustomVariable': companionSetCustomVariable,
  'companion.watchVariable': companionWatchVariable,
  'companion.getWatchedVariables': companionGetWatchedVariables,
};
