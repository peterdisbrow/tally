/**
 * Scenario D: Companion button press dispatched + observed.
 *
 * Two halves:
 *   1. Tally → Companion (outbound): send a press command via the relay's
 *      command-dispatch path and verify Companion mock recorded it.
 *   2. Companion → Tally (inbound): simulate a press on the mock and verify
 *      the agent's button-poll loop observes it (recentPresses populated).
 *
 * Verifies the bridge works in BOTH directions, since Companion is one of
 * the few devices where the agent both sends commands and listens for state.
 */

'use strict';

module.exports = async function companionPress(ctx) {
  const { mocks, sse, admin } = ctx;

  // Initial: Companion bridge connected.
  await sse.waitFor(
    (s) => s?.companion?.connected === true,
    { timeoutMs: 12_000 },
  );

  // Seed a labeled button so name-based dispatch works.
  await mocks.action('companion', 'setButton', {
    page: 1, row: 0, col: 0, text: 'CUE 1',
  });

  // ──────────────────────────────────────────────────────────────────────
  // Half 1: outbound — Tally tells the agent to press CUE 1.
  // The admin command endpoint is /api/command (admin-key auth, server.js
  // documented this path in the agent investigation).
  // ──────────────────────────────────────────────────────────────────────
  const before = (await mocks.state('companion')).pressLog?.length || 0;
  try {
    await admin.post('/api/command', {
      body: {
        churchId: ctx.account.churchId,
        command: 'companion.pressByLocation',
        params: { page: 1, row: 0, col: 0 },
      },
    });
  } catch (err) {
    // Some relay deployments use 'companion.press' or 'companion.pressNamed'.
    // Try the named alternative; if both fail the bridge surface is missing.
    try {
      await admin.post('/api/command', {
        body: {
          churchId: ctx.account.churchId,
          command: 'companion.pressNamed',
          params: { name: 'CUE 1' },
        },
      });
    } catch (err2) {
      throw new Error(`Both companion.pressByLocation and companion.pressNamed failed: ${err.message} / ${err2.message}`);
    }
  }

  // Wait for the press to land on the mock.
  const deadline = Date.now() + 8_000;
  let after = before;
  while (Date.now() < deadline && after === before) {
    await new Promise((r) => setTimeout(r, 200));
    after = (await mocks.state('companion')).pressLog?.length || 0;
  }
  if (after === before) {
    throw new Error(`Companion mock did not record an outbound press (pressLog still ${before})`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Half 2: inbound — simulate a press from the device side and verify the
  // agent's button-poll loop reports it back.
  // ──────────────────────────────────────────────────────────────────────
  await mocks.action('companion', 'simulatePress', { page: 1, row: 0, col: 0 });

  // The Companion bridge's pollButtonStates runs every 1s; allow 5s.
  await sse.waitFor(
    (s) => {
      const recent = s?.companion?.buttons?.recentPresses;
      return Array.isArray(recent) && recent.some((p) => p.page === 1 && p.row === 0 && p.column === 0);
    },
    { timeoutMs: 10_000 },
  );
};
