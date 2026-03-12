import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const { RundownEngine } = require('../src/rundownEngine');
const { RundownScheduler } = require('../src/scheduler');
const { ScheduleEngine } = require('../src/scheduleEngine');
const { PreServiceCheck } = require('../src/preServiceCheck');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      token TEXT,
      registeredAt TEXT NOT NULL
    )
  `);
  return db;
}

function seedChurch(db, churchId, name = 'Test Church') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO churches (churchId, name, email, token, registeredAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(churchId, name, `${churchId}@test.local`, `tok-${churchId}`, now);
}

describe('RundownEngine — CRUD and state', () => {
  let db;
  let engine;
  const churchId = 'church_rd_1';

  beforeEach(() => {
    db = createDb();
    engine = new RundownEngine(db);
    seedChurch(db, churchId);
  });

  afterEach(() => {
    if (db) db.close();
  });

  // ── 1. Rundown creation and parsing ────────────────────────────────────────

  it('creates a rundown with steps and parses them back', () => {
    const steps = [
      { label: 'Welcome', commands: [{ command: 'atem.cut', params: { input: 1 } }] },
      { label: 'Worship', commands: [{ command: 'atem.cut', params: { input: 2 } }] },
      { label: 'Sermon', commands: [] },
    ];
    const result = engine.createRundown(churchId, 'Sunday AM', steps);

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Sunday AM');
    expect(result.steps).toEqual(steps);
    expect(result.church_id).toBe(churchId);

    // Retrieve and verify parsing
    const fetched = engine.getRundown(result.id);
    expect(fetched.steps).toEqual(steps);
    expect(fetched.steps.length).toBe(3);
  });

  it('creates a rundown with empty steps', () => {
    const result = engine.createRundown(churchId, 'Empty Rundown');
    expect(result.steps).toEqual([]);
  });

  it('updates a rundown name and steps', () => {
    const rd = engine.createRundown(churchId, 'Original', [{ label: 'Cue 1' }]);
    const updated = engine.updateRundown(rd.id, { name: 'Updated', steps: [{ label: 'Cue A' }, { label: 'Cue B' }] });
    expect(updated.name).toBe('Updated');
    expect(updated.steps.length).toBe(2);
  });

  it('returns null when updating with no fields', () => {
    const rd = engine.createRundown(churchId, 'No Update');
    const result = engine.updateRundown(rd.id, {});
    expect(result).toBeNull();
  });

  it('deletes a rundown and cleans up active state', () => {
    const rd = engine.createRundown(churchId, 'To Delete', [{ label: 'Cue 1' }]);
    engine.activateRundown(churchId, rd.id);
    expect(engine.getActiveRundown(churchId)).not.toBeNull();

    engine.deleteRundown(rd.id);
    expect(engine.getRundown(rd.id)).toBeNull();
    expect(engine.getActiveRundown(churchId)).toBeNull();
  });

  it('lists rundowns for a church', () => {
    engine.createRundown(churchId, 'First');
    engine.createRundown(churchId, 'Second');
    engine.createRundown(churchId, 'Third');

    const list = engine.getRundowns(churchId);
    expect(list.length).toBe(3);
    const names = list.map(r => r.name);
    expect(names).toContain('First');
    expect(names).toContain('Second');
    expect(names).toContain('Third');
  });

  // ── Active state management ────────────────────────────────────────────────

  it('activates a rundown and tracks current step', () => {
    const rd = engine.createRundown(churchId, 'Active Test', [
      { label: 'Step 1' },
      { label: 'Step 2' },
      { label: 'Step 3' },
    ]);

    const active = engine.activateRundown(churchId, rd.id);
    expect(active.currentStep).toBe(0);
    expect(active.rundown.name).toBe('Active Test');
  });

  it('advances through steps correctly', () => {
    const rd = engine.createRundown(churchId, 'Advance', [
      { label: 'A' }, { label: 'B' }, { label: 'C' },
    ]);
    engine.activateRundown(churchId, rd.id);

    const s1 = engine.advanceStep(churchId);
    expect(s1.currentStep).toBe(1);

    const s2 = engine.advanceStep(churchId);
    expect(s2.currentStep).toBe(2);

    // Cannot advance past last step
    const s3 = engine.advanceStep(churchId);
    expect(s3).toBeNull();
  });

  it('goToStep jumps to a specific index', () => {
    const rd = engine.createRundown(churchId, 'Jump', [
      { label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' },
    ]);
    engine.activateRundown(churchId, rd.id);

    const r = engine.goToStep(churchId, 2);
    expect(r.currentStep).toBe(2);
  });

  it('goToStep rejects out-of-bounds indices', () => {
    const rd = engine.createRundown(churchId, 'Bounds', [{ label: 'A' }]);
    engine.activateRundown(churchId, rd.id);

    expect(engine.goToStep(churchId, -1)).toBeNull();
    expect(engine.goToStep(churchId, 5)).toBeNull();
  });

  it('getCurrentStep returns step detail', () => {
    const rd = engine.createRundown(churchId, 'Current', [
      { label: 'Intro' }, { label: 'Main' },
    ]);
    engine.activateRundown(churchId, rd.id);

    const cur = engine.getCurrentStep(churchId);
    expect(cur.stepIndex).toBe(0);
    expect(cur.step.label).toBe('Intro');
    expect(cur.totalSteps).toBe(2);
    expect(cur.rundownName).toBe('Current');
  });

  it('deactivateRundown clears active state', () => {
    const rd = engine.createRundown(churchId, 'Deactivate', [{ label: 'A' }]);
    engine.activateRundown(churchId, rd.id);
    expect(engine.getActiveRundown(churchId)).not.toBeNull();

    engine.deactivateRundown(churchId);
    expect(engine.getActiveRundown(churchId)).toBeNull();
  });

  it('returns null when activating a rundown from another church', () => {
    seedChurch(db, 'other_church');
    const rd = engine.createRundown('other_church', 'Other', [{ label: 'A' }]);
    const result = engine.activateRundown(churchId, rd.id);
    expect(result).toBeNull();
  });

  it('cleans up orphaned active rundown when rundown is missing', () => {
    const rd = engine.createRundown(churchId, 'Orphan', [{ label: 'A' }]);
    engine.activateRundown(churchId, rd.id);

    // Temporarily disable FK enforcement to simulate an orphaned row
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM rundowns WHERE id = ?').run(rd.id);
    db.pragma('foreign_keys = ON');

    const result = engine.getActiveRundown(churchId);
    expect(result).toBeNull();

    // Active row should be cleaned up
    const row = db.prepare('SELECT * FROM active_rundowns WHERE church_id = ?').get(churchId);
    expect(row).toBeUndefined();
  });
});

describe('ScheduleEngine — service windows and next service', () => {
  let db;
  let scheduleEngine;
  const churchId = 'church_sched_1';

  beforeEach(() => {
    db = createDb();
    scheduleEngine = new ScheduleEngine(db);
    seedChurch(db, churchId);
  });

  afterEach(() => {
    if (scheduleEngine._pollTimer) clearInterval(scheduleEngine._pollTimer);
    if (db) db.close();
  });

  // ── 2. Schedule calculation ────────────────────────────────────────────────

  it('sets and retrieves a schedule', () => {
    const times = [
      { day: 0, startHour: 9, startMin: 30, durationHours: 2 },
      { day: 3, startHour: 19, startMin: 0, durationHours: 1.5 },
    ];
    scheduleEngine.setSchedule(churchId, times);
    const result = scheduleEngine.getSchedule(churchId);
    expect(result).toEqual(times);
  });

  it('returns empty schedule for church with no times', () => {
    const result = scheduleEngine.getSchedule(churchId);
    expect(result).toEqual([]);
  });

  it('isServiceWindow returns false when no schedule is set', () => {
    expect(scheduleEngine.isServiceWindow(churchId)).toBe(false);
  });

  it('getNextService returns null when no schedule is set', () => {
    expect(scheduleEngine.getNextService(churchId)).toBeNull();
  });

  it('getNextService returns the soonest upcoming service', () => {
    // Set services for every day to ensure one is always "next"
    const times = [];
    for (let d = 0; d < 7; d++) {
      times.push({ day: d, startHour: 10, startMin: 0, durationHours: 2 });
    }
    scheduleEngine.setSchedule(churchId, times);

    const next = scheduleEngine.getNextService(churchId);
    expect(next).not.toBeNull();
    expect(next.startTime).toBe('10:00');
    expect(typeof next.minutesUntil).toBe('number');
    expect(next.minutesUntil).toBeGreaterThan(0);
  });

  // ── 5. Recurring schedule patterns ─────────────────────────────────────────

  it('handles multiple services on the same day', () => {
    const times = [
      { day: 0, startHour: 9, startMin: 0, durationHours: 1.5 },
      { day: 0, startHour: 11, startMin: 0, durationHours: 1.5 },
    ];
    scheduleEngine.setSchedule(churchId, times);
    const schedule = scheduleEngine.getSchedule(churchId);
    expect(schedule.length).toBe(2);
  });

  // ── Window open/close callbacks ────────────────────────────────────────────

  it('fires window open and close callbacks on state transitions', () => {
    const opened = [];
    const closed = [];

    scheduleEngine.addWindowOpenCallback((id) => opened.push(id));
    scheduleEngine.addWindowCloseCallback((id) => closed.push(id));

    // Set a schedule that matches right now
    const now = new Date();
    scheduleEngine.setSchedule(churchId, [
      { day: now.getDay(), startHour: now.getHours(), startMin: now.getMinutes(), durationHours: 1 },
    ]);

    // First poll — window opens
    scheduleEngine._pollWindows();
    expect(opened).toContain(churchId);
    expect(closed.length).toBe(0);

    // Second poll — no change (still in window)
    opened.length = 0;
    scheduleEngine._pollWindows();
    expect(opened.length).toBe(0);

    // Change schedule to a different day, so window closes
    const otherDay = (now.getDay() + 3) % 7;
    scheduleEngine.setSchedule(churchId, [
      { day: otherDay, startHour: 3, startMin: 0, durationHours: 1 },
    ]);
    scheduleEngine._pollWindows();
    expect(closed).toContain(churchId);
  });
});

describe('RundownScheduler — cue triggers and controls', () => {
  let db;
  let rundownEngine;
  let scheduleEngine;
  let scheduler;
  const churchId = 'church_rs_1';

  beforeEach(() => {
    db = createDb();
    rundownEngine = new RundownEngine(db);
    scheduleEngine = new ScheduleEngine(db);
    seedChurch(db, churchId);

    scheduler = new RundownScheduler(db, { rundownEngine, scheduleEngine });
    // Mock command executor — just records calls
    scheduler._executedCommands = [];
    scheduler.setCommandExecutor(async (cId, cmd, params, source) => {
      scheduler._executedCommands.push({ churchId: cId, command: cmd, params, source });
      return { ok: true };
    });
  });

  afterEach(() => {
    scheduler.stop();
    if (db) db.close();
  });

  // ── 4. Event mode activation/deactivation ──────────────────────────────────

  it('activates and deactivates a rundown manually', () => {
    const rd = rundownEngine.createRundown(churchId, 'Manual', [
      { label: 'Cue 1', commands: [] },
    ]);
    const result = scheduler.activate(churchId, rd.id);
    expect(result.churchId).toBe(churchId);
    expect(result.rundownId).toBe(rd.id);
    expect(result.currentStep).toBe(0);
    expect(result.state).toBe('running');

    const deact = scheduler.deactivate(churchId);
    expect(deact.deactivated).toBe(true);

    const status = scheduler.getStatus(churchId);
    expect(status.active).toBe(false);
  });

  it('returns error when activating a nonexistent rundown', () => {
    const result = scheduler.activate(churchId, 'nonexistent_id');
    expect(result.error).toBeTruthy();
  });

  // ── Manual advance, skip, goBack, jumpToCue ────────────────────────────────

  it('advances through cues and executes commands', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Advance Test', [
      { label: 'Camera 1', commands: [{ command: 'atem.cut', params: { input: 1 } }] },
      { label: 'Camera 2', commands: [{ command: 'atem.cut', params: { input: 2 } }] },
      { label: 'Outro', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);

    const r1 = await scheduler.advance(churchId);
    expect(r1.cueIndex).toBe(0);
    expect(r1.source).toBe('manual');
    expect(scheduler._executedCommands.length).toBe(1);
    expect(scheduler._executedCommands[0].command).toBe('atem.cut');

    const r2 = await scheduler.advance(churchId);
    expect(r2.cueIndex).toBe(1);
    expect(scheduler._executedCommands.length).toBe(2);
  });

  it('skip moves to next cue without executing commands', () => {
    const rd = rundownEngine.createRundown(churchId, 'Skip Test', [
      { label: 'A', commands: [{ command: 'obs.startStream' }] },
      { label: 'B', commands: [{ command: 'obs.stopStream' }] },
    ]);
    scheduler.activate(churchId, rd.id);

    const result = scheduler.skip(churchId);
    expect(result.skipped).toBe(true);
    expect(result.cueIndex).toBe(0);

    // No commands should have fired
    expect(scheduler._executedCommands.length).toBe(0);

    // Current step should now be 1
    const status = scheduler.getStatus(churchId);
    expect(status.currentCue).toBe(1);
  });

  it('goBack returns to previous cue', async () => {
    const rd = rundownEngine.createRundown(churchId, 'GoBack', [
      { label: 'A', commands: [] },
      { label: 'B', commands: [] },
      { label: 'C', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.advance(churchId); // fires cue 0, moves to 1
    await scheduler.advance(churchId); // fires cue 1, moves to 2

    const result = scheduler.goBack(churchId);
    expect(result.cueIndex).toBe(1);

    // Cue 1 should be removed from fired list so it can re-fire
    const active = rundownEngine.getActiveRundownFull(churchId);
    expect(active.cuesFired).not.toContain(1);
  });

  it('goBack returns error at first cue', () => {
    const rd = rundownEngine.createRundown(churchId, 'GoBack Edge', [{ label: 'A' }]);
    scheduler.activate(churchId, rd.id);
    const result = scheduler.goBack(churchId);
    expect(result.error).toBeTruthy();
  });

  it('jumpToCue moves to an arbitrary cue and clears future fired cues', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Jump', [
      { label: 'A', commands: [] },
      { label: 'B', commands: [] },
      { label: 'C', commands: [] },
      { label: 'D', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.advance(churchId); // fire 0
    await scheduler.advance(churchId); // fire 1
    await scheduler.advance(churchId); // fire 2

    // Jump back to cue 1
    const result = scheduler.jumpToCue(churchId, 1);
    expect(result.cueIndex).toBe(1);

    const active = rundownEngine.getActiveRundownFull(churchId);
    expect(active.cuesFired).toEqual([0]); // only cue 0 kept
  });

  it('jumpToCue rejects invalid index', () => {
    const rd = rundownEngine.createRundown(churchId, 'Jump OOB', [{ label: 'A' }]);
    scheduler.activate(churchId, rd.id);
    expect(scheduler.jumpToCue(churchId, 5).error).toBeTruthy();
    expect(scheduler.jumpToCue(churchId, -1).error).toBeTruthy();
  });

  // ── Pause and resume ──────────────────────────────────────────────────────

  it('pause and resume toggle scheduler state', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Pause', [
      { label: 'A', commands: [] },
      { label: 'B', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);

    scheduler.pause(churchId);
    let status = scheduler.getStatus(churchId);
    expect(status.state).toBe('paused');

    scheduler.resume(churchId);
    status = scheduler.getStatus(churchId);
    expect(status.state).toBe('running');
  });

  it('resume returns error when not paused', () => {
    const rd = rundownEngine.createRundown(churchId, 'Resume', [{ label: 'A' }]);
    scheduler.activate(churchId, rd.id);
    const result = scheduler.resume(churchId);
    expect(result.error).toBeTruthy();
  });

  it('advance resumes a paused scheduler', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Advance Resume', [
      { label: 'A', commands: [] },
      { label: 'B', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);
    scheduler.pause(churchId);

    const result = await scheduler.advance(churchId);
    expect(result.cueIndex).toBe(0);
    const status = scheduler.getStatus(churchId);
    expect(status.state).toBe('running');
  });

  // ── Rundown completion ────────────────────────────────────────────────────

  it('marks rundown as completed after firing last cue', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Complete', [
      { label: 'Only Cue', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.advance(churchId);

    const status = scheduler.getStatus(churchId);
    expect(status.state).toBe('completed');
    expect(status.progress).toBe(100);
  });

  it('returns error when advancing a completed rundown', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Done', [{ label: 'A', commands: [] }]);
    scheduler.activate(churchId, rd.id);
    await scheduler.advance(churchId);

    const result = await scheduler.advance(churchId);
    expect(result.error).toBeTruthy();
  });

  // ── Dedup — cues don't fire twice ─────────────────────────────────────────

  it('does not fire the same cue twice (dedup via cuesFired)', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Dedup', [
      { label: 'A', commands: [{ command: 'atem.cut', params: { input: 1 } }] },
      { label: 'B', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.advance(churchId); // fires cue 0

    // Manually try to re-fire cue 0 via internal method
    const result = await scheduler._fireCue(churchId, 0, 'manual');
    expect(result).toBeNull(); // should be deduplicated

    // Only one command should have been executed
    expect(scheduler._executedCommands.length).toBe(1);
  });

  // ── getStatus ─────────────────────────────────────────────────────────────

  it('getStatus returns complete scheduler status', () => {
    const rd = rundownEngine.createRundown(churchId, 'Status Test', [
      { label: 'Cue A', notes: 'Switch to cam 1', trigger: { type: 'manual' } },
      { label: 'Cue B', trigger: { type: 'time_absolute', time: '10:30' } },
    ]);
    scheduler.activate(churchId, rd.id);

    const status = scheduler.getStatus(churchId);
    expect(status.active).toBe(true);
    expect(status.state).toBe('running');
    expect(status.rundownName).toBe('Status Test');
    expect(status.totalCues).toBe(2);
    expect(status.currentCue).toBe(0);
    expect(status.currentCueLabel).toBe('Cue A');
    expect(status.currentCueNotes).toBe('Switch to cam 1');
    expect(status.triggerType).toBe('manual');
    expect(status.nextCueLabel).toBe('Cue B');
    expect(status.progress).toBe(0);
  });

  it('getStatus returns inactive when no rundown is active', () => {
    const status = scheduler.getStatus(churchId);
    expect(status.active).toBe(false);
  });
});

describe('RundownScheduler — event triggers', () => {
  let db;
  let rundownEngine;
  let scheduleEngine;
  let scheduler;
  const churchId = 'church_evt_1';

  beforeEach(() => {
    db = createDb();
    rundownEngine = new RundownEngine(db);
    scheduleEngine = new ScheduleEngine(db);
    seedChurch(db, churchId);

    scheduler = new RundownScheduler(db, { rundownEngine, scheduleEngine });
    scheduler._executedCommands = [];
    scheduler.setCommandExecutor(async (cId, cmd, params) => {
      scheduler._executedCommands.push({ churchId: cId, command: cmd, params });
    });
  });

  afterEach(() => {
    scheduler.stop();
    if (db) db.close();
  });

  it('onSlideChange fires a cue with matching event trigger', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Slide Event', [
      {
        label: 'On Worship Slide',
        trigger: { type: 'event', event: { type: 'propresenter_slide_change', config: { presentationPattern: 'worship' } } },
        commands: [{ command: 'atem.cut', params: { input: 2 } }],
      },
      { label: 'Next', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.onSlideChange(churchId, { presentationName: 'Worship Set 2024' });

    expect(scheduler._executedCommands.length).toBe(1);
    expect(scheduler._executedCommands[0].command).toBe('atem.cut');
  });

  it('onSlideChange ignores non-matching presentation names', async () => {
    const rd = rundownEngine.createRundown(churchId, 'No Match', [
      {
        label: 'On Worship',
        trigger: { type: 'event', event: { type: 'propresenter_slide_change', config: { presentationPattern: 'worship' } } },
        commands: [{ command: 'atem.cut' }],
      },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.onSlideChange(churchId, { presentationName: 'Announcements' });
    expect(scheduler._executedCommands.length).toBe(0);
  });

  it('onSlideChange does nothing when current cue is manual trigger', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Manual Cue', [
      { label: 'Manual', trigger: { type: 'manual' }, commands: [{ command: 'atem.cut' }] },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.onSlideChange(churchId, { presentationName: 'Anything' });
    expect(scheduler._executedCommands.length).toBe(0);
  });

  it('onEquipmentStateChange fires when conditions match', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Equip Event', [
      {
        label: 'When stream starts',
        trigger: {
          type: 'event',
          event: {
            type: 'equipment_state_match',
            config: { conditions: { 'obs.streaming': true } },
          },
        },
        commands: [{ command: 'atem.cut', params: { input: 3 } }],
      },
      { label: 'Next', commands: [] },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.onEquipmentStateChange(churchId, { obs: { streaming: true } });
    expect(scheduler._executedCommands.length).toBe(1);
  });

  it('onEquipmentStateChange does not fire when conditions mismatch', async () => {
    const rd = rundownEngine.createRundown(churchId, 'Equip Mismatch', [
      {
        label: 'When stream starts',
        trigger: {
          type: 'event',
          event: {
            type: 'equipment_state_match',
            config: { conditions: { 'obs.streaming': true } },
          },
        },
        commands: [{ command: 'atem.cut' }],
      },
    ]);
    scheduler.activate(churchId, rd.id);

    await scheduler.onEquipmentStateChange(churchId, { obs: { streaming: false } });
    expect(scheduler._executedCommands.length).toBe(0);
  });
});

describe('ScheduleEngine — timezone and edge cases', () => {
  let db;
  let scheduleEngine;
  const churchId = 'church_tz_1';

  beforeEach(() => {
    db = createDb();
    scheduleEngine = new ScheduleEngine(db);
    seedChurch(db, churchId);
  });

  afterEach(() => {
    if (scheduleEngine._pollTimer) clearInterval(scheduleEngine._pollTimer);
    if (db) db.close();
  });

  // ── 6 & 7. Timezone handling and edge cases ───────────────────────────────

  it('handles service at midnight (hour 0)', () => {
    scheduleEngine.setSchedule(churchId, [
      { day: 0, startHour: 0, startMin: 0, durationHours: 1 },
    ]);
    const schedule = scheduleEngine.getSchedule(churchId);
    expect(schedule[0].startHour).toBe(0);
    expect(schedule[0].startMin).toBe(0);
  });

  it('handles service at 23:59', () => {
    scheduleEngine.setSchedule(churchId, [
      { day: 6, startHour: 23, startMin: 59, durationHours: 1 },
    ]);
    const schedule = scheduleEngine.getSchedule(churchId);
    expect(schedule[0].startHour).toBe(23);
    expect(schedule[0].startMin).toBe(59);
  });

  it('getNextService wraps around the week correctly', () => {
    // Set a service only on a day that is not today
    const now = new Date();
    const futureDay = (now.getDay() + 3) % 7;
    scheduleEngine.setSchedule(churchId, [
      { day: futureDay, startHour: 10, startMin: 0, durationHours: 2 },
    ]);

    const next = scheduleEngine.getNextService(churchId);
    expect(next).not.toBeNull();
    expect(next.day).toBe(futureDay);
    expect(next.minutesUntil).toBeGreaterThan(0);
    // Should be within 7 days (in minutes)
    expect(next.minutesUntil).toBeLessThanOrEqual(7 * 24 * 60);
  });

  it('isServiceWindow accounts for 30-minute buffer', () => {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    // Set service to start 25 minutes from now (within 30-min buffer)
    const futureMinutes = currentMinutes + 25;
    const startHour = Math.floor(futureMinutes / 60) % 24;
    const startMin = futureMinutes % 60;

    scheduleEngine.setSchedule(churchId, [
      { day: now.getDay(), startHour, startMin, durationHours: 1 },
    ]);

    // Should be in service window (within the 30-min pre-buffer)
    expect(scheduleEngine.isServiceWindow(churchId)).toBe(true);
  });
});

describe('PreServiceCheck — timing and persistence', () => {
  let db;
  let scheduleEngine;
  let preServiceCheck;
  const churchId = 'church_psc_1';

  beforeEach(() => {
    db = createDb();
    scheduleEngine = new ScheduleEngine(db);
    seedChurch(db, churchId);

    preServiceCheck = new PreServiceCheck({ db, scheduleEngine, churches: new Map() });
  });

  afterEach(() => {
    preServiceCheck.stop();
    if (db) db.close();
  });

  // ── 3. Pre-service check triggering ────────────────────────────────────────

  it('detects a service starting in 25-35 minutes', () => {
    const now = new Date();
    const futureMinutes = now.getHours() * 60 + now.getMinutes() + 30;
    const startHour = Math.floor(futureMinutes / 60) % 24;
    const startMin = futureMinutes % 60;

    const schedule = [{ day: now.getDay(), startHour, startMin, durationHours: 2 }];
    const result = preServiceCheck._serviceStartingIn25to35(schedule);
    expect(result).not.toBeNull();
    expect(result.startHour).toBe(startHour);
    expect(result.startMin).toBe(startMin);
  });

  it('returns null when service is not in 25-35 minute window', () => {
    const now = new Date();
    // Service starts in 60 minutes (outside window)
    const futureMinutes = now.getHours() * 60 + now.getMinutes() + 60;
    const startHour = Math.floor(futureMinutes / 60) % 24;
    const startMin = futureMinutes % 60;

    const schedule = [{ day: now.getDay(), startHour, startMin, durationHours: 2 }];
    const result = preServiceCheck._serviceStartingIn25to35(schedule);
    expect(result).toBeNull();
  });

  it('returns null for a service on a different day', () => {
    const now = new Date();
    const otherDay = (now.getDay() + 1) % 7;
    const schedule = [{ day: otherDay, startHour: 10, startMin: 0, durationHours: 2 }];
    const result = preServiceCheck._serviceStartingIn25to35(schedule);
    expect(result).toBeNull();
  });

  it('persists check results to the database', () => {
    const result = { pass: true, checks: [{ name: 'OBS', pass: true, detail: 'Connected' }] };
    preServiceCheck._persistResult(churchId, result, 'manual');

    const latest = preServiceCheck.getLatestResult(churchId);
    expect(latest).not.toBeNull();
    expect(latest.pass).toBe(1);
    expect(latest.church_id).toBe(churchId);
    expect(latest.trigger_type).toBe('manual');
    expect(latest.checks).toEqual([{ name: 'OBS', pass: true, detail: 'Connected' }]);
  });

  it('does not persist null results', () => {
    preServiceCheck._persistResult(churchId, null, 'auto');
    const latest = preServiceCheck.getLatestResult(churchId);
    expect(latest).toBeNull();
  });

  it('getLatestResult returns the most recent check', () => {
    // Use different timestamps to ensure ordering
    const crypto = require('crypto');
    const oldTime = '2026-01-01T00:00:00.000Z';
    const newTime = '2026-06-01T00:00:00.000Z';

    db.prepare(`
      INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), churchId, 0, JSON.stringify([{ name: 'A', pass: false }]), 'auto', oldTime);

    db.prepare(`
      INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), churchId, 1, JSON.stringify([{ name: 'B', pass: true }]), 'manual', newTime);

    const latest = preServiceCheck.getLatestResult(churchId);
    expect(latest.trigger_type).toBe('manual');
    expect(latest.pass).toBe(1);
  });

  it('deduplicates checks within 2-hour window', async () => {
    // Simulate a recent check
    preServiceCheck.lastPreServiceCheckAt.set(churchId, Date.now());

    const now = new Date();
    const futureMinutes = now.getHours() * 60 + now.getMinutes() + 30;
    const startHour = Math.floor(futureMinutes / 60) % 24;
    const startMin = futureMinutes % 60;
    scheduleEngine.setSchedule(churchId, [
      { day: now.getDay(), startHour, startMin, durationHours: 2 },
    ]);

    // _checkChurch should skip because of dedup
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    await preServiceCheck._checkChurch(church);

    // No result should be persisted since the check was skipped
    const latest = preServiceCheck.getLatestResult(churchId);
    expect(latest).toBeNull();
  });
});

describe('RundownScheduler — auto-activate on service window', () => {
  let db;
  let rundownEngine;
  let scheduleEngine;
  let scheduler;
  const churchId = 'church_auto_1';

  beforeEach(() => {
    db = createDb();
    rundownEngine = new RundownEngine(db);
    scheduleEngine = new ScheduleEngine(db);
    seedChurch(db, churchId);

    scheduler = new RundownScheduler(db, { rundownEngine, scheduleEngine });
    scheduler._executedCommands = [];
    scheduler.setCommandExecutor(async (cId, cmd, params) => {
      scheduler._executedCommands.push({ churchId: cId, command: cmd, params });
    });
  });

  afterEach(() => {
    scheduler.stop();
    if (db) db.close();
  });

  it('auto-activates a rundown when service window opens', () => {
    const rd = rundownEngine.createRundown(churchId, 'Auto Rundown', [
      { label: 'Cue 1', commands: [] },
    ]);
    // Set auto_activate flag and service_day
    const dayOfWeek = new Date().getDay();
    db.prepare('UPDATE rundowns SET auto_activate = 1, service_day = ? WHERE id = ?').run(dayOfWeek, rd.id);

    scheduler.onServiceWindowOpen(churchId);

    const status = scheduler.getStatus(churchId);
    expect(status.active).toBe(true);
    expect(status.rundownName).toBe('Auto Rundown');
  });

  it('does not auto-activate if no rundown is configured', () => {
    scheduler.onServiceWindowOpen(churchId);
    const status = scheduler.getStatus(churchId);
    expect(status.active).toBe(false);
  });

  it('deactivates rundown when service window closes', () => {
    const rd = rundownEngine.createRundown(churchId, 'Close Test', [{ label: 'A' }]);
    scheduler.activate(churchId, rd.id);
    expect(scheduler.getStatus(churchId).active).toBe(true);

    scheduler.onServiceWindowClose(churchId);
    expect(scheduler.getStatus(churchId).active).toBe(false);
  });

  it('onServiceWindowClose is a no-op when no rundown is active', () => {
    // Should not throw
    scheduler.onServiceWindowClose(churchId);
    expect(scheduler.getStatus(churchId).active).toBe(false);
  });
});
