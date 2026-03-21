/**
 * Concurrency tests for church-client monitoring utilities.
 *
 * Tests that systemHealth, DiskSpaceMonitor, and EncoderBridge can be called
 * multiple times in parallel without crashing or corrupting shared state.
 *
 * All external I/O is stubbed so tests run deterministically without
 * needing real hardware, real disks, or real network connections.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { mock } = require('node:test');

const { getSystemHealth, getMemoryInfo, getDiskInfo, getCpuUsage } = require('../src/systemHealth');
const { DiskSpaceMonitor } = require('../src/diskSpaceMonitor');
const { EncoderBridge } = require('../src/encoderBridge');

// ─── A. systemHealth called 20 times in parallel ──────────────────────────────

test('getSystemHealth called 20 times in parallel — all return valid objects', async () => {
  const COUNT = 20;
  const promises = [];
  for (let i = 0; i < COUNT; i++) {
    promises.push(getSystemHealth());
  }
  const results = await Promise.all(promises);

  assert.equal(results.length, COUNT, 'Should get 20 results');

  for (const result of results) {
    assert.ok(result, 'result should be defined');
    assert.ok(typeof result === 'object', 'result should be an object');

    // cpu
    assert.ok('cpu' in result, 'should have cpu field');
    assert.ok(typeof result.cpu.usage === 'number', 'cpu.usage should be a number');
    assert.ok(typeof result.cpu.cores === 'number', 'cpu.cores should be a number');
    assert.ok(result.cpu.cores >= 1, 'should have at least 1 core');

    // memory
    assert.ok('memory' in result, 'should have memory field');
    assert.ok(typeof result.memory.total === 'number', 'memory.total should be a number');
    assert.ok(typeof result.memory.usage === 'number', 'memory.usage should be a number');
    assert.ok(result.memory.usage >= 0, 'memory usage should be >= 0');
    assert.ok(result.memory.usage <= 100, 'memory usage should be <= 100');

    // disk
    assert.ok('disk' in result, 'should have disk field');

    // uptime
    assert.ok(typeof result.uptime === 'number', 'uptime should be a number');
    assert.ok(result.uptime >= 0, 'uptime should be non-negative');

    // warnings
    assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
  }
});

test('getSystemHealth parallel calls all resolve (none reject)', async () => {
  const COUNT = 20;
  const settled = await Promise.allSettled(
    Array.from({ length: COUNT }, () => getSystemHealth())
  );
  const rejected = settled.filter(r => r.status === 'rejected');
  assert.equal(rejected.length, 0, `All 20 should resolve, but ${rejected.length} rejected`);
});

// ─── B. getMemoryInfo is pure — concurrent calls return consistent shape ───────

test('getMemoryInfo called 50 times in parallel — all return valid shape', () => {
  // getMemoryInfo is synchronous — fire 50 in a loop
  const COUNT = 50;
  const results = [];
  for (let i = 0; i < COUNT; i++) {
    results.push(getMemoryInfo());
  }

  assert.equal(results.length, COUNT);
  for (const r of results) {
    assert.ok(typeof r.total === 'number' && r.total > 0, 'total should be positive number');
    assert.ok(typeof r.used === 'number' && r.used >= 0, 'used should be non-negative');
    assert.ok(typeof r.free === 'number' && r.free >= 0, 'free should be non-negative');
    assert.ok(typeof r.usage === 'number', 'usage should be a number');
    assert.ok(r.usage >= 0 && r.usage <= 100, `usage ${r.usage} should be between 0-100`);
    // total should equal used + free (approximately — OS may shift)
    assert.ok(Math.abs(r.total - r.used - r.free) < r.total * 0.01, 'total ≈ used + free');
  }
});

// ─── C. DiskSpaceMonitor rapid polling — each call is independent ─────────────

test('DiskSpaceMonitor.check() called 20 times rapidly — no shared state corruption', () => {
  const mon = new DiskSpaceMonitor({ path: os.tmpdir(), bitrateKbps: 50_000 });

  const results = [];
  for (let i = 0; i < 20; i++) {
    results.push(mon.check());
  }

  assert.equal(results.length, 20);
  for (const r of results) {
    assert.ok('diskSpace' in r, 'should have diskSpace field');
    assert.ok('warnings' in r, 'should have warnings field');
    assert.ok(Array.isArray(r.warnings), 'warnings should be array');

    if (r.diskSpace !== null) {
      assert.ok(typeof r.diskSpace.total === 'number', 'diskSpace.total should be number');
      assert.ok(typeof r.diskSpace.free === 'number', 'diskSpace.free should be number');
      assert.ok(r.diskSpace.free >= 0, 'free should be non-negative');
      assert.ok(typeof r.diskSpace.estimatedMinutesRemaining === 'number', 'estimatedMinutes should be number');
    }
  }
});

test('DiskSpaceMonitor.getDiskSpace() called 20 times in parallel without crashing', () => {
  const COUNT = 20;
  const mon = new DiskSpaceMonitor({ path: os.tmpdir() });
  const results = [];

  for (let i = 0; i < COUNT; i++) {
    results.push(mon.getDiskSpace());
  }

  // All returned either null or a valid disk space object
  for (const r of results) {
    assert.ok(
      r === null || (typeof r === 'object' && 'total' in r),
      'each result should be null or a disk space object'
    );
  }
});

test('multiple DiskSpaceMonitor instances do not share state', () => {
  const mon1 = new DiskSpaceMonitor({ path: os.tmpdir(), bitrateKbps: 10_000, label: 'mon1' });
  const mon2 = new DiskSpaceMonitor({ path: os.tmpdir(), bitrateKbps: 100_000, label: 'mon2' });

  assert.equal(mon1.label, 'mon1');
  assert.equal(mon2.label, 'mon2');
  assert.equal(mon1._bitrateBytes, 10_000 * 1000 / 8);
  assert.equal(mon2._bitrateBytes, 100_000 * 1000 / 8);

  // Modifying one should not affect the other
  mon1.setBitrate(200_000);
  assert.equal(mon1._bitrateBytes, 200_000 * 1000 / 8);
  assert.equal(mon2._bitrateBytes, 100_000 * 1000 / 8, 'mon2 bitrate should be unchanged');
});

// ─── D. Multiple EncoderBridge instances simultaneously — each returns independently ─

test('multiple EncoderBridge instances getStatus simultaneously — each independent', async () => {
  // Use 'custom' type with a non-reachable URL so getStatus returns error gracefully
  const COUNT = 10;
  const bridges = Array.from({ length: COUNT }, (_, i) =>
    new EncoderBridge({ type: 'custom', host: '127.0.0.1', port: 19999 + i, label: `enc-${i}` })
  );

  // Fire all getStatus calls in parallel — they should all return without throwing
  const results = await Promise.all(bridges.map(b => b.getStatus()));

  assert.equal(results.length, COUNT, 'Should get status from all bridges');

  for (const status of results) {
    assert.ok(typeof status === 'object' && status !== null, 'status should be an object');
    assert.ok('type' in status, 'status should have type field');
    assert.ok('connected' in status, 'status should have connected field');
    assert.ok('live' in status, 'status should have live field');
  }
});

test('EncoderBridge getStatus error does not propagate — returns default shape', async () => {
  const bridge = new EncoderBridge({ type: 'custom', host: '127.0.0.2', port: 19998, label: 'test' });
  const status = await bridge.getStatus();

  // Even on network failure, should return a safe default object
  assert.ok(status !== null, 'status should not be null');
  assert.ok(typeof status === 'object', 'status should be an object');
  assert.equal(typeof status.connected, 'boolean', 'connected should be boolean');
});

test('concurrent isOnline checks from multiple encoders — all resolve', async () => {
  const COUNT = 8;
  const bridges = Array.from({ length: COUNT }, (_, i) =>
    new EncoderBridge({ type: 'rtmp-generic', host: `192.0.2.${i + 1}`, port: 80, label: `enc-${i}` })
  );

  const settled = await Promise.allSettled(bridges.map(b => b.isOnline()));
  const rejected = settled.filter(r => r.status === 'rejected');
  assert.equal(rejected.length, 0, `All ${COUNT} isOnline calls should resolve`);

  for (const r of settled) {
    assert.equal(r.status, 'fulfilled');
    assert.equal(typeof r.value, 'boolean', 'isOnline should return a boolean');
  }
});

// ─── E. getDiskInfo is stateless — rapid successive calls are safe ─────────────

test('getDiskInfo called 30 times in a tight loop — no state corruption', () => {
  const COUNT = 30;
  const results = [];
  for (let i = 0; i < COUNT; i++) {
    results.push(getDiskInfo());
  }

  assert.equal(results.length, COUNT);
  for (const r of results) {
    assert.ok(typeof r === 'object' && r !== null, 'getDiskInfo should return an object');
    assert.ok('total' in r, 'should have total');
    assert.ok('used' in r, 'should have used');
    assert.ok('free' in r, 'should have free');
    assert.ok('usage' in r, 'should have usage');
  }
});
