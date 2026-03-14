import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const {
  ensureTable,
  getSession,
  createSession,
  processOnboardingMessage,
  executeOnboardingAction,
  parseScheduleToFormats,
  parseTimeString,
  buildSystemPrompt,
  parseAIResponse,
  computeProgress,
  fallbackResponse,
  STATES,
  FALLBACK_FLOW,
} = require('../src/onboardingChat.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      timezone TEXT,
      schedule TEXT DEFAULT '{}',
      service_times TEXT DEFAULT '[]',
      engineer_profile TEXT DEFAULT '{}',
      atem_host TEXT, atem_port INTEGER,
      obs_host TEXT, obs_port INTEGER,
      videohub_host TEXT, videohub_port INTEGER,
      propresenter_host TEXT, propresenter_port INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE church_tds (
      id TEXT PRIMARY KEY,
      church_id TEXT,
      name TEXT,
      role TEXT,
      email TEXT,
      phone TEXT,
      registered_at TEXT
    )
  `);
  ensureTable(db);
  return db;
}

function seedChurch(db, churchId = 'church-1') {
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run(churchId, 'Test Church');
  return churchId;
}

function mockScheduleEngine() {
  return {
    setSchedule: vi.fn(),
    getSchedule: vi.fn().mockReturnValue([]),
  };
}

// ─── A. Table & Session Management ───────────────────────────────────────────

describe('Table & Session Management', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('ensureTable creates onboarding_sessions table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_sessions'").get();
    expect(row).toBeTruthy();
  });

  it('createSession creates a new session', () => {
    const session = createSession(db, 'church-1', { atem: ['192.168.1.240'] });
    expect(session.churchId).toBe('church-1');
    expect(session.state).toBe('intro');
    expect(session.collectedData).toEqual({});
    expect(session.scanResults).toEqual({ atem: ['192.168.1.240'] });
  });

  it('getSession returns null when no session exists', () => {
    expect(getSession(db, 'none')).toBeNull();
  });

  it('getSession returns existing session', () => {
    createSession(db, 'church-1');
    const session = getSession(db, 'church-1');
    expect(session.churchId).toBe('church-1');
    expect(session.state).toBe('intro');
  });

  it('createSession with OR REPLACE updates existing', () => {
    createSession(db, 'church-1', { old: true });
    createSession(db, 'church-1', { new: true });
    const session = getSession(db, 'church-1');
    expect(session.scanResults).toEqual({ new: true });
  });
});

// ─── B. Time Parsing ─────────────────────────────────────────────────────────

describe('parseTimeString', () => {
  it('parses "9:00 AM"', () => {
    expect(parseTimeString('9:00 AM')).toEqual({ hour: 9, minute: 0 });
  });

  it('parses "9:30pm"', () => {
    expect(parseTimeString('9:30pm')).toEqual({ hour: 21, minute: 30 });
  });

  it('parses "11"', () => {
    expect(parseTimeString('11')).toEqual({ hour: 11, minute: 0 });
  });

  it('parses "7 PM"', () => {
    expect(parseTimeString('7 PM')).toEqual({ hour: 19, minute: 0 });
  });

  it('parses "12:00 PM" (noon)', () => {
    expect(parseTimeString('12:00 PM')).toEqual({ hour: 12, minute: 0 });
  });

  it('parses "12:00 AM" (midnight)', () => {
    expect(parseTimeString('12:00 AM')).toEqual({ hour: 0, minute: 0 });
  });

  it('assumes PM for ambiguous low hours (church context)', () => {
    expect(parseTimeString('6')).toEqual({ hour: 18, minute: 0 });
  });

  it('keeps high hours as-is', () => {
    expect(parseTimeString('9')).toEqual({ hour: 9, minute: 0 });
  });

  it('returns null for invalid input', () => {
    expect(parseTimeString('')).toBeNull();
    expect(parseTimeString(null)).toBeNull();
    expect(parseTimeString('abc')).toBeNull();
  });
});

// ─── C. Schedule Parsing ─────────────────────────────────────────────────────

describe('parseScheduleToFormats', () => {
  it('parses single Sunday service', () => {
    const { portalFormat, engineFormat } = parseScheduleToFormats([
      { day: 'sunday', times: ['9:00 AM'], label: 'Worship' },
    ]);
    expect(portalFormat.sunday).toHaveLength(1);
    expect(portalFormat.sunday[0].start).toBe('09:00');
    expect(portalFormat.sunday[0].label).toBe('Worship');
    expect(engineFormat).toHaveLength(1);
    expect(engineFormat[0].day).toBe(0);
    expect(engineFormat[0].startHour).toBe(9);
    expect(engineFormat[0].startMin).toBe(0);
    expect(engineFormat[0].durationHours).toBe(1.5);
  });

  it('parses multiple times for one day', () => {
    const { portalFormat, engineFormat } = parseScheduleToFormats([
      { day: 'sunday', times: ['9:00 AM', '11:00 AM'] },
    ]);
    expect(portalFormat.sunday).toHaveLength(2);
    expect(engineFormat).toHaveLength(2);
    expect(engineFormat[0].startHour).toBe(9);
    expect(engineFormat[1].startHour).toBe(11);
  });

  it('parses multiple days', () => {
    const { portalFormat, engineFormat } = parseScheduleToFormats([
      { day: 'sunday', times: ['9:00 AM', '11:00 AM'] },
      { day: 'wednesday', times: ['7:00 PM'] },
    ]);
    expect(portalFormat.sunday).toHaveLength(2);
    expect(portalFormat.wednesday).toHaveLength(1);
    expect(engineFormat).toHaveLength(3);
  });

  it('uses default label based on day', () => {
    const { portalFormat } = parseScheduleToFormats([
      { day: 'sunday', times: ['10:00 AM'] },
      { day: 'wednesday', times: ['7:00 PM'] },
      { day: 'saturday', times: ['6:00 PM'] },
    ]);
    expect(portalFormat.sunday[0].label).toBe('Worship');
    expect(portalFormat.wednesday[0].label).toBe('Midweek');
    expect(portalFormat.saturday[0].label).toBe('Saturday Service');
  });

  it('calculates end time based on duration', () => {
    const { portalFormat } = parseScheduleToFormats([
      { day: 'sunday', times: ['9:00 AM'], duration: 2 },
    ]);
    expect(portalFormat.sunday[0].end).toBe('11:00');
  });

  it('handles day abbreviations', () => {
    const { engineFormat } = parseScheduleToFormats([
      { day: 'sun', times: ['10:00 AM'] },
      { day: 'wed', times: ['7:00 PM'] },
      { day: 'sat', times: ['6:00 PM'] },
    ]);
    expect(engineFormat[0].day).toBe(0);
    expect(engineFormat[1].day).toBe(3);
    expect(engineFormat[2].day).toBe(6);
  });

  it('skips invalid days', () => {
    const { engineFormat } = parseScheduleToFormats([
      { day: 'notaday', times: ['9:00 AM'] },
    ]);
    expect(engineFormat).toHaveLength(0);
  });

  it('skips invalid times', () => {
    const { engineFormat } = parseScheduleToFormats([
      { day: 'sunday', times: ['invalid'] },
    ]);
    expect(engineFormat).toHaveLength(0);
  });
});

// ─── D. AI Response Parsing ──────────────────────────────────────────────────

describe('parseAIResponse', () => {
  it('parses valid JSON', () => {
    const raw = JSON.stringify({ reply: 'Hello!', actions: [], nextState: 'gear', progress: { completed: [], remaining: ['gear'] } });
    const parsed = parseAIResponse(raw);
    expect(parsed.reply).toBe('Hello!');
    expect(parsed.nextState).toBe('gear');
  });

  it('parses JSON wrapped in markdown code blocks', () => {
    const raw = '```json\n{"reply":"Hi","actions":[]}\n```';
    const parsed = parseAIResponse(raw);
    expect(parsed.reply).toBe('Hi');
  });

  it('falls back to raw text when JSON is invalid', () => {
    const parsed = parseAIResponse('Just some text');
    expect(parsed.reply).toBe('Just some text');
    expect(parsed.actions).toEqual([]);
  });
});

// ─── E. Progress Computation ─────────────────────────────────────────────────

describe('computeProgress', () => {
  it('returns all remaining when no data collected', () => {
    const p = computeProgress('intro', {});
    expect(p.remaining).toEqual(['gear', 'schedule', 'tds', 'stream']);
    expect(p.completed).toEqual([]);
  });

  it('marks equipment as completed', () => {
    const p = computeProgress('schedule', { equipment: { atemHost: '1.2.3.4' } });
    expect(p.completed).toContain('gear');
    expect(p.remaining).not.toContain('gear');
  });

  it('marks schedule as completed', () => {
    const p = computeProgress('tds', { schedule: {} });
    expect(p.completed).toContain('schedule');
  });
});

// ─── F. System Prompt ────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('includes current state', () => {
    const prompt = buildSystemPrompt('gear', {}, {});
    expect(prompt).toContain('Current State: gear');
  });

  it('includes scan results', () => {
    const prompt = buildSystemPrompt('gear', {}, { atem: ['192.168.1.240'] });
    expect(prompt).toContain('192.168.1.240');
  });

  it('includes collected data', () => {
    const prompt = buildSystemPrompt('schedule', { equipment: { atemHost: '10.0.0.1' } }, {});
    expect(prompt).toContain('10.0.0.1');
  });

  it('includes encoder types in action docs', () => {
    const prompt = buildSystemPrompt('gear', {}, {});
    expect(prompt).toContain('encoderType');
    expect(prompt).toContain('vmix');
    expect(prompt).toContain('blackmagic');
  });

  it('includes engineer profile fields', () => {
    const prompt = buildSystemPrompt('stream', {}, {});
    expect(prompt).toContain('streamPlatform');
    expect(prompt).toContain('operatorLevel');
    expect(prompt).toContain('expectedViewers');
  });

  it('includes quickReplies in response format', () => {
    const prompt = buildSystemPrompt('gear', {}, {});
    expect(prompt).toContain('quickReplies');
  });
});

// ─── G. Action Execution — Equipment ─────────────────────────────────────────

describe('executeOnboardingAction — save_equipment', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedChurch(db);
  });

  it('saves equipment to database', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_equipment',
      data: { atemHost: '192.168.1.240', obsHost: 'localhost', obsPort: 4455 },
    }, new Map(), null);
    expect(result.ok).toBe(true);
    const row = db.prepare('SELECT atem_host, obs_host, obs_port FROM churches WHERE churchId = ?').get('church-1');
    expect(row.atem_host).toBe('192.168.1.240');
    expect(row.obs_host).toBe('localhost');
    expect(row.obs_port).toBe(4455);
  });

  it('updates in-memory church config', () => {
    const churches = new Map();
    churches.set('church-1', { atem_host: null });
    executeOnboardingAction(db, 'church-1', {
      type: 'save_equipment',
      data: { atemHost: '10.0.0.5' },
    }, churches, null);
    expect(churches.get('church-1').atem_host).toBe('10.0.0.5');
  });

  it('returns localConfig with atemIp for Electron (#5)', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_equipment',
      data: { atemHost: '192.168.1.10' },
    }, new Map(), null);
    expect(result.localConfig).toBeDefined();
    expect(result.localConfig.atemIp).toBe('192.168.1.10');
  });

  it('returns localConfig with encoder fields (#4)', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_equipment',
      data: { encoderType: 'obs', encoderHost: 'localhost', encoderPort: 4455 },
    }, new Map(), null);
    expect(result.localConfig.encoderType).toBe('obs');
    expect(result.localConfig.encoderHost).toBe('localhost');
    expect(result.localConfig.encoderPort).toBe(4455);
  });

  it('returns localConfig with companionUrl', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_equipment',
      data: { companionHost: '192.168.1.50', companionPort: 8888 },
    }, new Map(), null);
    expect(result.localConfig.companionUrl).toBe('http://192.168.1.50:8888');
  });

  it('uses default companion port 8888', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_equipment',
      data: { companionHost: '10.0.0.1' },
    }, new Map(), null);
    expect(result.localConfig.companionUrl).toBe('http://10.0.0.1:8888');
  });
});

// ─── H. Action Execution — Schedule ──────────────────────────────────────────

describe('executeOnboardingAction — save_schedule', () => {
  let db, scheduleEngine;
  beforeEach(() => {
    db = createTestDb();
    seedChurch(db);
    scheduleEngine = mockScheduleEngine();
  });

  it('saves schedule in both formats', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_schedule',
      data: {
        services: [
          { day: 'sunday', times: ['9:00 AM', '11:00 AM'], label: 'Worship' },
          { day: 'wednesday', times: ['7:00 PM'] },
        ],
      },
    }, new Map(), scheduleEngine);
    expect(result.ok).toBe(true);

    const row = db.prepare('SELECT schedule FROM churches WHERE churchId = ?').get('church-1');
    const portal = JSON.parse(row.schedule);
    expect(portal.sunday).toHaveLength(2);
    expect(portal.wednesday).toHaveLength(1);

    expect(scheduleEngine.setSchedule).toHaveBeenCalledWith('church-1', expect.any(Array));
    const engineArgs = scheduleEngine.setSchedule.mock.calls[0][1];
    expect(engineArgs).toHaveLength(3);
    expect(engineArgs[0].day).toBe(0);
    expect(engineArgs[0].startHour).toBe(9);
  });
});

// ─── I. Action Execution — TDs ───────────────────────────────────────────────

describe('executeOnboardingAction — save_tds', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedChurch(db);
  });

  it('saves TDs to database', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_tds',
      data: {
        tds: [
          { name: 'John', role: 'Lead TD', email: 'john@test.com' },
          { name: 'Jane', role: 'Camera Op' },
        ],
      },
    }, new Map(), null);
    expect(result.ok).toBe(true);
    const tds = db.prepare('SELECT * FROM church_tds WHERE church_id = ?').all('church-1');
    expect(tds).toHaveLength(2);
    expect(tds[0].name).toBe('John');
    expect(tds[1].name).toBe('Jane');
  });

  it('skips TDs without name', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_tds',
      data: { tds: [{ name: '' }, { name: 'Valid' }] },
    }, new Map(), null);
    const tds = db.prepare('SELECT * FROM church_tds WHERE church_id = ?').all('church-1');
    expect(tds).toHaveLength(1);
    expect(result.message).toBe('1 team member added');
  });
});

// ─── J. Action Execution — Engineer Profile (#3) ─────────────────────────────

describe('executeOnboardingAction — save_engineer_profile', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedChurch(db);
  });

  it('updates church name and timezone', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_engineer_profile',
      data: { churchName: 'Grace Community', timezone: 'America/Chicago' },
    }, new Map(), null);
    expect(result.ok).toBe(true);
    const row = db.prepare('SELECT name, timezone FROM churches WHERE churchId = ?').get('church-1');
    expect(row.name).toBe('Grace Community');
    expect(row.timezone).toBe('America/Chicago');
  });

  it('saves full engineer_profile JSON with stream/operator fields', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_engineer_profile',
      data: {
        streamPlatform: 'youtube',
        expectedViewers: '200-500',
        operatorLevel: 'intermediate',
        backupEncoder: 'yes',
        backupSwitcher: 'no',
        specialNotes: 'Splitter before encoder',
      },
    }, new Map(), null);
    expect(result.ok).toBe(true);
    const row = db.prepare('SELECT engineer_profile FROM churches WHERE churchId = ?').get('church-1');
    const profile = JSON.parse(row.engineer_profile);
    expect(profile.streamPlatform).toBe('youtube');
    expect(profile.expectedViewers).toBe('200-500');
    expect(profile.operatorLevel).toBe('intermediate');
    expect(profile.backupEncoder).toBe('yes');
    expect(profile.backupSwitcher).toBe('no');
    expect(profile.specialNotes).toBe('Splitter before encoder');
  });

  it('returns localConfig with church name', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'save_engineer_profile',
      data: { churchName: 'NewLife' },
    }, new Map(), null);
    expect(result.localConfig.name).toBe('NewLife');
  });
});

// ─── K. Action Execution — Complete ──────────────────────────────────────────

describe('executeOnboardingAction — complete', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedChurch(db);
    createSession(db, 'church-1');
  });

  it('marks session as complete', () => {
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'complete',
      data: {},
    }, new Map(), null);
    expect(result.ok).toBe(true);
    const session = getSession(db, 'church-1');
    expect(session.state).toBe('complete');
  });
});

// ─── L. Unknown Action ───────────────────────────────────────────────────────

describe('executeOnboardingAction — unknown', () => {
  it('returns error for unknown action type', () => {
    const db = createTestDb();
    const result = executeOnboardingAction(db, 'church-1', {
      type: 'bad_action',
      data: {},
    }, new Map(), null);
    expect(result.ok).toBe(false);
  });
});

// ─── M. STATES constant ─────────────────────────────────────────────────────

describe('STATES', () => {
  it('has expected state progression', () => {
    expect(STATES).toEqual(['intro', 'gear', 'schedule', 'tds', 'stream', 'review', 'complete']);
  });
});

// ─── N. Fallback mode (#1) ──────────────────────────────────────────────────

describe('Fallback mode (no API key)', () => {
  it('FALLBACK_FLOW covers all non-terminal states', () => {
    expect(FALLBACK_FLOW.intro).toBeDefined();
    expect(FALLBACK_FLOW.gear).toBeDefined();
    expect(FALLBACK_FLOW.schedule).toBeDefined();
    expect(FALLBACK_FLOW.tds).toBeDefined();
    expect(FALLBACK_FLOW.stream).toBeDefined();
  });

  it('each step has a reply and nextState', () => {
    for (const [key, step] of Object.entries(FALLBACK_FLOW)) {
      expect(step.reply).toBeTruthy();
      expect(step.nextState).toBeTruthy();
    }
  });

  it('stream step includes complete action', () => {
    expect(FALLBACK_FLOW.stream.actions).toHaveLength(1);
    expect(FALLBACK_FLOW.stream.actions[0].type).toBe('complete');
  });

  it('fallbackResponse returns reply for intro state', () => {
    const resp = fallbackResponse('intro', 'hi');
    expect(resp.reply).toBeTruthy();
    expect(resp.nextState).toBe('gear');
    expect(resp.quickReplies.length).toBeGreaterThan(0);
  });

  it('fallbackResponse advances through states', () => {
    const r1 = fallbackResponse('gear', 'We use an ATEM');
    expect(r1.nextState).toBe('schedule');
    const r2 = fallbackResponse('schedule', 'Sundays at 9');
    expect(r2.nextState).toBe('tds');
  });

  it('processOnboardingMessage uses fallback when no API key', async () => {
    const db = createTestDb();
    seedChurch(db);
    // No ANTHROPIC_API_KEY set → should use fallback
    const oldKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await processOnboardingMessage(db, 'church-1', 'hi', {}, null);
      expect(result.reply).toBeTruthy();
      expect(result.state).toBeTruthy();
      // Should not throw
    } finally {
      if (oldKey) process.env.ANTHROPIC_API_KEY = oldKey;
    }
  });
});

// ─── O. quickReplies in response ─────────────────────────────────────────────

describe('quickReplies field', () => {
  it('processOnboardingMessage returns quickReplies array', async () => {
    const db = createTestDb();
    seedChurch(db);
    const oldKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await processOnboardingMessage(db, 'church-1', 'hi', {}, null);
      expect(Array.isArray(result.quickReplies)).toBe(true);
    } finally {
      if (oldKey) process.env.ANTHROPIC_API_KEY = oldKey;
    }
  });
});
