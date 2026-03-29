/**
 * Version Configuration and Comparison
 *
 * Centralized minimum recommended versions for all monitored device types.
 * Defaults are hardcoded; per-deployment overrides live in a DB table.
 */

const DEFAULT_MIN_VERSIONS = {
  obs:              '30.0',
  proPresenter:     '7.14',
  vmix:             '27.0',
  atem_protocol:    '2.30',
  encoder_birddog:  '6.0',
  encoder_teradek:  '4.0',
  encoder_epiphan:  '4.24',
  mixer_behringer:  '4.0',
};

/**
 * Compare two dot-separated version strings.
 * Strips leading non-numeric text (e.g. "ProPresenter 21.3" → "21.3", "v7.14" → "7.14").
 * @returns -1 if a < b, 0 if equal, 1 if a > b, or null if either is invalid.
 */
function compareVersions(a, b) {
  if (!a || !b) return null;
  // Strip everything before the first digit (handles "ProPresenter 21.3", "v7.14", etc.)
  const cleanA = String(a).replace(/^[^\d]*/, '');
  const cleanB = String(b).replace(/^[^\d]*/, '');
  if (!cleanA || !cleanB) return null;
  const pa = cleanA.split('.').map(Number);
  const pb = cleanB.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

class VersionConfig {
  constructor(db) {
    this.db = db;
    this._ensureTable();
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS version_requirements (
        device_type TEXT PRIMARY KEY,
        min_version TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `);
  }

  /** Return the minimum version for a device type (DB override → hardcoded default). */
  getMinVersion(deviceType) {
    const row = this.db.prepare(
      'SELECT min_version FROM version_requirements WHERE device_type = ?',
    ).get(deviceType);
    return row?.min_version || DEFAULT_MIN_VERSIONS[deviceType] || null;
  }

  /** Override the minimum version for a device type. */
  setMinVersion(deviceType, version) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO version_requirements (device_type, min_version, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(device_type) DO UPDATE SET min_version = ?, updated_at = ?
    `).run(deviceType, version, now, version, now);
  }

  /** Return all minimums (DB overrides merged over defaults). */
  getAllRequirements() {
    const rows = this.db.prepare('SELECT * FROM version_requirements').all();
    const result = { ...DEFAULT_MIN_VERSIONS };
    for (const row of rows) result[row.device_type] = row.min_version;
    return result;
  }

  /**
   * Check a device's current version against the configured minimum.
   * @returns { checked, current, minimum, outdated, meetsRequirement }
   */
  checkVersion(deviceType, currentVersion) {
    const min = this.getMinVersion(deviceType);
    if (!min || !currentVersion) return { checked: false };
    const cmp = compareVersions(currentVersion, min);
    if (cmp === null) return { checked: false };
    return {
      checked: true,
      current: String(currentVersion),
      minimum: min,
      outdated: cmp < 0,
      meetsRequirement: cmp >= 0,
    };
  }
}

module.exports = { VersionConfig, compareVersions, DEFAULT_MIN_VERSIONS };
