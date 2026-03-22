/**
 * config-manager.test.js — Pure-function tests for config-manager.js
 *
 * Tests the exported pure functions: isMockValue and stripMockConfig.
 * These functions transform config objects without any I/O and are
 * safe to test in any environment.
 *
 * Coverage:
 *   - isMockValue: detects mock/fake/sim strings, URL prefixes, substrings
 *   - isMockValue: case-insensitive, null/empty safe
 *   - stripMockConfig: clears mock ATEM IP
 *   - stripMockConfig: clears mock OBS URL and password together
 *   - stripMockConfig: nulls out mock ProPresenter and mixer configs
 *   - stripMockConfig: filters mock entries from hyperdecks array
 *   - stripMockConfig: removes dev-only keys (mockProduction, fakeAtemApiPort, _preMock)
 *   - stripMockConfig: preserves real values unchanged
 *   - stripMockConfig: does not mutate the input object
 *   - stripMockConfig: handles empty, null, and undefined inputs gracefully
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isMockValue, stripMockConfig } = require('../src/config-manager');

// ─── isMockValue ──────────────────────────────────────────────────────────────

test('isMockValue: "mock" is a mock value', () => {
  assert.equal(isMockValue('mock'), true);
});

test('isMockValue: "fake" is a mock value', () => {
  assert.equal(isMockValue('fake'), true);
});

test('isMockValue: "sim" is a mock value', () => {
  assert.equal(isMockValue('sim'), true);
});

test('isMockValue: "simulate" is a mock value', () => {
  assert.equal(isMockValue('simulate'), true);
});

test('isMockValue: "mock://" prefixed URL is a mock value', () => {
  assert.equal(isMockValue('mock://192.168.1.100'), true);
});

test('isMockValue: string containing "mock-hyperdeck" is a mock value', () => {
  assert.equal(isMockValue('ws://mock-hyperdeck:9993'), true);
});

test('isMockValue: case-insensitive — MOCK is a mock value', () => {
  assert.equal(isMockValue('MOCK'), true);
});

test('isMockValue: case-insensitive — FAKE is a mock value', () => {
  assert.equal(isMockValue('FAKE'), true);
});

test('isMockValue: case-insensitive — SIM is a mock value', () => {
  assert.equal(isMockValue('SIM'), true);
});

test('isMockValue: a real IP address is not a mock value', () => {
  assert.equal(isMockValue('192.168.1.100'), false);
});

test('isMockValue: a real WebSocket URL is not a mock value', () => {
  assert.equal(isMockValue('ws://localhost:4455'), false);
});

test('isMockValue: a wss:// URL is not a mock value', () => {
  assert.equal(isMockValue('wss://api.tallyconnect.app'), false);
});

test('isMockValue: empty string is not a mock value', () => {
  assert.equal(isMockValue(''), false);
});

test('isMockValue: null is not a mock value', () => {
  assert.equal(isMockValue(null), false);
});

test('isMockValue: undefined is not a mock value', () => {
  assert.equal(isMockValue(undefined), false);
});

test('isMockValue: "simulation" is NOT a mock value (only exact "sim" matches)', () => {
  // isMockValue checks === 'sim', not startsWith — "simulation" does not match
  assert.equal(isMockValue('simulation'), false);
});

// ─── stripMockConfig: mock ATEM/OBS ───────────────────────────────────────────

test('stripMockConfig: clears mock atemIp', () => {
  const result = stripMockConfig({ atemIp: 'mock' });
  assert.equal(result.atemIp, '');
});

test('stripMockConfig: clears mock atemIp (fake variant)', () => {
  const result = stripMockConfig({ atemIp: 'fake' });
  assert.equal(result.atemIp, '');
});

test('stripMockConfig: clears obsUrl and obsPassword together when obsUrl is mock', () => {
  const result = stripMockConfig({ obsUrl: 'mock', obsPassword: 'real-secret' });
  assert.equal(result.obsUrl, '');
  assert.equal(result.obsPassword, '');
});

test('stripMockConfig: does not clear obsPassword when obsUrl is real', () => {
  const result = stripMockConfig({ obsUrl: 'ws://localhost:4455', obsPassword: 'secret' });
  assert.equal(result.obsUrl, 'ws://localhost:4455');
  assert.equal(result.obsPassword, 'secret');
});

// ─── stripMockConfig: ProPresenter and mixer ──────────────────────────────────

test('stripMockConfig: nulls out ProPresenter when host is mock', () => {
  const result = stripMockConfig({ proPresenter: { host: 'fake', port: 1025 } });
  assert.equal(result.proPresenter, null);
});

test('stripMockConfig: nulls out mixer when host is mock', () => {
  const result = stripMockConfig({ mixer: { host: 'sim', type: 'x32' } });
  assert.equal(result.mixer, null);
});

test('stripMockConfig: preserves real ProPresenter config', () => {
  const input = { proPresenter: { host: '10.0.0.5', port: 1025 } };
  const result = stripMockConfig(input);
  assert.deepStrictEqual(result.proPresenter, { host: '10.0.0.5', port: 1025 });
});

test('stripMockConfig: preserves real mixer config', () => {
  const input = { mixer: { host: '192.168.1.20', type: 'x32' } };
  const result = stripMockConfig(input);
  assert.deepStrictEqual(result.mixer, { host: '192.168.1.20', type: 'x32' });
});

// ─── stripMockConfig: hyperdecks array ────────────────────────────────────────

test('stripMockConfig: filters mock entries from hyperdecks array', () => {
  const result = stripMockConfig({
    hyperdecks: ['mock-hyperdeck-1', '192.168.1.50', 'ws://mock-hyperdeck:9993'],
  });
  assert.deepStrictEqual(result.hyperdecks, ['192.168.1.50']);
});

test('stripMockConfig: preserves all real hyperdeck entries', () => {
  const result = stripMockConfig({
    hyperdecks: ['192.168.1.50', '10.0.0.20'],
  });
  assert.deepStrictEqual(result.hyperdecks, ['192.168.1.50', '10.0.0.20']);
});

test('stripMockConfig: handles empty hyperdecks array', () => {
  const result = stripMockConfig({ hyperdecks: [] });
  assert.deepStrictEqual(result.hyperdecks, []);
});

test('stripMockConfig: handles hyperdecks with all mock entries', () => {
  const result = stripMockConfig({ hyperdecks: ['mock', 'fake'] });
  assert.deepStrictEqual(result.hyperdecks, []);
});

// ─── stripMockConfig: dev-only key removal ────────────────────────────────────

test('stripMockConfig: removes mockProduction key', () => {
  const result = stripMockConfig({ mockProduction: true, relay: 'wss://example.com' });
  assert.equal(result.mockProduction, undefined);
  assert.equal(result.relay, 'wss://example.com');
});

test('stripMockConfig: removes fakeAtemApiPort key', () => {
  const result = stripMockConfig({ fakeAtemApiPort: 9001 });
  assert.equal(result.fakeAtemApiPort, undefined);
});

test('stripMockConfig: removes _preMock key', () => {
  const result = stripMockConfig({ _preMock: { atemIp: '10.0.0.1' } });
  assert.equal(result._preMock, undefined);
});

// ─── stripMockConfig: preserves real values ───────────────────────────────────

test('stripMockConfig: preserves real atemIp', () => {
  const result = stripMockConfig({ atemIp: '192.168.10.240' });
  assert.equal(result.atemIp, '192.168.10.240');
});

test('stripMockConfig: preserves relay URL', () => {
  const result = stripMockConfig({ relay: 'wss://api.tallyconnect.app' });
  assert.equal(result.relay, 'wss://api.tallyconnect.app');
});

test('stripMockConfig: preserves token', () => {
  const result = stripMockConfig({ token: 'enc:abc123' });
  assert.equal(result.token, 'enc:abc123');
});

// ─── stripMockConfig: immutability ────────────────────────────────────────────

test('stripMockConfig: does not mutate the input object', () => {
  const input = { atemIp: 'mock', relay: 'wss://example.com' };
  stripMockConfig(input);
  assert.equal(input.atemIp, 'mock', 'Input should be unchanged');
});

// ─── stripMockConfig: edge inputs ─────────────────────────────────────────────

test('stripMockConfig: handles empty config object', () => {
  const result = stripMockConfig({});
  assert.deepStrictEqual(result, {});
});

test('stripMockConfig: handles null gracefully (returns object)', () => {
  assert.doesNotThrow(() => stripMockConfig(null));
  const result = stripMockConfig(null);
  assert.ok(result !== null && typeof result === 'object');
});

test('stripMockConfig: handles undefined gracefully', () => {
  assert.doesNotThrow(() => stripMockConfig(undefined));
  const result = stripMockConfig(undefined);
  assert.ok(typeof result === 'object');
});

test('stripMockConfig: unrelated keys are preserved unchanged', () => {
  const input = {
    name: 'First Baptist',
    timezone: 'America/Chicago',
    atemIp: '192.168.1.100',
  };
  const result = stripMockConfig(input);
  assert.equal(result.name, 'First Baptist');
  assert.equal(result.timezone, 'America/Chicago');
  assert.equal(result.atemIp, '192.168.1.100');
});
