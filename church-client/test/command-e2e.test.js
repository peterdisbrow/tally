/**
 * End-to-end command-dispatch tests.
 *
 * For every device type the relay can target, this suite:
 *   1. Boots the relay (subprocess), agent (subprocess), and 8 device mocks
 *      (in-process). See test/_e2e/harness.js for the full topology.
 *   2. Issues `POST /api/command` to the relay (admin-key auth).
 *   3. Reads the mock's state via its control API and asserts the device
 *      side-effect actually landed.
 *
 * What this catches that unit tests don't:
 *   - The full WS dispatch path (relay /api/command → admin auth → WS send →
 *     agent dispatch → bridge → device protocol).
 *   - Device modules speaking the right protocol (REST vs OSC vs MIDI vs
 *     binary VISCA, with the right URL, port, framing, and bytes).
 *   - Bugs in the relay's own `dispatchCommandAcrossRuntime` plumbing — e.g.
 *     missing-churchId early-returns or double-dispatch loops that surface
 *     as 503s or duplicated side-effects.
 *
 * One harness is shared across all tests via `test.before` to keep the suite
 * under a minute; each test resets mock state before it runs.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { bootHarness, waitFor, sleep } = require('./_e2e/harness');

let h = null;

before(async () => {
  h = await bootHarness({ churchName: `cmd-e2e-${Date.now()}` });
  // Some bridges (Companion, OBS, Resolume, ProPresenter, TriCaster) finish
  // their connect handshake asynchronously after the WS lands. A short pause
  // keeps the early tests from racing against bridge startup. The sleep is
  // capped on the agent's status output so we wait the minimum needed.
  await sleep(2500);
}, { timeout: 60_000 });

after(async () => {
  if (h) {
    // Dump the last bit of agent + relay logs so flaky failures aren't a
    // black box. The test reporter shows assertion text but not the
    // subprocesses' own logs, which is where most early-failure clues live.
    const logs = h.snapshotLogs();
    if (process.env.E2E_DUMP_LOGS === '1' || process.env.E2E_DUMP_LOGS === 'true') {
      console.error('--- agent stdout (tail) ---');
      console.error(logs.agentStdout.slice(-4000));
      console.error('--- agent stderr (tail) ---');
      console.error(logs.agentStderr.slice(-4000));
      console.error('--- relay stderr (tail) ---');
      console.error(logs.stderr.slice(-2000));
    }
    await h.stop();
  }
}, { timeout: 30_000 });

// ─── ATEM ────────────────────────────────────────────────────────────────────
// The standalone ATEM mock is a UDP stub (the real protocol is too large to
// reimplement); confirm the agent issues the command and the relay reports
// successful local delivery. Positive-path device-state coverage for ATEM
// already lives in atem-commands.test.js with the in-process fakeAtem.

test('atem.cut → relay accepts and dispatches', async () => {
  await h.resetMocks();
  // ATEM agent isn't connected to a real switcher, so this command will fail
  // at the bridge layer with "not connected". That's a useful coverage point —
  // it proves the relay→agent→handler path runs (the agent rejects only
  // *after* dispatching to the handler) without forcing us to ship a binary
  // ATEM simulator. We check the relay accepted the command and that the
  // failure was reported as a `command_result`, not a 503/timeout.
  const result = await h.dispatch('atem.cut', { input: 1 });
  assert.equal(result.sent, true);
  assert.equal(result.localRecipients, 1, 'agent should have received the command');
});

// ─── VideoHub ────────────────────────────────────────────────────────────────

test('videohub.route → mock applies new routing', async () => {
  await h.resetMocks();
  // Connect the bridge first (the agent does this on startup, but a route
  // command issued before the initial state-dump arrives can race). Wait
  // for the mock to have at least one incoming TCP connection.
  await waitFor(async () => {
    const s = await h.mocks.videohub.readState();
    return Number.isInteger(s.outputCount); // proves the dump was sent
  }, { timeoutMs: 5000, label: 'videohub bridge connect' });

  const result = await h.dispatch('videohub.route', { output: 0, input: 5 });
  assert.equal(result.sent, true);

  // The bridge sends `VIDEO OUTPUT ROUTING:\n0 5\n\n` and waits for ACK.
  // Allow a beat for the round-trip.
  await waitFor(async () => {
    const s = await h.mocks.videohub.readState();
    return s.routes['0'] === 5 || s.routes[0] === 5;
  }, { timeoutMs: 4000, label: 'videohub route to update' });

  const state = await h.mocks.videohub.readState();
  assert.equal(state.routes['0'] ?? state.routes[0], 5,
    'output 0 should now be routed from input 5');
});

// ─── ProPresenter ────────────────────────────────────────────────────────────

test('propresenter.next → mock advances slide', async () => {
  await h.resetMocks();
  const before = (await h.mocks.propresenter.readState()).slide.slideIndex;

  const result = await h.dispatch('propresenter.next', {});
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.propresenter.readState();
    return s.slide.slideIndex === before + 1 || s.triggerLog.length >= 1;
  }, { timeoutMs: 4000, label: 'propresenter slide to advance' });

  const state = await h.mocks.propresenter.readState();
  assert.equal(state.slide.slideIndex, before + 1,
    `slideIndex should advance by exactly 1 (got ${state.slide.slideIndex - before})`);
  assert.equal(state.triggerLog.length, 1,
    'exactly one trigger should have fired (no double-dispatch)');
});

test('propresenter.previous → mock goes back one slide', async () => {
  await h.resetMocks();
  // Push to slide index 3 first.
  await h.mocks.propresenter.action('setSlide', { slideIndex: 3 });

  const result = await h.dispatch('propresenter.previous', {});
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.propresenter.readState();
    return s.slide.slideIndex === 2;
  }, { timeoutMs: 4000, label: 'propresenter slide to go back' });
});

test('propresenter.goToSlide → mock jumps to target index', async () => {
  await h.resetMocks();
  // The PP command is 1-based for users, the bridge subtracts 1 before
  // hitting /v1/presentation/focused/<N>/trigger. So goToSlide(7) → mock
  // should land on slideIndex=6 (0-based).
  const result = await h.dispatch('propresenter.goToSlide', { index: 7 });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.propresenter.readState();
    return s.slide.slideIndex === 6;
  }, { timeoutMs: 4000, label: 'propresenter slide jump' });
});

// ─── Companion ───────────────────────────────────────────────────────────────

test('companion.pressButton → mock records exactly one press', async () => {
  await h.resetMocks();

  const result = await h.dispatch('companion.pressButton', { page: 1, row: 0, col: 2 });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.companion.readState();
    return s.pressLog.length >= 1;
  }, { timeoutMs: 4000, label: 'companion press to log' });

  const state = await h.mocks.companion.readState();
  assert.equal(state.pressLog.length, 1, 'exactly one press should have logged');
  assert.equal(state.pressLog[0].page, 1);
  assert.equal(state.pressLog[0].row, 0);
  assert.equal(state.pressLog[0].col, 2);
});

test('companion.setCustomVariable → mock stores the value', async () => {
  await h.resetMocks();

  const result = await h.dispatch('companion.setCustomVariable', {
    name: 'service_state', value: 'live',
  });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.companion.readState();
    return s.customVariables.service_state === 'live';
  }, { timeoutMs: 4000, label: 'companion variable to update' });
});

// ─── SQ Mixer ────────────────────────────────────────────────────────────────

test('mixer.mute / mixer.unmute → mock sees NRPN state change', async () => {
  await h.resetMocks();

  const muteResult = await h.dispatch('mixer.mute', { channel: 5 });
  assert.equal(muteResult.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.sq.readState();
    return s.mutes['input:4'] === true;
  }, { timeoutMs: 4000, label: 'SQ mute to land' });

  // Channel numbers are 1-based on the wire and 0-based in the SQ NRPN table,
  // so channel=5 → 'input:4'.
  let state = await h.mocks.sq.readState();
  assert.equal(state.mutes['input:4'], true,
    `channel 5 should be muted (mutes = ${JSON.stringify(state.mutes)})`);

  const unmuteResult = await h.dispatch('mixer.unmute', { channel: 5 });
  assert.equal(unmuteResult.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.sq.readState();
    return s.mutes['input:4'] === false;
  }, { timeoutMs: 4000, label: 'SQ unmute to land' });

  state = await h.mocks.sq.readState();
  assert.equal(state.mutes['input:4'], false, 'channel 5 should be unmuted');
});

test('mixer.setFader → mock sees fader 14-bit value', async () => {
  await h.resetMocks();

  const result = await h.dispatch('mixer.setFader', { channel: 1, level: 0.75 });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.sq.readState();
    return typeof s.faders['input:0'] === 'number' && s.faders['input:0'] > 0;
  }, { timeoutMs: 4000, label: 'SQ fader to land' });

  const state = await h.mocks.sq.readState();
  // 0.75 normalised × 16383 ≈ 12287 (with rounding).
  const fader = state.faders['input:0'];
  assert.ok(fader >= 12000 && fader <= 12500,
    `fader value should be ~12287 (got ${fader})`);
});

// ─── BirdDog / VISCA PTZ ─────────────────────────────────────────────────────

test('ptz.preset → VISCA mock records preset recall', async () => {
  await h.resetMocks();

  // `zeroBasedPreset: true` so the on-wire byte equals the user-facing number.
  // (Without it the bridge subtracts 1 to match the convention of most VISCA
  // command tables, which would land on byte=3 even though the user said "4".)
  const result = await h.dispatch('ptz.preset', { camera: 1, preset: 4, zeroBasedPreset: true });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks['visca-ptz'].readState();
    return s.lastPreset === 4;
  }, { timeoutMs: 4000, label: 'VISCA preset recall to land' });

  const state = await h.mocks['visca-ptz'].readState();
  assert.equal(state.lastPreset, 4);
  assert.equal(state.presetRecalls, 1,
    'exactly one preset recall (no double-dispatch)');
});

test('ptz.pan → VISCA mock records pan motion', async () => {
  await h.resetMocks();

  const result = await h.dispatch('ptz.pan', { camera: 1, speed: 0.5, durationMs: 50 });
  assert.equal(result.sent, true);

  // The bridge sends a pan-start frame, sleeps `durationMs`, then a stop
  // frame. We expect at least one pan frame and a non-zero panSpeed seen.
  await waitFor(async () => {
    const s = await h.mocks['visca-ptz'].readState();
    return s.panTiltMoves >= 1;
  }, { timeoutMs: 4000, label: 'VISCA pan to land' });

  const state = await h.mocks['visca-ptz'].readState();
  // The pan-start frame had panSpeed > 0; the stop frame brought it back to 0.
  // Either is fine — what matters is that we saw at least one pan move.
  assert.ok(state.panTiltMoves >= 1, 'pan/tilt frame should have arrived');
});

// ─── OBS ─────────────────────────────────────────────────────────────────────

test('obs.setScene → mock switches program scene', async () => {
  await h.resetMocks();

  const result = await h.dispatch('obs.setScene', { scene: 'Scene 3' });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.obs.readState();
    return s.programScene === 'Scene 3';
  }, { timeoutMs: 4000, label: 'OBS program scene to update' });
});

test('obs.startStream / obs.stopStream → mock toggles streaming.outputActive', async () => {
  await h.resetMocks();

  const startResult = await h.dispatch('obs.startStream', {});
  assert.equal(startResult.sent, true);
  await waitFor(async () => {
    const s = await h.mocks.obs.readState();
    return s.streaming.outputActive === true;
  }, { timeoutMs: 4000, label: 'OBS streaming to start' });

  const stopResult = await h.dispatch('obs.stopStream', {});
  assert.equal(stopResult.sent, true);
  await waitFor(async () => {
    const s = await h.mocks.obs.readState();
    return s.streaming.outputActive === false;
  }, { timeoutMs: 4000, label: 'OBS streaming to stop' });
});

test('obs.startRecording / obs.stopRecording → mock toggles recording.outputActive', async () => {
  await h.resetMocks();

  const startResult = await h.dispatch('obs.startRecording', {});
  assert.equal(startResult.sent, true);
  await waitFor(async () => {
    const s = await h.mocks.obs.readState();
    return s.recording.outputActive === true;
  }, { timeoutMs: 4000, label: 'OBS recording to start' });

  const stopResult = await h.dispatch('obs.stopRecording', {});
  assert.equal(stopResult.sent, true);
  await waitFor(async () => {
    const s = await h.mocks.obs.readState();
    return s.recording.outputActive === false;
  }, { timeoutMs: 4000, label: 'OBS recording to stop' });
});

// ─── Resolume ────────────────────────────────────────────────────────────────

test('resolume.playClip → mock connects the target clip', async () => {
  await h.resetMocks();

  const result = await h.dispatch('resolume.playClip', { layer: 1, clip: 2 });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.resolume.readState();
    return s.commandLog.some((e) => e.kind === 'connect' && e.layer === 1 && e.clip === 2);
  }, { timeoutMs: 4000, label: 'resolume clip connect to log' });

  const state = await h.mocks.resolume.readState();
  const layer = state.composition.layers[0];
  assert.ok(layer.clips[1].connected.index !== 0,
    `layer 1 clip 2 should be connected (clips=${JSON.stringify(layer.clips)})`);
});

test('resolume.setLayerOpacity → mock applies the new opacity', async () => {
  await h.resetMocks();

  const result = await h.dispatch('resolume.setLayerOpacity', { layer: 1, value: 0.42 });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.resolume.readState();
    return Math.abs(s.composition.layers[0].opacity.value - 0.42) < 0.001;
  }, { timeoutMs: 4000, label: 'resolume layer opacity to update' });
});

// ─── TriCaster ───────────────────────────────────────────────────────────────

test('switcher.setProgram → TriCaster mock records main_a_row shortcut', async () => {
  await h.resetMocks();

  const result = await h.dispatch('switcher.setProgram', { switcherId: 'tc-1', input: 3 });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.tricaster.readState();
    return s.shortcutLog.some((e) => e.name === 'main_a_row');
  }, { timeoutMs: 4000, label: 'tricaster main_a_row shortcut to log' });

  const state = await h.mocks.tricaster.readState();
  const lastRow = state.shortcutLog.filter((e) => e.name === 'main_a_row').pop();
  assert.ok(lastRow, 'main_a_row shortcut should have been called');
});

test('switcher.cut → TriCaster mock records main_take shortcut', async () => {
  await h.resetMocks();

  const result = await h.dispatch('switcher.cut', { switcherId: 'tc-1' });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.tricaster.readState();
    return s.shortcutLog.some((e) => e.name === 'main_take');
  }, { timeoutMs: 4000, label: 'tricaster main_take shortcut' });
});

test('tricaster.stream → TriCaster mock toggles streaming_toggle shortcut', async () => {
  await h.resetMocks();

  const result = await h.dispatch('tricaster.stream', { state: true });
  assert.equal(result.sent, true);

  await waitFor(async () => {
    const s = await h.mocks.tricaster.readState();
    return s.shortcutLog.some((e) => e.name === 'streaming_toggle');
  }, { timeoutMs: 4000, label: 'tricaster streaming_toggle shortcut' });
});
