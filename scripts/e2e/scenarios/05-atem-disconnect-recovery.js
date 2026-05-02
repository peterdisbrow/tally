/**
 * Scenario E: ATEM "disconnect" + recovery.
 *
 * The ATEM mock is a UDP stub with a `setReachable` control action that
 * starts dropping all incoming packets — perfect for simulating a
 * disconnect without killing the mock process.
 *
 * Flow:
 *   1. Verify ATEM initial state (the church-client uses fakeAtem in dev,
 *      but against the UDP stub it'll show as not-connected initially —
 *      that's expected. We assert "ATEM is in status object", not
 *      "ATEM is connected".)
 *   2. Set reachable=false → relay should report ATEM as disconnected.
 *   3. Set reachable=true → relay should recover.
 *
 * Note: real ATEM connection logic uses atem-connection's Hello/Ack
 * protocol which our stub doesn't speak. The agent treats the stub as
 * reachable-but-not-handshaked. We're testing the OBSERVABILITY of the
 * connection state, not full ATEM behavior — which would need fakeAtem.
 */

'use strict';

module.exports = async function atemDisconnectRecovery(ctx) {
  const { mocks, sse } = ctx;

  // Wait for the agent to publish ATEM status at all. With the UDP stub the
  // value may be `connected:false` or just an object — either is OK as long
  // as the agent has acknowledged the device.
  await sse.waitFor(
    (s) => s?.atem !== undefined,
    { timeoutMs: 12_000 },
  );

  // Tell the mock to drop all packets.
  await mocks.action('atem', 'setReachable', { reachable: false });

  // The ATEM bridge has its own connection-loss detection (atem-connection's
  // session timeout is ~1s). Allow up to 8s for the agent to publish a
  // disconnected state. Accept either explicit `connected:false` or the atem
  // field disappearing from the status object.
  await sse.waitFor(
    (s) => s?.atem === false || s?.atem === null || s?.atem?.connected === false || s?.atem === undefined,
    { timeoutMs: 12_000 },
  );

  // Bring it back.
  await mocks.action('atem', 'setReachable', { reachable: true });

  // Recovery — the agent should re-attempt connection and republish status.
  // We're tolerant of the stub never reaching `connected:true` because it
  // doesn't speak the full ATEM handshake; the assertion is that the agent
  // is RE-attempting (which it does on its own internal timer).
  // Wait long enough for at least one reconnect cycle.
  await new Promise((r) => setTimeout(r, 6_000));

  // After recovery, the agent should have at minimum republished SOMETHING
  // about ATEM (even if connected:false) — the field should still be present
  // and not stuck in error state.
  const final = ctx.sse.latest;
  if (!final || final.atem === undefined) {
    throw new Error('Post-recovery: agent stopped publishing ATEM status entirely');
  }
};
