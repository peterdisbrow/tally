const test = require('node:test');
const assert = require('node:assert/strict');

const { HyperDeck } = require('../src/hyperdeck');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Simulate a HyperDeck slot info response block being received,
 * bypassing the network layer.
 */
function injectSlotInfo(deck, totalBytes, freeBytes) {
  const block = {
    code: 202,
    title: 'slot info',
    fields: {
      'slot id': '1',
      'status': 'mounted',
      'volume name': 'TestDisk',
      'volume total': String(totalBytes),
      'volume free': String(freeBytes),
    },
    lines: [],
  };
  deck._applyBlock(block);
}

// ─── CONSTRUCTOR DEFAULTS ─────────────────────────────────────────────────────

test('HyperDeck initialises with null diskSpace', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  assert.equal(deck._status.diskSpace, null);
  const status = deck.getStatus();
  assert.equal(status.diskSpace, null);
  assert.deepEqual(status.diskWarnings, []);
});

// ─── DISK SPACE PARSING ──────────────────────────────────────────────────────

test('_applyBlock parses slot info and populates diskSpace', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  const total = 500_000_000_000; // 500 GB
  const free  = 200_000_000_000; // 200 GB
  injectSlotInfo(deck, total, free);

  const ds = deck._status.diskSpace;
  assert.ok(ds, 'diskSpace should be set');
  assert.equal(ds.total, total);
  assert.equal(ds.free, free);
  assert.equal(ds.used, total - free);
  assert.equal(ds.percentUsed, Math.round(((total - free) / total) * 1000) / 10);
  assert.equal(typeof ds.estimatedMinutesRemaining, 'number');
  assert.ok(ds.estimatedMinutesRemaining > 0, 'should have positive estimated minutes');
});

test('diskSpace appears in getStatus()', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  injectSlotInfo(deck, 1_000_000_000, 500_000_000);
  const status = deck.getStatus();
  assert.ok(status.diskSpace, 'status should include diskSpace');
  assert.equal(status.diskSpace.total, 1_000_000_000);
  assert.equal(status.diskSpace.free, 500_000_000);
});

// ─── ESTIMATED RECORDING TIME ────────────────────────────────────────────────

test('estimatedMinutesRemaining is calculated from default bitrate', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  // Default bitrate: 50 Mbps => 6,250,000 bytes/sec
  const freeBytes = 6_250_000 * 60 * 10; // exactly 10 minutes of recording
  injectSlotInfo(deck, freeBytes * 2, freeBytes);
  assert.equal(deck._status.diskSpace.estimatedMinutesRemaining, 10);
});

test('setRecordingBitrate changes estimated time', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  // Set to 100 Mbps => 12,500,000 bytes/sec
  deck.setRecordingBitrate(100_000_000);
  const freeBytes = 12_500_000 * 60 * 10; // exactly 10 min at 100 Mbps
  injectSlotInfo(deck, freeBytes * 2, freeBytes);
  assert.equal(deck._status.diskSpace.estimatedMinutesRemaining, 10);
});

// ─── DISK WARNINGS ───────────────────────────────────────────────────────────

test('no warnings when plenty of space', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  // 500 GB free at 50 Mbps => thousands of minutes
  injectSlotInfo(deck, 1_000_000_000_000, 500_000_000_000);
  const warnings = deck.getDiskWarnings();
  assert.equal(warnings.length, 0);
  assert.deepEqual(deck.getStatus().diskWarnings, []);
});

test('recording_disk_low when < 2 hours remaining', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  // 50 Mbps = 6,250,000 bytes/sec. 90 min => 90*60*6250000 = 33,750,000,000
  const freeBytes = 90 * 60 * 6_250_000;
  injectSlotInfo(deck, freeBytes * 10, freeBytes);
  const warnings = deck.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_low');
});

test('recording_disk_critical when < 30 min remaining', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  // 20 min at default bitrate
  const freeBytes = 20 * 60 * 6_250_000;
  injectSlotInfo(deck, freeBytes * 10, freeBytes);
  const warnings = deck.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_critical');
});

test('recording_disk_full when < 5 min remaining', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  // 3 min at default bitrate
  const freeBytes = 3 * 60 * 6_250_000;
  injectSlotInfo(deck, freeBytes * 10, freeBytes);
  const warnings = deck.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_full');
});

test('recording_disk_full when > 95% used', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  const total = 1_000_000_000_000;
  const free  = 40_000_000_000; // 4% free => 96% used
  injectSlotInfo(deck, total, free);
  const warnings = deck.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_full');
});

test('no warnings when diskSpace is null', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  assert.deepEqual(deck.getDiskWarnings(), []);
});

// ─── STATUS INTEGRATION ──────────────────────────────────────────────────────

test('getStatus includes diskWarnings array', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  // Critical level
  const freeBytes = 15 * 60 * 6_250_000;
  injectSlotInfo(deck, freeBytes * 10, freeBytes);
  const status = deck.getStatus();
  assert.ok(Array.isArray(status.diskWarnings));
  assert.equal(status.diskWarnings.length, 1);
  assert.equal(status.diskWarnings[0].type, 'recording_disk_critical');
});

// ─── BLOCK PARSING EDGE CASES ────────────────────────────────────────────────

test('_applyBlock ignores slot info with missing volume fields', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  deck._applyBlock({
    code: 202,
    title: 'slot info',
    fields: { 'slot id': '1', 'status': 'empty' },
    lines: [],
  });
  assert.equal(deck._status.diskSpace, null);
});

test('slot info does not interfere with transport info', () => {
  const deck = new HyperDeck({ host: '192.168.1.100' });
  // Apply transport info
  deck._applyBlock({
    code: 208,
    title: 'transport info',
    fields: { status: 'record', 'clip id': '5', 'slot id': '1' },
    lines: [],
  });
  assert.equal(deck._status.recording, true);
  assert.equal(deck._status.clipId, 5);

  // Apply slot info — should not change transport fields
  injectSlotInfo(deck, 1_000_000, 500_000);
  assert.equal(deck._status.recording, true);
  assert.equal(deck._status.clipId, 5);
  assert.ok(deck._status.diskSpace);
});
