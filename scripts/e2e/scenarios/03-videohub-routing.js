/**
 * Scenario C: VideoHub route change reflects in the portal status.
 *
 * Flow:
 *   1. Wait for the agent's initial VideoHub state to land in SSE.
 *   2. Drive setRoute(output=2, input=5) via mock control — mock broadcasts
 *      the new ROUTE block to all TCP clients.
 *   3. The agent re-parses + republishes status; assert SSE reflects it.
 */

'use strict';

module.exports = async function videohubRouting(ctx) {
  const { mocks, sse } = ctx;

  // Initial connection — agent has the videoHubs[] populated.
  await sse.waitFor(
    (s) => Array.isArray(s?.videoHubs) && s.videoHubs.length > 0 && s.videoHubs[0]?.connected === true,
    { timeoutMs: 12_000 },
  );

  // Drive a route change (output 2 → input 5).
  await mocks.action('videohub', 'setRoute', { output: 2, input: 5 });

  // Assert SSE reflects it. VideoHub status shape may use `routes` Map or
  // an array of `{output, input}` — accept either.
  await sse.waitFor(
    (s) => {
      const hub = s?.videoHubs?.[0];
      if (!hub) return false;
      if (hub.routes && typeof hub.routes === 'object') {
        const r = hub.routes[2] ?? hub.routes['2'];
        return r === 5;
      }
      if (Array.isArray(hub.routes)) {
        return hub.routes.some((r) => r.output === 2 && r.input === 5);
      }
      return false;
    },
    { timeoutMs: 10_000 },
  );

  // Verify the mock recorded the change too (catches false positives where
  // the relay reports stale state).
  const mockState = await mocks.state('videohub');
  if (mockState.routes?.[2] !== 5 && mockState.routes?.['2'] !== 5) {
    throw new Error(`Mock routes[2]=${mockState.routes?.[2]}, expected 5`);
  }
};
