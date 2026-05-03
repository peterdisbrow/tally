/**
 * scanner.test.js — NetworkScanner orchestration + subnet helpers
 *
 * Tests the top-level NetworkScanner class without opening real sockets:
 *  - subnet expansion math (off-by-one would skip the last /24 host)
 *  - netmask-to-prefix conversion
 *  - device merge logic (same IP from ARP + mDNS + ports collapses to one record)
 *  - abort() short-circuits in-progress scans
 *  - onProgress / onDeviceFound callbacks fire
 *
 * The actual probes (arp, mdns, port-scanner) are mocked via require.cache
 * so the test runs in <100ms with no network access.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SCANNER_DIR = path.resolve(__dirname, '..');

// ─── Pure helpers (no mocking needed) ───────────────────────────────────────

const { expandSubnet, netmaskToPrefix, NetworkScanner, listInterfaces } = require('../index');

test('netmaskToPrefix handles standard masks', () => {
  assert.equal(netmaskToPrefix('255.255.255.0'),  24);
  assert.equal(netmaskToPrefix('255.255.0.0'),    16);
  assert.equal(netmaskToPrefix('255.255.255.128'), 25);
  assert.equal(netmaskToPrefix('255.255.255.252'), 30);
});

test('netmaskToPrefix defaults to /24 for missing input', () => {
  assert.equal(netmaskToPrefix(null), 24);
  assert.equal(netmaskToPrefix(undefined), 24);
  assert.equal(netmaskToPrefix(''), 24);
});

test('expandSubnet returns 254 hosts for /24', () => {
  // Network/broadcast (.0/.255) excluded → 254 usable hosts.
  const hosts = expandSubnet('192.168.1.50', 24);
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], '192.168.1.1');
  assert.equal(hosts[hosts.length - 1], '192.168.1.254');
});

test('expandSubnet correctly handles /25 (split /24)', () => {
  // 192.168.1.50 with /25 → network 192.168.1.0, broadcast .127, 126 hosts
  const hosts = expandSubnet('192.168.1.50', 25);
  assert.equal(hosts.length, 126);
  assert.equal(hosts[0], '192.168.1.1');
  assert.equal(hosts[125], '192.168.1.126');
});

test('expandSubnet clamps absurd prefix lengths to safe range', () => {
  // The clamp prevents pathological scans (a /8 would be ~16M hosts).
  const huge = expandSubnet('10.0.0.5', 8);
  assert.ok(huge.length <= 65534, '/<16 should be clamped down to /16 max');

  const tiny = expandSubnet('192.168.1.50', 32);
  assert.ok(tiny.length >= 2, '/>30 should be clamped up to /30 (2 usable)');
});

test('listInterfaces returns IPv4 non-loopback NICs only', () => {
  const ifaces = listInterfaces();
  assert.ok(Array.isArray(ifaces));
  for (const i of ifaces) {
    assert.ok(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(i.ip),
      `Interface ${i.name} has non-IPv4 address: ${i.ip}`);
    assert.ok(!i.ip.startsWith('127.'),
      `Loopback interface should be filtered out: ${i.ip}`);
    assert.ok(i.netmask, `Interface ${i.name} missing netmask`);
  }
});

// ─── Orchestration with mocked probes ───────────────────────────────────────

/**
 * Load a fresh NetworkScanner with the arp/mdns/port-scanner submodules
 * stubbed out. We swap Module._load so `require('./arp')` etc. inside index.js
 * returns our fake — same trick the existing ipc-contracts.test.js uses for
 * Electron.
 */
function loadScannerWithMocks({ arp, mdns, portScanner }) {
  const fakes = {
    [path.join(SCANNER_DIR, 'arp.js')]: arp,
    [path.join(SCANNER_DIR, 'mdns.js')]: mdns,
    [path.join(SCANNER_DIR, 'port-scanner.js')]: portScanner,
    // classifier is pure — let the real one through
  };

  const originalLoad = Module._load.bind(Module);
  Module._load = function (request, parent, isMain) {
    const resolved = (() => {
      try { return Module._resolveFilename(request, parent); } catch { return null; }
    })();
    if (resolved && fakes[resolved]) return fakes[resolved];
    return originalLoad(request, parent, isMain);
  };

  // Force fresh load of index.js
  const indexPath = path.join(SCANNER_DIR, 'index.js');
  delete require.cache[indexPath];
  const mod = require(indexPath);
  Module._load = originalLoad;
  delete require.cache[indexPath];
  return mod;
}

test('scan() merges ARP + mDNS + port-scanner results by IP', async () => {
  const fakeArp = {
    discover: async () => [
      { ip: '192.168.1.50', mac: '7C:2E:0D:11:22:33', vendor: 'Blackmagic Design', hostname: 'switcher.local' },
    ],
  };
  const fakeMdns = {
    browse: async () => [
      { ip: '192.168.1.50', service: '_obs-websocket._tcp.local', port: 4455, hostname: 'studio.local', txt: {} },
      // Different IP — should land as a separate device
      { ip: '192.168.1.20', service: '_companion._tcp.local', port: 8888, hostname: 'companion.local', txt: {} },
    ],
  };
  const fakePortScanner = {
    scanHost: async (ip) => {
      if (ip === '192.168.1.50') {
        return [{ port: 9910, protocol: 'ATEM', deviceType: 'switcher', model: null, details: {} }];
      }
      return [];
    },
  };

  const { NetworkScanner: ScannerWithMocks } = loadScannerWithMocks({
    arp: fakeArp, mdns: fakeMdns, portScanner: fakePortScanner,
  });

  // Scan a single explicit IP so we don't enumerate the whole subnet
  // (extraIps overrides subnet expansion when no real interfaces match).
  const scanner = new ScannerWithMocks({ timeout: 50 });
  // Inject extraIps but skip iface expansion by passing an unknown interface name
  const result = await scanner.scan({ interfaceName: '__nonexistent__', extraIps: ['192.168.1.50', '192.168.1.20'] });

  assert.ok(result.devices.length >= 2, `Expected ≥2 devices, got ${result.devices.length}`);

  const sw = result.devices.find(d => d.ip === '192.168.1.50');
  assert.ok(sw, '192.168.1.50 should appear');
  // ARP gave us MAC + vendor; mDNS added a service; port scan added ATEM protocol.
  assert.equal(sw.mac, '7C:2E:0D:11:22:33');
  assert.equal(sw.vendor, 'Blackmagic Design');
  assert.ok(sw.protocols.includes('ATEM'), 'ATEM protocol from port scan should be merged');
  assert.ok(sw.openPorts.includes(9910), 'Port 9910 should be merged in');
  assert.ok(sw.services.some(s => s.name === '_obs-websocket._tcp.local'),
    'mDNS service should be merged in');
  // Classification phase ran — switcher beats software (protocol > mDNS service)
  assert.equal(sw.deviceType, 'switcher');
});

test('onDeviceFound fires for each merged-in device', async () => {
  const fakeArp = {
    discover: async () => [
      { ip: '10.0.0.10', mac: '11:22:33:44:55:66', vendor: null, hostname: null },
    ],
  };
  const fakeMdns = { browse: async () => [] };
  const fakePortScanner = { scanHost: async () => [] };

  const { NetworkScanner: ScannerWithMocks } = loadScannerWithMocks({
    arp: fakeArp, mdns: fakeMdns, portScanner: fakePortScanner,
  });

  const found = [];
  const scanner = new ScannerWithMocks({
    timeout: 50,
    onDeviceFound: (d) => found.push(d.ip),
  });
  await scanner.scan({ interfaceName: '__nonexistent__', extraIps: ['10.0.0.10'] });

  assert.ok(found.includes('10.0.0.10'), 'onDeviceFound should fire when ARP discovers a host');
});

test('onProgress reports phases in order with monotonically rising percent', async () => {
  const fakeArp = { discover: async () => [] };
  const fakeMdns = { browse: async () => [] };
  const fakePortScanner = { scanHost: async () => [] };

  const { NetworkScanner: ScannerWithMocks } = loadScannerWithMocks({
    arp: fakeArp, mdns: fakeMdns, portScanner: fakePortScanner,
  });

  const phases = [];
  const percents = [];
  const scanner = new ScannerWithMocks({
    timeout: 50,
    onProgress: (p) => { phases.push(p.phase); percents.push(p.percent); },
  });
  await scanner.scan({ interfaceName: '__nonexistent__', extraIps: ['10.0.0.1'] });

  // Should pass through arp → mdns → ports → classify → done
  assert.ok(phases.includes('arp'), 'arp phase missing');
  assert.ok(phases.includes('mdns'), 'mdns phase missing');
  assert.ok(phases.includes('ports'), 'ports phase missing');
  assert.equal(phases[phases.length - 1], 'done');

  // Percent should never go backwards
  for (let i = 1; i < percents.length; i++) {
    assert.ok(percents[i] >= percents[i - 1],
      `Progress went backwards: ${percents[i - 1]} → ${percents[i]} at phase ${phases[i]}`);
  }
  assert.equal(percents[percents.length - 1], 100);
});

test('abort() stops port-scan early', async () => {
  let portScansStarted = 0;
  const fakeArp = { discover: async () => [] };
  const fakeMdns = { browse: async () => [] };
  const fakePortScanner = {
    scanHost: async () => {
      portScansStarted++;
      // Slow scan so abort has a chance to land
      await new Promise(r => setTimeout(r, 50));
      return [];
    },
  };

  const { NetworkScanner: ScannerWithMocks } = loadScannerWithMocks({
    arp: fakeArp, mdns: fakeMdns, portScanner: fakePortScanner,
  });

  const scanner = new ScannerWithMocks({ timeout: 50, batchSize: 5 });
  const ips = Array.from({ length: 30 }, (_, i) => `10.99.99.${i + 1}`);
  const promise = scanner.scan({ interfaceName: '__nonexistent__', extraIps: ips });

  // Abort after one batch has had a chance to start
  setTimeout(() => scanner.abort(), 20);
  await promise;

  // Without abort we'd see 30; with abort we should see substantially fewer.
  assert.ok(portScansStarted < 30,
    `abort() should short-circuit; got ${portScansStarted}/30 scans`);
});

test('extraIps with malformed entries are silently dropped', async () => {
  const fakeArp = { discover: async () => [] };
  const fakeMdns = { browse: async () => [] };
  let scannedIps = [];
  const fakePortScanner = {
    scanHost: async (ip) => { scannedIps.push(ip); return []; },
  };

  const { NetworkScanner: ScannerWithMocks } = loadScannerWithMocks({
    arp: fakeArp, mdns: fakeMdns, portScanner: fakePortScanner,
  });

  const scanner = new ScannerWithMocks({ timeout: 50 });
  await scanner.scan({
    interfaceName: '__nonexistent__',
    extraIps: ['192.168.1.10', 'not-an-ip', '999.999.999.999', '10.0.0.1'],
  });

  // Only the two valid IPv4s should have been probed.
  assert.deepEqual(scannedIps.sort(), ['10.0.0.1', '192.168.1.10']);
});

test('extraSubnets expands "192.168.5" → 254 hosts', async () => {
  const fakeArp = { discover: async () => [] };
  const fakeMdns = { browse: async () => [] };
  let count = 0;
  const fakePortScanner = {
    scanHost: async () => { count++; return []; },
  };

  const { NetworkScanner: ScannerWithMocks } = loadScannerWithMocks({
    arp: fakeArp, mdns: fakeMdns, portScanner: fakePortScanner,
  });

  const scanner = new ScannerWithMocks({ timeout: 10 });
  await scanner.scan({
    interfaceName: '__nonexistent__',
    extraSubnets: ['192.168.5'],
  });

  assert.equal(count, 254, 'extraSubnets entry should expand to 254 hosts (.1–.254)');
});
