'use strict';

/**
 * Mock device server harness for TallyConnect integration tests.
 *
 * Re-exports all individual mocks plus a convenience helper that starts
 * everything at once and returns the running instances with their ports.
 *
 * Usage:
 *   const { startAll, stopAll } = require('../mock-devices');
 *
 *   let mocks;
 *   before(async () => { mocks = await startAll(); });
 *   after(async  () => { await stopAll(mocks); });
 */

const { MockVideoHub }   = require('./videohub');
const { MockAllenHeath } = require('./allenheath');
const { MockAtem }       = require('./atem');
const { MockVmix }       = require('./vmix');
const { MockBirdDog }    = require('./birddog');

/**
 * Start all mock servers on random available ports.
 *
 * @returns {Promise<{
 *   videoHub:    MockVideoHub   & { port: number },
 *   allenHeath:  MockAllenHeath & { port: number },
 *   atem:        MockAtem       & { port: number },
 *   vmix:        MockVmix       & { port: number },
 *   birdDog:     MockBirdDog    & { port: number, viscaPort: number },
 * }>}
 */
async function startAll() {
  const videoHub   = new MockVideoHub();
  const allenHeath = new MockAllenHeath();
  const atem       = new MockAtem();
  const vmix       = new MockVmix();
  const birdDog    = new MockBirdDog();

  await Promise.all([
    videoHub.start(),
    allenHeath.start(),
    atem.start(),
    vmix.start(),
    birdDog.start(),
  ]);

  return { videoHub, allenHeath, atem, vmix, birdDog };
}

/**
 * Stop all running mock servers.
 * @param {{ videoHub, allenHeath, atem, vmix, birdDog }} mocks
 */
async function stopAll(mocks) {
  if (!mocks) return;
  await Promise.all([
    mocks.videoHub?.stop(),
    mocks.allenHeath?.stop(),
    mocks.atem?.stop(),
    mocks.vmix?.stop(),
    mocks.birdDog?.stop(),
  ]);
}

module.exports = {
  MockVideoHub,
  MockAllenHeath,
  MockAtem,
  MockVmix,
  MockBirdDog,
  startAll,
  stopAll,
};
