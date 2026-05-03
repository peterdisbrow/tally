/**
 * classifier.test.js — Device classification logic
 *
 * The classifier is the source of truth for "what kind of AV device is this?"
 * Misclassifying a BirdDog PTZ as an NDI source (or a HyperDeck as a generic
 * recorder) lands the device in the wrong portal bucket. These tests pin the
 * priority ordering — protocol fingerprints beat vendor OUI beats port
 * heuristics — so future port additions can't quietly demote a high-confidence
 * match.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classify, classifyMdnsService, DEVICE_TYPES, VENDOR_DEVICE_TYPES } = require('../classifier');

// ─── classify() — protocol-based (highest priority) ─────────────────────────

test('ATEM protocol → switcher with high confidence', () => {
  const r = classify({ protocols: ['ATEM'], openPorts: [9910] });
  assert.equal(r.deviceType, 'switcher');
  assert.equal(r.confidence, 'high');
  assert.equal(r.category, 'video');
});

test('HyperDeck → recorder, ProPresenter → presentation', () => {
  assert.equal(classify({ protocols: ['HyperDeck'] }).deviceType, 'recorder');
  assert.equal(classify({ protocols: ['ProPresenter'] }).deviceType, 'presentation');
});

test('Videohub → router (not "router" infrastructure)', () => {
  const r = classify({ protocols: ['Videohub'] });
  assert.equal(r.deviceType, 'router');
  assert.equal(r.category, 'video', 'Blackmagic Videohub is a video router, not network gear');
});

test('BirdDog PTZ wins over generic NDI — must come before NDI rule', () => {
  // BirdDog PTZ cameras advertise NDI via mDNS. Without the explicit ordering,
  // they would land in ndi-source instead of camera. Regression guard.
  const r = classify({ protocols: ['BirdDog NDI PTZ', 'NDI'] });
  assert.equal(r.deviceType, 'camera');
  assert.equal(r.confidence, 'high');
});

test('BirdDog NDI (encoder/decoder) → ndi-converter, not ndi-source', () => {
  const r = classify({ protocols: ['BirdDog NDI', 'NDI'] });
  assert.equal(r.deviceType, 'ndi-converter');
});

test('Plain NDI advertisement → ndi-source', () => {
  const r = classify({ protocols: ['NDI'] });
  assert.equal(r.deviceType, 'ndi-source');
});

test('Mixer protocols all land in audio-mixer', () => {
  for (const proto of ['Behringer X32/M32', 'Allen & Heath', 'Yamaha CL/QL']) {
    const r = classify({ protocols: [proto] });
    assert.equal(r.deviceType, 'audio-mixer', `${proto} should be audio-mixer`);
    assert.equal(r.category, 'audio');
  }
});

test('Lighting protocols → lighting category', () => {
  assert.equal(classify({ protocols: ['sACN (E1.31)'] }).deviceType, 'lighting');
  assert.equal(classify({ protocols: ['Art-Net'] }).deviceType, 'lighting');
});

test('Shelly smart-plug protocol → smart-plug', () => {
  assert.equal(classify({ protocols: ['Shelly'] }).deviceType, 'smart-plug');
});

test('Tally Encoder protocol → encoder', () => {
  assert.equal(classify({ protocols: ['Tally Encoder'] }).deviceType, 'encoder');
});

// ─── classify() — vendor-based fallback ─────────────────────────────────────

test('Vendor only (no protocol hits) → medium confidence vendor mapping', () => {
  const r = classify({ vendor: 'Blackmagic Design', openPorts: [80] });
  assert.equal(r.deviceType, 'switcher');
  assert.equal(r.confidence, 'medium');
});

test('Apple vendor without protocol → computer', () => {
  const r = classify({ vendor: 'Apple', openPorts: [22, 80] });
  assert.equal(r.deviceType, 'computer');
});

test('Protocol always beats vendor — Blackmagic vendor + ProPresenter protocol', () => {
  const r = classify({ vendor: 'Blackmagic Design', protocols: ['ProPresenter'] });
  assert.equal(r.deviceType, 'presentation', 'Protocol fingerprint must override vendor OUI');
});

// ─── classify() — port heuristics (lowest priority before fallback) ─────────

test('SSH-only host with few ports → infrastructure', () => {
  const r = classify({ openPorts: [22] });
  assert.equal(r.deviceType, 'infrastructure');
});

test('SSH-only with many ports falls through (does NOT classify as infra)', () => {
  // The heuristic requires <= 3 open ports. A host with SSH + many other
  // services is more likely a Linux server than a switch.
  const r = classify({ openPorts: [22, 80, 443, 3306, 5432] });
  assert.notEqual(r.deviceType, 'infrastructure');
});

test('Unknown device → unknown with low confidence', () => {
  const r = classify({ protocols: [], openPorts: [] });
  assert.equal(r.deviceType, 'unknown');
  assert.equal(r.confidence, 'low');
});

test('Returns label/category/icon from DEVICE_TYPES table', () => {
  const r = classify({ protocols: ['ATEM'] });
  assert.equal(r.label, DEVICE_TYPES['switcher'].label);
  assert.equal(r.icon, DEVICE_TYPES['switcher'].icon);
  assert.equal(r.category, DEVICE_TYPES['switcher'].category);
});

// ─── classifyMdnsService() — mDNS service-name routing ──────────────────────

test('_ndi._tcp → NDI/ndi-source', () => {
  const r = classifyMdnsService({ service: '_ndi._tcp.local' });
  assert.deepEqual(r, { protocols: ['NDI'], deviceType: 'ndi-source' });
});

test('_dante._udp → Dante audio-network', () => {
  const r = classifyMdnsService({ service: '_dante._udp.local' });
  assert.equal(r.deviceType, 'audio-network');
  assert.deepEqual(r.protocols, ['Dante']);
});

test('_obs-websocket._tcp → OBS WebSocket software', () => {
  const r = classifyMdnsService({ service: '_obs-websocket._tcp.local' });
  assert.deepEqual(r.protocols, ['OBS WebSocket']);
  assert.equal(r.deviceType, 'software');
});

test('_companion._tcp → Companion controller', () => {
  const r = classifyMdnsService({ service: '_companion._tcp.local' });
  assert.equal(r.deviceType, 'controller');
});

test('_ssh on a Pi instance → controller (Companion runs on Pis)', () => {
  // Real Companion appliances are usually a Raspberry Pi running Companion;
  // SSH on a host whose mDNS instance starts with "raspberrypi" should be
  // tagged as a controller, not a generic computer.
  const r = classifyMdnsService({ service: '_ssh._tcp.local', instance: 'raspberrypi-companion._ssh._tcp.local' });
  assert.equal(r.deviceType, 'controller');
});

test('_ssh on a non-Pi instance → computer', () => {
  const r = classifyMdnsService({ service: '_ssh._tcp.local', instance: 'macbook._ssh._tcp.local' });
  assert.equal(r.deviceType, 'computer');
});

test('Unknown service → empty protocols + unknown deviceType', () => {
  const r = classifyMdnsService({ service: '_someweird._tcp.local' });
  assert.deepEqual(r, { protocols: [], deviceType: 'unknown' });
});

test('Empty/missing service is safe (no crash)', () => {
  assert.doesNotThrow(() => classifyMdnsService({}));
  assert.doesNotThrow(() => classifyMdnsService({ service: null }));
});

// ─── DEVICE_TYPES & VENDOR_DEVICE_TYPES — table integrity ───────────────────

test('Every VENDOR_DEVICE_TYPES value maps to a real DEVICE_TYPES entry', () => {
  // Catches typos that would otherwise return `undefined` from classify().
  for (const [vendor, dt] of Object.entries(VENDOR_DEVICE_TYPES)) {
    assert.ok(DEVICE_TYPES[dt], `Vendor "${vendor}" maps to unknown deviceType "${dt}"`);
  }
});

test('Every DEVICE_TYPES entry has label, category, and icon', () => {
  for (const [key, def] of Object.entries(DEVICE_TYPES)) {
    assert.ok(def.label, `${key} missing label`);
    assert.ok(def.category, `${key} missing category`);
    assert.ok(def.icon, `${key} missing icon`);
  }
});
