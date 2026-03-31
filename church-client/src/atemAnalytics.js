/**
 * AtemAnalytics — Tracks ATEM input usage during a service session.
 *
 * Records which program inputs are used, how long each is on-air,
 * switch counts, and computes per-input and session-wide statistics.
 */

class AtemAnalytics {
  constructor(configuredInputs = [], switcherId = null) {
    // configuredInputs: array of { id, name } for all known inputs
    this._configuredInputs = configuredInputs;
    this._switcherId = switcherId; // optional — identifies which switcher this tracks
    this._tracking = false;
    this._sessionStart = null;
    this._sessionEnd = null;
    this._timeline = [];       // { inputId, inputName, timestamp }
    this._currentInput = null;  // { inputId, inputName, timestamp }
  }

  /**
   * Begin a new tracking session. Resets all accumulated data.
   */
  startTracking() {
    this._tracking = true;
    this._sessionStart = Date.now();
    this._sessionEnd = null;
    this._timeline = [];
    this._currentInput = null;
  }

  /**
   * Record a program input change.
   * @param {number|string} inputId   — ATEM input id (e.g. 1, 2, 1000)
   * @param {string}        inputName — human-readable label
   * @param {number}        [timestamp] — epoch ms, defaults to Date.now()
   */
  recordInputChange(inputId, inputName, timestamp) {
    if (!this._tracking) return;
    const ts = timestamp != null ? timestamp : Date.now();

    // Close the previous shot
    if (this._currentInput) {
      this._currentInput.endTime = ts;
      this._timeline.push({ ...this._currentInput });
    }

    this._currentInput = {
      inputId,
      inputName: inputName || `Input ${inputId}`,
      timestamp: ts,
      endTime: null,
    };
  }

  /**
   * End the current tracking session and finalise the last shot.
   */
  stopTracking() {
    if (!this._tracking) return;

    const now = Date.now();
    this._sessionEnd = now;
    this._tracking = false;

    // Close the last open shot
    if (this._currentInput) {
      this._currentInput.endTime = now;
      this._timeline.push({ ...this._currentInput });
      this._currentInput = null;
    }
  }

  /**
   * Return the chronological list of all switches with timestamps.
   * Each entry: { inputId, inputName, timestamp, endTime, duration }
   */
  getSwitchTimeline() {
    return this._timeline.map((entry) => ({
      inputId: entry.inputId,
      inputName: entry.inputName,
      timestamp: entry.timestamp,
      endTime: entry.endTime,
      duration: entry.endTime != null ? entry.endTime - entry.timestamp : null,
    }));
  }

  /**
   * Compute and return session statistics.
   */
  getSessionStats() {
    const timeline = this.getSwitchTimeline();

    const totalDuration =
      this._sessionStart != null && this._sessionEnd != null
        ? this._sessionEnd - this._sessionStart
        : 0;

    // Aggregate per-input
    const inputMap = new Map(); // inputId → { id, name, timeOnAir, switchCount, shots[] }

    for (const shot of timeline) {
      const dur = shot.duration || 0;
      if (!inputMap.has(shot.inputId)) {
        inputMap.set(shot.inputId, {
          id: shot.inputId,
          name: shot.inputName,
          timeOnAir: 0,
          switchCount: 0,
          shots: [],
        });
      }
      const rec = inputMap.get(shot.inputId);
      rec.timeOnAir += dur;
      rec.switchCount += 1;
      rec.shots.push(dur);
    }

    const totalSwitches = timeline.length;

    // Build inputs array
    const inputs = [];
    for (const rec of inputMap.values()) {
      inputs.push({
        id: rec.id,
        name: rec.name,
        timeOnAir: rec.timeOnAir,
        percentOfTotal: totalDuration > 0 ? Math.round((rec.timeOnAir / totalDuration) * 10000) / 100 : 0,
        switchCount: rec.switchCount,
      });
    }

    // Sort by timeOnAir descending
    inputs.sort((a, b) => b.timeOnAir - a.timeOnAir);

    // All shot durations
    const allDurations = timeline.map((s) => s.duration || 0);
    const avgShotDuration =
      allDurations.length > 0
        ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length)
        : 0;

    // Longest and shortest shots
    let longestShot = null;
    let shortestShot = null;

    if (timeline.length > 0) {
      let longestEntry = timeline[0];
      let shortestEntry = timeline[0];
      for (const shot of timeline) {
        const dur = shot.duration || 0;
        if (dur > (longestEntry.duration || 0)) longestEntry = shot;
        if (dur < (shortestEntry.duration || 0)) shortestEntry = shot;
      }
      longestShot = { input: longestEntry.inputId, duration: longestEntry.duration || 0 };
      shortestShot = { input: shortestEntry.inputId, duration: shortestEntry.duration || 0 };
    }

    // Unused inputs: configured but never switched to
    const usedIds = new Set(inputMap.keys());
    const unusedInputs = this._configuredInputs
      .filter((inp) => !usedIds.has(inp.id))
      .map((inp) => inp.id);

    return {
      switcherId: this._switcherId || undefined,
      totalDuration,
      inputs,
      totalSwitches,
      avgShotDuration,
      longestShot,
      shortestShot,
      unusedInputs,
    };
  }
}

/**
 * Manages AtemAnalytics instances across multiple switchers.
 * Falls back to a single default instance for legacy single-ATEM setups.
 */
class SwitcherAnalyticsManager {
  constructor() {
    this._instances = new Map(); // switcherId → AtemAnalytics
  }

  /**
   * Get or create an analytics instance for a switcher.
   * @param {string} switcherId
   * @param {Array} [configuredInputs]
   */
  getOrCreate(switcherId, configuredInputs = []) {
    if (!this._instances.has(switcherId)) {
      this._instances.set(switcherId, new AtemAnalytics(configuredInputs, switcherId));
    }
    return this._instances.get(switcherId);
  }

  /** Start tracking on all instances */
  startAll() {
    for (const inst of this._instances.values()) inst.startTracking();
  }

  /** Stop tracking on all instances */
  stopAll() {
    for (const inst of this._instances.values()) inst.stopTracking();
  }

  /** Get session stats for all switchers, keyed by switcherId */
  getAllStats() {
    const result = {};
    for (const [id, inst] of this._instances) {
      result[id] = inst.getSessionStats();
    }
    return result;
  }

  /** Get all switch timelines, keyed by switcherId */
  getAllTimelines() {
    const result = {};
    for (const [id, inst] of this._instances) {
      result[id] = inst.getSwitchTimeline();
    }
    return result;
  }
}

module.exports = { AtemAnalytics, SwitcherAnalyticsManager };
