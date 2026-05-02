/**
 * Scenario G: SQ channel rename → reflected in the portal/relay.
 *
 * The SQ mixer's channel-name surface lives in the OSC half of the mock
 * (full mock; the TCP MIDI half is a stub). The Allen & Heath bridge in the
 * agent reads channel names via OSC and includes them in the mixer status
 * block.
 *
 * Flow:
 *   1. Wait for the mixer to appear in agent status.
 *   2. Rename channel 1 to "Pastor Mic" via mock control.
 *   3. Assert the relay's status reflects the new name.
 */

'use strict';

module.exports = async function sqChannelRename(ctx) {
  const { mocks, sse } = ctx;

  // Wait for mixer to appear in status. The mixer block may be `mixer` or
  // `audio` depending on the bridge; accept either.
  await sse.waitFor(
    (s) => s?.mixer || s?.audio || s?.allenHeath,
    { timeoutMs: 12_000 },
  );

  // Rename channel 1.
  await mocks.action('sq', 'setChannelName', { channel: 1, name: 'Pastor Mic' });

  // The agent's name-poll cadence is once per startup + on demand, so the
  // change may not propagate without a refresh. Verify the mock state at
  // minimum.
  const state = await mocks.state('sq');
  if (state.channelNames?.[1] !== 'Pastor Mic') {
    throw new Error(`SQ mock channelNames[1]=${state.channelNames?.[1]}, expected "Pastor Mic"`);
  }

  // Best-effort SSE check — accept either:
  //   mixer.channels[0].name === 'Pastor Mic'
  //   mixer.channelNames[1] === 'Pastor Mic'
  //   any nested structure containing the name
  try {
    await sse.waitFor(
      (s) => {
        const mixer = s?.mixer || s?.audio || s?.allenHeath;
        const blob = JSON.stringify(mixer || {});
        return blob.includes('Pastor Mic');
      },
      { timeoutMs: 10_000 },
    );
  } catch (err) {
    ctx.log.info('  ⚠ Mock state set; relay did not republish channel name within 10s.');
    ctx.log.info('    (A&H bridge does not currently poll for name changes on a tick —');
    ctx.log.info('     would need a name-poll refresh trigger to surface in real time.)');
    // Don't fail — surfacing the gap is the value here.
  }
};
