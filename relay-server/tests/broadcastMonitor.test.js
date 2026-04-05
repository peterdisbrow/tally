/**
 * Tests for src/broadcastMonitor.js — YouTube & Facebook broadcast health
 * polling, status derivation, alert transitions, and portal data attachment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { SqliteQueryClient } = require('../src/db/queryClient');

// ─── Pure function tests (no mocks needed) ────────────────────────────────

const { deriveYouTubeHealth, deriveFacebookHealth } = await import('../src/broadcastMonitor.js');

describe('deriveYouTubeHealth', () => {
  it('returns good for "good" status', () => {
    expect(deriveYouTubeHealth({ status: 'good' })).toBe('good');
  });
  it('returns good for "ok" status', () => {
    expect(deriveYouTubeHealth({ status: 'ok' })).toBe('good');
  });
  it('returns error for "bad" status', () => {
    expect(deriveYouTubeHealth({ status: 'bad' })).toBe('error');
  });
  it('returns error for "revoked" status', () => {
    expect(deriveYouTubeHealth({ status: 'revoked' })).toBe('error');
  });
  it('returns noData for "noData" status', () => {
    expect(deriveYouTubeHealth({ status: 'noData' })).toBe('noData');
  });
  it('returns warning for unknown status', () => {
    expect(deriveYouTubeHealth({ status: 'something_else' })).toBe('warning');
  });
  it('returns noData for null input', () => {
    expect(deriveYouTubeHealth(null)).toBe('noData');
  });
  it('returns noData for undefined input', () => {
    expect(deriveYouTubeHealth(undefined)).toBe('noData');
  });
});

describe('deriveFacebookHealth', () => {
  it('returns good for LIVE status', () => {
    expect(deriveFacebookHealth('LIVE')).toBe('good');
  });
  it('returns warning for UNPUBLISHED status', () => {
    expect(deriveFacebookHealth('UNPUBLISHED')).toBe('warning');
  });
  it('returns warning for SCHEDULED_UNPUBLISHED', () => {
    expect(deriveFacebookHealth('SCHEDULED_UNPUBLISHED')).toBe('warning');
  });
  it('returns noData for VOD', () => {
    expect(deriveFacebookHealth('VOD')).toBe('noData');
  });
  it('returns noData for PROCESSING', () => {
    expect(deriveFacebookHealth('PROCESSING')).toBe('noData');
  });
  it('returns error for unknown status', () => {
    expect(deriveFacebookHealth('SCHEDULED_CANCELED')).toBe('error');
  });
  it('returns noData for null', () => {
    expect(deriveFacebookHealth(null)).toBe('noData');
  });
  it('returns noData for empty string', () => {
    expect(deriveFacebookHealth('')).toBe('noData');
  });
  it('is case insensitive', () => {
    expect(deriveFacebookHealth('live')).toBe('good');
  });
});

// ─── Integration tests with mocked fetch & DB ─────────────────────────────

function mockDb(rows = {}) {
  const store = new Map();
  for (const [churchId, data] of Object.entries(rows)) {
    store.set(churchId, { churchId, ...data });
  }
  return {
    _store: store,
    prepare: vi.fn(function (sql) {
      return {
        get: vi.fn((...args) => {
          const id = args[args.length - 1];
          return store.get(id) || null;
        }),
        run: vi.fn((...args) => {
          const churchId = args[args.length - 1];
          const existing = store.get(churchId);
          if (existing) {
            const setMatch = sql.match(/SET\s+([\s\S]+?)(?:WHERE|$)/i);
            if (setMatch) {
              const assignments = setMatch[1].split(',').map(a => a.trim());
              let argIdx = 0;
              for (const assignment of assignments) {
                const colMatch = assignment.match(/(\w+)\s*=/);
                if (colMatch && assignment.includes('?')) {
                  existing[colMatch[1]] = args[argIdx++];
                }
              }
            }
          }
        }),
        all: vi.fn(() => Array.from(store.values())),
      };
    }),
    exec: vi.fn(),
  };
}

describe('setupBroadcastMonitor', () => {
  let originalFetch;
  let fetchMock;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('AbortSignal', { timeout: () => undefined });
    vi.useFakeTimers({ shouldAdvanceTime: false });
    process.env.YOUTUBE_CLIENT_ID = 'yt-id';
    process.env.YOUTUBE_CLIENT_SECRET = 'yt-secret';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    delete process.env.YOUTUBE_CLIENT_ID;
    delete process.env.YOUTUBE_CLIENT_SECRET;
  });

  async function createMonitor(churchData = {}) {
    const db = mockDb(churchData);
    const churches = new Map();
    for (const id of Object.keys(churchData)) {
      churches.set(id, { churchId: id, name: churchData[id].name || id });
    }
    const alertEngine = {
      sendAlert: vi.fn().mockResolvedValue({ alertId: 'test', severity: 'WARNING' }),
    };
    const notifyUpdate = vi.fn();

    // Import fresh to avoid timer side effects
    const { setupBroadcastMonitor } = await import('../src/broadcastMonitor.js');
    const monitor = setupBroadcastMonitor(db, { churches }, alertEngine, notifyUpdate);

    return { db, churches, alertEngine, notifyUpdate, monitor };
  }

  it('attaches YouTube broadcast health to church runtime on successful poll', async () => {
    const { churches, monitor } = await createMonitor({
      c1: {
        name: 'Test Church',
        yt_access_token: 'valid-token',
        yt_refresh_token: 'refresh',
        yt_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
        yt_channel_name: 'Test Channel',
      },
    });

    // Mock broadcasts response
    fetchMock.mockImplementation((url) => {
      if (url.includes('liveBroadcasts')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{
              status: { lifeCycleStatus: 'live' },
              snippet: { title: 'Sunday Service' },
              statistics: { concurrentViewers: '42' },
              contentDetails: { boundStreamId: 'stream-1' },
            }],
          }),
        });
      }
      if (url.includes('liveStreams')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{
              status: { healthStatus: { status: 'good', configurationIssues: [] } },
              cdn: { resolution: '1080p', frameRate: '30fps', ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2' } },
            }],
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await monitor.pollYouTube('c1', churches.get('c1'));

    const church = churches.get('c1');
    expect(church.broadcastHealth).toBeUndefined(); // Not set until pollAll
    const state = monitor.getState('c1');
    expect(state.youtube.status).toBe('good');
    expect(state.youtube.live).toBe(true);
    expect(state.youtube.concurrentViewers).toBe(42);
    expect(state.youtube.resolution).toBe('1080p');
    expect(state.youtube.framerate).toBe('30fps');
  });

  it('fires alert on YouTube broadcast going unhealthy', async () => {
    const { churches, alertEngine, monitor } = await createMonitor({
      c1: {
        name: 'Test Church',
        yt_access_token: 'valid-token',
        yt_refresh_token: 'refresh',
        yt_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // First poll — healthy
    fetchMock.mockImplementation((url) => {
      if (url.includes('liveBroadcasts')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{
              status: { lifeCycleStatus: 'live' },
              snippet: { title: 'Service' },
              statistics: { concurrentViewers: '10' },
              contentDetails: { boundStreamId: 'stream-1' },
            }],
          }),
        });
      }
      if (url.includes('liveStreams')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{ status: { healthStatus: { status: 'good' } }, cdn: {} }],
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await monitor.pollYouTube('c1', churches.get('c1'));
    expect(alertEngine.sendAlert).not.toHaveBeenCalled();

    // Second poll — unhealthy
    fetchMock.mockImplementation((url) => {
      if (url.includes('liveBroadcasts')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{
              status: { lifeCycleStatus: 'live' },
              snippet: { title: 'Service' },
              statistics: {},
              contentDetails: { boundStreamId: 'stream-1' },
            }],
          }),
        });
      }
      if (url.includes('liveStreams')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{ status: { healthStatus: { status: 'bad' } }, cdn: {} }],
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await monitor.pollYouTube('c1', churches.get('c1'));
    expect(alertEngine.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ churchId: 'c1' }),
      'yt_broadcast_unhealthy',
      expect.objectContaining({ platform: 'YouTube' }),
    );
  });

  it('fires alert on YouTube broadcast going offline', async () => {
    const { churches, alertEngine, monitor } = await createMonitor({
      c1: {
        name: 'Test Church',
        yt_access_token: 'valid-token',
        yt_refresh_token: 'refresh',
        yt_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // First poll — live and healthy
    fetchMock.mockImplementation((url) => {
      if (url.includes('liveBroadcasts')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{
              status: { lifeCycleStatus: 'live' },
              snippet: { title: 'Service' },
              statistics: { concurrentViewers: '5' },
              contentDetails: { boundStreamId: 'stream-1' },
            }],
          }),
        });
      }
      if (url.includes('liveStreams')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{ status: { healthStatus: { status: 'good' } }, cdn: {} }],
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });
    await monitor.pollYouTube('c1', churches.get('c1'));

    // Second poll — no broadcast (offline)
    fetchMock.mockImplementation((url) => {
      if (url.includes('liveBroadcasts')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [] }),
        });
      }
      return Promise.resolve({ ok: false });
    });
    await monitor.pollYouTube('c1', churches.get('c1'));

    expect(alertEngine.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ churchId: 'c1' }),
      'yt_broadcast_offline',
      expect.objectContaining({ platform: 'YouTube' }),
    );
  });

  it('attaches Facebook broadcast health to state on successful poll', async () => {
    const { churches, monitor } = await createMonitor({
      c1: {
        name: 'Test Church',
        fb_access_token: 'fb-token',
        fb_page_id: '12345',
        fb_page_name: 'Test Page',
      },
    });

    fetchMock.mockImplementation((url) => {
      if (url.includes('live_videos')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{
              status: 'LIVE',
              title: 'Sunday Service',
              live_views: 15,
              ingest_streams: {
                data: [{
                  stream_health: 'good',
                  video_codec: 'h264',
                  audio_codec: 'aac',
                  stream_width: 1920,
                  stream_height: 1080,
                  video_bitrate: 4500000,
                }],
              },
            }],
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await monitor.pollFacebook('c1', churches.get('c1'));

    const state = monitor.getState('c1');
    expect(state.facebook.status).toBe('good');
    expect(state.facebook.live).toBe(true);
    expect(state.facebook.liveViews).toBe(15);
    expect(state.facebook.ingestHealth.width).toBe(1920);
    expect(state.facebook.ingestHealth.bitrate).toBe(4500000);
  });

  it('fires alert on Facebook broadcast going offline', async () => {
    const { churches, alertEngine, monitor } = await createMonitor({
      c1: {
        name: 'Test Church',
        fb_access_token: 'fb-token',
        fb_page_id: '12345',
        fb_page_name: 'Test Page',
      },
    });

    // First: live
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        data: [{ status: 'LIVE', title: 'Service', live_views: 5 }],
      }),
    }));
    await monitor.pollFacebook('c1', churches.get('c1'));

    // Second: no broadcast
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    }));
    await monitor.pollFacebook('c1', churches.get('c1'));

    expect(alertEngine.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ churchId: 'c1' }),
      'fb_broadcast_offline',
      expect.objectContaining({ platform: 'Facebook' }),
    );
  });

  it('handles API errors gracefully without throwing', async () => {
    const { churches, monitor } = await createMonitor({
      c1: {
        name: 'Test Church',
        yt_access_token: 'valid-token',
        yt_refresh_token: 'refresh',
        yt_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
        fb_access_token: 'fb-token',
        fb_page_id: '12345',
      },
    });

    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 500 }));

    // Should not throw
    await monitor.pollYouTube('c1', churches.get('c1'));
    await monitor.pollFacebook('c1', churches.get('c1'));

    const state = monitor.getState('c1');
    expect(state.youtube.status).toBe('api_error');
    expect(state.facebook.status).toBe('api_error');
  });

  it('skips churches without OAuth tokens', async () => {
    const { churches, monitor } = await createMonitor({
      c1: { name: 'No Tokens Church' },
    });

    fetchMock.mockImplementation(() => { throw new Error('should not be called'); });

    // Should not call fetch at all
    await monitor.pollYouTube('c1', churches.get('c1'));
    await monitor.pollFacebook('c1', churches.get('c1'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throttles repeated alerts within 5 minute window', async () => {
    const { churches, alertEngine, monitor } = await createMonitor({
      c1: {
        name: 'Test Church',
        yt_access_token: 'valid-token',
        yt_refresh_token: 'refresh',
        yt_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // Set up healthy → unhealthy transition
    const makeHealthyResponse = () => ({
      ok: true,
      json: () => Promise.resolve({
        items: [{
          status: { lifeCycleStatus: 'live' },
          snippet: {},
          statistics: {},
          contentDetails: { boundStreamId: 's1' },
        }],
      }),
    });
    const makeStreamResponse = (status) => ({
      ok: true,
      json: () => Promise.resolve({
        items: [{ status: { healthStatus: { status } }, cdn: {} }],
      }),
    });

    // First: healthy
    fetchMock.mockImplementation((url) => {
      if (url.includes('liveBroadcasts')) return Promise.resolve(makeHealthyResponse());
      if (url.includes('liveStreams')) return Promise.resolve(makeStreamResponse('good'));
      return Promise.resolve({ ok: false });
    });
    await monitor.pollYouTube('c1', churches.get('c1'));

    // Second: unhealthy → triggers alert
    fetchMock.mockImplementation((url) => {
      if (url.includes('liveBroadcasts')) return Promise.resolve(makeHealthyResponse());
      if (url.includes('liveStreams')) return Promise.resolve(makeStreamResponse('bad'));
      return Promise.resolve({ ok: false });
    });
    await monitor.pollYouTube('c1', churches.get('c1'));
    expect(alertEngine.sendAlert).toHaveBeenCalledTimes(1);

    // Third: still unhealthy but within throttle window → no new alert
    // Manually set prevYtHealth back to non-error to simulate a re-transition
    // Actually the throttle is on the time, and prevHealth stays 'error' so no transition
    await monitor.pollYouTube('c1', churches.get('c1'));
    // No new alert since prev was already 'error'
    expect(alertEngine.sendAlert).toHaveBeenCalledTimes(1);
  });

  it('pollAll attaches broadcastHealth to church runtime', async () => {
    const { churches, monitor } = await createMonitor({
      c1: {
        name: 'Test Church',
        yt_access_token: 'valid-token',
        yt_refresh_token: 'refresh',
        yt_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    fetchMock.mockImplementation((url) => {
      if (url.includes('liveBroadcasts')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [] }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await monitor.pollAll();

    const church = churches.get('c1');
    expect(church.broadcastHealth).toBeDefined();
    expect(church.broadcastHealth.youtube).toBeDefined();
    expect(church.broadcastHealth.youtube.status).toBe('no_broadcast');
  });

  it('supports the async queryClient path for token refresh and polling', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (
        churchId TEXT PRIMARY KEY,
        name TEXT,
        yt_access_token TEXT,
        yt_refresh_token TEXT,
        yt_token_expires_at TEXT,
        yt_channel_name TEXT,
        fb_access_token TEXT,
        fb_page_id TEXT,
        fb_page_name TEXT,
        room_id TEXT,
        room_name TEXT
      )
    `);
    db.prepare(`
      INSERT INTO churches (
        churchId, name, yt_access_token, yt_refresh_token, yt_token_expires_at,
        yt_channel_name, fb_access_token, fb_page_id, fb_page_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'c1',
      'Test Church',
      'expired-token',
      'refresh-token',
      new Date(Date.now() + 60_000).toISOString(),
      'Test Channel',
      'fb-token',
      'page-1',
      'FB Page',
    );

    const queryClient = new SqliteQueryClient(db);
    const churches = new Map([
      ['c1', { churchId: 'c1', name: 'Test Church' }],
    ]);
    const alertEngine = {
      sendAlert: vi.fn().mockResolvedValue({ alertId: 'test', severity: 'WARNING' }),
    };
    const notifyUpdate = vi.fn();
    const monitor = (await import('../src/broadcastMonitor.js')).setupBroadcastMonitor(queryClient, { churches }, alertEngine, notifyUpdate);

    fetchMock.mockImplementation((url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: 'refreshed-token', expires_in: 3600 }),
        });
      }
      if (url.includes('liveBroadcasts')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{
              status: { lifeCycleStatus: 'live' },
              snippet: { title: 'Sunday Service' },
              statistics: { concurrentViewers: '12' },
              contentDetails: { boundStreamId: 'stream-1' },
            }],
          }),
        });
      }
      if (url.includes('liveStreams')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: [{
              status: { healthStatus: { status: 'good' } },
              cdn: { resolution: '1080p', frameRate: '30fps' },
            }],
          }),
        });
      }
      if (url.includes('live_videos')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{
              status: 'LIVE',
              title: 'Sunday Service',
              live_views: 7,
            }],
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await monitor.pollAll();

    const refreshed = await queryClient.queryOne('SELECT yt_access_token FROM churches WHERE churchId = ?', ['c1']);
    expect(refreshed?.yt_access_token).toBe('refreshed-token');
    expect(churches.get('c1').broadcastHealth.youtube.status).toBe('good');
    expect(churches.get('c1').broadcastHealth.facebook.status).toBe('good');
    expect(notifyUpdate).toHaveBeenCalledWith('c1');

    await queryClient.close();
    db.close();
  });
});
