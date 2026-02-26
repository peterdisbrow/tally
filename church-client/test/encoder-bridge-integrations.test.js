const test = require('node:test');
const assert = require('node:assert/strict');

const { EncoderBridge } = require('../src/encoderBridge');
const { NdiEncoder } = require('../src/encoders/ndi');

test('EncoderBridge constructs TriCaster adapter', () => {
  const bridge = new EncoderBridge({ type: 'tricaster', host: '192.168.1.50' });
  assert.equal(bridge.adapter.constructor.name, 'TriCasterEncoder');
});

test('EncoderBridge constructs BirdDog adapter with source field', () => {
  const bridge = new EncoderBridge({
    type: 'birddog',
    host: '192.168.1.60',
    source: 'BirdDog Cam 1',
  });
  assert.equal(bridge.adapter.constructor.name, 'BirdDogEncoder');
  assert.equal(bridge.adapter.source, 'BirdDog Cam 1');
});

test('EncoderBridge passes source to NDI adapter', () => {
  const bridge = new EncoderBridge({
    type: 'ndi',
    host: 'legacy-source',
    source: 'Program Feed',
  });
  assert.equal(bridge.adapter.constructor.name, 'NdiEncoder');
  assert.equal(bridge.adapter.getSource(), 'Program Feed');
});

test('NDI status reports structured probe error when source is missing', async () => {
  const ndi = new NdiEncoder({ host: '' });
  const status = await ndi.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.probeError, 'source_not_configured');
});
