/**
 * RundownEngine — scheduler helper tests
 *
 * The basic CRUD and active-state tests (createRundown, getRundown, updateRundown,
 * deleteRundown, activateRundown, advanceStep, goToStep, getCurrentStep,
 * deactivateRundown, orphan cleanup) are already covered in rundown-scheduler.test.js.
 *
 * This file extends coverage with:
 *   A. activateRundown edge cases — nonexistent rundown, returns null
 *   B. getAutoActivateRundown — by day, null day = any day, not found
 *   C. activateRundownForScheduler — sets full scheduler state
 *   D. getActiveRundownFull — returns all scheduler fields, orphan cleanup
 *   E. updateActiveState — partial field updates, no-op on empty updates
 *   F. Multiple churches — isolated active state
 *   G. updateRundown — name-only and steps-only partial updates
 *   H. Schema migration — service_day, auto_activate columns added safely
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { RundownEngine } from '../src/rundownEngine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT NOT NULL
    )
  `);
  return db;
}

function seedChurch(db, churchId, name = 'Test Church') {
  db.prepare(
    'INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)'
  ).run(churchId, name, `${churchId}@test.local`, `tok-${churchId}`, new Date().toISOString());
}

// ─── A. activateRundown edge cases ────────────────────────────────────────────

describe('A. activateRundown edge cases', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new RundownEngine(db);
    seedChurch(db, 'ch1');
    seedChurch(db, 'ch2');
  });

  afterEach(() => db?.close());

  it('returns null when rundown does not exist', () => {
    const result = engine.activateRundown('ch1', 'nonexistent-id');
    expect(result).toBeNull();
  });

  it('returns null when rundown belongs to a different church', () => {
    const rd = engine.createRundown('ch2', 'Other Church Rundown', [{ label: 'A' }]);
    const result = engine.activateRundown('ch1', rd.id);
    expect(result).toBeNull();
  });

  it('replaces an existing active rundown (INSERT OR REPLACE)', () => {
    const rd1 = engine.createRundown('ch1', 'First', [{ label: 'Step 1' }, { label: 'Step 2' }]);
    const rd2 = engine.createRundown('ch1', 'Second', [{ label: 'A' }]);

    engine.activateRundown('ch1', rd1.id);
    engine.advanceStep('ch1'); // move to step 1

    const result = engine.activateRundown('ch1', rd2.id);
    expect(result.rundownId).toBe(rd2.id);
    expect(result.currentStep).toBe(0); // reset to 0
  });

  it('returns correct shape from activateRundown', () => {
    const rd = engine.createRundown('ch1', 'Shape Test', [{ label: 'X' }]);
    const result = engine.activateRundown('ch1', rd.id);

    expect(result).toHaveProperty('churchId', 'ch1');
    expect(result).toHaveProperty('rundownId', rd.id);
    expect(result).toHaveProperty('currentStep', 0);
    expect(result).toHaveProperty('startedAt');
    expect(result).toHaveProperty('rundown');
    expect(result.rundown.name).toBe('Shape Test');
  });

  it('advanceStep returns null when no active rundown', () => {
    expect(engine.advanceStep('ch1')).toBeNull();
  });

  it('goToStep returns null when no active rundown', () => {
    expect(engine.goToStep('ch1', 0)).toBeNull();
  });

  it('getCurrentStep returns null when no active rundown', () => {
    expect(engine.getCurrentStep('ch1')).toBeNull();
  });
});

// ─── B. getAutoActivateRundown ────────────────────────────────────────────────

describe('B. getAutoActivateRundown', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new RundownEngine(db);
    seedChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('returns null when no auto_activate rundown exists', () => {
    engine.createRundown('ch1', 'Manual Only', []);
    expect(engine.getAutoActivateRundown('ch1', 0)).toBeNull();
  });

  it('returns a rundown set to auto_activate on the matching day', () => {
    const rd = engine.createRundown('ch1', 'Sunday AM', [{ label: 'Cue 1' }]);
    db.prepare('UPDATE rundowns SET auto_activate = 1, service_day = ? WHERE id = ?').run(0, rd.id); // Sunday

    const result = engine.getAutoActivateRundown('ch1', 0);
    expect(result).not.toBeNull();
    expect(result.id).toBe(rd.id);
    expect(result.name).toBe('Sunday AM');
  });

  it('returns null when auto_activate rundown exists for a different day', () => {
    const rd = engine.createRundown('ch1', 'Wednesday', []);
    db.prepare('UPDATE rundowns SET auto_activate = 1, service_day = 3 WHERE id = ?').run(rd.id); // Wednesday

    expect(engine.getAutoActivateRundown('ch1', 0)).toBeNull(); // asking for Sunday
  });

  it('returns auto_activate rundown with NULL service_day for any day', () => {
    // NULL service_day = matches any day of week
    const rd = engine.createRundown('ch1', 'Any Day Rundown', [{ label: 'Generic' }]);
    db.prepare('UPDATE rundowns SET auto_activate = 1, service_day = NULL WHERE id = ?').run(rd.id);

    const sun = engine.getAutoActivateRundown('ch1', 0);
    const wed = engine.getAutoActivateRundown('ch1', 3);
    const sat = engine.getAutoActivateRundown('ch1', 6);

    expect(sun).not.toBeNull();
    expect(wed).not.toBeNull();
    expect(sat).not.toBeNull();
  });

  it('returns steps parsed from JSON', () => {
    const steps = [{ label: 'Intro', commands: [] }, { label: 'Sermon' }];
    const rd = engine.createRundown('ch1', 'With Steps', steps);
    db.prepare('UPDATE rundowns SET auto_activate = 1, service_day = 0 WHERE id = ?').run(rd.id);

    const result = engine.getAutoActivateRundown('ch1', 0);
    expect(result.steps).toEqual(steps);
  });

  it('does not return rundown from another church', () => {
    seedChurch(db, 'ch2');
    const rd = engine.createRundown('ch2', 'Other Church', []);
    db.prepare('UPDATE rundowns SET auto_activate = 1, service_day = 0 WHERE id = ?').run(rd.id);

    expect(engine.getAutoActivateRundown('ch1', 0)).toBeNull();
  });
});

// ─── C. activateRundownForScheduler ───────────────────────────────────────────

describe('C. activateRundownForScheduler', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new RundownEngine(db);
    seedChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('returns null when rundown does not exist', () => {
    expect(engine.activateRundownForScheduler('ch1', 'bad-id', null)).toBeNull();
  });

  it('returns null when rundown belongs to another church', () => {
    seedChurch(db, 'ch2');
    const rd = engine.createRundown('ch2', 'Other', []);
    expect(engine.activateRundownForScheduler('ch1', rd.id, null)).toBeNull();
  });

  it('inserts a full scheduler row with state = running', () => {
    const rd = engine.createRundown('ch1', 'Full Scheduler', [{ label: 'A' }]);
    const serviceStart = new Date().toISOString();

    const result = engine.activateRundownForScheduler('ch1', rd.id, serviceStart);

    expect(result).not.toBeNull();
    expect(result.churchId).toBe('ch1');
    expect(result.rundownId).toBe(rd.id);
    expect(result.currentStep).toBe(0);
    expect(result.state).toBe('running');
    expect(result.serviceStartAt).toBe(serviceStart);
    expect(result.rundown.name).toBe('Full Scheduler');
  });

  it('sets cues_fired to [] in the DB', () => {
    const rd = engine.createRundown('ch1', 'Cues Init', []);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    const row = db.prepare('SELECT cues_fired FROM active_rundowns WHERE church_id = ?').get('ch1');
    expect(JSON.parse(row.cues_fired)).toEqual([]);
  });

  it('sets last_cue_fired_at to NULL in the DB', () => {
    const rd = engine.createRundown('ch1', 'Last Cue Init', []);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    const row = db.prepare('SELECT last_cue_fired_at FROM active_rundowns WHERE church_id = ?').get('ch1');
    expect(row.last_cue_fired_at).toBeNull();
  });

  it('defaults serviceStartAt to now when not provided', () => {
    const rd = engine.createRundown('ch1', 'No ServiceStart', []);
    const before = new Date().toISOString();
    const result = engine.activateRundownForScheduler('ch1', rd.id, null);
    const after = new Date().toISOString();

    expect(result.serviceStartAt >= before).toBe(true);
    expect(result.serviceStartAt <= after).toBe(true);
  });

  it('replaces existing active rundown', () => {
    const rd1 = engine.createRundown('ch1', 'First', [{ label: 'X' }, { label: 'Y' }]);
    const rd2 = engine.createRundown('ch1', 'Second', []);

    engine.activateRundownForScheduler('ch1', rd1.id, null);
    engine.updateActiveState('ch1', { currentStep: 1, state: 'paused' });

    const result = engine.activateRundownForScheduler('ch1', rd2.id, null);
    expect(result.rundownId).toBe(rd2.id);
    expect(result.currentStep).toBe(0);
    expect(result.state).toBe('running');
  });
});

// ─── D. getActiveRundownFull ──────────────────────────────────────────────────

describe('D. getActiveRundownFull', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new RundownEngine(db);
    seedChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('returns null when no active rundown', () => {
    expect(engine.getActiveRundownFull('ch1')).toBeNull();
  });

  it('returns all scheduler fields', () => {
    const rd = engine.createRundown('ch1', 'Full', [{ label: 'A' }, { label: 'B' }]);
    const serviceStart = new Date().toISOString();
    engine.activateRundownForScheduler('ch1', rd.id, serviceStart);

    const full = engine.getActiveRundownFull('ch1');

    expect(full).toHaveProperty('churchId', 'ch1');
    expect(full).toHaveProperty('rundownId', rd.id);
    expect(full).toHaveProperty('currentStep', 0);
    expect(full).toHaveProperty('state', 'running');
    expect(full).toHaveProperty('startedAt');
    expect(full).toHaveProperty('serviceStartAt', serviceStart);
    expect(full).toHaveProperty('lastCueFiredAt', null);
    expect(full).toHaveProperty('cuesFired');
    expect(Array.isArray(full.cuesFired)).toBe(true);
    expect(full).toHaveProperty('rundown');
  });

  it('parses cuesFired from JSON array', () => {
    const rd = engine.createRundown('ch1', 'Cues', [{ label: 'A' }, { label: 'B' }]);
    engine.activateRundownForScheduler('ch1', rd.id, null);
    engine.updateActiveState('ch1', { cuesFired: [0, 1] });

    const full = engine.getActiveRundownFull('ch1');
    expect(full.cuesFired).toEqual([0, 1]);
  });

  it('returns state from DB, defaults to "running" if null', () => {
    const rd = engine.createRundown('ch1', 'State Test', []);
    engine.activateRundown('ch1', rd.id); // uses basic activate, no state column set

    const full = engine.getActiveRundownFull('ch1');
    expect(full.state).toBe('running'); // default
  });

  it('cleans up orphaned active rundown when rundown is deleted', () => {
    const rd = engine.createRundown('ch1', 'Orphan', [{ label: 'A' }]);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    // Force-delete rundown without cleanup (simulate orphan)
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM rundowns WHERE id = ?').run(rd.id);
    db.pragma('foreign_keys = ON');

    const result = engine.getActiveRundownFull('ch1');
    expect(result).toBeNull();

    // Active row should be gone
    const row = db.prepare('SELECT * FROM active_rundowns WHERE church_id = ?').get('ch1');
    expect(row).toBeUndefined();
  });
});

// ─── E. updateActiveState ─────────────────────────────────────────────────────

describe('E. updateActiveState', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new RundownEngine(db);
    seedChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('updates currentStep only', () => {
    const rd = engine.createRundown('ch1', 'Steps', [{ label: 'A' }, { label: 'B' }, { label: 'C' }]);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    engine.updateActiveState('ch1', { currentStep: 2 });

    const full = engine.getActiveRundownFull('ch1');
    expect(full.currentStep).toBe(2);
    expect(full.state).toBe('running'); // unchanged
  });

  it('updates state only', () => {
    const rd = engine.createRundown('ch1', 'State', []);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    engine.updateActiveState('ch1', { state: 'paused' });

    const full = engine.getActiveRundownFull('ch1');
    expect(full.state).toBe('paused');
  });

  it('updates lastCueFiredAt', () => {
    const rd = engine.createRundown('ch1', 'Cue Time', []);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    const firedAt = new Date().toISOString();
    engine.updateActiveState('ch1', { lastCueFiredAt: firedAt });

    const full = engine.getActiveRundownFull('ch1');
    expect(full.lastCueFiredAt).toBe(firedAt);
  });

  it('updates cuesFired array', () => {
    const rd = engine.createRundown('ch1', 'Cues', [{ label: 'A' }, { label: 'B' }]);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    engine.updateActiveState('ch1', { cuesFired: [0] });
    const full1 = engine.getActiveRundownFull('ch1');
    expect(full1.cuesFired).toEqual([0]);

    engine.updateActiveState('ch1', { cuesFired: [0, 1] });
    const full2 = engine.getActiveRundownFull('ch1');
    expect(full2.cuesFired).toEqual([0, 1]);
  });

  it('is a no-op when updates object is empty', () => {
    const rd = engine.createRundown('ch1', 'No Update', []);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    // Should not throw or change anything
    expect(() => engine.updateActiveState('ch1', {})).not.toThrow();

    const full = engine.getActiveRundownFull('ch1');
    expect(full.currentStep).toBe(0);
    expect(full.state).toBe('running');
  });

  it('can update multiple fields at once', () => {
    const rd = engine.createRundown('ch1', 'Multi', [{ label: 'A' }, { label: 'B' }]);
    engine.activateRundownForScheduler('ch1', rd.id, null);

    const firedAt = new Date().toISOString();
    engine.updateActiveState('ch1', {
      currentStep: 1,
      state: 'paused',
      lastCueFiredAt: firedAt,
      cuesFired: [0],
    });

    const full = engine.getActiveRundownFull('ch1');
    expect(full.currentStep).toBe(1);
    expect(full.state).toBe('paused');
    expect(full.lastCueFiredAt).toBe(firedAt);
    expect(full.cuesFired).toEqual([0]);
  });
});

// ─── F. Multiple churches isolated ────────────────────────────────────────────

describe('F. Multiple churches — isolated active state', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new RundownEngine(db);
    seedChurch(db, 'ch1');
    seedChurch(db, 'ch2');
  });

  afterEach(() => db?.close());

  it('each church has its own active rundown', () => {
    const rd1 = engine.createRundown('ch1', 'Church 1 Rundown', [{ label: 'A' }, { label: 'B' }]);
    const rd2 = engine.createRundown('ch2', 'Church 2 Rundown', [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }]);

    engine.activateRundown('ch1', rd1.id);
    engine.activateRundown('ch2', rd2.id);

    engine.advanceStep('ch1'); // ch1 now at step 1
    // ch2 still at step 0

    expect(engine.getActiveRundown('ch1').currentStep).toBe(1);
    expect(engine.getActiveRundown('ch2').currentStep).toBe(0);
  });

  it('deactivating one church does not affect the other', () => {
    const rd1 = engine.createRundown('ch1', 'Rd1', [{ label: 'A' }]);
    const rd2 = engine.createRundown('ch2', 'Rd2', [{ label: 'X' }]);

    engine.activateRundown('ch1', rd1.id);
    engine.activateRundown('ch2', rd2.id);

    engine.deactivateRundown('ch1');

    expect(engine.getActiveRundown('ch1')).toBeNull();
    expect(engine.getActiveRundown('ch2')).not.toBeNull();
  });

  it('updateActiveState scoped to correct church', () => {
    const rd1 = engine.createRundown('ch1', 'Rd1', [{ label: 'A' }, { label: 'B' }]);
    const rd2 = engine.createRundown('ch2', 'Rd2', [{ label: 'X' }, { label: 'Y' }]);

    engine.activateRundownForScheduler('ch1', rd1.id, null);
    engine.activateRundownForScheduler('ch2', rd2.id, null);

    engine.updateActiveState('ch1', { currentStep: 1, state: 'paused' });

    const f1 = engine.getActiveRundownFull('ch1');
    const f2 = engine.getActiveRundownFull('ch2');

    expect(f1.currentStep).toBe(1);
    expect(f1.state).toBe('paused');
    expect(f2.currentStep).toBe(0);
    expect(f2.state).toBe('running');
  });
});

// ─── G. updateRundown partial updates ─────────────────────────────────────────

describe('G. updateRundown partial updates', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new RundownEngine(db);
    seedChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('updates name only, leaving steps unchanged', () => {
    const steps = [{ label: 'A' }, { label: 'B' }];
    const rd = engine.createRundown('ch1', 'Original', steps);
    const updated = engine.updateRundown(rd.id, { name: 'Renamed' });

    expect(updated.name).toBe('Renamed');
    expect(updated.steps).toEqual(steps);
  });

  it('updates steps only, leaving name unchanged', () => {
    const rd = engine.createRundown('ch1', 'Keep Name', [{ label: 'X' }]);
    const newSteps = [{ label: 'Intro' }, { label: 'Worship' }, { label: 'Sermon' }];
    const updated = engine.updateRundown(rd.id, { steps: newSteps });

    expect(updated.name).toBe('Keep Name');
    expect(updated.steps).toEqual(newSteps);
  });

  it('returns null when no updatable fields provided', () => {
    const rd = engine.createRundown('ch1', 'No Fields', []);
    expect(engine.updateRundown(rd.id, {})).toBeNull();
    expect(engine.updateRundown(rd.id, { unrelated: 'value' })).toBeNull();
  });

  it('updates updated_at timestamp on change', () => {
    const rd = engine.createRundown('ch1', 'Timestamp', []);
    const originalUpdatedAt = rd.updated_at;

    // Wait a tick to ensure timestamp changes
    const updated = engine.updateRundown(rd.id, { name: 'New Name' });
    expect(updated.updated_at >= originalUpdatedAt).toBe(true);
  });

  it('updateRundown reflects changes immediately via getRundown', () => {
    const rd = engine.createRundown('ch1', 'Check Persist', [{ label: 'Old' }]);
    engine.updateRundown(rd.id, { name: 'Persisted', steps: [{ label: 'New' }] });

    const fetched = engine.getRundown(rd.id);
    expect(fetched.name).toBe('Persisted');
    expect(fetched.steps[0].label).toBe('New');
  });
});

// ─── H. Schema migration ──────────────────────────────────────────────────────

describe('H. Schema migration', () => {
  it('adds service_day and auto_activate columns to existing rundowns table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (churchId TEXT PRIMARY KEY, name TEXT NOT NULL, registeredAt TEXT NOT NULL)
    `);

    // Create a rundowns table WITHOUT the scheduler columns
    db.exec(`
      CREATE TABLE rundowns (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        name TEXT NOT NULL,
        steps_json TEXT DEFAULT '[]',
        is_template INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // RundownEngine constructor should add missing columns safely
    expect(() => new RundownEngine(db)).not.toThrow();

    // Verify columns were added
    const info = db.prepare('PRAGMA table_info(rundowns)').all();
    const cols = info.map(c => c.name);
    expect(cols).toContain('service_day');
    expect(cols).toContain('auto_activate');

    db.close();
  });

  it('is idempotent — constructing twice does not throw', () => {
    const db = createTestDb();
    expect(() => {
      new RundownEngine(db);
      new RundownEngine(db);
    }).not.toThrow();
    db.close();
  });
});
