import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalFailover, STATES, DEFAULTS } from '../src/signalFailover.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDb(config = {}) {
  const defaults = {
    failover_enabled: 1,
    failover_black_threshold_s: 5,
    failover_ack_timeout_s: 30,
    failover_action: JSON.stringify({ type: 'atem_switch', input: 3010 }),
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

  it('returns to HEALTHY when encoder recovers within threshold', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    // Recover before 5s
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
      { input: 3010 }
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
      { output: 0, input: 5, hubIndex: 0 }
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

  it('logs state transitions', () => {
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
});
