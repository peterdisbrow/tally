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

  // Initial: OBS connected.
  await sse.waitFor(
    (s) => s?.obs?.connected === true,
    { timeoutMs: 12_000 },
  );

  // Flip the streaming switch.
  await mocks.action('obs', 'setStreaming', { active: true });

  // Wait for the agent's WebSocket-driven status update to propagate.
  await sse.waitFor(
    (s) => s?.obs?.streaming === true || s?.streaming === true,
    { timeoutMs: 10_000 },
  );

  // Stat surface — the OBS bridge polls GetStats periodically; allow time for
  // a poll. We don't assert exact numbers (mock returns canned values) but
  // ANY non-null fps/cpu indicates the stat plumbing works end-to-end.
  await sse.waitFor(
    (s) => {
      const fps = s?.obs?.fps ?? s?.fps;
      const cpu = s?.obs?.cpuUsage ?? s?.cpuUsage;
      return (typeof fps === 'number' && fps > 0) || (typeof cpu === 'number' && cpu > 0);
    },
    { timeoutMs: 12_000 },
  );

  // Stop streaming and assert the off transition lands too — proves the
  // round-trip isn't a one-way latch.
  await mocks.action('obs', 'setStreaming', { active: false });
  await sse.waitFor(
    (s) => s?.obs?.streaming === false,
    { timeoutMs: 10_000 },
  );
};
