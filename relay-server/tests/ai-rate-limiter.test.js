import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiRateLimiter } from '../src/aiRateLimiter.js';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      billing_tier TEXT DEFAULT 'connect'
    )
  `);
  db.exec(`
    INSERT INTO churches (churchId, name, billing_tier)
    VALUES ('church-1', 'Test Church', 'connect')
  `);
  return db;
}

function mockSignalFailover(state = 'HEALTHY') {
  return {
    getState: vi.fn().mockReturnValue({ state }),
  };
}

// ─── A. Active Incident Bypass ───────────────────────────────────────────────

describe('Active Incident Bypass', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db?.close();
  });

  it('CONFIRMED_OUTAGE bypasses diagnostic limit', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('CONFIRMED_OUTAGE') });
    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it('FAILOVER_ACTIVE bypasses diagnostic limit', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('FAILOVER_ACTIVE') });
    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it('HEALTHY does NOT bypass — normal limit check', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBeUndefined();
    expect(result.usage).toBe(1);
  });

  it('bypass logged to ai_rate_limit_events', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('CONFIRMED_OUTAGE') });
    limiter.checkDiagnosticLimit('church-1', 'connect');
    const row = db.prepare('SELECT * FROM ai_rate_limit_events WHERE church_id = ?').get('church-1');
    expect(row).toBeTruthy();
    expect(row.event_type).toBe('bypass');
    expect(row.category).toBe('diagnostic');
    expect(row.detail).toBe('active_incident');
  });

  it('no signalFailover reference → bypass never triggers', () => {
    limiter = new AiRateLimiter({ db });
    expect(limiter.isActiveIncident('church-1')).toBe(false);
    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBeUndefined();
  });

  it('works when constructed with a query client', async () => {
    const queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    limiter = new AiRateLimiter({ db: queryClient, signalFailover: mockSignalFailover('HEALTHY') });
    await limiter.ready;

    const result = await limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);

    const month = limiter._getCurrentMonth();
    const row = db.prepare('SELECT usage_count FROM ai_diagnostic_usage WHERE church_id = ? AND month = ?')
      .get('church-1', month);
    expect(row.usage_count).toBe(1);
  });
});

// ─── B. Diagnostic Monthly Limits ────────────────────────────────────────────

describe('Diagnostic Monthly Limits', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
  });

  afterEach(() => {
    db?.close();
  });

  it('Connect tier allows 20/month', () => {
    // Use up 19 calls
    for (let i = 0; i < 19; i++) {
      const r = limiter.checkDiagnosticLimit('church-1', 'connect');
      expect(r.allowed).toBe(true);
    }
    // 20th should still be allowed
    const r20 = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(r20.allowed).toBe(true);
    expect(r20.usage).toBe(20);
    // 21st should be denied
    const r21 = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(r21.allowed).toBe(false);
    expect(r21.usage).toBe(20);
    expect(r21.limit).toBe(20);
  });

  it('Plus tier allows 100/month', () => {
    const result = limiter.checkDiagnosticLimit('church-1', 'plus');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(100);
  });

  it('Pro tier allows 300/month', () => {
    const result = limiter.checkDiagnosticLimit('church-1', 'pro');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(300);
  });

  it('Enterprise (managed) is unlimited', () => {
    const result = limiter.checkDiagnosticLimit('church-1', 'managed');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(Infinity);
  });

  it('usage incremented atomically', () => {
    limiter.checkDiagnosticLimit('church-1', 'connect');
    limiter.checkDiagnosticLimit('church-1', 'connect');
    limiter.checkDiagnosticLimit('church-1', 'connect');
    const month = limiter._getCurrentMonth();
    const row = db.prepare('SELECT usage_count FROM ai_diagnostic_usage WHERE church_id = ? AND month = ?')
      .get('church-1', month);
    expect(row.usage_count).toBe(3);
  });

  it('new month resets count', () => {
    // Manually insert usage for a previous month
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', '2025-01', 20);
    // Current month should start fresh
    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.usage).toBe(1); // not 21
  });
});

// ─── C. 80% Warning Threshold ────────────────────────────────────────────────

describe('80% Warning Threshold', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
  });

  afterEach(() => {
    db?.close();
  });

  it('first call crossing 80% includes warning80', () => {
    // Connect limit = 20, 80% = 16
    // Pre-fill 15 calls
    const month = limiter._getCurrentMonth();
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', month, 15);

    // 16th call crosses 80%
    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.warning80).toBe(true);
    expect(result.usage).toBe(16);
  });

  it('subsequent calls above 80% do NOT re-warn', () => {
    const month = limiter._getCurrentMonth();
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', month, 16);

    // 17th call — already above 80%
    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.warning80).toBeUndefined();
  });

  it('calls below 80% do NOT warn', () => {
    const month = limiter._getCurrentMonth();
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', month, 10);

    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.warning80).toBeUndefined();
  });
});

// ─── D. Limit Hit Response ───────────────────────────────────────────────────

describe('Limit Hit Response', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
  });

  afterEach(() => {
    db?.close();
  });

  it('returns allowed:false with usage, limit, resetDate when at limit', () => {
    const month = limiter._getCurrentMonth();
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', month, 20);

    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(false);
    expect(result.usage).toBe(20);
    expect(result.limit).toBe(20);
    expect(result.resetDate).toBeTruthy();
    expect(typeof result.resetDate).toBe('string');
  });

  it('logged to ai_rate_limit_events with event_type limit_hit', () => {
    const month = limiter._getCurrentMonth();
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', month, 20);

    limiter.checkDiagnosticLimit('church-1', 'connect');
    const row = db.prepare("SELECT * FROM ai_rate_limit_events WHERE event_type = 'limit_hit'").get();
    expect(row).toBeTruthy();
    expect(row.category).toBe('diagnostic');
    expect(row.detail).toBe('20/20');
  });

  it('reset date is 1st of next month', () => {
    const resetDate = limiter._getResetDate();
    expect(resetDate).toMatch(/^\w+ 1$/); // e.g. "April 1"
  });
});

// ─── E. Haiku Command Rate Limit ─────────────────────────────────────────────

describe('Haiku Command Rate Limit', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db?.close();
  });

  it('incident bypass via isActiveIncident during CONFIRMED_OUTAGE', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('CONFIRMED_OUTAGE') });
    const result = limiter.checkCommandLimit('church-1');
    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it('incident bypass via isActiveIncident during FAILOVER_ACTIVE', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('FAILOVER_ACTIVE') });
    const result = limiter.checkCommandLimit('church-1');
    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it('no bypass when HEALTHY', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
    const result = limiter.checkCommandLimit('church-1');
    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBe(false);
  });

  it('command bypass logged to events table', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('CONFIRMED_OUTAGE') });
    limiter.checkCommandLimit('church-1');
    const row = db.prepare("SELECT * FROM ai_rate_limit_events WHERE category = 'command'").get();
    expect(row).toBeTruthy();
    expect(row.event_type).toBe('bypass');
  });
});

// ─── F. Category 3 — Incident Summaries Never Limited ────────────────────────

describe('Category 3 — Incident Summaries Never Limited', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
  });

  afterEach(() => {
    db?.close();
  });

  it('no checkDiagnosticLimit or checkCommandLimit for incident summaries (category 3 is never gated)', () => {
    // The incidentSummarizer does NOT call any rate limiter check — it just generates.
    // This test verifies that AiRateLimiter has no method that would be called to block summaries.
    // It only provides logEvent for template fallback tracking.
    expect(typeof limiter.logEvent).toBe('function');
    // No "checkIncidentLimit" method exists
    expect(limiter.checkIncidentLimit).toBeUndefined();
  });

  it('template fallback logged via logEvent', () => {
    limiter.logEvent('church-1', 'incident_summary', 'template_fallback', 'api_timeout');
    const row = db.prepare("SELECT * FROM ai_rate_limit_events WHERE category = 'incident_summary'").get();
    expect(row).toBeTruthy();
    expect(row.event_type).toBe('template_fallback');
    expect(row.detail).toBe('api_timeout');
  });

  it('template fallback logged when no API key', () => {
    limiter.logEvent('church-1', 'incident_summary', 'template_fallback', 'no_api_key');
    const row = db.prepare("SELECT * FROM ai_rate_limit_events WHERE detail = 'no_api_key'").get();
    expect(row).toBeTruthy();
    expect(row.category).toBe('incident_summary');
  });
});

// ─── G. Portal Usage Stats ───────────────────────────────────────────────────

describe('Portal Usage Stats', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
  });

  afterEach(() => {
    db?.close();
  });

  it('returns correct current usage and limit', () => {
    // Make 5 calls first
    for (let i = 0; i < 5; i++) limiter.checkDiagnosticLimit('church-1', 'connect');
    const stats = limiter.getUsageStats('church-1', 'connect');
    expect(stats.diagnosticUsage).toBe(5);
    expect(stats.diagnosticLimit).toBe(20);
    expect(stats.diagnosticResetDate).toBeTruthy();
  });

  it('Enterprise tier returns Infinity for limit', () => {
    const stats = limiter.getUsageStats('church-1', 'managed');
    expect(stats.diagnosticLimit).toBe(Infinity);
  });

  it('zero usage returns 0 (not null/undefined)', () => {
    const stats = limiter.getUsageStats('church-1', 'connect');
    expect(stats.diagnosticUsage).toBe(0);
    expect(typeof stats.diagnosticUsage).toBe('number');
  });
});

// ─── H. Event Logging ────────────────────────────────────────────────────────

describe('Event Logging', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
  });

  afterEach(() => {
    db?.close();
  });

  it('logEvent writes to ai_rate_limit_events table', () => {
    limiter.logEvent('church-1', 'diagnostic', 'limit_hit', '20/20');
    const row = db.prepare('SELECT * FROM ai_rate_limit_events').get();
    expect(row.church_id).toBe('church-1');
    expect(row.category).toBe('diagnostic');
    expect(row.event_type).toBe('limit_hit');
    expect(row.detail).toBe('20/20');
    expect(row.created_at).toBeTruthy();
  });

  it('fire-and-forget: errors caught and do not propagate', () => {
    // Close DB to force error
    db.close();
    // Should not throw
    expect(() => limiter.logEvent('church-1', 'diagnostic', 'limit_hit', 'test')).not.toThrow();
  });

  it('all event types stored with correct category and timestamp', () => {
    limiter.logEvent('church-1', 'command', 'bypass', 'active_incident');
    limiter.logEvent('church-1', 'diagnostic', 'warning_80pct', '16/20');
    limiter.logEvent('church-1', 'incident_summary', 'template_fallback', 'api_error');

    const rows = db.prepare('SELECT * FROM ai_rate_limit_events ORDER BY id').all();
    expect(rows).toHaveLength(3);
    expect(rows[0].category).toBe('command');
    expect(rows[0].event_type).toBe('bypass');
    expect(rows[1].category).toBe('diagnostic');
    expect(rows[1].event_type).toBe('warning_80pct');
    expect(rows[2].category).toBe('incident_summary');
    expect(rows[2].event_type).toBe('template_fallback');
    // All should have timestamps
    rows.forEach(r => expect(r.created_at).toMatch(/\d{4}-\d{2}/));
  });
});

// ─── I. Integration: Server Routing (unit-level) ─────────────────────────────

describe('Integration: Routing Logic', () => {
  let db, limiter;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db?.close();
  });

  it('diagnostic intent blocked when over limit', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
    const month = limiter._getCurrentMonth();
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', month, 20);

    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(false);
    expect(result.resetDate).toBeTruthy();
  });

  it('diagnostic intent allowed during active incident even when over limit', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('CONFIRMED_OUTAGE') });
    const month = limiter._getCurrentMonth();
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', month, 20);

    const result = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBe(true);
  });

  it('ambiguous escalation blocked when over diagnostic limit → checkDiagnosticLimit returns false', () => {
    limiter = new AiRateLimiter({ db, signalFailover: mockSignalFailover('HEALTHY') });
    const month = limiter._getCurrentMonth();
    db.prepare('INSERT INTO ai_diagnostic_usage (church_id, month, usage_count) VALUES (?, ?, ?)')
      .run('church-1', month, 20);

    // Simulates the ambiguous escalation path in server.js
    const check = limiter.checkDiagnosticLimit('church-1', 'connect');
    expect(check.allowed).toBe(false);
    // Server.js would show Haiku's response instead of escalating to Sonnet
  });
});
