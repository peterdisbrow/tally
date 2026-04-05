import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PreServiceRundown } from '../src/preServiceRundown.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      operator_level TEXT DEFAULT 'intermediate',
      escalation_enabled INTEGER DEFAULT 1,
      escalation_timing_json TEXT
    );

    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      grade TEXT,
      alert_count INTEGER DEFAULT 0,
      auto_recovered_count INTEGER DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run('church-1', 'Test Church');
  return db;
}

function createQueryClient(db) {
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async query(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async queryOne(sql, params = []) {
      return db.prepare(sql).get(...params) || null;
    },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return {
        changes: Number(info?.changes || 0),
        lastInsertRowid: info?.lastInsertRowid ?? null,
        rows: [],
      };
    },
    async close() {},
  };
}

describe('PreServiceRundown queryClient path', () => {
  let db;
  let queryClient;

  beforeEach(() => {
    db = createDb();
    queryClient = createQueryClient(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await queryClient?.close();
    db?.close();
  });

  it('preloads and serves rundown and escalation-contact cache through queryClient', async () => {
    const runtime = {
      status: {},
      sockets: new Map([['main-instance', { readyState: 1 }]]),
      roomInstanceMap: { 'room-main': 'main-instance' },
    };

    const rundown = new PreServiceRundown({
      queryClient,
      scheduleEngine: {
        getNextService: () => ({ minutesUntil: 30, day: 0, startTime: '10:00' }),
        isServiceWindow: () => true,
      },
      preServiceCheck: { getLatestResult: async () => null },
      churchMemory: { getPreServiceBriefing: async () => ({ recurringIssues: [] }) },
      viewerBaseline: { getBaseline: async () => ({ expectedPeak: 0, platformSplit: {}, trendPct: 0, sampleCount: 0 }) },
      churches: new Map([['church-1', runtime]]),
      broadcastToPortal: vi.fn(),
      postSystemChatMessage: vi.fn(),
    });

    await rundown.ready;

    const contact = rundown.addEscalationContact('church-1', {
      role: 'pastor',
      name: 'Pastor Taylor',
      contactType: 'telegram',
      contactValue: '12345',
      notifyOn: 'critical',
    });

    const generated = await rundown.generate('church-1', 'main-instance', 'room-main');
    expect(generated.roomId).toBe('room-main');
    expect(rundown.getLatestRundown('church-1', 'main-instance', 'room-main')?.room_id).toBe('room-main');
    expect(rundown.getEscalationContacts('church-1')).toHaveLength(1);
    expect(rundown.getEscalationContacts('church-1')[0].id).toBe(contact.id);

    rundown.confirm('church-1', 'Taylor', 'portal', 'main-instance', 'room-main');
    expect(rundown.isConfirmed('church-1', 'main-instance', 'room-main')).toBe(true);

    await new Promise(resolve => setImmediate(resolve));

    const reloaded = new PreServiceRundown({
      queryClient,
      scheduleEngine: {
        getNextService: () => ({ minutesUntil: 30, day: 0, startTime: '10:00' }),
        isServiceWindow: () => true,
      },
      preServiceCheck: { getLatestResult: async () => null },
      churchMemory: { getPreServiceBriefing: async () => ({ recurringIssues: [] }) },
      viewerBaseline: { getBaseline: async () => ({ expectedPeak: 0, platformSplit: {}, trendPct: 0, sampleCount: 0 }) },
      churches: new Map([['church-1', runtime]]),
      broadcastToPortal: vi.fn(),
      postSystemChatMessage: vi.fn(),
    });

    await reloaded.ready;

    expect(reloaded.getEscalationContacts('church-1')).toHaveLength(1);
    expect(reloaded.getEscalationContacts('church-1')[0].contact_value).toBe('12345');
    expect(reloaded.getLatestRundown('church-1', 'main-instance', 'room-main')?.confirmed_by).toBe('Taylor');
    expect(reloaded.isConfirmed('church-1', 'main-instance', 'room-main')).toBe(true);
  });
});
