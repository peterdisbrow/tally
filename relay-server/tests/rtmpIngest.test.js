import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const NodeMediaServer = require('node-media-server');

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

let originalRun;
let originalOn;
let originalGetSession;

function patchNodeMediaServer() {
  originalRun = NodeMediaServer.prototype.run;
  originalOn = NodeMediaServer.prototype.on;
  originalGetSession = NodeMediaServer.prototype.getSession;

  NodeMediaServer.prototype.run = function run() {
    globalThis.__lastRtmpNms = this;
    this.__runCalled = true;
  };

  NodeMediaServer.prototype.on = function on(event, handler) {
    this.__handlers = this.__handlers || {};
    this.__handlers[event] = handler;
    return this;
  };

  NodeMediaServer.prototype.getSession = function getSession() {
    return null;
  };
}

function restoreNodeMediaServer() {
  if (originalRun) NodeMediaServer.prototype.run = originalRun;
  if (originalOn) NodeMediaServer.prototype.on = originalOn;
  if (originalGetSession) NodeMediaServer.prototype.getSession = originalGetSession;
  delete globalThis.__lastRtmpNms;
}

function makeQueryClient() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ingest_stream_key TEXT
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      campus_id TEXT NOT NULL,
      stream_key TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  sqlite.prepare(
    'INSERT INTO churches (churchId, name, ingest_stream_key) VALUES (?, ?, ?)'
  ).run('church-1', 'Grace Church', 'church-key');
  sqlite.prepare(
    'INSERT INTO rooms (id, name, campus_id, stream_key, deleted_at) VALUES (?, ?, ?, ?, NULL)'
  ).run('room-1', 'Main Room', 'church-1', 'room-key');

  const queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: sqlite });
  return { sqlite, queryClient };
}

describe('rtmpIngest', () => {
  let shutdownRtmpIngest;
  let initRtmpIngest;

  beforeEach(() => {
    patchNodeMediaServer();
    delete require.cache[require.resolve('../src/rtmpIngest')];
    ({ initRtmpIngest, shutdownRtmpIngest } = require('../src/rtmpIngest'));
  });

  afterEach(() => {
    try {
      shutdownRtmpIngest?.();
    } catch {}
    restoreNodeMediaServer();
    delete require.cache[require.resolve('../src/rtmpIngest')];
    vi.restoreAllMocks();
  });

  it('uses the query-client preload cache to authorize room streams', async () => {
    const { sqlite, queryClient } = makeQueryClient();
    const broadcastToSSE = vi.fn();

    initRtmpIngest({ queryClient }, broadcastToSSE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const nms = globalThis.__lastRtmpNms;
    expect(nms).toBeTruthy();
    expect(nms.__runCalled).toBe(true);
    expect(typeof nms.__handlers?.prePublish).toBe('function');

    const session = {
      streamPath: '/live/room-key',
      reject: vi.fn(),
    };

    nms.__handlers.prePublish(session);

    expect(session.reject).not.toHaveBeenCalled();
    expect(session._tallyChurchId).toBe('church-1');
    expect(session._tallyChurchName).toBe('Grace Church');
    expect(session._tallyRoomId).toBe('room-1');
    expect(session._tallyRoomName).toBe('Main Room');
    expect(broadcastToSSE).not.toHaveBeenCalled();

    await queryClient.close();
    sqlite.close();
  });

  it('rejects invalid stream keys without touching the publish session', async () => {
    const { sqlite, queryClient } = makeQueryClient();

    initRtmpIngest({ queryClient }, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const nms = globalThis.__lastRtmpNms;
    const session = {
      streamPath: '/live/not-a-real-key',
      reject: vi.fn(),
    };

    nms.__handlers.prePublish(session);

    expect(session.reject).toHaveBeenCalledTimes(1);
    expect(session._tallyChurchId).toBeUndefined();

    await queryClient.close();
    sqlite.close();
  });
});
