const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProtocol, defaultPortForProtocol } = require('../src/ptz');

test('PTZOptics protocol aliases normalize correctly', () => {
  assert.equal(normalizeProtocol('ptzoptics'), 'ptzoptics-visca');
  assert.equal(normalizeProtocol('ptzoptics-visca'), 'ptzoptics-visca');
  assert.equal(normalizeProtocol('ptzoptics-onvif'), 'ptzoptics-onvif');
});

test('PTZOptics protocol defaults use expected ports', () => {
  assert.equal(defaultPortForProtocol('ptzoptics-visca'), 5678);
  assert.equal(defaultPortForProtocol('ptzoptics-onvif'), 80);
});

test('Sony VISCA UDP normalizes and maps to port 52381', () => {
  assert.equal(normalizeProtocol('sony-visca'), 'sony-visca-udp');
  assert.equal(normalizeProtocol('sony-visca-udp'), 'sony-visca-udp');
  assert.equal(normalizeProtocol('visca-sony'), 'sony-visca-udp');
  assert.equal(defaultPortForProtocol('sony-visca-udp'), 52381);
});

test('all known protocols normalize to expected values', () => {
  assert.equal(normalizeProtocol('auto'), 'auto');
  assert.equal(normalizeProtocol('onvif'), 'onvif');
  assert.equal(normalizeProtocol('visca'), 'visca-tcp');
  assert.equal(normalizeProtocol('visca-tcp'), 'visca-tcp');
  assert.equal(normalizeProtocol('tcp'), 'visca-tcp');
  assert.equal(normalizeProtocol('visca-udp'), 'visca-udp');
  assert.equal(normalizeProtocol('udp'), 'visca-udp');
  assert.equal(normalizeProtocol('atem'), 'atem');
});

test('default port mapping covers all protocols', () => {
  assert.equal(defaultPortForProtocol('onvif'), 80);
  assert.equal(defaultPortForProtocol('visca-tcp'), 5678);
  assert.equal(defaultPortForProtocol('visca-udp'), 1259);
});
