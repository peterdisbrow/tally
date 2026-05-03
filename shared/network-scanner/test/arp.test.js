/**
 * arp.test.js — ARP cache parsing and OUI vendor lookup
 *
 * `arp -a` output varies subtly across macOS, Linux distributions, and even
 * BSD versions. Parser regressions silently drop devices from scan results,
 * so these tests pin parsing for the exact output formats we've observed in
 * the wild.
 *
 * MAC normalization matters: macOS prints shortened bytes like `4:17:b6:...`
 * which would miss every OUI lookup if not zero-padded.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArpOutput, lookupVendor, normalizeMac, OUI_VENDORS } = require('../arp');

// ─── normalizeMac() ──────────────────────────────────────────────────────────

test('normalizeMac zero-pads short macOS bytes', () => {
  // macOS arp output: shortened bytes (no leading zero)
  assert.equal(normalizeMac('4:17:b6:4a:d6:e5'), '04:17:B6:4A:D6:E5');
});

test('normalizeMac uppercases hex and accepts hyphens', () => {
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
});

test('normalizeMac preserves already-normalized form', () => {
  assert.equal(normalizeMac('7C:2E:0D:11:22:33'), '7C:2E:0D:11:22:33');
});

test('normalizeMac returns null for falsy input', () => {
  assert.equal(normalizeMac(null), null);
  assert.equal(normalizeMac(''), null);
  assert.equal(normalizeMac(undefined), null);
});

// ─── lookupVendor() ──────────────────────────────────────────────────────────

test('lookupVendor finds Blackmagic from full MAC', () => {
  assert.equal(lookupVendor('7C:2E:0D:11:22:33'), 'Blackmagic Design');
});

test('lookupVendor handles macOS short-byte form', () => {
  // Without normalization, '4:17:b6:...' would never match the '04:17:B6'
  // OUI prefix. This regression-tested the MAC-normalization fix.
  // (B8:27:EB is Raspberry Pi — common for Companion appliances.)
  assert.equal(lookupVendor('b8:27:eb:01:02:03'), 'Raspberry Pi');
});

test('lookupVendor returns null for unknown OUI', () => {
  assert.equal(lookupVendor('FF:FF:FF:00:00:00'), null);
});

test('lookupVendor returns null for null/empty input', () => {
  assert.equal(lookupVendor(null), null);
  assert.equal(lookupVendor(''), null);
});

test('Every OUI_VENDORS prefix is a 3-byte uppercase MAC', () => {
  for (const prefix of Object.keys(OUI_VENDORS)) {
    assert.ok(/^[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/.test(prefix),
      `OUI prefix "${prefix}" is not 3-byte uppercase MAC`);
  }
});

// ─── parseArpOutput() — macOS ───────────────────────────────────────────────

test('parses standard macOS arp -a output', () => {
  const stdout = [
    '? (192.168.1.1) at 00:11:22:33:44:55 on en0 ifscope [ethernet]',
    'mixer.local (192.168.1.50) at 00:60:52:aa:bb:cc on en0 ifscope [ethernet]',
    'switcher (192.168.1.100) at 7c:2e:0d:11:22:33 on en0 ifscope [ethernet]',
  ].join('\n');

  const entries = parseArpOutput(stdout);
  assert.equal(entries.length, 3);

  // First entry: hostname is '?' which should be normalized to null
  assert.equal(entries[0].ip, '192.168.1.1');
  assert.equal(entries[0].hostname, null);

  // Second entry: hostname preserved + Allen & Heath vendor from OUI
  assert.equal(entries[1].ip, '192.168.1.50');
  assert.equal(entries[1].hostname, 'mixer.local');
  assert.equal(entries[1].mac, '00:60:52:AA:BB:CC');
  assert.equal(entries[1].vendor, 'Allen & Heath');

  // Third entry: Blackmagic from OUI
  assert.equal(entries[2].vendor, 'Blackmagic Design');
});

test('parses Linux arp -a output (with [ether] tag)', () => {
  // Linux format: "hostname (ip) at mac [ether] on iface"
  const stdout = 'router (10.0.0.1) at aa:bb:cc:dd:ee:ff [ether] on eth0';
  const entries = parseArpOutput(stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ip, '10.0.0.1');
  assert.equal(entries[0].mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(entries[0].hostname, 'router');
});

test('skips (incomplete) entries — host did not respond to ARP', () => {
  const stdout = [
    '? (192.168.1.99) at (incomplete) on en0',
    'live (192.168.1.100) at 7c:2e:0d:11:22:33 on en0',
  ].join('\n');
  const entries = parseArpOutput(stdout);
  // Only the live entry should make it through; (incomplete) does not match
  // the MAC regex, so it's filtered out before the explicit guard.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ip, '192.168.1.100');
});

test('skips broadcast MAC FF:FF:FF:FF:FF:FF', () => {
  const stdout = '? (255.255.255.255) at ff:ff:ff:ff:ff:ff on en0';
  assert.equal(parseArpOutput(stdout).length, 0);
});

test('handles macOS short-byte MACs end-to-end', () => {
  // Real-world macOS output uses unpadded bytes. The parser must normalize so
  // OUI lookup still works.
  const stdout = 'companion (192.168.1.30) at 4:17:b6:4a:d6:e5 on en0';
  const entries = parseArpOutput(stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mac, '04:17:B6:4A:D6:E5');
});

test('returns empty array for empty/garbage input', () => {
  assert.deepEqual(parseArpOutput(''), []);
  assert.deepEqual(parseArpOutput('totally not arp output\nrandom text'), []);
});

test('multi-interface output — every entry parsed, no cross-talk', () => {
  // When a host has multiple NICs (e.g. en0 + utun0 VPN), arp -a prints
  // entries for each. Make sure we don't drop any.
  const stdout = [
    '? (192.168.1.1) at 11:22:33:44:55:66 on en0',
    '? (10.8.0.1) at aa:bb:cc:dd:ee:ff on utun0',
    '? (192.168.1.50) at 7c:2e:0d:00:11:22 on en0',
  ].join('\n');
  const entries = parseArpOutput(stdout);
  assert.equal(entries.length, 3);
  const ips = entries.map(e => e.ip).sort();
  assert.deepEqual(ips, ['10.8.0.1', '192.168.1.1', '192.168.1.50']);
});
