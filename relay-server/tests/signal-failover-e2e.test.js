/**
 * End-to-End Integration Test — Signal Failover Full Round-Trip
 *
 * Simulates a complete failover lifecycle:
 *   HEALTHY → SUSPECTED_BLACK → CONFIRMED_OUTAGE → FAILOVER_ACTIVE → recovery → HEALTHY
 *
 * Mocks ATEM/Telegram but exercises the full state machine flow,
 * including multi-signal correlation, stability timer, and auto-recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalFailover, STATES, DEFAULTS } from '../src/signalFailover.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDb(config = {}) {
  const defaults = {
    failover_enabled: 1,
    failover_black_threshold_s: 5,
    failover_ack_timeout_s: 30,
    failover_action: JSON.stringify({ type: 'atem_switch', input: 3010 }),
    failover_auto_recover: 1,
    failover_audio_trigger: 1,
    td_telegram_chat_id: '12345',
    telegram_bot_token: 'bot:token',
    churchId: 'church-e2e',
  };
  const row = { ...defaults, ...config };
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(row),
      run: vi.fn(),
    }),
  };
}

function mockAlertEngine() {
  return {
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
    _calls: [],
  };
}

function mockAutoRecovery() {
  return {
    dispatchCommand: vi.fn().mockResolvedValue('ok'),
  };
}

function makeChurch(overrides = {}) {
  return {
    churchId: 'church-e2e',
    name: 'E2E Test Church',
    ws: { readyState: 1 },
    status: {
      atem: { connected: true, programInput: 1, streamingBitrate: 5000000 },
      encoder: { connected: true, live: true, bitrateKbps: 5000 },
    },
    ...overrides,
  };
}

function makeChurches(church) {
  const map = new Map();
  map.set(church.churchId, church);
  return map;
}

// ─── Full Round-Trip E2E ─────────────────────────────────────────────────────

describe('Signal Failover E2E — Full Round-Trip', () => {
  let failover, db, alertEngine, autoRecovery, church, churches;
  let transitions;

  beforeEach(() => {
    vi.useFakeTimers();
    db = mockDb();
    alertEngine = mockAlertEngine();
    autoRecovery = mockAutoRecovery();
    church = makeChurch();
    churches = makeChurches(church);
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);
    transitions = [];

    // Record every state transition for timeline verification
    failover.onTransition((churchId, from, to, trigger, snapshot) => {
      transitions.push({ churchId, from, to, trigger, diagnosis: snapshot.diagnosis?.type || null, ts: Date.now() });
    });
  });

  afterEach(() => {
    failover.cleanup('church-e2e');
    vi.useRealTimers();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Setup verification — church connected, ATEM connected, failover on
  // ──────────────────────────────────────────────────────────────────────────

  it('starts with correct initial setup: HEALTHY, ATEM connected, failover enabled', () => {
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);
    expect(church.status.atem.connected).toBe(true);
    expect(church.status.encoder.live).toBe(true);
    expect(church.status.encoder.bitrateKbps).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2-9. FULL FAILOVER → RECOVERY ROUND-TRIP
  // ──────────────────────────────────────────────────────────────────────────

  it('completes full failover round-trip: signal loss → failover → stability → auto-recovery', async () => {
    // ── Step 1: Verify initial state ──
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);

    // ── Step 2: Signal loss — encoder bitrate drops to 0 ──
    // Simulate ATEM program source going black (encoder sees no signal)
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', {
      church,
      bitrateKbps: 0,
      baselineKbps: 5000,
    });

    expect(failover.getState('church-e2e').state).toBe(STATES.SUSPECTED_BLACK);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe(STATES.HEALTHY);
    expect(transitions[0].to).toBe(STATES.SUSPECTED_BLACK);
    expect(transitions[0].trigger).toBe('encoder_bitrate_loss');

    // ── Step 3: Multi-signal correlation — black threshold timer elapses ──
    // After 5 seconds of confirmed black, state machine escalates
    vi.advanceTimersByTime(5000);

    expect(failover.getState('church-e2e').state).toBe(STATES.CONFIRMED_OUTAGE);
    // Diagnosis should indicate source_dead (encoder lost, ATEM still up)
    const diagAfterConfirm = failover.getState('church-e2e').diagnosis;
    expect(diagAfterConfirm).not.toBeNull();
    expect(diagAfterConfirm.type).toBe('source_dead');
    expect(diagAfterConfirm.switchWillHelp).toBe(true);

    // Telegram alert should have been sent to TD
    expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
    const confirmAlert = alertEngine.sendTelegramMessage.mock.calls.find(
      call => String(call[2]).includes('Stream Problem')
    );
    expect(confirmAlert).toBeDefined();

    // ── Step 4: State transition CONFIRMED → FAILOVER (ack timeout) ──
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();

    expect(failover.getState('church-e2e').state).toBe(STATES.FAILOVER_ACTIVE);

    // ── Step 5: Safe source switch — ATEM input change command sent ──
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ churchId: 'church-e2e' }),
      'atem.cut',
      { input: 3010 },
      null
    );

    // ── Step 6: Telegram alert sent for failover execution ──
    const failoverAlert = alertEngine.sendTelegramMessage.mock.calls.find(
      call => String(call[2]).includes('Switched to Backup')
    );
    expect(failoverAlert).toBeDefined();

    // ── Step 7: Source recovers — encoder comes back ──
    const alertCallsBefore = alertEngine.sendTelegramMessage.mock.calls.length;
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_recovered', {
      church,
      bitrateKbps: 5000,
    });

    // Should still be in FAILOVER_ACTIVE (stability timer running)
    expect(failover.getState('church-e2e').state).toBe(STATES.FAILOVER_ACTIVE);

    // Recovery-in-progress alert sent
    expect(alertEngine.sendTelegramMessage.mock.calls.length).toBeGreaterThan(alertCallsBefore);

    // ── Step 8: After 10s stability — auto-recovery triggers ──
    vi.advanceTimersByTime(DEFAULTS.stabilityTimerS * 1000);
    await vi.runAllTimersAsync();

    // ── Step 9: State returns to HEALTHY ──
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);

    // Recovery command should have been dispatched (switch back to original input)
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledTimes(2);
    const recoveryCalls = autoRecovery.dispatchCommand.mock.calls;
    const recoveryCall = recoveryCalls[1];
    expect(recoveryCall[1]).toBe('atem.cut');
    // Original source was input 1 (from church.status.atem.programInput)
    expect(recoveryCall[2].input).toBe(1);

    // Auto-recovered alert sent
    const recoveredAlert = alertEngine.sendTelegramMessage.mock.calls.find(
      call => String(call[2]).includes('Switched Back Automatically')
    );
    expect(recoveredAlert).toBeDefined();

    // ── Step 10: Verify full transition timeline ──
    // The state machine logs transitions via _logTransition. The black timer path
    // escalates directly from SUSPECTED_BLACK without an explicit SUSPECTED_BLACK→CONFIRMED_OUTAGE
    // log entry — it jumps to CONFIRMED_OUTAGE→FAILOVER_ACTIVE when the ack timer fires.
    const transitionSequence = transitions.map(t => `${t.from}→${t.to}`);
    expect(transitionSequence).toContain(`${STATES.HEALTHY}→${STATES.SUSPECTED_BLACK}`);
    expect(transitionSequence).toContain(`${STATES.CONFIRMED_OUTAGE}→${STATES.FAILOVER_ACTIVE}`);
    expect(transitionSequence).toContain(`${STATES.FAILOVER_ACTIVE}→${STATES.HEALTHY}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cascading failure fast-path: audio + encoder → skip timer
  // ──────────────────────────────────────────────────────────────────────────

  it('fast-tracks cascading failure when audio silence precedes encoder loss', async () => {
    // Audio goes silent first
    failover.onSignalEvent('church-e2e', 'audio_silence_sustained', { church, durationSec: 30 });
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);

    // Encoder drops — cascading diagnosis → skip black timer
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-e2e').state).toBe(STATES.CONFIRMED_OUTAGE);

    const diagnosis = failover.getState('church-e2e').diagnosis;
    expect(diagnosis.type).toBe('cascading');
    expect(diagnosis.confidence).toBeGreaterThan(0.9);

    // Ack timeout → failover
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();

    expect(failover.getState('church-e2e').state).toBe(STATES.FAILOVER_ACTIVE);
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledWith(
      expect.anything(),
      'atem.cut',
      { input: 3010 },
      null
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Network outage — switching won't help
  // ──────────────────────────────────────────────────────────────────────────

  it('does not auto-switch on network outage (ATEM + encoder both down)', async () => {
    const unhealthyChurch = makeChurch({
      status: {
        atem: { connected: false },
        encoder: { connected: true, live: true, bitrateKbps: 0 },
      },
    });
    churches.set('church-e2e', unhealthyChurch);

    failover.onSignalEvent('church-e2e', 'atem_lost', { church: unhealthyChurch });
    expect(failover.getState('church-e2e').state).toBe(STATES.CONFIRMED_OUTAGE);

    const diagnosis = failover.getState('church-e2e').diagnosis;
    expect(diagnosis.type).toBe('network_outage');
    expect(diagnosis.switchWillHelp).toBe(false);

    // Even after waiting a long time, failover command should NOT be dispatched
    vi.advanceTimersByTime(120000);
    await vi.runAllTimersAsync();

    expect(autoRecovery.dispatchCommand).not.toHaveBeenCalled();

    // But an alert WAS sent
    expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Brief glitch recovery — SUSPECTED_BLACK → HEALTHY
  // ──────────────────────────────────────────────────────────────────────────

  it('returns to HEALTHY on brief encoder glitch within threshold', () => {
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-e2e').state).toBe(STATES.SUSPECTED_BLACK);

    // Encoder recovers after 2s (before 5s threshold)
    vi.advanceTimersByTime(2000);
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });

    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);

    // No alerts sent for a brief glitch
    const confirmAlerts = alertEngine.sendTelegramMessage.mock.calls.filter(
      call => String(call[2]).includes('Stream Problem')
    );
    expect(confirmAlerts).toHaveLength(0);

    // No failover command
    expect(autoRecovery.dispatchCommand).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TD acknowledges during countdown → cancel auto-failover
  // ──────────────────────────────────────────────────────────────────────────

  it('TD ack during countdown cancels auto-failover, stays in CONFIRMED', async () => {
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000); // → CONFIRMED
    expect(failover.getState('church-e2e').state).toBe(STATES.CONFIRMED_OUTAGE);

    // TD acknowledges at 10s
    vi.advanceTimersByTime(10000);
    failover.onTdAcknowledge('church-e2e');

    // Wait past ack timeout — should NOT failover
    vi.advanceTimersByTime(60000);
    await vi.runAllTimersAsync();

    expect(failover.getState('church-e2e').state).toBe(STATES.CONFIRMED_OUTAGE);
    expect(autoRecovery.dispatchCommand).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TD manual recovery during auto-recover stability window
  // ──────────────────────────────────────────────────────────────────────────

  it('TD can manually recover during the stability window', async () => {
    // Get to FAILOVER_ACTIVE
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();
    expect(failover.getState('church-e2e').state).toBe(STATES.FAILOVER_ACTIVE);

    // Encoder recovers — stability timer starts
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });

    // TD manually confirms at 3s (before 10s stability window)
    vi.advanceTimersByTime(3000);
    await failover.onTdConfirmRecovery('church-e2e');

    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);

    // Stability timer fires later — no-op since already HEALTHY
    vi.advanceTimersByTime(7000);
    await vi.runAllTimersAsync();
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Source drops again during stability window → stay on safe source
  // ──────────────────────────────────────────────────────────────────────────

  it('stays on safe source if encoder drops again during stability window', async () => {
    // Get to FAILOVER_ACTIVE
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();
    expect(failover.getState('church-e2e').state).toBe(STATES.FAILOVER_ACTIVE);

    // Encoder recovers — stability timer starts
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });

    // Encoder goes unhealthy again before stability timer fires
    const unhealthyChurch = makeChurch({
      status: {
        atem: { connected: true, programInput: 3010 },
        encoder: { connected: true, live: true, bitrateKbps: 0 },
      },
    });
    churches.set('church-e2e', unhealthyChurch);

    // Stability timer fires — encoder NOT healthy → do NOT auto-recover
    vi.advanceTimersByTime(10000);
    await vi.runAllTimersAsync();

    expect(failover.getState('church-e2e').state).toBe(STATES.FAILOVER_ACTIVE);
    // Only the original failover command — no recovery
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ATEM-only loss — alert but no state machine escalation to failover
  // ──────────────────────────────────────────────────────────────────────────

  it('handles ATEM-only loss: alerts TD, does not failover', () => {
    failover.onSignalEvent('church-e2e', 'atem_lost', { church });
    expect(failover.getState('church-e2e').state).toBe(STATES.ATEM_LOST);

    const diagnosis = failover.getState('church-e2e').diagnosis;
    expect(diagnosis.type).toBe('atem_only');

    // Alert sent
    expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();

    // ATEM restored → back to HEALTHY
    failover.onSignalEvent('church-e2e', 'atem_restored', { church });
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Correlated failure: ATEM drops during SUSPECTED_BLACK → skip timer
  // ──────────────────────────────────────────────────────────────────────────

  it('skips remaining black timer when ATEM drops during SUSPECTED_BLACK', () => {
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-e2e').state).toBe(STATES.SUSPECTED_BLACK);

    // ATEM drops at 2s — correlated failure, skip remaining timer
    vi.advanceTimersByTime(2000);
    failover.onSignalEvent('church-e2e', 'atem_lost', { church });

    expect(failover.getState('church-e2e').state).toBe(STATES.CONFIRMED_OUTAGE);

    const diagnosis = failover.getState('church-e2e').diagnosis;
    expect(diagnosis.type).toBe('network_outage');
    expect(diagnosis.switchWillHelp).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Full transition timeline logged correctly
  // ──────────────────────────────────────────────────────────────────────────

  it('logs complete transition timeline with all expected entries', async () => {
    // Full round-trip
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();

    // Recover
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });
    vi.advanceTimersByTime(10000);
    await vi.runAllTimersAsync();

    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);

    // Check stateLog from the state machine itself
    // After reset, stateLog may be cleared — check transitions listener instead
    expect(transitions.length).toBeGreaterThanOrEqual(4);

    // Verify the sequence of transitions
    const sequence = transitions.map(t => t.to);
    expect(sequence).toContain(STATES.SUSPECTED_BLACK);
    expect(sequence).toContain(STATES.FAILOVER_ACTIVE);
    expect(sequence).toContain(STATES.HEALTHY);

    // Each transition should have churchId and trigger
    for (const t of transitions) {
      expect(t.churchId).toBe('church-e2e');
      expect(t.trigger).toBeTruthy();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Manual recovery mode (autoRecover = false)
  // ──────────────────────────────────────────────────────────────────────────

  it('stays in FAILOVER_ACTIVE when autoRecover is off, even after source recovers', async () => {
    db = mockDb({ failover_auto_recover: 0 });
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();
    expect(failover.getState('church-e2e').state).toBe(STATES.FAILOVER_ACTIVE);

    // Encoder recovers
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });

    // Wait well past stability timer
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();

    // Still in FAILOVER_ACTIVE — requires manual recovery
    expect(failover.getState('church-e2e').state).toBe(STATES.FAILOVER_ACTIVE);
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledTimes(1); // only failover, no recovery

    // TD manually recovers
    await failover.onTdConfirmRecovery('church-e2e');
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledTimes(2); // failover + recovery
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cleanup mid-failover — no stale timers
  // ──────────────────────────────────────────────────────────────────────────

  it('cleanup cancels all timers and removes state', () => {
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-e2e').state).toBe(STATES.SUSPECTED_BLACK);

    failover.cleanup('church-e2e');

    // State should be reset (fresh HEALTHY for a new query)
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);

    // Black timer should be cleared — advancing time should not change state
    vi.advanceTimersByTime(10000);
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Stream end resets everything
  // ──────────────────────────────────────────────────────────────────────────

  it('resetBaseline returns to HEALTHY from any state', () => {
    failover.onSignalEvent('church-e2e', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000); // → CONFIRMED
    expect(failover.getState('church-e2e').state).toBe(STATES.CONFIRMED_OUTAGE);

    failover.resetBaseline('church-e2e');
    expect(failover.getState('church-e2e').state).toBe(STATES.HEALTHY);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bitrate baseline tracking through status updates
  // ──────────────────────────────────────────────────────────────────────────

  it('builds bitrate baseline from status updates before failover', () => {
    failover.onStatusUpdate('church-e2e', { encoder: { bitrateKbps: 5000 } });
    failover.onStatusUpdate('church-e2e', { encoder: { bitrateKbps: 5100 } });
    failover.onStatusUpdate('church-e2e', { encoder: { bitrateKbps: 4900 } });

    const state = failover.getState('church-e2e');
    expect(state.bitrateBaseline).toBeCloseTo(5000, -1);
  });
});
