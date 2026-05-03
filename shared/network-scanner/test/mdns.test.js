/**
 * mdns.test.js — mDNS/Bonjour packet parsing
 *
 * `parseResponse` consumes raw multicast-dns response packets and emits flat
 * service records. The combinatorics of PTR + SRV + TXT + A records means
 * any one missing record can drop a service from the output. These tests
 * pin behavior for the most common shapes we see on church networks.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseResponse, SERVICE_QUERIES } = require('../mdns');

// ─── Packet builder helpers ─────────────────────────────────────────────────

function ptr(name, target)   { return { type: 'PTR', name, data: target }; }
function srv(name, target, port) { return { type: 'SRV', name, data: { target, port } }; }
function a(name, ip)         { return { type: 'A', name, data: ip }; }
function txt(name, kvs) {
  // multicast-dns returns TXT data as Buffer or array of Buffers
  const buffers = Object.entries(kvs).map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
  return { type: 'TXT', name, data: buffers };
}

// ─── Full PTR + SRV + A + TXT chain ─────────────────────────────────────────

test('parses a complete NDI advertisement (PTR + SRV + A + TXT)', () => {
  const packet = {
    answers: [
      ptr('_ndi._tcp.local', 'CAM-1._ndi._tcp.local'),
    ],
    additionals: [
      srv('CAM-1._ndi._tcp.local', 'cam1.local', 5961),
      a('cam1.local', '192.168.1.50'),
      txt('CAM-1._ndi._tcp.local', { txtvers: '1', name: 'CAM-1' }),
    ],
  };

  const services = parseResponse(packet);
  assert.equal(services.length, 1);

  const s = services[0];
  assert.equal(s.service, '_ndi._tcp.local');
  assert.equal(s.instance, 'CAM-1._ndi._tcp.local');
  assert.equal(s.hostname, 'cam1.local');
  assert.equal(s.port, 5961);
  assert.equal(s.ip, '192.168.1.50');
  assert.deepEqual(s.txt, { txtvers: '1', name: 'CAM-1' });
});

test('handles answers and additionals interchangeably', () => {
  // Some responders put the SRV in answers, some in additionals. Either should
  // resolve into a complete service record.
  const packet = {
    answers: [
      ptr('_obs-websocket._tcp.local', 'OBS._obs-websocket._tcp.local'),
      srv('OBS._obs-websocket._tcp.local', 'studio.local', 4455),
      a('studio.local', '192.168.1.20'),
    ],
    additionals: [],
  };

  const services = parseResponse(packet);
  assert.equal(services.length, 1);
  assert.equal(services[0].port, 4455);
  assert.equal(services[0].ip, '192.168.1.20');
});

// ─── PTR alone (no SRV) ─────────────────────────────────────────────────────

test('PTR with missing SRV → service record with null port/ip/hostname', () => {
  // Plenty of devices send a PTR but the SRV doesn't make it into the response
  // (UDP is lossy). We still want the record to surface — the IP can be
  // resolved later via the same scan's port-probe phase.
  const packet = {
    answers: [ptr('_companion._tcp.local', 'Companion._companion._tcp.local')],
    additionals: [],
  };
  const services = parseResponse(packet);
  assert.equal(services.length, 1);
  assert.equal(services[0].service, '_companion._tcp.local');
  assert.equal(services[0].port, null);
  assert.equal(services[0].ip, null);
});

// ─── Multiple instances of same service ─────────────────────────────────────

test('two instances of the same service produce two records', () => {
  const packet = {
    answers: [
      ptr('_ndi._tcp.local', 'CAM-1._ndi._tcp.local'),
      ptr('_ndi._tcp.local', 'CAM-2._ndi._tcp.local'),
    ],
    additionals: [
      srv('CAM-1._ndi._tcp.local', 'cam1.local', 5960),
      srv('CAM-2._ndi._tcp.local', 'cam2.local', 5961),
      a('cam1.local', '192.168.1.50'),
      a('cam2.local', '192.168.1.51'),
    ],
  };
  const services = parseResponse(packet);
  assert.equal(services.length, 2);
  const ips = services.map(s => s.ip).sort();
  assert.deepEqual(ips, ['192.168.1.50', '192.168.1.51']);
});

// ─── TXT parsing ────────────────────────────────────────────────────────────

test('TXT key-value pairs are parsed from buffer array', () => {
  const packet = {
    answers: [ptr('_dante._udp.local', 'console._dante._udp.local')],
    additionals: [
      srv('console._dante._udp.local', 'dante-console.local', 4440),
      a('dante-console.local', '10.0.0.5'),
      txt('console._dante._udp.local', { manufacturer: 'AandH', model: 'SQ-6', proto: '1' }),
    ],
  };
  const services = parseResponse(packet);
  assert.equal(services.length, 1);
  assert.deepEqual(services[0].txt, { manufacturer: 'AandH', model: 'SQ-6', proto: '1' });
});

test('TXT with no = separator is silently dropped (DNS-SD spec)', () => {
  // Per RFC 6763 §6.4, TXT entries without "=" are boolean-only flags.
  // We keep the strict key=value interpretation for now — anything else
  // would change the public service record shape downstream.
  const packet = {
    answers: [ptr('_http._tcp.local', 'svc._http._tcp.local')],
    additionals: [
      srv('svc._http._tcp.local', 'svc.local', 80),
      a('svc.local', '10.0.0.1'),
      { type: 'TXT', name: 'svc._http._tcp.local', data: [Buffer.from('flag-no-equals', 'utf8')] },
    ],
  };
  const services = parseResponse(packet);
  assert.deepEqual(services[0].txt, {});
});

// ─── Empty / malformed packets ──────────────────────────────────────────────

test('empty packet returns empty array', () => {
  assert.deepEqual(parseResponse({ answers: [], additionals: [] }), []);
  assert.deepEqual(parseResponse({}), []);
});

test('packet with only A records (no PTR/SRV) returns nothing', () => {
  const packet = {
    answers: [a('orphan.local', '192.168.1.99')],
    additionals: [],
  };
  assert.deepEqual(parseResponse(packet), []);
});

// ─── SERVICE_QUERIES table integrity ────────────────────────────────────────

test('SERVICE_QUERIES covers the AV protocols we depend on', () => {
  // Sanity check: if someone removes a query entry, scanning silently stops
  // discovering that protocol. Pin the names we rely on.
  const names = SERVICE_QUERIES.map(q => q.name);
  for (const required of [
    '_ndi._tcp.local',
    '_dante._udp.local',
    '_obs-websocket._tcp.local',
    '_companion._tcp.local',
    '_sacn._udp.local',
    '_artnet._udp.local',
    '_airplay._tcp.local',
  ]) {
    assert.ok(names.includes(required), `Missing service query: ${required}`);
  }
});

test('every SERVICE_QUERIES entry has both name and label', () => {
  for (const q of SERVICE_QUERIES) {
    assert.ok(q.name && q.name.endsWith('.local'), `Bad service name: ${q.name}`);
    assert.ok(q.label, `Missing label for ${q.name}`);
  }
});
