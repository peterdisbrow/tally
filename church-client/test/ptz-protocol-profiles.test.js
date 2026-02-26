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
