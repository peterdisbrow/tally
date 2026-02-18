/**
 * Audio Monitor — Silence / Dropout Detection
 *
 * Monitors ATEM master output audio during active OBS streaming.
 * Alerts if master output level stays below -40 dBFS for 15+ consecutive seconds.
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
const DEDUP_WINDOW_MS        = 5 * 60_000; // don't re-alert same issue within 5 min
const TICK_INTERVAL_MS       = 2_000;     // check every 2 seconds

class AudioMonitor {
  constructor() {
    this.agent = null;
    this._tickInterval = null;
    this._silenceStartTime = null;     // when silence was first detected
    this._lastAlertTimes  = new Map(); // alertKey → timestamp
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
    console.log('[AudioMonitor] Stopped');
  }

  /** Main check tick — called every 2 seconds */
  async tick() {
    if (!this.agent) return;
    const { status } = this.agent;

    // Only monitor while OBS is streaming
    if (!status.obs?.streaming) {
      this._silenceStartTime = null; // reset silence timer when not streaming
      return;
    }

    // Check ATEM master audio
    this._checkATEMAudio();

    // Check OBS congestion (secondary signal)
    await this._checkOBSAudio().catch(() => {});
  }

  // ─── ATEM Audio Check ──────────────────────────────────────────────────────

  _checkATEMAudio() {
    const { agent } = this;
    if (!agent.atem || !agent.status.atem?.connected) return;

    try {
      const state = agent.atem.state;
      if (!state?.audio) return;

      const master = state.audio.master;
      if (!master) return;

      // ATEM exposes audio levels in two formats depending on firmware:
      //   Format A: dBFS * 1000 (e.g. -40000 = -40dB, range -10000 to 0)
      //   Format B: normalized linear 0–32768 (classic ATEM)
      let levelDb = null;

      if (master.inputLevel !== undefined) {
        levelDb = this._atemLevelToDb(master.inputLevel);
      } else if (master.outputLevel !== undefined) {
        levelDb = this._atemLevelToDb(master.outputLevel);
      } else if (master.left !== undefined) {
        // Some firmware exposes left/right channels separately
        const leftDb  = this._atemLevelToDb(master.left);
        const rightDb = this._atemLevelToDb(master.right ?? master.left);
        levelDb = Math.max(leftDb, rightDb); // use louder channel
      }

      if (levelDb === null) return;

      if (levelDb < SILENCE_THRESHOLD_DB) {
        // Audio below threshold — start or continue silence timer
        if (!this._silenceStartTime) {
          this._silenceStartTime = Date.now();
        } else if (Date.now() - this._silenceStartTime >= SILENCE_DURATION_MS) {
          this._sendAlert(
            'atem_audio_silence',
            `Audio silence detected on ATEM master output (${levelDb.toFixed(1)} dBFS for 15+ seconds). Check microphone and mixer.`
          );
        }
      } else {
        // Audio present — reset silence timer
        this._silenceStartTime = null;
      }
    } catch (e) {
      // ATEM state is not always available; safe to ignore
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
      lastAlerts: Object.fromEntries(
        [...this._lastAlertTimes.entries()].map(([k, v]) => [k, new Date(v).toISOString()])
      ),
    };
  }
}

module.exports = { AudioMonitor };
