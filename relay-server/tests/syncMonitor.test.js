/**
 * Tests for src/syncMonitor.js — A/V sync monitoring, alert transitions,
 * and rolling history computation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function makeMonitor(opts = {}) {
  const { setupSyncMonitor } = require('../src/syncMonitor');
  const churches = new Map(Object.entries(opts.churches || {}));
  const relay = { churches };
  const db = opts.db || {};
  const telegramBot = opts.telegramBot || null;
  const notifyUpdate = opts.notifyUpdate || vi.fn();

  return { setupSyncMonitor, relay, db, telegramBot, notifyUpdate, churches };
}

function makeChurch(id, encoderApiUrl = 'http://encoder.local', overrides = {}) {
  return { churchId: id, name: `Church ${id}`, encoderApiUrl, ...overrides };
}

function mockFetchResponse(data, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(data),
  });
}

describe('syncMonitor', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('AbortSignal', { timeout: () => undefined });
    vi.useFakeTimers({ shouldAdvanceTime: false });
    process.env.ALERT_BOT_TOKEN = 'test-token';
    process.env.ADMIN_TELEGRAM_CHAT_ID = 'test-chat-id';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    delete process.env.ALERT_BOT_TOKEN;
    delete process.env.ADMIN_TELEGRAM_CHAT_ID;
  });

  async function createAndPoll(churchData, fetchImpl) {
    fetchMock.mockImplementation(fetchImpl);

    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: churchData } });

    // Capture pollAll from interval callback
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => {
      pollAll = fn;
      return 99;
    });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);

    setupSyncMonitor(db, relay, null, notifyUpdate);

    await pollAll();
    return { church: relay.churches.get('c1'), notifyUpdate };
  }

  it('sets syncStatus on the church runtime after a successful poll', async () => {
    const church = makeChurch('c1');
    const { church: c } = await createAndPoll(church, () =>
      mockFetchResponse({ avOffsetMs: 15, status: 'ok' })
    );

    expect(c.syncStatus).toBeDefined();
    expect(c.syncStatus.status).toBe('ok');
    expect(c.syncStatus.avOffsetMs).toBe(15);
  });

  it('skips poll when church has no encoderApiUrl', async () => {
    const church = makeChurch('c1', null); // no URL
    const { notifyUpdate } = await createAndPoll(church, () =>
      mockFetchResponse({ avOffsetMs: 10, status: 'ok' })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks unavailable after 2 consecutive fetch failures', async () => {
    const church = makeChurch('c1');
    fetchMock.mockRejectedValue(new Error('network error'));

    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    // First failure: should not mark unavailable yet
    await pollAll();
    const churchObj = relay.churches.get('c1');
    expect(churchObj.syncStatus).toBeUndefined();

    // Second failure: should now mark unavailable
    await pollAll();
    expect(churchObj.syncStatus?.status).toBe('unavailable');
  });

  it('resets consecutive failures on success', async () => {
    const church = makeChurch('c1');
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('temporary error'));
      return mockFetchResponse({ avOffsetMs: 10, status: 'ok' });
    });

    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    await pollAll(); // first call fails
    await pollAll(); // second call succeeds

    const churchObj = relay.churches.get('c1');
    expect(churchObj.syncStatus?.status).toBe('ok');
  });

  it('computes rolling 60s average and max drift', async () => {
    const church = makeChurch('c1');
    let callCount = 0;
    fetchMock.mockImplementation(() =>
      mockFetchResponse({ avOffsetMs: callCount++ === 0 ? 20 : 40, status: 'ok' })
    );

    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    await pollAll();
    await pollAll();

    const churchObj = relay.churches.get('c1');
    expect(churchObj.syncStatus?.avg60s).toBe(30); // (20+40)/2
    expect(churchObj.syncStatus?.maxDrift60s).toBe(40);
  });

  it('sends critical alert on transition to critical status', async () => {
    const church = makeChurch('c1');
    let callCount = 0;
    fetchMock.mockImplementation(() =>
      mockFetchResponse({ avOffsetMs: callCount++ === 0 ? 10 : 150, status: callCount <= 1 ? 'ok' : 'critical' })
    );

    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    // First poll: ok status
    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 10, status: 'ok' }));
    await pollAll();

    // Second poll: critical status
    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 150, status: 'critical' }));
    await pollAll();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('api.telegram.org'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends warn alert on first transition to warn status', async () => {
    const church = makeChurch('c1');
    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    // First poll: ok
    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 10, status: 'ok' }));
    await pollAll();

    // Second poll: warn
    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 50, status: 'warn' }));
    await pollAll();

    const telegramCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('telegram'));
    expect(telegramCalls.length).toBe(1);
    const body = JSON.parse(telegramCalls[0][1].body);
    expect(body.text).toContain('WARNING');
  });

  it('sends recovery alert when transitioning from warn back to ok', async () => {
    const church = makeChurch('c1');
    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    // ok → warn → ok
    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 10, status: 'ok' }));
    await pollAll();
    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 50, status: 'warn' }));
    await pollAll();
    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 5, status: 'ok' }));
    await pollAll();

    const telegramCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('telegram'));
    const bodies = telegramCalls.map(c => JSON.parse(c[1].body).text);
    expect(bodies.some(t => t.includes('RECOVERED'))).toBe(true);
  });

  it('notifies dashboard when status changes', async () => {
    const church = makeChurch('c1');
    const notifyUpdate = vi.fn();
    const { setupSyncMonitor, relay, db } = makeMonitor({ churches: { c1: church }, notifyUpdate });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 10, status: 'ok' }));
    await pollAll();
    expect(notifyUpdate).toHaveBeenCalledWith('c1');
  });

  it('does not notify dashboard when status is unchanged', async () => {
    const church = makeChurch('c1');
    const notifyUpdate = vi.fn();
    const { setupSyncMonitor, relay, db } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ avOffsetMs: 10, status: 'ok' }) });
    await pollAll(); // status: null → ok (notifies)
    const firstCallCount = notifyUpdate.mock.calls.length;
    await pollAll(); // status: ok → ok (no change, no notify)
    expect(notifyUpdate.mock.calls.length).toBe(firstCallCount); // no additional calls
  });

  it('does not send telegrams when bot token is missing', async () => {
    delete process.env.ALERT_BOT_TOKEN;
    const church = makeChurch('c1');
    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 10, status: 'ok' }));
    await pollAll();
    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: 150, status: 'critical' }));
    await pollAll();

    const telegramCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('telegram'));
    expect(telegramCalls.length).toBe(0);
  });

  it('skips avOffsetMs null values from history', async () => {
    const church = makeChurch('c1');
    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    fetchMock.mockImplementationOnce(() => mockFetchResponse({ avOffsetMs: null, status: 'unavailable' }));
    await pollAll();

    const churchObj = relay.churches.get('c1');
    expect(churchObj.syncStatus?.avg60s).toBeNull();
  });

  it('catches and logs errors thrown from within pollChurch', async () => {
    const church = makeChurch('c1');
    // Make fetch throw a non-network error (e.g., JSON parse failure)
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => { throw new Error('unexpected JSON parse error'); },
    });

    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupSyncMonitor(db, relay, null, notifyUpdate);

    // Should not throw — error is caught in pollAll's catch block (line 166)
    await expect(pollAll()).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('handles HTTP error responses as fetch failures', async () => {
    const church = makeChurch('c1');
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { setupSyncMonitor, relay, db, notifyUpdate } = makeMonitor({ churches: { c1: church } });
    let pollAll;
    vi.spyOn(global, 'setInterval').mockImplementation((fn) => { pollAll = fn; return 99; });
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 100);
    setupSyncMonitor(db, relay, null, notifyUpdate);

    await pollAll(); // first failure — no status yet
    await pollAll(); // second failure — mark unavailable

    const churchObj = relay.churches.get('c1');
    expect(churchObj.syncStatus?.status).toBe('unavailable');
  });
});
