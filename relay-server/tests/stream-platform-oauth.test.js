/**
 * Tests for src/streamPlatformOAuth.js — YouTube & Facebook OAuth flows,
 * token exchange, refresh, revocation, and error handling.
 *
 * All external HTTP calls are mocked via vi.stubGlobal('fetch', ...).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// ─── Mock DB ─────────────────────────────────────────────────────────────────

function mockDb(rows = {}) {
  const store = new Map();
  // Pre-populate store with church rows
  for (const [churchId, data] of Object.entries(rows)) {
    store.set(churchId, { churchId, ...data });
  }

  return {
    _store: store,
    prepare: vi.fn(function (sql) {
      return {
        get: vi.fn((...args) => {
          // Simple lookup by churchId (last argument)
          const id = args[args.length - 1];
          return store.get(id) || null;
        }),
        run: vi.fn((...args) => {
          // For UPDATE statements, update the store
          // Try to extract churchId from the last argument
          const churchId = args[args.length - 1];
          const existing = store.get(churchId);
          if (existing) {
            // Parse SET clause from sql to figure out what's being updated
            // This is a rough heuristic for testing
            const setMatch = sql.match(/SET\s+([\s\S]+?)(?:WHERE|$)/i);
            if (setMatch) {
              const assignments = setMatch[1].split(',').map(a => a.trim());
              let argIdx = 0;
              for (const assignment of assignments) {
                const colMatch = assignment.match(/(\w+)\s*=/);
                if (colMatch) {
                  const col = colMatch[1];
                  if (assignment.includes('?')) {
                    existing[col] = args[argIdx++];
                  }
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockFetchResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchError(message) {
  return Promise.reject(new Error(message));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('StreamPlatformOAuth', () => {
  let StreamPlatformOAuth, oauth, db, originalFetch;

  beforeEach(() => {
    // Save and mock fetch
    originalFetch = globalThis.fetch;

    // Set env vars for OAuth
    process.env.YOUTUBE_CLIENT_ID = 'yt-client-id';
    process.env.YOUTUBE_CLIENT_SECRET = 'yt-client-secret';
    process.env.FACEBOOK_APP_ID = 'fb-app-id';
    process.env.FACEBOOK_APP_SECRET = 'fb-app-secret';

    // Fresh require for each test to reset module state
    const require = createRequire(import.meta.url);
    // Clear cached module
    delete require.cache[require.resolve('../src/streamPlatformOAuth')];
    ({ StreamPlatformOAuth } = require('../src/streamPlatformOAuth'));

    db = mockDb({
      'church-1': {
        name: 'First Baptist',
        yt_access_token: null,
        yt_refresh_token: null,
        yt_token_expires_at: null,
        yt_stream_key: null,
        yt_stream_url: null,
        yt_channel_name: null,
        fb_access_token: null,
        fb_token_expires_at: null,
        fb_page_id: null,
        fb_page_name: null,
        fb_stream_key: null,
        fb_stream_url: null,
      },
    });

    oauth = new StreamPlatformOAuth(db);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    oauth.stop();
    delete process.env.YOUTUBE_CLIENT_ID;
    delete process.env.YOUTUBE_CLIENT_SECRET;
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
  });

  // ── 1. OAuth URL Generation (scope validation) ────────────────────────────

  describe('OAuth Scope & Configuration', () => {
    it('requires YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET for YouTube', async () => {
      delete process.env.YOUTUBE_CLIENT_ID;
      delete process.env.YOUTUBE_CLIENT_SECRET;

      const result = await oauth.exchangeYouTubeCode('church-1', 'auth-code', 'http://localhost/callback');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('requires FACEBOOK_APP_ID and FACEBOOK_APP_SECRET for Facebook', async () => {
      delete process.env.FACEBOOK_APP_ID;
      delete process.env.FACEBOOK_APP_SECRET;

      const result = await oauth.exchangeFacebookCode('church-1', 'auth-code', 'http://localhost/callback');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('requires only YOUTUBE_CLIENT_ID (not SECRET) to detect misconfiguration', async () => {
      process.env.YOUTUBE_CLIENT_ID = 'yt-id';
      delete process.env.YOUTUBE_CLIENT_SECRET;

      const result = await oauth.exchangeYouTubeCode('church-1', 'code', 'http://localhost/cb');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('requires only FACEBOOK_APP_ID (not SECRET) to detect misconfiguration', async () => {
      process.env.FACEBOOK_APP_ID = 'fb-id';
      delete process.env.FACEBOOK_APP_SECRET;

      const result = await oauth.exchangeFacebookCode('church-1', 'code', 'http://localhost/cb');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });
  });

  // ── 2. YouTube Token Exchange ─────────────────────────────────────────────

  describe('YouTube Token Exchange', () => {
    it('exchanges authorization code for tokens and fetches stream key', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          // Token exchange
          return mockFetchResponse(200, {
            access_token: 'yt-access-123',
            refresh_token: 'yt-refresh-456',
            expires_in: 3600,
          });
        } else if (callCount === 2) {
          // Channel info
          return mockFetchResponse(200, {
            items: [{ snippet: { title: 'My Church Channel' } }],
          });
        } else {
          // Stream key
          return mockFetchResponse(200, {
            items: [{
              cdn: {
                ingestionInfo: {
                  streamName: 'stream-key-abc',
                  ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2',
                },
              },
            }],
          });
        }
      });

      const result = await oauth.exchangeYouTubeCode('church-1', 'auth-code-xyz', 'http://localhost/callback');

      expect(result.success).toBe(true);
      expect(result.channelName).toBe('My Church Channel');
      expect(result.streamKey).toBe('stream-key-abc');
      expect(result.streamUrl).toBe('rtmp://a.rtmp.youtube.com/live2');

      // Verify token exchange was called with correct params
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      const firstCall = globalThis.fetch.mock.calls[0];
      expect(firstCall[0]).toBe('https://oauth2.googleapis.com/token');
      expect(firstCall[1].method).toBe('POST');
    });

    it('returns error on failed token exchange', async () => {
      globalThis.fetch = vi.fn(() =>
        mockFetchResponse(400, {
          error: 'invalid_grant',
          error_description: 'Code has already been used',
        })
      );

      const result = await oauth.exchangeYouTubeCode('church-1', 'used-code', 'http://localhost/cb');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Code has already been used');
    });

    it('handles network error during token exchange', async () => {
      globalThis.fetch = vi.fn(() => mockFetchError('Network timeout'));

      const result = await oauth.exchangeYouTubeCode('church-1', 'code', 'http://localhost/cb');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });

    it('stores tokens in database after successful exchange', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return mockFetchResponse(200, {
            access_token: 'yt-access-new',
            refresh_token: 'yt-refresh-new',
            expires_in: 3600,
          });
        }
        // Channel and stream calls — return empty
        return mockFetchResponse(200, { items: [] });
      });

      await oauth.exchangeYouTubeCode('church-1', 'code', 'http://localhost/cb');

      // Verify db.prepare was called to store tokens
      const prepareCalls = db.prepare.mock.calls;
      const updateCalls = prepareCalls.filter(c => c[0].includes('yt_access_token'));
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    it('handles missing stream key gracefully', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return mockFetchResponse(200, {
            access_token: 'yt-access',
            refresh_token: 'yt-refresh',
            expires_in: 3600,
          });
        }
        return mockFetchResponse(200, { items: [] }); // no streams or channels
      });

      const result = await oauth.exchangeYouTubeCode('church-1', 'code', 'http://localhost/cb');

      expect(result.success).toBe(true);
      expect(result.streamKey).toBeNull();
    });
  });

  // ── 3. YouTube Token Refresh ──────────────────────────────────────────────

  describe('YouTube Token Refresh', () => {
    it('refreshes token using stored refresh token', async () => {
      // Set up church with existing refresh token
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        yt_refresh_token: 'yt-refresh-existing',
      });

      globalThis.fetch = vi.fn(() =>
        mockFetchResponse(200, {
          access_token: 'yt-access-refreshed',
          expires_in: 3600,
        })
      );

      const result = await oauth.refreshYouTubeToken('church-1');

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const call = globalThis.fetch.mock.calls[0];
      expect(call[0]).toBe('https://oauth2.googleapis.com/token');
      const body = call[1].body;
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('yt-refresh-existing');
    });

    it('returns false when no refresh token stored', async () => {
      const result = await oauth.refreshYouTubeToken('church-1');
      expect(result).toBe(false);
    });

    it('returns false when refresh request fails', async () => {
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        yt_refresh_token: 'yt-refresh-existing',
      });

      globalThis.fetch = vi.fn(() => mockFetchResponse(401, { error: 'invalid_grant' }));

      const result = await oauth.refreshYouTubeToken('church-1');
      expect(result).toBe(false);
    });

    it('returns false when credentials are missing', async () => {
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        yt_refresh_token: 'yt-refresh-existing',
      });

      delete process.env.YOUTUBE_CLIENT_ID;
      const result = await oauth.refreshYouTubeToken('church-1');
      expect(result).toBe(false);
    });

    it('returns false on network error during refresh', async () => {
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        yt_refresh_token: 'yt-refresh-existing',
      });

      globalThis.fetch = vi.fn(() => mockFetchError('Connection refused'));

      const result = await oauth.refreshYouTubeToken('church-1');
      expect(result).toBe(false);
    });
  });

  // ── 4. Token Revocation / Disconnect ──────────────────────────────────────

  describe('Token Revocation / Disconnect', () => {
    it('clears all YouTube columns on disconnect', () => {
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        yt_access_token: 'some-token',
        yt_refresh_token: 'some-refresh',
        yt_channel_name: 'My Channel',
        yt_stream_key: 'key123',
      });

      oauth.disconnectYouTube('church-1');

      // Verify the UPDATE SET ... NULL query was prepared and run
      const prepareCalls = db.prepare.mock.calls;
      const disconnectCalls = prepareCalls.filter(c =>
        c[0].includes('yt_access_token = NULL') &&
        c[0].includes('yt_refresh_token = NULL') &&
        c[0].includes('yt_stream_key = NULL')
      );
      expect(disconnectCalls.length).toBeGreaterThan(0);
    });

    it('clears all Facebook columns on disconnect', () => {
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        fb_access_token: 'fb-token',
        fb_page_id: 'page-123',
        fb_page_name: 'My Page',
      });

      oauth.disconnectFacebook('church-1');

      const prepareCalls = db.prepare.mock.calls;
      const disconnectCalls = prepareCalls.filter(c =>
        c[0].includes('fb_access_token = NULL') &&
        c[0].includes('fb_page_id = NULL') &&
        c[0].includes('fb_stream_key = NULL')
      );
      expect(disconnectCalls.length).toBeGreaterThan(0);
    });
  });

  // ── 5. Facebook Token Exchange ────────────────────────────────────────────

  describe('Facebook Token Exchange', () => {
    it('exchanges code for short-lived then long-lived token', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          // Short-lived token exchange
          return mockFetchResponse(200, { access_token: 'fb-short-lived' });
        } else if (callCount === 2) {
          // Long-lived token exchange
          return mockFetchResponse(200, { access_token: 'fb-long-lived', expires_in: 5184000 });
        } else {
          // List pages
          return mockFetchResponse(200, {
            data: [{ id: 'page-1', name: 'Church Page', access_token: 'page-token' }],
          });
        }
      });

      const result = await oauth.exchangeFacebookCode('church-1', 'fb-auth-code', 'http://localhost/cb');

      expect(result.success).toBe(true);
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].name).toContain('Personal');
      expect(result.pages[1].name).toBe('Church Page');

      // Verify the token exchange calls (short token, long token, pages, /me)
      expect(globalThis.fetch).toHaveBeenCalledTimes(4);

      // First call should be short-lived token exchange
      const firstCallUrl = globalThis.fetch.mock.calls[0][0];
      expect(firstCallUrl).toContain('oauth/access_token');
      expect(firstCallUrl).toContain('code=fb-auth-code');

      // Second call should be long-lived exchange
      const secondCallUrl = globalThis.fetch.mock.calls[1][0];
      expect(secondCallUrl).toContain('fb_exchange_token');
    });

    it('returns error on failed short-lived token exchange', async () => {
      globalThis.fetch = vi.fn(() =>
        mockFetchResponse(400, { error: { message: 'Invalid verification code' } })
      );

      const result = await oauth.exchangeFacebookCode('church-1', 'bad-code', 'http://localhost/cb');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid verification code');
    });

    it('returns error on failed long-lived token exchange', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return mockFetchResponse(200, { access_token: 'fb-short-lived' });
        }
        return mockFetchResponse(400, { error: { message: 'Exchange failed' } });
      });

      const result = await oauth.exchangeFacebookCode('church-1', 'code', 'http://localhost/cb');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to get long-lived token');
    });

    it('handles network error during Facebook exchange', async () => {
      globalThis.fetch = vi.fn(() => mockFetchError('DNS resolution failed'));

      const result = await oauth.exchangeFacebookCode('church-1', 'code', 'http://localhost/cb');

      expect(result.success).toBe(false);
      expect(result.error).toBe('DNS resolution failed');
    });
  });

  // ── 6. Error Handling ─────────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('handles invalid authorization code for YouTube', async () => {
      globalThis.fetch = vi.fn(() =>
        mockFetchResponse(400, {
          error: 'invalid_grant',
          error_description: 'Malformed auth code',
        })
      );

      const result = await oauth.exchangeYouTubeCode('church-1', 'bad-code', 'http://localhost/cb');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Malformed auth code');
    });

    it('handles expired refresh token for YouTube', async () => {
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        yt_refresh_token: 'expired-refresh-token',
      });

      globalThis.fetch = vi.fn(() =>
        mockFetchResponse(400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked',
        })
      );

      const result = await oauth.refreshYouTubeToken('church-1');
      expect(result).toBe(false);
    });

    it('handles API failure during YouTube stream key fetch', async () => {
      globalThis.fetch = vi.fn(() => mockFetchResponse(500, { error: 'Internal server error' }));

      const result = await oauth.fetchYouTubeStreamKey('church-1', 'valid-access-token');
      expect(result).toEqual({});
    });

    it('handles missing access token for stream key fetch', async () => {
      // church-1 has no yt_access_token
      const result = await oauth.fetchYouTubeStreamKey('church-1');
      expect(result).toEqual({});
    });

    it('handles YouTube token exchange with no error_description', async () => {
      globalThis.fetch = vi.fn(() =>
        mockFetchResponse(400, { error: 'server_error' })
      );

      const result = await oauth.exchangeYouTubeCode('church-1', 'code', 'http://localhost/cb');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Token exchange failed');
    });

    it('handles Facebook exchange with non-JSON error response', async () => {
      globalThis.fetch = vi.fn(() => Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.resolve('Internal Server Error'),
      }));

      const result = await oauth.exchangeFacebookCode('church-1', 'code', 'http://localhost/cb');
      expect(result.success).toBe(false);
    });
  });

  // ── Status (never exposes tokens) ─────────────────────────────────────────

  describe('Status', () => {
    it('returns connected status for YouTube', () => {
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        yt_access_token: 'secret-token',
        yt_channel_name: 'My Channel',
        yt_stream_key: 'stream-key-123',
        yt_token_expires_at: '2030-01-01T00:00:00.000Z',
      });

      const status = oauth.getStatus('church-1');

      expect(status.youtube.connected).toBe(true);
      expect(status.youtube.channelName).toBe('My Channel');
      expect(status.youtube.streamKeySet).toBe(true);
      // Token should NOT be exposed
      expect(status.youtube.accessToken).toBeUndefined();
      expect(status.youtube.refreshToken).toBeUndefined();
    });

    it('returns disconnected status when no tokens', () => {
      const status = oauth.getStatus('church-1');

      expect(status.youtube.connected).toBe(false);
      expect(status.facebook.connected).toBe(false);
    });

    it('returns disconnected for unknown church', () => {
      const status = oauth.getStatus('unknown-church');

      expect(status.youtube.connected).toBe(false);
      expect(status.facebook.connected).toBe(false);
    });

    it('returns stream keys without exposing OAuth tokens', () => {
      db._store.set('church-1', {
        ...db._store.get('church-1'),
        yt_stream_key: 'yt-key',
        yt_stream_url: 'rtmp://yt-url',
        fb_stream_key: 'fb-key',
        fb_stream_url: 'rtmps://fb-url',
      });

      const keys = oauth.getStreamKeys('church-1');

      expect(keys.youtube.key).toBe('yt-key');
      expect(keys.youtube.url).toBe('rtmp://yt-url');
      expect(keys.facebook.key).toBe('fb-key');
      expect(keys.facebook.url).toBe('rtmps://fb-url');
    });

    it('returns null stream keys for unknown church', () => {
      const keys = oauth.getStreamKeys('unknown-church');

      expect(keys.youtube).toBeNull();
      expect(keys.facebook).toBeNull();
    });
  });

  // ── Facebook Pending Codes ────────────────────────────────────────────────

  describe('Facebook Pending Codes', () => {
    it('stores and retrieves a pending code by state', () => {
      oauth.storeFacebookPendingCode('state-abc', 'code-123');

      const result = oauth.getFacebookPendingCode('state-abc');
      expect(result).not.toBeNull();
      expect(result.code).toBe('code-123');
    });

    it('returns null for unknown state', () => {
      const result = oauth.getFacebookPendingCode('unknown-state');
      expect(result).toBeNull();
    });

    it('deletes code after retrieval (one-time use)', () => {
      oauth.storeFacebookPendingCode('state-xyz', 'code-456');

      // First retrieval succeeds
      const first = oauth.getFacebookPendingCode('state-xyz');
      expect(first).not.toBeNull();

      // Second retrieval returns null (already consumed)
      const second = oauth.getFacebookPendingCode('state-xyz');
      expect(second).toBeNull();
    });
  });

  // ── Background Refresh Timer ──────────────────────────────────────────────

  describe('Background Refresh Timer', () => {
    it('starts and stops the refresh timer', () => {
      expect(oauth._refreshTimer).toBeNull();

      oauth.start();
      expect(oauth._refreshTimer).not.toBeNull();

      oauth.stop();
      expect(oauth._refreshTimer).toBeNull();
    });

    it('stop is idempotent', () => {
      oauth.stop();
      oauth.stop();
      expect(oauth._refreshTimer).toBeNull();
    });
  });
});
