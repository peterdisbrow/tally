/**
 * Stream Protection command handlers.
 */

async function streamProtectionEnable(agent) {
  if (!agent.streamProtection) throw new Error('Stream protection not available');
  agent.streamProtection.setEnabled(true);
  return 'Stream protection enabled';
}

async function streamProtectionDisable(agent) {
  if (!agent.streamProtection) throw new Error('Stream protection not available');
  agent.streamProtection.setEnabled(false);
  return 'Stream protection disabled';
}

async function streamProtectionStatus(agent) {
  if (!agent.streamProtection) throw new Error('Stream protection not available');
  return agent.streamProtection.status;
}

async function streamProtectionRestart(agent) {
  if (!agent.streamProtection) throw new Error('Stream protection not available');
  agent.streamProtection.manualRestart();
  return 'Stream restart initiated';
}

module.exports = {
  'streamProtection.enable': streamProtectionEnable,
  'streamProtection.disable': streamProtectionDisable,
  'streamProtection.status': streamProtectionStatus,
  'streamProtection.restart': streamProtectionRestart,
};
