/**
 * Failover command handlers — encoder-level failover between primary and backup.
 *
 * Dispatched by the relay's SignalFailover engine when the primary encoder fails
 * and the failover action is configured as "backup_encoder".
 *
 * Critical: only one encoder can stream to a CDN at a time (same stream key).
 * The backup streams until it fails or the TD manually switches back. We do NOT
 * reconnect the primary in the background — it would fight for CDN credentials.
 *
 * After failover, roles swap: the old primary becomes config.backupEncoder so
 * the system can fail over again if the new primary dies.
 */

const EncoderBridge = require('../encoderBridge');

/**
 * Switch from the primary encoder to the backup encoder.
 * Stops polling the primary, starts the backup, swaps roles so the old primary
 * becomes the new backup config, and begins monitoring backup availability.
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

  // Save the current primary config before overwriting
  const oldPrimaryCfg = agent.config.encoder;

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

  // ── Role swap: old primary becomes the new backup config ──
  agent.config.encoder = backupCfg;
  agent.config.backupEncoder = oldPrimaryCfg;

  // Restart polling at 3s to monitor the now-active encoder
  agent._startEncoderPoll(3_000);

  // Start monitoring the old primary (now backup) so TD knows when it's available
  agent._monitorBackupEncoder(oldPrimaryCfg);

  console.log(`[Failover] ✅ Switched from ${primaryType} to backup encoder (${backupType}) — roles swapped`);
  return `Switched to backup encoder (${backupType})`;
}

/**
 * Switch to the other encoder (the current backup).
 * Called when the TD triggers /recover, or when the current primary fails and
 * the backup is available. Swaps roles again so the cycle can repeat.
 */
async function failoverSwitchToPrimaryEncoder(agent) {
  const backupType = agent._backupEncoderType;

  // Stop polling
  if (agent._encoderPollTimer) {
    clearInterval(agent._encoderPollTimer);
    agent._encoderPollTimer = null;
  }

  // Stop monitoring the backup encoder availability
  if (agent._stopMonitoringBackupEncoder) {
    agent._stopMonitoringBackupEncoder();
  }

  // Stop the current active encoder
  if (backupType === 'atem-streaming') {
    try { await agent.atem.stopStreaming(); } catch { /* ignore */ }
  } else if (agent.encoderBridge) {
    try { await agent.encoderBridge.stopStream(); } catch { /* ignore */ }
    try { await agent.encoderBridge.disconnect(); } catch { /* ignore */ }
  }

  // The target is config.backupEncoder (the other encoder after role swap)
  const targetCfg = agent.config.backupEncoder;
  if (!targetCfg || !targetCfg.type) {
    throw new Error('No backup encoder config available for recovery');
  }

  const targetBridge = new EncoderBridge(targetCfg);
  if (targetCfg.type === 'obs' && agent.obs) {
    targetBridge.setObs(agent.obs);
  }

  const online = await targetBridge.connect();
  if (online) {
    try { await targetBridge.startStream(); } catch (e) {
      console.warn(`[Failover] Recovery encoder startStream: ${e.message}`);
    }
  }

  // ── Swap roles: target becomes primary, old active becomes backup ──
  const oldActiveCfg = agent.config.encoder;
  agent.config.encoder = targetCfg;
  agent.config.backupEncoder = oldActiveCfg;

  agent.encoderBridge = targetBridge;
  agent._backupEncoderActive = false;
  agent._backupEncoderType = null;

  // Resume polling at 3s (active stream)
  agent._startEncoderPoll(3_000);

  const targetType = targetCfg.type;
  console.log(`[Failover] ✅ Recovered to encoder (${targetType}) — roles swapped`);
  return `Recovered to encoder (${targetType})`;
}

module.exports = {
  'failover.switchToBackupEncoder': failoverSwitchToBackupEncoder,
  'failover.switchToPrimaryEncoder': failoverSwitchToPrimaryEncoder,
};
