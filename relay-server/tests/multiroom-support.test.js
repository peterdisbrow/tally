import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SessionRecap } from '../src/sessionRecap.js';
import { PreServiceRundown } from '../src/preServiceRundown.js';

function createChurchDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      operator_level TEXT DEFAULT 'intermediate',
      leadership_emails TEXT,
      service_times TEXT DEFAULT '[]',
      escalation_enabled INTEGER DEFAULT 0,
      escalation_timing_json TEXT
    );
  `);
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run('church-1', 'Test Church');
  db.exec(`
    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_minutes INTEGER,
      stream_ran INTEGER DEFAULT 0,
      stream_runtime_minutes INTEGER DEFAULT 0,
      recording_confirmed INTEGER DEFAULT 0,
      alert_count INTEGER DEFAULT 0,
      auto_recovered_count INTEGER DEFAULT 0,
      escalated_count INTEGER DEFAULT 0,
      audio_silence_count INTEGER DEFAULT 0,
      peak_viewers INTEGER,
      td_name TEXT,
      grade TEXT,
      notes TEXT,
      instance_name TEXT,
      room_id TEXT
    );
  `);
  return db;
}

describe('multiroom session lifecycle', () => {
  it('tracks and closes separate sessions per connected instance', async () => {
    const db = createChurchDb();
    const recap = new SessionRecap(db);
    recap.setRoomResolver((churchId, instanceName) => {
      if (churchId !== 'church-1') return null;
      return instanceName === 'main-instance' ? 'room-main' : instanceName === 'youth-instance' ? 'room-youth' : null;
    });

    recap.startSession('church-1', 'Taylor', 'main-instance');
    recap.startSession('church-1', 'Taylor', 'youth-instance');

    expect(recap.getActiveSessionId('church-1')).toBeNull();
    expect(recap.getActiveSessionId('church-1', 'main-instance')).toBeTruthy();
    expect(recap.getActiveSessionId('church-1', 'youth-instance')).toBeTruthy();

    const ended = await recap.endSessionsForChurch('church-1');
    expect(ended).toHaveLength(2);

    const rows = db.prepare('SELECT instance_name, room_id, ended_at FROM service_sessions ORDER BY instance_name ASC').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].instance_name).toBe('main-instance');
    expect(rows[0].room_id).toBe('room-main');
    expect(rows[0].ended_at).toBeTruthy();
    expect(rows[1].instance_name).toBe('youth-instance');
    expect(rows[1].room_id).toBe('room-youth');
    expect(rows[1].ended_at).toBeTruthy();

    db.close();
  });
});

describe('multiroom pre-service rundown state', () => {
  it('keeps separate active and persisted rundowns per room', async () => {
    const db = createChurchDb();

    const runtime = {
      roomInstanceMap: {
        'room-main': 'main-instance',
        'room-youth': 'youth-instance',
      },
      sockets: new Map([
        ['main-instance', { readyState: 1 }],
        ['youth-instance', { readyState: 1 }],
      ]),
      status: {},
    };

    const rundowns = new PreServiceRundown({
      db,
      scheduleEngine: {
        getNextService: () => ({ minutesUntil: 30, day: 0, startTime: '10:00' }),
        isServiceWindow: () => true,
      },
      preServiceCheck: { getLatestResult: () => null },
      churchMemory: { getPreServiceBriefing: () => ({ recurringIssues: [] }) },
      viewerBaseline: { getBaseline: () => ({ expectedPeak: 0, platformSplit: {}, trendPct: 0, sampleCount: 0 }) },
      churches: new Map([['church-1', runtime]]),
      broadcastToPortal: () => {},
      postSystemChatMessage: () => {},
    });

    const main = await rundowns.generate('church-1', 'main-instance', 'room-main');
    const youth = await rundowns.generate('church-1', 'youth-instance', 'room-youth');

    expect(main.roomId).toBe('room-main');
    expect(youth.roomId).toBe('room-youth');
    expect(rundowns.getActiveRundown('church-1', 'main-instance', 'room-main')?.roomId).toBe('room-main');
    expect(rundowns.getActiveRundown('church-1', 'youth-instance', 'room-youth')?.roomId).toBe('room-youth');

    rundowns.confirm('church-1', 'Taylor', 'portal', 'main-instance', 'room-main');
    expect(rundowns.isConfirmed('church-1', 'main-instance', 'room-main')).toBe(true);
    expect(rundowns.isConfirmed('church-1', 'youth-instance', 'room-youth')).toBe(false);

    const latestMain = rundowns.getLatestRundown('church-1', 'main-instance', 'room-main');
    const latestYouth = rundowns.getLatestRundown('church-1', 'youth-instance', 'room-youth');
    expect(latestMain?.room_id).toBe('room-main');
    expect(latestYouth?.room_id).toBe('room-youth');

    db.close();
  });
});
