/**
 * Equipment Tester — Protocol Dispatch Tests
 *
 * Verifies that testEquipmentConnection() dispatches to the correct network
 * protocol for each equipment type:
 *   - SQ/Allen & Heath mixer  → TCP on port 51325
 *   - ATEM switcher           → UDP on port 9910
 *   - vMix                    → HTTP (GET /api)
 *
 * Uses the init() injection point so no real sockets are opened.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { init, testEquipmentConnection } = require('../src/equipment-tester');

// ─── Mock factories ───────────────────────────────────────────────────────────

/**
 * Build a call-recording mock for init().
 * Each probe records { host, port, packet?, url? } and returns the given result.
 */
function makeMocks({ tcpResult = true, httpResult = { success: true, body: '<edition>HD</edition>' }, udpResult = true } = {}) {
  const calls = { tcp: [], http: [], udp: [] };

  init({
    tryTcpConnect: (host, port) => {
      calls.tcp.push({ host, port });
      return Promise.resolve(tcpResult);
    },
    tryHttpGet: (url) => {
      calls.http.push({ url });
      return Promise.resolve(typeof httpResult === 'function' ? httpResult(url) : httpResult);
    },
    tryUdpProbe: (host, port, packet) => {
      calls.udp.push({ host, port, packetLen: packet?.length });
      return Promise.resolve(udpResult);
    },
  });

  return calls;
}

// ─── SQ / Allen & Heath mixer ─────────────────────────────────────────────────

describe('equipment-tester: SQ mixer → TCP/51325', () => {
  it('probes via TCP on port 51325 when mixerType=allenheath', async () => {
    const calls = makeMocks({ tcpResult: true });
    const result = await testEquipmentConnection({ type: 'mixer', mixerType: 'allenheath', ip: '192.168.1.10' });
    assert.equal(result.success, true);
    assert.equal(calls.tcp.length, 1, 'exactly one TCP probe');
    assert.equal(calls.tcp[0].port, 51325, 'must probe TCP port 51325');
    assert.equal(calls.udp.length, 0, 'must NOT use UDP for SQ');
    assert.equal(calls.http.length, 0, 'must NOT use HTTP for SQ');
  });

  it('probes TCP/51325 for mixerType=dlive', async () => {
    const calls = makeMocks({ tcpResult: true });
    await testEquipmentConnection({ type: 'mixer', mixerType: 'dlive', ip: '10.0.0.5' });
    assert.equal(calls.tcp[0].port, 51325);
  });

  it('probes TCP/51325 for mixerType=avantis', async () => {
    const calls = makeMocks({ tcpResult: true });
    await testEquipmentConnection({ type: 'mixer', mixerType: 'avantis', ip: '10.0.0.6' });
    assert.equal(calls.tcp[0].port, 51325);
  });

  it('returns success=false when TCP probe fails', async () => {
    const calls = makeMocks({ tcpResult: false });
    const result = await testEquipmentConnection({ type: 'mixer', mixerType: 'allenheath', ip: '192.168.1.99' });
    assert.equal(result.success, false);
    assert.equal(calls.tcp.length, 1);
  });

  it('respects explicit port override', async () => {
    const calls = makeMocks({ tcpResult: true });
    await testEquipmentConnection({ type: 'mixer', mixerType: 'allenheath', ip: '10.0.0.1', port: 51326 });
    assert.equal(calls.tcp[0].port, 51326);
  });
});

// ─── ATEM switcher → UDP/9910 ─────────────────────────────────────────────────

describe('equipment-tester: ATEM → UDP/9910', () => {
  it('probes via UDP on port 9910', async () => {
    const calls = makeMocks({ udpResult: true });
    const result = await testEquipmentConnection({ type: 'atem', ip: '192.168.1.240' });
    assert.equal(result.success, true);
    assert.equal(calls.udp.length, 1, 'exactly one UDP probe');
    assert.equal(calls.udp[0].port, 9910, 'must probe UDP port 9910');
    assert.equal(calls.tcp.length, 0, 'must NOT use TCP for ATEM');
    assert.equal(calls.http.length, 0, 'must NOT use HTTP for ATEM');
  });

  it('sends the ATEM SYN packet (non-empty)', async () => {
    const calls = makeMocks({ udpResult: true });
    await testEquipmentConnection({ type: 'atem', ip: '10.0.0.1' });
    assert.ok(calls.udp[0].packetLen > 0, 'ATEM SYN packet must be non-empty');
  });

  it('returns success=false when UDP probe times out', async () => {
    const calls = makeMocks({ udpResult: false });
    const result = await testEquipmentConnection({ type: 'atem', ip: '10.0.0.1' });
    assert.equal(result.success, false);
    assert.match(result.details, /Cannot reach ATEM/);
  });

  it('respects explicit port override', async () => {
    const calls = makeMocks({ udpResult: true });
    await testEquipmentConnection({ type: 'atem', ip: '10.0.0.1', port: 9911 });
    assert.equal(calls.udp[0].port, 9911);
  });
});

// ─── vMix → HTTP ──────────────────────────────────────────────────────────────

describe('equipment-tester: vMix → HTTP', () => {
  it('probes via HTTP GET (not TCP, not UDP)', async () => {
    const calls = makeMocks({ httpResult: { success: true, body: '<edition>HD</edition>' } });
    const result = await testEquipmentConnection({ type: 'vmix', ip: '192.168.1.50' });
    assert.equal(result.success, true);
    assert.equal(calls.http.length, 1, 'exactly one HTTP probe');
    assert.equal(calls.tcp.length, 0, 'must NOT use TCP for vMix');
    assert.equal(calls.udp.length, 0, 'must NOT use UDP for vMix');
  });

  it('probes the vMix API endpoint on port 8088', async () => {
    const calls = makeMocks({ httpResult: { success: true, body: '<edition>4K</edition>' } });
    await testEquipmentConnection({ type: 'vmix', ip: '192.168.1.50' });
    assert.match(calls.http[0].url, /8088/, 'default port must be 8088');
    assert.match(calls.http[0].url, /GetShortXML/, 'must use GetShortXML API endpoint');
  });

  it('returns success=false when HTTP response has no <edition> tag', async () => {
    makeMocks({ httpResult: { success: true, body: '<something>else</something>' } });
    const result = await testEquipmentConnection({ type: 'vmix', ip: '192.168.1.50' });
    assert.equal(result.success, false);
  });

  it('returns success=false when HTTP probe fails entirely', async () => {
    makeMocks({ httpResult: { success: false, body: '' } });
    const result = await testEquipmentConnection({ type: 'vmix', ip: '192.168.1.50' });
    assert.equal(result.success, false);
  });

  it('extracts edition name from XML response', async () => {
    makeMocks({ httpResult: { success: true, body: '<edition>4K</edition>' } });
    const result = await testEquipmentConnection({ type: 'vmix', ip: '192.168.1.50' });
    assert.match(result.details, /4K/);
  });
});

// ─── normalizeHost() — localhost → 127.0.0.1 ──────────────────────────────────

describe('equipment-tester: normalizeHost', () => {
  it('translates localhost to 127.0.0.1 for TCP probe', async () => {
    const calls = makeMocks({ tcpResult: true });
    await testEquipmentConnection({ type: 'obs', ip: 'localhost' });
    assert.equal(calls.tcp[0].host, '127.0.0.1', 'localhost must resolve to 127.0.0.1');
  });

  it('passes through explicit IP addresses unchanged', async () => {
    const calls = makeMocks({ tcpResult: true });
    await testEquipmentConnection({ type: 'obs', ip: '10.0.0.100' });
    assert.equal(calls.tcp[0].host, '10.0.0.100');
  });
});
