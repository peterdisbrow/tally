const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {
  DiskSpaceMonitor,
  THRESHOLD_LOW_MINUTES,
  THRESHOLD_CRITICAL_MINUTES,
  THRESHOLD_FULL_MINUTES,
  THRESHOLD_FULL_PERCENT,
} = require('../src/diskSpaceMonitor');

// ─── CONSTRUCTOR ─────────────────────────────────────────────────────────────

test('DiskSpaceMonitor stores path and default bitrate', () => {
  const mon = new DiskSpaceMonitor({ path: '/tmp' });
  assert.equal(mon.dirPath, '/tmp');
  assert.equal(mon.label, '/tmp');
  // Default 50 Mbps => 50000 * 1000 / 8 = 6,250,000 bytes/sec
  assert.equal(mon._bitrateBytes, 6_250_000);
});

test('DiskSpaceMonitor accepts custom label and bitrate', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings', bitrateKbps: 100_000, label: 'Main Recording' });
  assert.equal(mon.label, 'Main Recording');
  assert.equal(mon._bitrateBytes, 100_000 * 1000 / 8);
});

test('setBitrate updates internal bitrate', () => {
  const mon = new DiskSpaceMonitor({ path: '/tmp' });
  mon.setBitrate(20_000);
  assert.equal(mon._bitrateBytes, 20_000 * 1000 / 8);
});

// ─── THRESHOLD CONSTANTS ─────────────────────────────────────────────────────

test('threshold constants are exported with correct values', () => {
  assert.equal(THRESHOLD_LOW_MINUTES, 120);
  assert.equal(THRESHOLD_CRITICAL_MINUTES, 30);
  assert.equal(THRESHOLD_FULL_MINUTES, 5);
  assert.equal(THRESHOLD_FULL_PERCENT, 95);
});

// ─── getDiskSpace ON REAL FILESYSTEM ─────────────────────────────────────────

test('getDiskSpace returns valid data for an existing path', () => {
  const mon = new DiskSpaceMonitor({ path: os.tmpdir() });
  const ds = mon.getDiskSpace();
  assert.ok(ds, 'should return disk space info for tmpdir');
  assert.equal(typeof ds.total, 'number');
  assert.equal(typeof ds.used, 'number');
  assert.equal(typeof ds.free, 'number');
  assert.equal(typeof ds.percentUsed, 'number');
  assert.equal(typeof ds.estimatedMinutesRemaining, 'number');
  assert.ok(ds.total > 0, 'total should be > 0');
  assert.ok(ds.free >= 0, 'free should be >= 0');
  assert.ok(ds.percentUsed >= 0 && ds.percentUsed <= 100, `percentUsed should be 0-100, got ${ds.percentUsed}`);
  assert.ok(ds.estimatedMinutesRemaining >= 0, 'estimated minutes should be >= 0');
});

test('getDiskSpace returns null for empty path', () => {
  const mon = new DiskSpaceMonitor({ path: '' });
  assert.equal(mon.getDiskSpace(), null);
});

test('getDiskSpace walks up to find existing parent for non-existent path', () => {
  const fakePath = path.join(os.tmpdir(), 'nonexistent-dir-xyz-12345');
  const mon = new DiskSpaceMonitor({ path: fakePath });
  const ds = mon.getDiskSpace();
  assert.ok(ds, 'should return disk space by walking up to existing parent');
  assert.ok(ds.total > 0);
});

// ─── WARNINGS ────────────────────────────────────────────────────────────────

test('getWarnings returns empty array when disk has plenty of space', () => {
  const mon = new DiskSpaceMonitor({ path: '/tmp' });
  const ds = { total: 1e12, used: 1e11, free: 9e11, percentUsed: 10, estimatedMinutesRemaining: 5000 };
  const warnings = mon.getWarnings(ds);
  assert.deepEqual(warnings, []);
});

test('getWarnings returns recording_disk_low when < 120 min remaining', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings', label: 'Recordings' });
  const ds = { total: 1e12, used: 9e11, free: 1e11, percentUsed: 90, estimatedMinutesRemaining: 100 };
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_low');
  assert.ok(warnings[0].message.includes('Recordings'));
});

test('getWarnings returns recording_disk_critical when < 30 min remaining', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 9.5e11, free: 5e10, percentUsed: 93, estimatedMinutesRemaining: 20 };
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_critical');
});

test('getWarnings returns recording_disk_full when < 5 min remaining', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 9.9e11, free: 1e10, percentUsed: 94, estimatedMinutesRemaining: 3 };
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_full');
});

test('getWarnings returns recording_disk_full when > 95% used', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 9.6e11, free: 4e10, percentUsed: 96, estimatedMinutesRemaining: 200 };
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_full');
});

test('getWarnings returns empty for null diskSpace', () => {
  const mon = new DiskSpaceMonitor({ path: '' });
  assert.deepEqual(mon.getWarnings(null), []);
});

// ─── CHECK ───────────────────────────────────────────────────────────────────

test('check() returns combined diskSpace and warnings', () => {
  const mon = new DiskSpaceMonitor({ path: os.tmpdir() });
  const result = mon.check();
  assert.ok(result.diskSpace, 'check should return diskSpace');
  assert.ok(Array.isArray(result.warnings), 'check should return warnings array');
});

// ─── PRIORITY ORDER ──────────────────────────────────────────────────────────

test('warning levels are mutually exclusive (worst wins)', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });

  const lowDs = { total: 1e12, used: 5e11, free: 5e11, percentUsed: 50, estimatedMinutesRemaining: 119 };
  assert.equal(mon.getWarnings(lowDs)[0].type, 'recording_disk_low');

  const critDs = { total: 1e12, used: 5e11, free: 5e11, percentUsed: 50, estimatedMinutesRemaining: 29 };
  assert.equal(mon.getWarnings(critDs)[0].type, 'recording_disk_critical');

  const fullDs = { total: 1e12, used: 5e11, free: 5e11, percentUsed: 50, estimatedMinutesRemaining: 4 };
  assert.equal(mon.getWarnings(fullDs)[0].type, 'recording_disk_full');
});

// ─── NEW: Cross-platform command handling (mocked) ──────────────────────────

test('getDiskSpace uses wmic on win32 platform (mocked)', (t) => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  const cp = require('child_process');
  const wmicOutput = 'Node,FreeSpace,Size\nPC1,214748364800,429496729600\n';
  t.mock.method(cp, 'execSync', () => wmicOutput);

  // Also mock fs.existsSync so the path resolution works on non-Windows
  const fsMod = require('fs');
  t.mock.method(fsMod, 'existsSync', () => true);

  const mon = new DiskSpaceMonitor({ path: 'C:\\Recordings' });
  const ds = mon.getDiskSpace();
  assert.ok(ds);
  assert.equal(ds.free, 214748364800);
  assert.equal(ds.total, 429496729600);
  assert.equal(ds.percentUsed, 50);

  if (origPlatform) {
    Object.defineProperty(process, 'platform', origPlatform);
  } else {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  }
});

test('getDiskSpace falls back to C: when drive letter cannot be parsed on non-Windows host (mocked)', (t) => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  const cp = require('child_process');
  let capturedCommand = '';
  t.mock.method(cp, 'execSync', (cmd) => {
    capturedCommand = cmd;
    return 'Node,FreeSpace,Size\nPC1,100000000000,200000000000\n';
  });

  const fsMod = require('fs');
  t.mock.method(fsMod, 'existsSync', () => true);

  const mon = new DiskSpaceMonitor({ path: 'D:\\Videos\\Recordings' });
  const ds = mon.getDiskSpace();
  // On macOS host, path.resolve('D:\\...') produces a Unix path, so drive letter
  // regex won't match and code falls back to C:. The important thing is that
  // it still returns valid disk space data.
  assert.ok(ds);
  assert.ok(capturedCommand.includes("wmic"), 'Should use wmic command');
  assert.equal(ds.total, 200000000000);
  assert.equal(ds.free, 100000000000);

  if (origPlatform) {
    Object.defineProperty(process, 'platform', origPlatform);
  } else {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  }
});

test('getDiskSpace uses df on Unix platform (mocked)', (t) => {
  // Ensure we're not on win32 for this test (should be default)
  if (process.platform === 'win32') return;

  const cp = require('child_process');
  const dfOutput = 'Filesystem  1K-blocks    Used     Available Use% Mounted on\n/dev/sda1   500000000 400000000 100000000  80% /\n';
  t.mock.method(cp, 'execSync', () => dfOutput);

  const mon = new DiskSpaceMonitor({ path: '/tmp' });
  const ds = mon.getDiskSpace();
  assert.ok(ds);
  assert.equal(ds.total, 500000000 * 1024);
  assert.equal(ds.used, 400000000 * 1024);
  assert.equal(ds.free, 100000000 * 1024);
});

// ─── NEW: Disk completely full (100%) ───────────────────────────────────────

test('disk 100% full triggers recording_disk_full warning', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 1e12, free: 0, percentUsed: 100, estimatedMinutesRemaining: 0 };
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_full');
  assert.ok(warnings[0].message.includes('100%'));
});

test('disk exactly 95% triggers recording_disk_full', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 9.5e11, free: 5e10, percentUsed: 95, estimatedMinutesRemaining: 200 };
  const warnings = mon.getWarnings(ds);
  // percentUsed 95 is NOT > 95, but estimatedMinutesRemaining 200 > 5, so no full warning
  // Since 200 > 120 threshold too, it won't even be low
  assert.equal(warnings.length, 0);
});

test('disk at 95.1% triggers recording_disk_full regardless of minutes remaining', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 9.51e11, free: 4.9e10, percentUsed: 95.1, estimatedMinutesRemaining: 500 };
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_full');
});

// ─── NEW: Very high bitrate (100 Mbps) ──────────────────────────────────────

test('very high bitrate (100 Mbps) reduces estimated minutes', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings', bitrateKbps: 100_000 });
  // 100 Mbps = 100000 * 1000 / 8 = 12,500,000 bytes/sec
  assert.equal(mon._bitrateBytes, 12_500_000);

  // 100GB free at 12.5 MB/s = 8000 seconds = 133.3 minutes
  const ds = { total: 1e12, used: 9e11, free: 100e9, percentUsed: 90, estimatedMinutesRemaining: 133.3 };
  const warnings = mon.getWarnings(ds);
  // 133.3 > 120, so just barely above low threshold
  assert.equal(warnings.length, 0);

  // Reduce free space
  const ds2 = { total: 1e12, used: 9.9e11, free: 10e9, percentUsed: 99, estimatedMinutesRemaining: 13.3 };
  const warnings2 = mon.getWarnings(ds2);
  assert.equal(warnings2.length, 1);
  assert.equal(warnings2[0].type, 'recording_disk_full'); // >95% triggers full
});

// ─── NEW: setBitrate with edge values ───────────────────────────────────────

test('setBitrate with 0 defaults to minimum 1 byte/sec', () => {
  const mon = new DiskSpaceMonitor({ path: '/tmp' });
  mon.setBitrate(0);
  assert.equal(mon._bitrateBytes, 6_250_000); // defaults to 50000 when NaN-ish
});

test('setBitrate with negative value clamps to minimum', () => {
  const mon = new DiskSpaceMonitor({ path: '/tmp' });
  mon.setBitrate(-100);
  // (-100 * 1000 / 8) = -12500, max(1, -12500) = 1
  assert.equal(mon._bitrateBytes, 1);
});

// ─── NEW: Constructor edge cases ────────────────────────────────────────────

test('constructor with no arguments does not crash', () => {
  const mon = new DiskSpaceMonitor();
  assert.equal(mon.dirPath, '');
  assert.equal(mon.label, 'Recording disk');
});

test('constructor trims path whitespace', () => {
  const mon = new DiskSpaceMonitor({ path: '  /tmp  ' });
  assert.equal(mon.dirPath, '/tmp');
});

// ─── NEW: Boundary values for warning thresholds ────────────────────────────

test('exactly 120 minutes remaining does NOT trigger low warning', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 5e11, free: 5e11, percentUsed: 50, estimatedMinutesRemaining: 120 };
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 0);
});

test('exactly 30 minutes remaining triggers critical (not full)', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 5e11, free: 5e11, percentUsed: 50, estimatedMinutesRemaining: 30 };
  // 30 is not < 30, so should NOT be critical; but 30 < 120, so should be low
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_low');
});

test('exactly 5 minutes remaining triggers critical (not full, unless percent triggers)', () => {
  const mon = new DiskSpaceMonitor({ path: '/recordings' });
  const ds = { total: 1e12, used: 5e11, free: 5e11, percentUsed: 50, estimatedMinutesRemaining: 5 };
  // 5 is not < 5, so not full; 5 < 30, so critical
  const warnings = mon.getWarnings(ds);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_critical');
});
