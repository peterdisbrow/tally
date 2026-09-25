/**
 * Scenario G: SQ master mute on the console surface → visible through the relay.
 *
 * The Allen & Heath SQ speaks only MIDI over TCP (51325). The mock transmits
 * surface changes to connected clients exactly like the desk does, and answers
 * the driver's GET polls. (The old version of this scenario "renamed a channel
 * over OSC" — the SQ has no OSC — and passed without checking anything real.)
 *
 * Flow:
 *   1. Wait for the SQ to be connected and its master mute known (false).
 *   2. Mute LR on the "surface" via mock control.
 *   3. FAIL unless the relay's status shows mixer.mainMuted === true.
 *   4. Unmute, FAIL unless it goes back to false.
 */

'use strict';

module.exports = async function sqMasterMute(ctx) {
  const { mocks, sse } = ctx;

  await sse.waitFor((s) => s?.mixer?.connected === true && s?.mixer?.mainMuted === false, { timeoutMs: 20_000 });

  await mocks.action('sq', 'surfaceSet', { key: 'mute:lr:0', value: 1 });
  await sse.waitFor((s) => s?.mixer?.mainMuted === true, { timeoutMs: 15_000 });

  await mocks.action('sq', 'surfaceSet', { key: 'mute:lr:0', value: 0 });
  await sse.waitFor((s) => s?.mixer?.mainMuted === false, { timeoutMs: 15_000 });
};
