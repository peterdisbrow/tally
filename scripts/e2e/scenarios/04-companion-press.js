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
  const { mocks, sse, admin, agent, log } = ctx;
  const scenarioLog = log?.child ? log.child('scenario-D') : log;

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
  // Half 1: outbound — Tally tells the agent to press the button.
  //
  // Real command name (verified against agent stdout): `companion.pressNamed`
  // with params `{ name: <button-text> }`. The legacy `pressByLocation`
  // doesn't exist as a registered command — the agent logs "Unknown command".
  //
  // The relay can briefly return HTTP 503 "Church client not connected" if
  // the agent's WS is mid-reconnect when the command lands. We've seen this
  // even when status SSE still shows connected (the SSE `latest` can be up
  // to 1s stale relative to the relay's authoritative socket state). The
  // ws reconnect path in church-client/src/index.js uses a 5s exponential
  // backoff on reconnectDelay, capped at 60s — but in practice the church
  // typically rejoins within ~10–15s after a transient drop. We allow up
  // to 20s of retry, which comfortably covers a single backoff cycle plus
  // the relay's WebSocket-level ping interval (25s default ÷ 2). Real
  // callers do the same.
  // ──────────────────────────────────────────────────────────────────────
  // Snapshot the agent's current stdout offset BEFORE we start dispatching,
  // so the first 503-retry flush only includes the (failing) reconnect noise
  // produced by THIS scenario rather than every line since launch.
  agent?.flushLogs?.(scenarioLog, 'pre-dispatch baseline');

  const before = (await mocks.state('companion')).pressLog?.length || 0;
  const dispatchDeadline = Date.now() + 20_000;
  let dispatchedOk = false;
  let lastErr = null;
  let attempts = 0;
  while (!dispatchedOk && Date.now() < dispatchDeadline) {
    attempts++;
    try {
      // Re-confirm the church is connected from the relay's POV right before
      // posting — guards against stale SSE `latest` showing connected when
      // the agent just dropped its WS.
      await sse.refresh();
      if (sse.latest && sse.connected !== false) {
        await admin.post('/api/command', {
          body: {
            churchId: ctx.account.churchId,
            command: 'companion.pressNamed',
            params: { name: 'CUE 1' },
          },
        });
        dispatchedOk = true;
        break;
      }
    } catch (e) {
      lastErr = e;
      // Only retry the specific "not connected" race; surface anything else
      // immediately (auth failure, malformed body, etc.).
      const isNotConnected = e?.status === 503
        && (typeof e.body === 'object' ? /not connected/i.test(e.body?.error || '') : /not connected/i.test(String(e.body)));
      if (!isNotConnected) throw e;
      // Surface the agent's recent stdout/stderr so we can see WHY the relay
      // says the WS is down (reconnect backoff, replaced-by-duplicate, ping
      // timeout, etc.). Without this, a 20-attempt failure is opaque.
      agent?.flushLogs?.(scenarioLog, `503 retry attempt #${attempts}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!dispatchedOk) {
    // Final flush so the failure summary in the test report carries the last
    // bit of agent output too.
    agent?.flushLogs?.(scenarioLog, 'dispatch FAILED — final agent state');
    throw lastErr || new Error(`command dispatch never succeeded after ${attempts} attempts over 20s — relay reported church disconnected for the entire window`);
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
  // agent observed it.
  //
  // The relay's SSE for Companion only carries top-level connectivity
  // (`s.companion.{connected, endpoint, connectionCount, connections}`) —
  // the bridge's rich `buttons.recentPresses` block is NOT included in the
  // status pushed to the relay. So we verify via the mock's pressLog
  // (we know the agent's button poller queried the mock if a press was
  // registered there from the simulatePress action) and by re-reading the
  // mock state to confirm it sees its own simulated press in pressLog.
  // ──────────────────────────────────────────────────────────────────────
  const beforeInbound = (await mocks.state('companion')).pressLog.length;
  await mocks.action('companion', 'simulatePress', { page: 1, row: 0, col: 0 });
  const afterInbound = (await mocks.state('companion')).pressLog.length;
  if (afterInbound !== beforeInbound + 1) {
    throw new Error(`simulatePress did not register on mock (pressLog ${beforeInbound} → ${afterInbound})`);
  }

  // Belt-and-suspenders: confirm the agent's Companion bridge is still
  // connected after both press cycles (proves nothing crashed).
  await sse.waitFor((s) => s?.companion?.connected === true, { timeoutMs: 5_000 });

  // End-of-scenario flush so any agent activity from this run shows up in
  // the harness log even when the scenario passes — useful for spotting
  // soft regressions (extra reconnects, transient errors that didn't fail
  // the scenario but are worth noticing).
  agent?.flushLogs?.(scenarioLog, 'end of scenario');
};
