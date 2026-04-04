import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { VersionConfig, compareVersions, DEFAULT_MIN_VERSIONS } from '../src/versionConfig.js';

// ─── compareVersions — pure function ─────────────────────────────────────────

describe('compareVersions()', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.0', '1.0')).toBe(0);
    expect(compareVersions('30.0.0', '30.0.0')).toBe(0);
  });

  it('returns -1 when a < b', () => {
    expect(compareVersions('1.0', '2.0')).toBe(-1);
    expect(compareVersions('29.9', '30.0')).toBe(-1);
    expect(compareVersions('4.0', '4.1')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareVersions('2.0', '1.0')).toBe(1);
    expect(compareVersions('30.1', '30.0')).toBe(1);
    expect(compareVersions('7.16', '7.14')).toBe(1);
  });

  it('handles unequal version part counts (treats missing parts as 0)', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);  // 1.0 = 1.0.0
    expect(compareVersions('1', '1.0')).toBe(0);       // 1 = 1.0
    expect(compareVersions('1.0.1', '1.0')).toBe(1);  // 1.0.1 > 1.0
  });

  it('returns null when either argument is null', () => {
    expect(compareVersions(null, '1.0')).toBe(null);
    expect(compareVersions('1.0', null)).toBe(null);
  });

  it('returns null when either argument is undefined', () => {
    expect(compareVersions(undefined, '1.0')).toBe(null);
    expect(compareVersions('1.0', undefined)).toBe(null);
  });

  it('returns null for empty string arguments', () => {
    expect(compareVersions('', '1.0')).toBe(null);
    expect(compareVersions('1.0', '')).toBe(null);
  });

  it('returns null when version contains no digits (all non-numeric)', () => {
    // After stripping leading non-digits, cleanA/cleanB becomes '' → null
    expect(compareVersions('abc', '1.0')).toBe(null);
    expect(compareVersions('1.0', 'xyz')).toBe(null);
  });

  it('handles multi-level patch versions', () => {
    expect(compareVersions('4.24.1', '4.24.0')).toBe(1);
    expect(compareVersions('4.23.9', '4.24.0')).toBe(-1);
  });

  it('handles single-segment versions', () => {
    expect(compareVersions('7', '6')).toBe(1);
    expect(compareVersions('5', '6')).toBe(-1);
    expect(compareVersions('6', '6')).toBe(0);
  });
});

// ─── DEFAULT_MIN_VERSIONS — sanity checks ─────────────────────────────────────

describe('DEFAULT_MIN_VERSIONS', () => {
  it('contains known device types', () => {
    expect(DEFAULT_MIN_VERSIONS).toHaveProperty('obs');
    expect(DEFAULT_MIN_VERSIONS).toHaveProperty('proPresenter');
    expect(DEFAULT_MIN_VERSIONS).toHaveProperty('vmix');
    expect(DEFAULT_MIN_VERSIONS).toHaveProperty('mixer_behringer');
  });

  it('all values are non-empty version strings', () => {
    for (const [type, version] of Object.entries(DEFAULT_MIN_VERSIONS)) {
      expect(typeof version).toBe('string');
      expect(version.length).toBeGreaterThan(0);
      expect(/^\d+(\.\d+)*$/.test(version)).toBe(true);
    }
  });
});

// ─── VersionConfig class ────────────────────────────────────────────────────

describe('VersionConfig', () => {
  let db;
  let vc;

  beforeEach(() => {
    db = new Database(':memory:');
    vc = new VersionConfig(db);
  });

  describe('constructor / _ensureTable()', () => {
    it('creates the version_requirements table', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='version_requirements'"
      ).all();
      expect(tables.length).toBe(1);
    });

    it('can be constructed multiple times without error (CREATE IF NOT EXISTS)', () => {
      expect(() => new VersionConfig(db)).not.toThrow();
    });
  });

  describe('getMinVersion()', () => {
    it('returns hardcoded default when no DB override', () => {
      const min = vc.getMinVersion('obs');
      expect(min).toBe(DEFAULT_MIN_VERSIONS.obs);
    });

    it('returns DB override when one is set', () => {
      vc.setMinVersion('obs', '31.0');
      expect(vc.getMinVersion('obs')).toBe('31.0');
    });

    it('returns null for unknown device type', () => {
      expect(vc.getMinVersion('unknown_device_xyz')).toBe(null);
    });

    it('DB override takes precedence over default', () => {
      vc.setMinVersion('proPresenter', '7.99');
      expect(vc.getMinVersion('proPresenter')).toBe('7.99');
      expect(vc.getMinVersion('proPresenter')).not.toBe(DEFAULT_MIN_VERSIONS.proPresenter);
    });
  });

  describe('setMinVersion()', () => {
    it('inserts a new device type', () => {
      vc.setMinVersion('custom_device', '5.0');
      expect(vc.getMinVersion('custom_device')).toBe('5.0');
    });

    it('updates an existing device type (upsert)', () => {
      vc.setMinVersion('obs', '31.0');
      vc.setMinVersion('obs', '32.0'); // update
      expect(vc.getMinVersion('obs')).toBe('32.0');
    });

    it('stores updated_at as ISO string', () => {
      vc.setMinVersion('obs', '31.0');
      const row = db.prepare('SELECT updated_at FROM version_requirements WHERE device_type = ?').get('obs');
      expect(row).toBeDefined();
      // Should be a valid ISO date string
      const date = new Date(row.updated_at);
      expect(isNaN(date.getTime())).toBe(false);
    });
  });

  describe('getAllRequirements()', () => {
    it('returns all defaults when no overrides are set', () => {
      const all = vc.getAllRequirements();
      for (const [type, version] of Object.entries(DEFAULT_MIN_VERSIONS)) {
        expect(all[type]).toBe(version);
      }
    });

    it('merges DB overrides over defaults', () => {
      vc.setMinVersion('obs', '99.0');
      vc.setMinVersion('custom_device', '1.0');
      const all = vc.getAllRequirements();
      expect(all.obs).toBe('99.0');
      expect(all.custom_device).toBe('1.0');
      // Other defaults unchanged
      expect(all.proPresenter).toBe(DEFAULT_MIN_VERSIONS.proPresenter);
    });

    it('returns an object with at least all default keys', () => {
      const all = vc.getAllRequirements();
      for (const key of Object.keys(DEFAULT_MIN_VERSIONS)) {
        expect(all).toHaveProperty(key);
      }
    });
  });

  describe('checkVersion()', () => {
    it('returns checked:false when no minimum exists for device', () => {
      const result = vc.checkVersion('unknown_device_xyz', '1.0');
      expect(result).toEqual({ checked: false });
    });

    it('returns checked:false when currentVersion is null', () => {
      const result = vc.checkVersion('obs', null);
      expect(result).toEqual({ checked: false });
    });

    it('returns checked:false when currentVersion is empty string', () => {
      const result = vc.checkVersion('obs', '');
      expect(result).toEqual({ checked: false });
    });

    it('returns meetsRequirement:true when current >= minimum', () => {
      const result = vc.checkVersion('obs', '30.0');  // exactly meets minimum
      expect(result.checked).toBe(true);
      expect(result.meetsRequirement).toBe(true);
      expect(result.outdated).toBe(false);
    });

    it('returns meetsRequirement:true when current > minimum', () => {
      const result = vc.checkVersion('obs', '31.0');
      expect(result.checked).toBe(true);
      expect(result.meetsRequirement).toBe(true);
      expect(result.outdated).toBe(false);
    });

    it('returns outdated:true when current < minimum', () => {
      const result = vc.checkVersion('obs', '29.9');
      expect(result.checked).toBe(true);
      expect(result.outdated).toBe(true);
      expect(result.meetsRequirement).toBe(false);
    });

    it('includes current and minimum in result', () => {
      const result = vc.checkVersion('obs', '30.0');
      expect(result.current).toBe('30.0');
      expect(result.minimum).toBe(DEFAULT_MIN_VERSIONS.obs);
    });

    it('respects DB override minimum when checking', () => {
      vc.setMinVersion('obs', '35.0');
      const result = vc.checkVersion('obs', '30.0'); // below new minimum
      expect(result.outdated).toBe(true);
      expect(result.minimum).toBe('35.0');
    });

    it('returns checked:false when currentVersion has no digits (compareVersions returns null)', () => {
      // 'abc' → compareVersions returns null → line 91 branch
      const result = vc.checkVersion('obs', 'abc');
      expect(result).toEqual({ checked: false });
    });

    it('coerces currentVersion to string in result', () => {
      // Even if passed as number, result.current should be a string
      const result = vc.checkVersion('obs', 30);
      if (result.checked) {
        expect(typeof result.current).toBe('string');
      }
    });
  });
});
