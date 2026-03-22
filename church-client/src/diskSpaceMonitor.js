/**
 * diskSpaceMonitor.js — Monitor disk space for local recording directories
 *
 * For use with OBS, vMix, or any software that records to a local path.
 * Checks available disk space and generates warnings when recording time
 * is running low.
 *
 * Usage:
 *   const monitor = new DiskSpaceMonitor({ path: '/Volumes/Recordings', bitrateKbps: 50000 });
 *   const status = monitor.check();
 *   // status.diskSpace  => { total, used, free, percentUsed, estimatedMinutesRemaining }
 *   // status.warnings   => [{ type, message }]
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

/** Warning thresholds (in minutes of estimated recording time remaining) */
const THRESHOLD_LOW_MINUTES = 120;
const THRESHOLD_CRITICAL_MINUTES = 30;
const THRESHOLD_FULL_MINUTES = 5;
const THRESHOLD_FULL_PERCENT = 95;

class DiskSpaceMonitor {
  /**
   * @param {object} opts
   * @param {string} opts.path - Directory path to monitor (e.g., OBS recording output folder)
   * @param {number} [opts.bitrateKbps=50000] - Recording bitrate in kilobits/sec (default 50 Mbps)
   * @param {string} [opts.label] - Human-readable label for this path
   */
  constructor({ path: dirPath, bitrateKbps = 50_000, label } = {}) {
    this.dirPath = String(dirPath || '').trim();
    this.label = String(label || this.dirPath || 'Recording disk');
    /** Recording bitrate in bytes per second */
    this._bitrateBytes = Math.max(1, (Number(bitrateKbps) || 50_000) * 1000 / 8);
  }

  /**
   * Set the recording bitrate.
   * @param {number} bitrateKbps - Bitrate in kilobits per second
   */
  setBitrate(bitrateKbps) {
    this._bitrateBytes = Math.max(1, (Number(bitrateKbps) || 50_000) * 1000 / 8);
  }

  /**
   * Get disk space info for the configured path.
   * Returns { total, used, free, percentUsed, estimatedMinutesRemaining } (bytes)
   * or null if the path is invalid / not accessible.
   */
  getDiskSpace() {
    if (!this.dirPath) return null;

    // Resolve the path to check — use the directory itself or nearest existing parent
    let checkPath = path.resolve(this.dirPath);
    try {
      // Walk up until we find an existing directory (for paths not yet created)
      while (!fs.existsSync(checkPath)) {
        const parent = path.dirname(checkPath);
        if (parent === checkPath) return null; // reached root with nothing found
        checkPath = parent;
      }
    } catch {
      return null;
    }

    try {
      if (process.platform === 'win32') {
        // Get the drive letter from the resolved path
        const drive = checkPath.match(/^([A-Za-z]):/);
        const driveLetter = drive ? drive[1].toUpperCase() + ':' : 'C:';
        const raw = child_process.execSync(
          `wmic logicaldisk where "DeviceID='${driveLetter}'" get Size,FreeSpace /format:csv`,
          { encoding: 'utf8', timeout: 5000 }
        );
        const lines = raw.trim().split('\n').filter(l => l.trim());
        const parts = lines[lines.length - 1].split(',');
        const free = parseInt(parts[1], 10);
        const total = parseInt(parts[2], 10);
        const used = total - free;
        const percentUsed = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
        const estimatedMinutesRemaining = Math.round((free / this._bitrateBytes) / 60 * 10) / 10;
        return { total, used, free, percentUsed, estimatedMinutesRemaining };
      } else {
        const raw = child_process.execSync(`df -k "${checkPath}"`, { encoding: 'utf8', timeout: 5000 });
        const lines = raw.trim().split('\n');
        if (lines.length < 2) return null;
        const parts = lines[1].split(/\s+/);
        const total = parseInt(parts[1], 10) * 1024;
        const used = parseInt(parts[2], 10) * 1024;
        const free = parseInt(parts[3], 10) * 1024;
        const percentUsed = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
        const estimatedMinutesRemaining = Math.round((free / this._bitrateBytes) / 60 * 10) / 10;
        return { total, used, free, percentUsed, estimatedMinutesRemaining };
      }
    } catch {
      return null;
    }
  }

  /**
   * Get warnings based on current disk space.
   * @param {object|null} diskSpace - Disk space info (or null to query fresh)
   * @returns {{ type: string, message: string }[]}
   */
  getWarnings(diskSpace) {
    const ds = diskSpace || this.getDiskSpace();
    if (!ds) return [];

    const warnings = [];
    const mins = ds.estimatedMinutesRemaining;

    if ((mins !== null && mins < THRESHOLD_FULL_MINUTES) || ds.percentUsed > THRESHOLD_FULL_PERCENT) {
      warnings.push({
        type: 'recording_disk_full',
        message: `"${this.label}" disk nearly full: ${ds.percentUsed}% used, ~${mins} min remaining`,
      });
    } else if (mins !== null && mins < THRESHOLD_CRITICAL_MINUTES) {
      warnings.push({
        type: 'recording_disk_critical',
        message: `"${this.label}" disk critical: ~${mins} min recording time remaining`,
      });
    } else if (mins !== null && mins < THRESHOLD_LOW_MINUTES) {
      warnings.push({
        type: 'recording_disk_low',
        message: `"${this.label}" disk low: ~${mins} min recording time remaining`,
      });
    }

    return warnings;
  }

  /**
   * Full check: returns diskSpace info and any warnings.
   */
  check() {
    const diskSpace = this.getDiskSpace();
    const warnings = this.getWarnings(diskSpace);
    return { diskSpace, warnings };
  }
}

module.exports = {
  DiskSpaceMonitor,
  THRESHOLD_LOW_MINUTES,
  THRESHOLD_CRITICAL_MINUTES,
  THRESHOLD_FULL_MINUTES,
  THRESHOLD_FULL_PERCENT,
};
