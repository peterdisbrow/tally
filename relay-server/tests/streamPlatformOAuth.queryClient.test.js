import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const { StreamPlatformOAuth } = require('../src/streamPlatformOAuth');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run('church-1', 'Grace Community');
  return db;
}

describe('StreamPlatformOAuth query client', () => {
  let db;
  let queryClient;
  let oauth;

  beforeEach(async () => {
    process.env.YOUTUBE_CLIENT_ID = 'yt-client-id';
    process.env.YOUTUBE_CLIENT_SECRET = 'yt-client-secret';
    process.env.FACEBOOK_APP_ID = 'fb-app-id';
    process.env.FACEBOOK_APP_SECRET = 'fb-app-secret';

    db = createDb();
    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    oauth = new StreamPlatformOAuth(queryClient);
    await oauth.ready;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    oauth?.stop();
    await queryClient?.close();
    db?.close();
    delete process.env.YOUTUBE_CLIENT_ID;
    delete process.env.YOUTUBE_CLIENT_SECRET;
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
  });

  it('stores YouTube OAuth data and stream keys through the query client', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'yt-access', refresh_token: 'yt-refresh', expires_in: 3600 }),
        };
      }
      if (String(url).includes('/channels')) {
        return {
          ok: true,
          json: async () => ({ items: [{ snippet: { title: 'Grace Channel' } }] }),
        };
      }
      if (String(url).includes('/liveStreams')) {
        return {
          ok: true,
          json: async () => ({
            items: [{
              cdn: {
                ingestionInfo: {
                  streamName: 'stream-key-123',
                  ingestionAddress: 'rtmp://youtube/live2',
                },
              },
            }],
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const result = await oauth.exchangeYouTubeCode('church-1', 'auth-code', 'http://localhost/callback');
    const stored = await queryClient.queryOne(`
      SELECT yt_access_token, yt_refresh_token, yt_stream_key, yt_stream_url, yt_channel_name
      FROM churches WHERE churchId = ?
    `, ['church-1']);

    expect(result.success).toBe(true);
    expect(stored.yt_access_token).toBe('yt-access');
    expect(stored.yt_refresh_token).toBe('yt-refresh');
    expect(stored.yt_stream_key).toBe('stream-key-123');
    expect(stored.yt_stream_url).toBe('rtmp://youtube/live2');
    expect(stored.yt_channel_name).toBe('Grace Channel');

    const status = await oauth.getStatus('church-1');
    const keys = await oauth.getStreamKeys('church-1');
    expect(status.youtube.connected).toBe(true);
    expect(status.youtube.streamKeySet).toBe(true);
    expect(keys.youtube).toEqual({ url: 'rtmp://youtube/live2', key: 'stream-key-123' });
  });

  it('clears Facebook connection fields through the query client', async () => {
    db.prepare(`
      UPDATE churches
      SET fb_access_token = 'fb-access', fb_token_expires_at = '2026-05-01T00:00:00.000Z',
          fb_page_id = 'page-1', fb_page_name = 'Grace Page',
          fb_stream_key = 'fb-key', fb_stream_url = 'rtmp://facebook/live'
      WHERE churchId = ?
    `).run('church-1');

    await oauth.disconnectFacebook('church-1');

    const status = await oauth.getStatus('church-1');
    const keys = await oauth.getStreamKeys('church-1');
    expect(status.facebook.connected).toBe(false);
    expect(keys.facebook).toBeNull();
  });
});
