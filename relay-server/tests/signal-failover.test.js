import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalFailover, STATES, DEFAULTS } from '../src/signalFailover.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDb(config = {}) {
  const defaults = {
    failover_enabled: 1,
    failover_black_threshold_s: 5,
    failover_ack_timeout_s: 30,
    failover_action: JSON.stringify({ type: 'atem_switch', input: 3010 }),
    failover_auto_recover: 0,
    failover_audio_trigger: 0,
    td_telegram_chat_id: '12345',
    telegram_bot_token: 'bot:token',
    churchId: 'church-1',
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
  };
}

function mockAutoRecovery() {
  return {
    dispatchCommand: vi.fn().mockResolvedValue('ok'),
  };
}

function mockChurch(overrides = {}) {
  return {
    churchId: 'church-1',
    name: 'Test Church',
    ws: { readyState: 1 },
    status: {
      atem: { connected: true, programInput: 1, streamingBitrate: 5000000 },
      encoder: { connected: true, live: true, bitrateKbps: 5000 },
    },
    ...overrides,
  };
}

function mockChurches(church) {
  const map = new Map();
  map.set(church.churchId, church);
  return map;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SignalFailover', () => {
  let failover, db, alertEngine, autoRecovery, church, churches;

  beforeEach(() => {
    vi.useFakeTimers();
    db = mockDb();
    alertEngine = mockAlertEngine();
    autoRecovery = mockAutoRecovery();
    church = mockChurch();
    churches = mockChurches(church);
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);
  });

  afterEach(() => {
    failover.cleanup('church-1');
    vi.useRealTimers();
  });

  // ── Basic State ──────────────────────────────────────────────────────────

  it('starts in HEALTHY state', () => {
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });

  it('does nothing when failover is not enabled', () => {
    db = mockDb({ failover_enabled: 0 });
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });

  it('does nothing when failover_action is not configured', () => {
    db = mockDb({ failover_action: null });
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });

  // ── HEALTHY → SUSPECTED_BLACK → HEALTHY ──────────────────────────────────

  it('transitions to SUSPECTED_BLACK on encoder bitrate loss', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);
  });

  it('returns to HEALTHY when encoder recovers strongly (>80% of baseline) within threshold', () => {
    // Feed 3 status updates to establish a baseline of ~5000 kbps
    for (let i = 0; i < 3; i++) {
      failover.onStatusUpdate('church-1', { encoder: { bitrateKbps: 5000 } });
    }

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    // Strong recovery: 4500 kbps = 90% of 5000 baseline → cancels timer
    vi.advanceTimersByTime(3000);
    failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 4500 });
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });

  it('stays in SUSPECTED_BLACK on weak recovery (50-80% of baseline)', () => {
    // Establish baseline of ~4345 kbps
    for (let i = 0; i < 3; i++) {
      failover.onStatusUpdate('church-1', { encoder: { bitrateKbps: 4345 } });
    }

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    // Weak recovery: 2328 kbps = 54% of 4345 baseline → timer keeps running
    vi.advanceTimersByTime(3000);
    failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 2328 });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);
  });

  it('escalates to CONFIRMED_OUTAGE after weak recovery when timer fires', () => {
    // Establish baseline of ~4345 kbps
    for (let i = 0; i < 3; i++) {
      failover.onStatusUpdate('church-1', { encoder: { bitrateKbps: 4345 } });
    }

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    // Weak recovery at 2s — timer should keep running
    vi.advanceTimersByTime(2000);
    failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 2328 });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    // Timer fires at 5s — should escalate to CONFIRMED_OUTAGE
    vi.advanceTimersByTime(3000);
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
    expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
  });

  it('weak recovery followed by timer fires ATEM switch after ack timeout', async () => {
    db = mockDb({ failover_ack_timeout_s: 10 });
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);
    // Establish baseline of ~4345 kbps
    for (let i = 0; i < 3; i++) {
      failover.onStatusUpdate('church-1', { encoder: { bitrateKbps: 4345 } });
    }

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });

    // Weak recovery at 54% — doesn't cancel timer
    vi.advanceTimersByTime(2000);
    failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 2328 });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    // Black timer fires at 5s → CONFIRMED_OUTAGE
    vi.advanceTimersByTime(3000);
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);

    // Ack timeout fires at 10s → should execute failover (ATEM switch)
    await vi.advanceTimersByTimeAsync(10000);
    expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledWith(
      church, 'atem.cut', { input: 3010 }, null
    );
  });

  it('returns to HEALTHY on recovery when no baseline is set (backward compat)', () => {
    // No baseline set — ratio defaults to 1.0 (strong), so any recovery cancels
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    vi.advanceTimersByTime(3000);
    failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });

  // ── SUSPECTED_BLACK → CONFIRMED_OUTAGE (timer) ──────────────────────────

  it('escalates to CONFIRMED_OUTAGE after black threshold elapses', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    vi.advanceTimersByTime(5000);
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
    expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
  });

  it('uses custom black threshold from config', () => {
    db = mockDb({ failover_black_threshold_s: 10 });
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });

    // Not yet at 5s
    vi.advanceTimersByTime(5000);
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    // Now at 10s
    vi.advanceTimersByTime(5000);
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
  });

  // ── SUSPECTED_BLACK → CONFIRMED_OUTAGE (ATEM also drops) ────────────────

  it('escalates immediately when ATEM drops during suspected black', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    // ATEM drops at 2s — should escalate immediately without waiting for 5s
    vi.advanceTimersByTime(2000);
    failover.onSignalEvent('church-1', 'atem_lost', { church });
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
  });

  // ── HEALTHY → ATEM_LOST (encoder ok) ─────────────────────────────────────

  it('transitions to ATEM_LOST when ATEM drops but encoder is healthy', () => {
    failover.onSignalEvent('church-1', 'atem_lost', { church });
    expect(failover.getState('church-1').state).toBe(STATES.ATEM_LOST);
    expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
  });

  it('returns to HEALTHY when ATEM reconnects from ATEM_LOST', () => {
    failover.onSignalEvent('church-1', 'atem_lost', { church });
    expect(failover.getState('church-1').state).toBe(STATES.ATEM_LOST);

    failover.onSignalEvent('church-1', 'atem_restored', { church });
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });

  // ── ATEM_LOST → CONFIRMED_OUTAGE (encoder then drops) ───────────────────

  it('escalates to CONFIRMED when encoder drops after ATEM is already lost', () => {
    failover.onSignalEvent('church-1', 'atem_lost', { church });
    expect(failover.getState('church-1').state).toBe(STATES.ATEM_LOST);

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
  });

  // ── Simultaneous loss → CONFIRMED_OUTAGE (skip timer) ───────────────────

  it('skips black timer on simultaneous ATEM + encoder loss', () => {
    // Set encoder as unhealthy before ATEM drop
    const unhealthyChurch = mockChurch({
      status: {
        atem: { connected: false },
        encoder: { connected: true, live: true, bitrateKbps: 0 },
      },
    });
    churches.set('church-1', unhealthyChurch);

    failover.onSignalEvent('church-1', 'atem_lost', { church: unhealthyChurch });
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
  });

  // ── CONFIRMED_OUTAGE → FAILOVER_ACTIVE (30s no ack) ────────────────────

  it('executes failover after ack timeout', async () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000); // → CONFIRMED
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);

    vi.advanceTimersByTime(30000); // → FAILOVER
    // Need to flush promises for async dispatchCommand
    await vi.runAllTimersAsync();

    expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledWith(
      expect.anything(),
      'atem.cut',
      { input: 3010 },
      null
    );
  });

  it('uses custom ack timeout from config', async () => {
    db = mockDb({ failover_ack_timeout_s: 60 });
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000); // → CONFIRMED

    // Not at 30s
    vi.advanceTimersByTime(30000);
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);

    // At 60s
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();
    expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);
  });

  // ── CONFIRMED_OUTAGE + TD ack → cancel auto-failover ────────────────────

  it('cancels auto-failover when TD acknowledges', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000); // → CONFIRMED
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);

    failover.onTdAcknowledge('church-1');

    // 30s passes — should NOT failover
    vi.advanceTimersByTime(30000);
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
    expect(autoRecovery.dispatchCommand).not.toHaveBeenCalled();
  });

  // ── FAILOVER_ACTIVE + encoder recovered → notification only ──────────────

  it('sends recovery notification but stays in FAILOVER on encoder recovery', async () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();
    expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);

    const callsBefore = alertEngine.sendTelegramMessage.mock.calls.length;
    failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });
    expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE); // still active
    expect(alertEngine.sendTelegramMessage.mock.calls.length).toBeGreaterThan(callsBefore); // sent notification
  });

  // ── FAILOVER_ACTIVE + TD confirm recovery → HEALTHY ──────────────────────

  it('returns to HEALTHY when TD confirms recovery', async () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();
    expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);

    await failover.onTdConfirmRecovery('church-1');
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
    // Should dispatch recovery command (switch back to original input)
    expect(autoRecovery.dispatchCommand).toHaveBeenCalledTimes(2); // failover + recovery
  });

  // ── VideoHub failover action ──────────────────────────────────────────────

  it('dispatches videohub.route command for videohub_route action', async () => {
    db = mockDb({
      failover_action: JSON.stringify({ type: 'videohub_route', output: 0, input: 5, hubIndex: 0 }),
    });
    failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();

    expect(autoRecovery.dispatchCommand).toHaveBeenCalledWith(
      expect.anything(),
      'videohub.route',
      { output: 0, input: 5, hubIndex: 0 },
      null
    );
  });

  // ── Multiple churches — isolated state ───────────────────────────────────

  it('tracks state independently per church', () => {
    const church2 = mockChurch({ churchId: 'church-2', name: 'Church 2' });
    churches.set('church-2', church2);
    db = mockDb(); // Both churches use same config

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);
    expect(failover.getState('church-2').state).toBe(STATES.HEALTHY);
  });

  // ── Baseline reset on stream end ────────────────────────────────────────

  it('resets state and baseline when stream ends', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    failover.resetBaseline('church-1');
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });

  // ── State log ────────────────────────────────────────────────────────────

  it('logs state transitions with diagnosis type', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    const log = failover.getState('church-1').stateLog;
    expect(log.length).toBe(1);
    expect(log[0].from).toBe(STATES.HEALTHY);
    expect(log[0].to).toBe(STATES.SUSPECTED_BLACK);
    expect(log[0].trigger).toBe('encoder_bitrate_loss');
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────

  it('cleans up timers on cleanup()', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    failover.cleanup('church-1');
    // No error thrown, state is removed
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });

  // ── onStatusUpdate builds baseline ───────────────────────────────────────

  it('builds bitrate baseline from status updates', () => {
    failover.onStatusUpdate('church-1', { encoder: { bitrateKbps: 5000 } });
    failover.onStatusUpdate('church-1', { encoder: { bitrateKbps: 5100 } });
    failover.onStatusUpdate('church-1', { encoder: { bitrateKbps: 4900 } });
    const state = failover.getState('church-1');
    expect(state.bitrateBaseline).toBeCloseTo(5000, -1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // NEW: Multi-Signal Diagnosis
  // ──────────────────────────────────────────────────────────────────────────

  describe('Multi-Signal Diagnosis', () => {
    it('diagnoses source_dead when encoder lost but ATEM connected', () => {
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
      const state = failover.getState('church-1');
      expect(state.diagnosis).not.toBeNull();
      // After encoder loss with ATEM still up, diagnosis should indicate source issue
      expect(state.diagnosis.type).toBe('source_dead');
      expect(state.diagnosis.switchWillHelp).toBe(true);
    });

    it('diagnoses network_outage when both ATEM and encoder are dead', () => {
      // Simulate simultaneous loss
      const unhealthyChurch = mockChurch({
        status: {
          atem: { connected: false },
          encoder: { connected: true, live: true, bitrateKbps: 0 },
        },
      });
      churches.set('church-1', unhealthyChurch);

      failover.onSignalEvent('church-1', 'atem_lost', { church: unhealthyChurch });

      const state = failover.getState('church-1');
      expect(state.diagnosis).not.toBeNull();
      expect(state.diagnosis.type).toBe('network_outage');
      expect(state.diagnosis.switchWillHelp).toBe(false);
    });

    it('does not auto-switch on network outage diagnosis', () => {
      const unhealthyChurch = mockChurch({
        status: {
          atem: { connected: false },
          encoder: { connected: true, live: true, bitrateKbps: 0 },
        },
      });
      churches.set('church-1', unhealthyChurch);

      failover.onSignalEvent('church-1', 'atem_lost', { church: unhealthyChurch });
      expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);

      // Even after 30s, should NOT execute failover (no ack timer started for network outage)
      vi.advanceTimersByTime(60000);
      expect(autoRecovery.dispatchCommand).not.toHaveBeenCalled();
    });

    it('diagnoses atem_only when ATEM drops but encoder is fine', () => {
      failover.onSignalEvent('church-1', 'atem_lost', { church });
      const state = failover.getState('church-1');
      expect(state.state).toBe(STATES.ATEM_LOST);
      expect(state.diagnosis.type).toBe('atem_only');
      expect(state.diagnosis.switchWillHelp).toBe(false);
    });

    it('returns diagnosis in getState()', () => {
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
      const state = failover.getState('church-1');
      expect(state.diagnosis).toBeDefined();
      expect(state.diagnosis.type).toBeTruthy();
      expect(state.diagnosis.confidence).toBeGreaterThan(0);
      expect(Array.isArray(state.diagnosis.signals)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // NEW: Audio Silence as Failover Signal
  // ──────────────────────────────────────────────────────────────────────────

  describe('Audio Silence Trigger', () => {
    it('alerts TD on audio silence alone when audio trigger enabled', () => {
      db = mockDb({ failover_audio_trigger: 1 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      failover.onSignalEvent('church-1', 'audio_silence_sustained', { church, durationSec: 30 });

      // Should alert but NOT change state (audio alone = could be a quiet moment)
      expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
      expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
    });

    it('does not alert on audio silence when audio trigger is disabled', () => {
      db = mockDb({ failover_audio_trigger: 0 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      failover.onSignalEvent('church-1', 'audio_silence_sustained', { church, durationSec: 30 });
      expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
      expect(alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
    });

    it('escalates immediately when audio silence + encoder loss (cascading)', () => {
      db = mockDb({ failover_audio_trigger: 1 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Set audio silence first
      failover.onSignalEvent('church-1', 'audio_silence_sustained', { church, durationSec: 30 });
      expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);

      // Now encoder drops — with audio already silent, should cascade
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });

      // Should skip straight to CONFIRMED_OUTAGE (cascading diagnosis)
      expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
      const diagnosis = failover.getState('church-1').diagnosis;
      expect(diagnosis.type).toBe('cascading');
    });

    it('escalates when audio dies during SUSPECTED_BLACK', () => {
      db = mockDb({ failover_audio_trigger: 1 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Encoder drops first
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
      expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

      // Audio silence at 2s — should escalate immediately (skip remaining 3s timer)
      vi.advanceTimersByTime(2000);
      failover.onSignalEvent('church-1', 'audio_silence_sustained', { church, durationSec: 30 });

      expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
    });

    it('clears audio silence flag on audio_silence_cleared event', () => {
      db = mockDb({ failover_audio_trigger: 1 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      failover.onSignalEvent('church-1', 'audio_silence_sustained', { church, durationSec: 30 });
      failover.onSignalEvent('church-1', 'audio_silence_cleared', { church });

      // Now encoder drops — without audio silence, should go through normal path (not cascading)
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
      expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // NEW: VideoHub Source Capture
  // ──────────────────────────────────────────────────────────────────────────

  describe('VideoHub Source Capture', () => {
    it('captures current VideoHub route for recovery', async () => {
      db = mockDb({
        failover_action: JSON.stringify({ type: 'videohub_route', output: 0, input: 5, hubIndex: 0 }),
      });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Church status includes VideoHub route map
      const vhChurch = mockChurch({
        status: {
          atem: { connected: true, programInput: 1 },
          encoder: { connected: true, live: true, bitrateKbps: 5000 },
          videoHubs: [{
            connected: true,
            routes: { '0': 2, '1': 3 },
            inputLabels: { '0': 'Camera 1', '1': 'Camera 2', '2': 'Backup' },
            outputLabels: { '0': 'Program', '1': 'Preview' },
          }],
        },
      });
      churches.set('church-1', vhChurch);

      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church: vhChurch });
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(30000);
      await vi.runAllTimersAsync();

      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);

      // Recovery should switch back to original input (2), not null
      await failover.onTdConfirmRecovery('church-1');
      const recoveryCalls = autoRecovery.dispatchCommand.mock.calls;
      const lastCall = recoveryCalls[recoveryCalls.length - 1];
      expect(lastCall[1]).toBe('videohub.route');
      expect(lastCall[2].input).toBe(2); // original input captured from route map
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // NEW: Auto-Recovery with Stability Timer
  // ──────────────────────────────────────────────────────────────────────────

  describe('Auto-Recovery Mode', () => {
    it('auto-recovers after stability timer when source is stable', async () => {
      db = mockDb({ failover_auto_recover: 1 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Get to FAILOVER_ACTIVE
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(30000);
      await vi.runAllTimersAsync();
      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);

      // Encoder recovers
      failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });
      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE); // still active during stability check

      // Wait 10s stability timer
      vi.advanceTimersByTime(10000);
      await vi.runAllTimersAsync();

      expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
      // Should have dispatched failover command + recovery command
      expect(autoRecovery.dispatchCommand).toHaveBeenCalledTimes(2);
    });

    it('cancels auto-recovery if source drops again during stability window', async () => {
      db = mockDb({ failover_auto_recover: 1 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Get to FAILOVER_ACTIVE
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(30000);
      await vi.runAllTimersAsync();
      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);

      // Encoder recovers — starts stability timer
      failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });

      // Make encoder unhealthy BEFORE advancing time so the stability check sees it
      const unhealthyChurch = mockChurch({
        status: {
          atem: { connected: true },
          encoder: { connected: true, live: true, bitrateKbps: 0 },
        },
      });
      churches.set('church-1', unhealthyChurch);

      // Stability timer fires at 10s — encoder is not healthy — should NOT auto-recover
      vi.advanceTimersByTime(10000);
      await vi.runAllTimersAsync();

      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);
      // Only the original failover command, no recovery
      expect(autoRecovery.dispatchCommand).toHaveBeenCalledTimes(1);
    });

    it('does not auto-recover when autoRecover is disabled', async () => {
      db = mockDb({ failover_auto_recover: 0 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Get to FAILOVER_ACTIVE
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(30000);
      await vi.runAllTimersAsync();
      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);

      // Encoder recovers
      failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });

      // Wait well past stability timer
      vi.advanceTimersByTime(30000);
      await vi.runAllTimersAsync();

      // Should still be in FAILOVER_ACTIVE (manual recovery required)
      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);
      expect(autoRecovery.dispatchCommand).toHaveBeenCalledTimes(1); // only failover, no recovery
    });

    it('TD can still manually recover during auto-recover stability window', async () => {
      db = mockDb({ failover_auto_recover: 1 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Get to FAILOVER_ACTIVE
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(30000);
      await vi.runAllTimersAsync();

      // Encoder recovers — starts stability timer
      failover.onSignalEvent('church-1', 'encoder_bitrate_recovered', { church, bitrateKbps: 5000 });

      // TD manually confirms at 3s (before 10s stability timer)
      vi.advanceTimersByTime(3000);
      await failover.onTdConfirmRecovery('church-1');

      expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);

      // Stability timer fires at 10s — should be a no-op since we're already HEALTHY
      vi.advanceTimersByTime(7000);
      await vi.runAllTimersAsync();
      expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // NEW: Config reads new columns
  // ──────────────────────────────────────────────────────────────────────────

  describe('Config', () => {
    it('reads autoRecover and audioTrigger from DB', () => {
      db = mockDb({ failover_auto_recover: 1, failover_audio_trigger: 1 });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // If audioTrigger works, sending audio_silence_sustained should alert
      failover.onSignalEvent('church-1', 'audio_silence_sustained', { church, durationSec: 30 });
      expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
    });
  });

  // ── Backup Encoder Available ────────────────────────────────────────────

  describe('Backup Encoder Available', () => {
    it('sends alert when backup encoder becomes available during FAILOVER_ACTIVE', async () => {
      db = mockDb({ failover_action: JSON.stringify({ type: 'backup_encoder' }) });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Get to FAILOVER_ACTIVE: encoder disconnect → CONFIRMED → ack timeout → failover
      failover.onSignalEvent('church-1', 'encoder_disconnected', { church });
      expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);

      await vi.advanceTimersByTimeAsync(30000);
      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);

      const alertsBefore = alertEngine.sendTelegramMessage.mock.calls.length;

      // Backup encoder comes back online
      failover.onSignalEvent('church-1', 'backup_encoder_available', { church });

      expect(alertEngine.sendTelegramMessage.mock.calls.length).toBeGreaterThan(alertsBefore);
      const lastCall = alertEngine.sendTelegramMessage.mock.calls.at(-1);
      expect(lastCall[2]).toContain('Original Encoder Back Online');
      expect(lastCall[2]).toContain('/recover_');
    });

    it('ignores backup_encoder_available when not in FAILOVER_ACTIVE', () => {
      db = mockDb({ failover_action: JSON.stringify({ type: 'backup_encoder' }) });
      failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      const alertsBefore = alertEngine.sendTelegramMessage.mock.calls.length;
      failover.onSignalEvent('church-1', 'backup_encoder_available', { church });
      expect(alertEngine.sendTelegramMessage.mock.calls.length).toBe(alertsBefore);
    });

    it('ignores backup_encoder_available when action type is not backup_encoder', async () => {
      // Default action is atem_switch, not backup_encoder
      failover.onSignalEvent('church-1', 'encoder_disconnected', { church });
      await vi.advanceTimersByTimeAsync(30000);
      expect(failover.getState('church-1').state).toBe(STATES.FAILOVER_ACTIVE);

      const alertsBefore = alertEngine.sendTelegramMessage.mock.calls.length;
      failover.onSignalEvent('church-1', 'backup_encoder_available', { church });
      expect(alertEngine.sendTelegramMessage.mock.calls.length).toBe(alertsBefore);
    });
  });
});
