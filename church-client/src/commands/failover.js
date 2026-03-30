/**
 * Failover command handlers — encoder-level failover between primary and backup.
 *
 * Dispatched by the relay's SignalFailover engine when the primary encoder fails
 * and the failover action is configured as "backup_encoder".
 *
 * Critical: only one encoder can stream to a CDN at a time (same stream key).
 * The backup streams until it fails or the TD manually switches back. We do NOT
 * reconnect the primary in the background — it would fight for CDN credentials.
 */

const EncoderBridge = require('../encoderBridge');

/**
 * Switch from the primary encoder to the backup encoder.
 * Stops polling the primary, starts the backup, and begins monitoring it.
 */
async function failoverSwitchToBackupEncoder(agent) {
  const backupCfg = agent.config.backupEncoder;
  if (!backupCfg || !backupCfg.type) {
    throw new Error('No backup encoder configured');
  }

  const primaryType = agent.status.encoder?.type || agent.config.encoder?.type || 'primary';
  const backupType = backupCfg.type;

  // Stop polling the primary encoder
  if (agent._encoderPollTimer) {
    clearInterval(agent._encoderPollTimer);
    agent._encoderPollTimer = null;
  }

  // Disconnect primary encoder bridge (don't try to restart it)
  if (agent.encoderBridge) {
    try { await agent.encoderBridge.disconnect(); } catch { /* ignore */ }
  }

  // Store primary config for later recovery
  agent._primaryEncoderBridge = agent.encoderBridge;
  agent._primaryEncoderConfig = agent.config.encoder;

  if (backupType === 'atem-streaming') {
    // ATEM built-in streaming — no separate bridge needed
    if (!agent.atem) throw new Error('ATEM not connected — cannot start backup streaming');
    await agent.atem.startStreaming();
    agent.encoderBridge = null;
    agent._backupEncoderType = 'atem-streaming';
  } else {
    // Hardware/software backup encoder — create a new bridge
    const backupBridge = new EncoderBridge(backupCfg);
    if (backupCfg.type === 'obs' && agent.obs) {
      backupBridge.setObs(agent.obs);
    }
    const online = await backupBridge.connect();
    if (!online) {
      throw new Error(`Backup encoder (${backupType}) failed to connect`);
    }
    try { await backupBridge.startStream(); } catch (e) {
      // Some encoder types don't support remote start — that's OK if it's already streaming
      console.warn(`[Failover] Backup encoder startStream: ${e.message}`);
    }
    agent.encoderBridge = backupBridge;
    agent._backupEncoderType = backupType;
  }

  agent._backupEncoderActive = true;

  // Restart polling at 3s to monitor backup encoder health
  agent._startEncoderPoll(3_000);

  console.log(`[Failover] ✅ Switched from ${primaryType} to backup encoder (${backupType})`);
  return `Switched to backup encoder (${backupType})`;
}

/**
 * Switch back from the backup encoder to the primary encoder.
 * Called when the backup fails or the TD manually triggers recovery.
 */
async function failoverSwitchToPrimaryEncoder(agent) {
  const backupType = agent._backupEncoderType;

  // Stop polling
  if (agent._encoderPollTimer) {
    clearInterval(agent._encoderPollTimer);
    agent._encoderPollTimer = null;
  }

  // Stop backup encoder
  if (backupType === 'atem-streaming') {
    try { await agent.atem.stopStreaming(); } catch { /* ignore */ }
  } else if (agent.encoderBridge) {
    try { await agent.encoderBridge.stopStream(); } catch { /* ignore */ }
    try { await agent.encoderBridge.disconnect(); } catch { /* ignore */ }
  }

  // Recreate primary encoder bridge from saved config
  const primaryCfg = agent._primaryEncoderConfig || agent.config.encoder;
  if (!primaryCfg || !primaryCfg.type) {
    throw new Error('No primary encoder config available for recovery');
  }

  const primaryBridge = new EncoderBridge(primaryCfg);
  if (primaryCfg.type === 'obs' && agent.obs) {
    primaryBridge.setObs(agent.obs);
  }

  const online = await primaryBridge.connect();
  if (online) {
    try { await primaryBridge.startStream(); } catch (e) {
      console.warn(`[Failover] Primary encoder startStream: ${e.message}`);
    }
  }

  agent.encoderBridge = primaryBridge;
  agent._backupEncoderActive = false;
  agent._backupEncoderType = null;
  agent._primaryEncoderBridge = null;
  agent._primaryEncoderConfig = null;

  // Resume polling at 3s (active stream)
  agent._startEncoderPoll(3_000);

  const primaryType = primaryCfg.type;
  console.log(`[Failover] ✅ Switched back to primary encoder (${primaryType})`);
  return `Switched back to primary encoder (${primaryType})`;
}

module.exports = {
  'failover.switchToBackupEncoder': failoverSwitchToBackupEncoder,
  'failover.switchToPrimaryEncoder': failoverSwitchToPrimaryEncoder,
};
