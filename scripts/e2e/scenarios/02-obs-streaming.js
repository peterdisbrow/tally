/**
 * Scenario B: OBS goes live → relay reports streaming + stream stats.
 *
 * Flow:
 *   1. Verify OBS is connected from the agent's POV (initial status).
 *   2. Flip outputActive=true on the OBS mock.
 *   3. Assert the agent's next status push has obs.streaming === true.
 *   4. Verify the bridge mirrored some of the canned stats (cpuUsage, fps).
 */

'use strict';

module.exports = async function obsStreaming(ctx) {
  const { mocks, sse } = ctx;

  // Initial: OBS connected. (Requires encoder.type='obs' in equipment
  // config — see lib/spawnAgent.js for why.)
  await sse.waitFor(
    (s) => s?.obs?.connected === true,
    { timeoutMs: 15_000 },
  );

  // Flip the streaming switch.
  await mocks.action('obs', 'setStreaming', { active: true });

  // Wait for the agent's WebSocket-driven status update to propagate.
  // Real shape (verified): s.obs.streaming is a boolean.
  await sse.waitFor(
    (s) => s?.obs?.streaming === true,
    { timeoutMs: 10_000 },
  );

  // Stat surface — the OBS bridge polls GetStats periodically. Real SSE
  // shape (verified): fps + bitrate live on s.obs; cpuUsage lives on
  // s.encoder (which is OBS in our config). Accept either source.
  // Mock returns canned non-zero stats so ANY non-null indicates the
  // stat plumbing works end-to-end.
  await sse.waitFor(
    (s) => {
      const fps = s?.obs?.fps ?? s?.encoder?.fps;
      const cpu = s?.encoder?.cpuUsage;
      return (typeof fps === 'number' && fps > 0) || (typeof cpu === 'number' && cpu > 0);
    },
    { timeoutMs: 15_000 },
  );

  // Stop streaming and assert the off transition lands too — proves the
  // round-trip isn't a one-way latch.
  await mocks.action('obs', 'setStreaming', { active: false });
  await sse.waitFor(
    (s) => s?.obs?.streaming === false,
    { timeoutMs: 10_000 },
  );
};
