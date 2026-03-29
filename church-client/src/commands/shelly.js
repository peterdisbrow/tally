/**
 * Command handlers for Shelly smart plugs.
 *
 * Commands:
 *   shelly.turnOn       { plugId }          → Turn plug on
 *   shelly.turnOff      { plugId }          → Turn plug off
 *   shelly.toggle       { plugId }          → Toggle plug state
 *   shelly.powerCycle   { plugId, delayMs } → Power cycle (off → wait → on)
 *   shelly.status       {}                  → List all plugs with status
 */

async function shellyTurnOn(agent, params) {
  if (!agent.shellyManager) throw new Error('Smart plugs not configured');
  const plugId = params.plugId || params.ip;
  if (!plugId) throw new Error('plugId required');
  await agent.shellyManager.turnOn(plugId);
  const plug = agent.shellyManager.getPlug(plugId);
  return `${plug?.name || plugId} turned ON`;
}

async function shellyTurnOff(agent, params) {
  if (!agent.shellyManager) throw new Error('Smart plugs not configured');
  const plugId = params.plugId || params.ip;
  if (!plugId) throw new Error('plugId required');
  await agent.shellyManager.turnOff(plugId);
  const plug = agent.shellyManager.getPlug(plugId);
  return `${plug?.name || plugId} turned OFF`;
}

async function shellyToggle(agent, params) {
  if (!agent.shellyManager) throw new Error('Smart plugs not configured');
  const plugId = params.plugId || params.ip;
  if (!plugId) throw new Error('plugId required');
  const newState = await agent.shellyManager.togglePlug(plugId);
  const plug = agent.shellyManager.getPlug(plugId);
  return `${plug?.name || plugId} turned ${newState ? 'ON' : 'OFF'}`;
}

async function shellyPowerCycle(agent, params) {
  if (!agent.shellyManager) throw new Error('Smart plugs not configured');
  const plugId = params.plugId || params.ip;
  if (!plugId) throw new Error('plugId required');
  const delayMs = Number(params.delayMs) || 5000;
  const plug = agent.shellyManager.getPlug(plugId);
  const name = plug?.name || plugId;
  agent.sendAlert(`🔌 Power cycling ${name} (${delayMs / 1000}s delay)`, 'info');
  await agent.shellyManager.powerCycle(plugId, delayMs);
  return `${name} power cycled (${delayMs / 1000}s delay)`;
}

async function shellyStatus(agent) {
  if (!agent.shellyManager) throw new Error('Smart plugs not configured');
  const plugs = agent.shellyManager.toStatus();
  if (plugs.length === 0) return '🔌 No smart plugs discovered';
  const lines = plugs.map(p => {
    const state = p.connected ? (p.powerOn ? '🟢 ON' : '🔴 OFF') : '⚪ Offline';
    const watts = p.powerWatts != null ? ` (${p.powerWatts}W)` : '';
    return `${p.name}: ${state}${watts}`;
  });
  return `🔌 Smart Plugs:\n${lines.join('\n')}`;
}

module.exports = {
  'shelly.turnOn': shellyTurnOn,
  'shelly.turnOff': shellyTurnOff,
  'shelly.toggle': shellyToggle,
  'shelly.powerCycle': shellyPowerCycle,
  'shelly.status': shellyStatus,
};
