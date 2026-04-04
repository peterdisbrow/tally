/**
 * Tests for src/streamPlatformOAuth.js — DB-backed OAuth methods,
 * pending code helpers, and stream status queries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { StreamPlatformOAuth } = require('../src/streamPlatformOAuth');

// ─── DB helpers ──────────────────────────────────────────────────────────────

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  return db;
}

function seedChurch(db, churchId = 'c1', extra = {}) {
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run(churchId, extra.name || 'Test Church');
  return churchId;
}

// ─── Constructor / _ensureColumns ────────────────────────────────────────────

describe('StreamPlatformOAuth constructor', () => {
  let db;

  afterEach(() => db?.close());

  it('constructs without error and adds OAuth columns', () => {
    db = createDb();
    const oauth = new StreamPlatformOAuth(db);
    expect(oauth).toBeDefined();
    const cols = db.prepare("PRAGMA table_info('churches')").all().map(c => c.name);
    expect(cols).toContain('yt_access_token');
    expect(cols).toContain('fb_access_token');
  });

  it('can be constructed multiple times without error (idempotent columns)', () => {
    db = createDb();
    expect(() => {
      new StreamPlatformOAuth(db);
      new StreamPlatformOAuth(db); // should not throw for existing columns
    }).not.toThrow();
  });
});

// ─── getStatus ───────────────────────────────────────────────────────────────

describe('getStatus()', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
  });
  afterEach(() => db?.close());

  it('returns {connected:false} for both platforms when church not found', () => {
    const result = oauth.getStatus('no-such-church');
    expect(result.youtube.connected).toBe(false);
    expect(result.facebook.connected).toBe(false);
  });

  it('returns {connected:false} when no tokens set', () => {
    seedChurch(db);
    const result = oauth.getStatus('c1');
    expect(result.youtube.connected).toBe(false);
    expect(result.facebook.connected).toBe(false);
    expect(result.youtube.streamKeySet).toBe(false);
    expect(result.facebook.streamKeySet).toBe(false);
  });

  it('returns {connected:true} when YouTube token is set', () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET yt_access_token = 'yt-tok', yt_channel_name = 'My Channel' WHERE churchId = ?").run('c1');
    const result = oauth.getStatus('c1');
    expect(result.youtube.connected).toBe(true);
    expect(result.youtube.channelName).toBe('My Channel');
  });

  it('returns streamKeySet:true when stream key is present', () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET yt_stream_key = 'key123' WHERE churchId = ?").run('c1');
    const result = oauth.getStatus('c1');
    expect(result.youtube.streamKeySet).toBe(true);
  });

  it('returns {connected:true} when Facebook token is set', () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET fb_access_token = 'fb-tok', fb_page_name = 'Grace FB' WHERE churchId = ?").run('c1');
    const result = oauth.getStatus('c1');
    expect(result.facebook.connected).toBe(true);
    expect(result.facebook.pageName).toBe('Grace FB');
  });
});

// ─── getStreamKeys ───────────────────────────────────────────────────────────

describe('getStreamKeys()', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
  });
  afterEach(() => db?.close());

  it('returns {youtube:null, facebook:null} for unknown church', () => {
    const result = oauth.getStreamKeys('no-such-church');
    expect(result.youtube).toBeNull();
    expect(result.facebook).toBeNull();
  });

  it('returns null for both when no stream keys set', () => {
    seedChurch(db);
    const result = oauth.getStreamKeys('c1');
    expect(result.youtube).toBeNull();
    expect(result.facebook).toBeNull();
  });

  it('returns YouTube stream key when set', () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET yt_stream_key = 'yt-key', yt_stream_url = 'rtmp://yt' WHERE churchId = ?").run('c1');
    const result = oauth.getStreamKeys('c1');
    expect(result.youtube).toEqual({ url: 'rtmp://yt', key: 'yt-key' });
    expect(result.facebook).toBeNull();
  });

  it('returns Facebook stream key when set', () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET fb_stream_key = 'fb-key', fb_stream_url = 'rtmp://fb' WHERE churchId = ?").run('c1');
    const result = oauth.getStreamKeys('c1');
    expect(result.facebook).toEqual({ url: 'rtmp://fb', key: 'fb-key' });
    expect(result.youtube).toBeNull();
  });
});

// ─── disconnectYouTube ───────────────────────────────────────────────────────

describe('disconnectYouTube()', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
  });
  afterEach(() => db?.close());

  it('clears all YouTube columns', () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET yt_access_token = 'tok', yt_stream_key = 'key', yt_channel_name = 'ch' WHERE churchId = ?").run('c1');
    oauth.disconnectYouTube('c1');
    const row = db.prepare('SELECT yt_access_token, yt_stream_key, yt_channel_name FROM churches WHERE churchId = ?').get('c1');
    expect(row.yt_access_token).toBeNull();
    expect(row.yt_stream_key).toBeNull();
    expect(row.yt_channel_name).toBeNull();
  });
});

// ─── disconnectFacebook ──────────────────────────────────────────────────────

describe('disconnectFacebook()', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
  });
  afterEach(() => db?.close());

  it('clears all Facebook columns', () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET fb_access_token = 'fb-tok', fb_stream_key = 'fb-key', fb_page_name = 'pg' WHERE churchId = ?").run('c1');
    oauth.disconnectFacebook('c1');
    const row = db.prepare('SELECT fb_access_token, fb_stream_key, fb_page_name FROM churches WHERE churchId = ?').get('c1');
    expect(row.fb_access_token).toBeNull();
    expect(row.fb_stream_key).toBeNull();
    expect(row.fb_page_name).toBeNull();
  });
});

// ─── YouTube pending code helpers ────────────────────────────────────────────

describe('storeYouTubePendingCode / getYouTubePendingCode', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
  });
  afterEach(() => db?.close());

  it('stores and retrieves a YouTube pending code', () => {
    oauth.storeYouTubePendingCode('state-yt-1', 'yt-code-abc');
    const result = oauth.getYouTubePendingCode('state-yt-1');
    expect(result).toEqual({ code: 'yt-code-abc' });
  });

  it('returns null when no pending code exists for state', () => {
    const result = oauth.getYouTubePendingCode('nonexistent-state');
    expect(result).toBeNull();
  });

  it('deletes code after retrieval (one-time use)', () => {
    oauth.storeYouTubePendingCode('state-yt-2', 'yt-code-xyz');
    oauth.getYouTubePendingCode('state-yt-2');
    const second = oauth.getYouTubePendingCode('state-yt-2');
    expect(second).toBeNull();
  });
});

// ─── Facebook pending code helpers ───────────────────────────────────────────

describe('storeFacebookPendingCode / getFacebookPendingCode', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
  });
  afterEach(() => db?.close());

  it('stores and retrieves a Facebook pending code', () => {
    oauth.storeFacebookPendingCode('state-fb-1', 'fb-code-abc');
    const result = oauth.getFacebookPendingCode('state-fb-1');
    expect(result).toEqual({ code: 'fb-code-abc' });
  });

  it('returns null when no pending code exists', () => {
    const result = oauth.getFacebookPendingCode('nonexistent-state');
    expect(result).toBeNull();
  });

  it('deletes code after retrieval (one-time use)', () => {
    oauth.storeFacebookPendingCode('state-fb-2', 'fb-code-xyz');
    oauth.getFacebookPendingCode('state-fb-2');
    const second = oauth.getFacebookPendingCode('state-fb-2');
    expect(second).toBeNull();
  });
});

// ─── start / stop ────────────────────────────────────────────────────────────

describe('start() and stop()', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
  });
  afterEach(() => {
    oauth.stop();
    db?.close();
  });

  it('start() creates a refresh timer', () => {
    expect(oauth._refreshTimer).toBeNull();
    oauth.start();
    expect(oauth._refreshTimer).not.toBeNull();
  });

  it('stop() clears the refresh timer', () => {
    oauth.start();
    oauth.stop();
    expect(oauth._refreshTimer).toBeNull();
  });

  it('stop() is safe to call when not started', () => {
    expect(() => oauth.stop()).not.toThrow();
  });
});

// ─── listFacebookDestinations ─────────────────────────────────────────────────

describe('listFacebookDestinations()', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('AbortSignal', { timeout: () => undefined });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  it('returns error when church has no Facebook token', async () => {
    seedChurch(db);
    const result = await oauth.listFacebookDestinations('c1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not connected');
  });

  it('returns pages list when connected', async () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET fb_access_token = 'fb-tok' WHERE churchId = ?").run('c1');
    // Mock: /me returns name, pages endpoint returns empty list
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'John Doe', data: [] }),
    });
    const result = await oauth.listFacebookDestinations('c1');
    expect(result.success).toBe(true);
    expect(result.pages).toContainEqual(expect.objectContaining({ id: 'me' }));
  });
});

// ─── exchangeYouTubeCode (no credentials configured) ──────────────────────────

describe('exchangeYouTubeCode() with no env credentials', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
    delete process.env.YOUTUBE_CLIENT_ID;
    delete process.env.YOUTUBE_CLIENT_SECRET;
  });
  afterEach(() => db?.close());

  it('returns error when YouTube OAuth not configured', async () => {
    const result = await oauth.exchangeYouTubeCode('c1', 'code', 'http://localhost');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });
});

// ─── exchangeFacebookCode (no credentials) ────────────────────────────────────

describe('exchangeFacebookCode() with no env credentials', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
  });
  afterEach(() => db?.close());

  it('returns error when Facebook OAuth not configured', async () => {
    const result = await oauth.exchangeFacebookCode('c1', 'code', 'http://localhost');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });
});

// ─── verifyStreamOnPlatforms ─────────────────────────────────────────────────

describe('verifyStreamOnPlatforms()', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('AbortSignal', { timeout: () => undefined });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  it('returns empty object when church not found', async () => {
    const result = await oauth.verifyStreamOnPlatforms('no-such-church');
    expect(result).toEqual({});
  });

  it('returns empty object when no tokens connected', async () => {
    seedChurch(db);
    const result = await oauth.verifyStreamOnPlatforms('c1');
    expect(result).toEqual({});
  });

  it('checks YouTube live status when yt_access_token is set', async () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET yt_access_token = 'yt-tok' WHERE churchId = ?").run('c1');
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ status: { lifeCycleStatus: 'live' }, statistics: { concurrentViewers: '150' }, snippet: { title: 'Sunday Service' } }] }),
    });
    const result = await oauth.verifyStreamOnPlatforms('c1');
    expect(result.youtube).toBeDefined();
    expect(result.youtube.checked).toBe(true);
    expect(result.youtube.live).toBe(true);
    expect(result.youtube.viewerCount).toBe(150);
  });

  it('handles YouTube API HTTP error', async () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET yt_access_token = 'yt-tok' WHERE churchId = ?").run('c1');
    fetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const result = await oauth.verifyStreamOnPlatforms('c1');
    expect(result.youtube.live).toBe(false);
    expect(result.youtube.error).toContain('401');
  });

  it('handles YouTube API fetch error', async () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET yt_access_token = 'yt-tok' WHERE churchId = ?").run('c1');
    fetch.mockRejectedValueOnce(new Error('Network timeout'));
    const result = await oauth.verifyStreamOnPlatforms('c1');
    expect(result.youtube.live).toBe(false);
    expect(result.youtube.error).toContain('Network timeout');
  });

  it('checks Facebook live status when fb_access_token is set', async () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET fb_access_token = 'fb-tok' WHERE churchId = ?").run('c1');
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'LIVE', live_views: 50, title: 'Worship' }] }),
    });
    const result = await oauth.verifyStreamOnPlatforms('c1');
    expect(result.facebook).toBeDefined();
    expect(result.facebook.live).toBe(true);
    expect(result.facebook.viewerCount).toBe(50);
  });

  it('handles Facebook API HTTP error', async () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET fb_access_token = 'fb-tok' WHERE churchId = ?").run('c1');
    fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await oauth.verifyStreamOnPlatforms('c1');
    expect(result.facebook.live).toBe(false);
    expect(result.facebook.error).toContain('403');
  });

  it('handles Facebook API fetch error', async () => {
    seedChurch(db);
    db.prepare("UPDATE churches SET fb_access_token = 'fb-tok' WHERE churchId = ?").run('c1');
    fetch.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await oauth.verifyStreamOnPlatforms('c1');
    expect(result.facebook.live).toBe(false);
    expect(result.facebook.error).toContain('Connection refused');
  });
});

// ─── _refreshAll ─────────────────────────────────────────────────────────────

describe('_refreshAll()', () => {
  let db, oauth;

  beforeEach(() => {
    db = createDb();
    oauth = new StreamPlatformOAuth(db);
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('AbortSignal', { timeout: () => undefined });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  it('runs without error when no churches have OAuth tokens', async () => {
    seedChurch(db);
    await expect(oauth._refreshAll()).resolves.toBeUndefined();
  });

  it('warns when Facebook token expires within 7 days', async () => {
    seedChurch(db, 'c1', { name: 'Grace Church' });
    const soonExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days
    db.prepare("UPDATE churches SET fb_access_token = 'tok', fb_token_expires_at = ? WHERE churchId = ?").run(soonExpiry, 'c1');
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await oauth._refreshAll();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('expires in'));
    consoleSpy.mockRestore();
  });

  it('does not warn when Facebook token has more than 7 days remaining', async () => {
    seedChurch(db);
    const farExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
    db.prepare("UPDATE churches SET fb_access_token = 'tok', fb_token_expires_at = ? WHERE churchId = ?").run(farExpiry, 'c1');
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await oauth._refreshAll();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
