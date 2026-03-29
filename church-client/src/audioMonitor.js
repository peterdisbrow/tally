/**
 * Audio Monitor — Silence / Dropout Detection
 *
 * Monitors audio levels from ATEM or vMix during active streaming (OBS, vMix,
 * or any encoder). Alerts if audio stays below -40 dBFS for 15+ consecutive seconds.
 *
 * Audio sources (checked in priority order):
 *   1. ATEM master output (reads hardware audio meters)
 *   2. vMix master meters (meterF1/meterF2 from API)
 *   3. No source available → status reports "no audio monitoring source"
 *
 * Also monitors OBS stream congestion as a secondary audio health signal.
 *
 * Class: AudioMonitor
 *   start(agent)  — begin monitoring
 *   stop()        — stop monitoring
 *   tick()        — called every 2 seconds (exposed for testing)
 *   getStatus()   — returns current monitoring state for watchdog reporting
 */

const SILENCE_THRESHOLD_DB  = -40;        // dBFS: below this = silence
const SILENCE_DURATION_MS   = 15_000;     // 15 seconds of sustained silence = alert
const SILENCE_FAILOVER_MS   = 30_000;     // 30 seconds of silence = send signal_event for failover
const DEDUP_WINDOW_MS        = 5 * 60_000; // don't re-alert same issue within 5 min
const TICK_INTERVAL_MS       = 2_000;     // check every 2 seconds

class AudioMonitor {
  constructor() {
    this.agent = null;
    this._tickInterval = null;
    this._silenceStartTime = null;     // when silence was first detected
    this._lastAlertTimes  = new Map(); // alertKey → timestamp
    this._failoverSignalSent = false;  // prevent re-sending signal_event
    this._lastLevelDb = null;          // most recent audio level reading (dBFS)
    this._audioSource = null;          // which source is providing audio: 'atem', 'vmix', or null
  }

  /** Start monitoring. Must be called with the ChurchAVAgent instance. */
  start(agent) {
    if (this._tickInterval) return; // already running
    this.agent = agent;
    this._tickInterval = setInterval(() => {
      this.tick().catch(e => console.error('[AudioMonitor] tick error:', e.message));
    }, TICK_INTERVAL_MS);
    console.log('[AudioMonitor] Started (2s tick)');
  }

  /** Stop monitoring */
  stop() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    this.agent = null;
    this._silenceStartTime = null;
    this._failoverSignalSent = false;
    console.log('[AudioMonitor] Stopped');
  }

  /** Main check tick — called every 2 seconds */
  async tick() {
    if (!this.agent) return;
    const { status } = this.agent;

    // Monitor while ANY encoder is streaming (OBS, vMix, Blackmagic, etc.)
    const isStreaming = status.obs?.streaming || status.vmix?.streaming || status.encoder?.live;
    if (!isStreaming) {
      this._silenceStartTime = null; // reset silence timer when not streaming
      this._lastLevelDb = null;
      this._audioSource = null;
      return;
    }

    // Check audio sources in priority order: ATEM → vMix → no source
    let levelRead = false;

    // 1. ATEM master audio (most reliable — hardware meters)
    if (this.agent.atem && status.atem?.connected) {
      levelRead = this._checkATEMAudio();
    }

    // 2. vMix master meters (if no ATEM level was read)
    if (!levelRead && status.vmix?.connected) {
      levelRead = this._checkVMixAudio();
    }

    // 3. No audio source available
    if (!levelRead) {
      this._audioSource = null;
    }

    // Check OBS congestion (secondary signal, independent of audio source)
    if (status.obs?.connected) {
      await this._checkOBSAudio().catch(() => {});
    }
  }

  // ─── ATEM Audio Check ──────────────────────────────────────────────────────

  /** @returns {boolean} true if a level was successfully read */
  _checkATEMAudio() {
    const { agent } = this;
    if (!agent.atem || !agent.status.atem?.connected) return false;

    try {
      const state = agent.atem.state;
      if (!state?.audio) return false;

      const master = state.audio.master;
      if (!master) return false;

      let levelDb = null;

      if (master.inputLevel !== undefined) {
        levelDb = this._atemLevelToDb(master.inputLevel);
      } else if (master.outputLevel !== undefined) {
        levelDb = this._atemLevelToDb(master.outputLevel);
      } else if (master.left !== undefined) {
        const leftDb  = this._atemLevelToDb(master.left);
        const rightDb = this._atemLevelToDb(master.right ?? master.left);
        levelDb = Math.max(leftDb, rightDb);
      }

      if (levelDb === null) return false;

      this._lastLevelDb = levelDb;
      this._audioSource = 'atem';
      this._processSilenceDetection(levelDb, 'ATEM master output');
      return true;
    } catch (e) {
      return false;
    }
  }

  // ─── vMix Audio Check ───────────────────────────────────────────────────────

  /** @returns {boolean} true if a level was successfully read */
  _checkVMixAudio() {
    const { agent } = this;
    if (!agent.vmix || !agent.status.vmix?.connected) return false;

    try {
      // vMix caches state from getState() / getStatus() — audio is in _stateCache.audio
      const audio = agent.vmix._stateCache?.audio;
      if (!audio) return false;

      // vMix meterF1/meterF2 are linear 0.0–1.0 values
      const meterL = audio.meterL || 0;
      const meterR = audio.meterR || 0;
      const peak = Math.max(meterL, meterR);

      // Convert linear to dBFS: 20 * log10(value)
      const levelDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

      this._lastLevelDb = levelDb;
      this._audioSource = 'vmix';
      this._processSilenceDetection(levelDb, 'vMix master output');
      return true;
    } catch (e) {
      return false;
    }
  }

  // ─── Shared silence detection logic ─────────────────────────────────────────

  _processSilenceDetection(levelDb, sourceName) {
    if (levelDb < SILENCE_THRESHOLD_DB) {
      if (!this._silenceStartTime) {
        this._silenceStartTime = Date.now();
      } else {
        const silenceDuration = Date.now() - this._silenceStartTime;

        if (silenceDuration >= SILENCE_DURATION_MS) {
          this._sendAlert(
            'audio_silence',
            `Audio silence detected on ${sourceName} (${levelDb === -Infinity ? '-∞' : levelDb.toFixed(1)} dBFS for 15+ seconds). Check microphone and mixer.`
          );
        }

        if (silenceDuration >= SILENCE_FAILOVER_MS && !this._failoverSignalSent) {
          this._failoverSignalSent = true;
          if (this.agent) {
            this.agent.sendToRelay({
              type: 'signal_event',
              signal: 'audio_silence_sustained',
              durationSec: Math.floor(silenceDuration / 1000),
            });
          }
        }
      }
    } else {
      if (this._silenceStartTime && this._failoverSignalSent) {
        if (this.agent) {
          this.agent.sendToRelay({
            type: 'signal_event',
            signal: 'audio_silence_cleared',
          });
        }
      }
      this._silenceStartTime = null;
      this._failoverSignalSent = false;
    }
  }

  /**
   * Convert a raw ATEM audio level to dBFS.
   * ATEM firmware formats:
   *   • Negative (<= 0): already in dBFS * 1000 format → divide by 1000
   *   • Positive (> 0, <= 32768): normalized linear → 20 * log10(val / 32768)
   *   • 0: silence → -Infinity
   */
  _atemLevelToDb(raw) {
    if (raw === 0) return -Infinity;
    if (raw < 0)  return raw / 1000; // dBFS * 1000 format (e.g. -10000 = -10dB)
    if (raw <= 32768) return 20 * Math.log10(raw / 32768);
    if (raw <= 65535) return 20 * Math.log10(raw / 65535); // some firmware uses 0-65535
    return 0;
  }

  // ─── OBS Audio Check ───────────────────────────────────────────────────────

  async _checkOBSAudio() {
    const { agent } = this;
    if (!agent.obs || !agent.status.obs?.connected) return;

    try {
      const stats = await agent.obs.call('GetStats');
      // High output congestion → the encoder is struggling, possibly dropping audio frames
      if (typeof stats.outputCongestion === 'number' && stats.outputCongestion > 0.8) {
        this._sendAlert(
          'obs_stream_congestion',
          `OBS stream severely congested (${Math.round(stats.outputCongestion * 100)}%). Audio dropout possible — check CPU and network.`
        );
      }
    } catch {
      // Ignore — OBS may not be reachable right now
    }
  }

  // ─── Alert helper ─────────────────────────────────────────────────────────

  _sendAlert(alertKey, message) {
    const now = Date.now();
    const lastSent = this._lastAlertTimes.get(alertKey) || 0;
    if (now - lastSent < DEDUP_WINDOW_MS) return; // dedup

    this._lastAlertTimes.set(alertKey, now);
    this._silenceStartTime = null; // reset so it doesn't immediately re-fire

    console.log(`[AudioMonitor] 🔇 ${message}`);

    if (this.agent) {
      this.agent.sendToRelay({
        type: 'alert',
        alertType: 'audio_silence',
        message,
        severity: 'warning',
      });
    }
  }

  // ─── Status (for watchdog reporting) ─────────────────────────────────────

  getStatus() {
    const silenceDuration = this._silenceStartTime
      ? Math.floor((Date.now() - this._silenceStartTime) / 1000)
      : 0;

    return {
      monitoring: !!this._tickInterval,
      silenceDetected: this._silenceStartTime !== null,
      silenceDurationSec: silenceDuration,
      lastLevelDb: this._lastLevelDb,       // current audio level in dBFS (null if no source)
      source: this._audioSource,             // 'atem', 'vmix', or null
      lastAlerts: Object.fromEntries(
        [...this._lastAlertTimes.entries()].map(([k, v]) => [k, new Date(v).toISOString()])
      ),
    };
  }
}

module.exports = { AudioMonitor };
