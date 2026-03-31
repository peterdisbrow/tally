/**
 * SwitcherManager — Manages multiple switcher instances per agent.
 *
 * Handles:
 *   - Creating switcher instances from config (with auto-migration from legacy)
 *   - Lookup by ID, role, or type
 *   - Aggregated status for status_update messages
 *   - Dual-write to legacy status.atem / status.obs / status.vmix fields
 *   - Event forwarding (alerts, stateChanged) to the agent
 */

const { AtemSwitcher } = require('./switchers/atemSwitcher');
const { ObsSwitcher } = require('./switchers/obsSwitcher');
const { VmixSwitcher } = require('./switchers/vmixSwitcher');

class SwitcherManager {
  constructor(agent) {
    this.agent = agent;
    /** @type {Map<string, import('./switcher').Switcher>} */
    this._switchers = new Map();
  }

  // ─── Initialization ─────────────────────────────────────────────────────

  /**
   * Build the switchers list from config.  If config.switchers exists, use it.
   * Otherwise auto-migrate from legacy atemIp / obs / vmix fields.
   */
  buildFromConfig(config) {
    const entries = config.switchers && config.switchers.length > 0
      ? config.switchers
      : this._migrateFromLegacy(config);

    for (const entry of entries) {
      if (!entry.type || !entry.id) continue;
      this._createSwitcher(entry);
    }
  }

  /**
   * Connect all registered switchers.  Call after relay is connected.
   */
  async connectAll() {
    const promises = [];
    for (const sw of this._switchers.values()) {
      promises.push(this._connectWithSharing(sw));
    }
    await Promise.allSettled(promises);
  }

  /**
   * Disconnect and clean up all switchers.
   */
  async disconnectAll() {
    const promises = [];
    for (const sw of this._switchers.values()) {
      promises.push(sw.disconnect().catch(() => {}));
    }
    await Promise.allSettled(promises);
    this._switchers.clear();
  }

  // ─── Lookup ─────────────────────────────────────────────────────────────

  /** Get a switcher by ID. */
  get(id) { return this._switchers.get(id) || null; }

  /** Get the first switcher with the given role. */
  getByRole(role) {
    for (const sw of this._switchers.values()) {
      if (sw.role === role) return sw;
    }
    return null;
  }

  /** Get the primary switcher (first with role=primary, or first ATEM, or first overall). */
  getPrimary() {
    return this.getByRole('primary')
      || this.getFirstByType('atem')
      || (this._switchers.size > 0 ? this._switchers.values().next().value : null);
  }

  /** Get the first switcher of a given type. */
  getFirstByType(type) {
    for (const sw of this._switchers.values()) {
      if (sw.type === type) return sw;
    }
    return null;
  }

  /** Get all switchers of a given type. */
  getAllByType(type) {
    const result = [];
    for (const sw of this._switchers.values()) {
      if (sw.type === type) result.push(sw);
    }
    return result;
  }

  /** Iterate all switchers. */
  all() { return [...this._switchers.values()]; }

  /** Number of registered switchers. */
  get size() { return this._switchers.size; }

  // ─── Status ─────────────────────────────────────────────────────────────

  /**
   * Return the status.switchers object keyed by switcher ID.
   */
  getSwitchersStatus() {
    const result = {};
    for (const [id, sw] of this._switchers) {
      result[id] = sw.getStatus();
    }
    return result;
  }

  /**
   * Return merged tally from all switchers.
   * Format: { inputId: { switcherId, state: "program"|"preview" } }
   */
  getAggregateTally() {
    const tally = {};
    for (const [id, sw] of this._switchers) {
      const t = sw.getTally();
      for (const [input, state] of Object.entries(t)) {
        // Program takes priority over preview
        if (!tally[input] || state === 'program') {
          tally[input] = { switcherId: id, state };
        }
      }
    }
    return tally;
  }

  /**
   * Dual-write: sync the primary switcher's status back into the legacy
   * status.atem / status.obs / status.vmix fields.  This ensures backward
   * compatibility with all downstream consumers.
   *
   * Call this in sendStatus() before sending the payload.
   */
  syncLegacyStatus(status) {
    // ── ATEM legacy ──────────────────────────────────────────────────────
    const primaryAtem = this.getByRole('primary') && this.getByRole('primary').type === 'atem'
      ? this.getByRole('primary')
      : this.getFirstByType('atem');

    if (primaryAtem) {
      const s = primaryAtem.getStatus();
      status.atem.connected = s.connected;
      status.atem.ip = s.ip || status.atem.ip;
      status.atem.model = s.model;
      status.atem.modelCode = s.modelCode;
      status.atem.productIdentifier = s.productIdentifier;
      status.atem.protocolVersion = s.protocolVersion;
      status.atem.programInput = s.programInput;
      status.atem.previewInput = s.previewInput;
      status.atem.inTransition = s.inTransition;
      status.atem.recording = s.recording;
      status.atem.streaming = s.streaming;
      status.atem.streamingBitrate = s.streamingBitrate;
      status.atem.streamingCacheUsed = s.streamingCacheUsed;
      status.atem.streamingService = s.streamingService;
      status.atem.inputLabels = s.inputLabels;
      status.atem.inputSources = s.inputSources;
      status.atem.audioDelays = s.audioDelays;
      status.atem.atemAudioSources = s.atemAudioSources;
      status.atem.cameras = s.cameras;
      if (s.recordingDuration != null) status.atem.recordingDuration = s.recordingDuration;
      if (s.recordingTimeAvailable != null) status.atem.recordingTimeAvailable = s.recordingTimeAvailable;
      if (s.recordingError != null) status.atem.recordingError = s.recordingError;
    }

    // ── OBS legacy (only sync if the OBS switcher is different from the encoder OBS) ──
    const obsSwitch = this.getFirstByType('obs');
    if (obsSwitch) {
      const s = obsSwitch.getStatus();
      // Don't overwrite the encoder-managed obs status fields (bitrate, fps, cpuUsage).
      // Only sync the switcher-relevant fields.
      if (s.connected) status.obs.connected = true;
      // streaming/recording are encoder concerns — only set if no encoder manages them
      if (!this.agent._encoderManaged) {
        status.obs.streaming = s.streaming;
        status.obs.recording = s.recording;
      }
    }

    // ── vMix legacy ──────────────────────────────────────────────────────
    const vmixSwitch = this.getFirstByType('vmix');
    if (vmixSwitch) {
      const s = vmixSwitch.getStatus();
      status.vmix.connected = s.connected;
      status.vmix.streaming = s.streaming;
      status.vmix.recording = s.recording;
      status.vmix.edition = s.edition || status.vmix.edition;
      status.vmix.version = s.version || status.vmix.version;
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /**
   * Auto-migrate legacy config (atemIp, obsUrl, vmix) into switcher entries.
   * Returns an array of switcher config objects.
   */
  _migrateFromLegacy(config) {
    const entries = [];

    // Legacy ATEM
    if (config.atemIp) {
      entries.push({
        id: 'atem-1',
        type: 'atem',
        role: 'primary',
        name: 'ATEM Switcher',
        ip: config.atemIp,
      });
    }

    // Legacy OBS-as-switcher: only create a switcher entry if OBS is explicitly
    // configured as a switcher (via config.obsSwitcher flag) — otherwise it's
    // just an encoder.  For now, don't auto-migrate OBS as a switcher to avoid
    // changing existing behavior.

    // Legacy vMix-as-switcher: same caution as OBS.  vMix is configured as
    // a separate device.  We don't auto-promote it to switcher status from
    // legacy config — user must opt in via the new switchers config.

    return entries;
  }

  /**
   * Create a Switcher instance from a config entry and register it.
   */
  _createSwitcher(entry) {
    let sw;
    switch (entry.type) {
      case 'atem':
        sw = new AtemSwitcher({
          id: entry.id,
          role: entry.role,
          name: entry.name,
          ip: entry.ip,
        });
        break;
      case 'obs':
        sw = new ObsSwitcher({
          id: entry.id,
          role: entry.role,
          name: entry.name,
          url: entry.url,
          password: entry.password,
        });
        break;
      case 'vmix':
        sw = new VmixSwitcher({
          id: entry.id,
          role: entry.role,
          name: entry.name,
          host: entry.host,
          port: entry.port,
        });
        break;
      default:
        console.warn(`Unknown switcher type: ${entry.type}`);
        return;
    }

    // Wire up event forwarding
    sw.on('alert', (message, severity) => {
      this.agent.sendAlert(message, severity);
    });

    sw.on('stateChanged', () => {
      // Sync to legacy fields and send status
      this.syncLegacyStatus(this.agent.status);
      this.agent.sendStatus();
    });

    sw.on('connected', () => {
      this.agent.sendToRelay({ type: 'signal_event', signal: `${sw.type}_restored`, switcherId: sw.id });
      // For primary ATEM, also fire the legacy atem_restored signal
      if (sw.type === 'atem' && (sw.role === 'primary' || this.getAllByType('atem').length === 1)) {
        this.agent.sendToRelay({ type: 'signal_event', signal: 'atem_restored' });
      }
    });

    sw.on('disconnected', () => {
      this.agent.sendToRelay({ type: 'signal_event', signal: `${sw.type}_lost`, switcherId: sw.id });
      // For primary ATEM, also fire the legacy atem_lost signal
      if (sw.type === 'atem' && (sw.role === 'primary' || this.getAllByType('atem').length === 1)) {
        this.agent.sendToRelay({ type: 'signal_event', signal: 'atem_lost' });
      }
    });

    this._switchers.set(entry.id, sw);
    return sw;
  }

  /**
   * Connect a switcher, sharing connections with existing agent devices where possible.
   */
  async _connectWithSharing(sw) {
    try {
      // OBS: share the agent's existing obs-websocket-js connection if available
      if (sw.type === 'obs' && this.agent.obs && this.agent.status.obs?.connected) {
        sw.attachShared(this.agent.obs);
        return;
      }

      // vMix: share the agent's existing VMix instance if available
      if (sw.type === 'vmix' && this.agent.vmix) {
        sw.attachShared(this.agent.vmix);
        return;
      }

      await sw.connect();
    } catch (e) {
      console.warn(`⚠️  Failed to connect switcher ${sw.id}: ${e.message}`);
    }
  }
}

module.exports = { SwitcherManager };
