'use strict';

/**
 * Guards the command-e2e hang: bootHarness must fail fast and skip when the
 * sibling relay-server is not installed (church-client CI only runs npm ci
 * in church-client/).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipCommandE2EReason, isRelayAvailable, waitFor } = require('./_e2e/harness');

test('skipCommandE2EReason is set when relay-server deps are missing', () => {
  if (isRelayAvailable()) {
    assert.equal(skipCommandE2EReason(), false);
    return;
  }
  assert.match(String(skipCommandE2EReason()), /relay-server/);
});

test('waitFor rethrows fatal errors immediately instead of retrying', async () => {
  const started = Date.now();
  const err = new Error('relay exited early');
  err.fatal = true;
  await assert.rejects(
    () => waitFor(async () => { throw err; }, { timeoutMs: 5000, label: 'fatal' }),
    /relay exited early/,
  );
  assert.ok(Date.now() - started < 500, 'fatal errors must not consume the wait timeout');
});
