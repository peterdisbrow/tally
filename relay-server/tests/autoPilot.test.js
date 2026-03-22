/**
 * AutoPilot — comprehensive state machine and rule engine tests
 *
 * Template management (getTemplates, activateTemplate, deactivateTemplate,
 * getActiveTemplates) is covered in autoPilot-templates.test.js.
 *
 * This file covers:
 *   A. Rule CRUD (createRule, updateRule, deleteRule, getRules, getRule)
 *   B. Billing tier enforcement for createRule
 *   C. logCommand / getCommandLog
 *   D. Pause / resume / isPaused
 *   E. Trigger evaluation — onSlideChange
 *   F. Trigger evaluation — onScheduleTick
 *   G. Trigger evaluation — onEquipmentStateChange
 *   H. Session dedup — each rule fires max once per session
 *   I. Max fire cap — auto-pause after MAX_FIRES_PER_SESSION
 *   J. Service window gating — rules don't fire outside windows
 *   K. Billing gating — rules don't fire when billing.checkAccess denies
 *   L. testRule — dry-run for all three trigger types
 *   M. resetSession — clears dedup state for a church
 *   N. Command executor — actions dispatched to _executeCommand
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AutoPilot, TRIGGER_TYPES } from '../src/autoPilot.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(opts = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'pro'
    )
  `);
  return db;
}

function addChurch(db, churchId, tier = 'pro') {
  db.prepare('INSERT INTO churches (churchId, name, billing_tier) VALUES (?, ?, ?)')
    .run(churchId, 'Test Church', tier);
}

function makeScheduleEngine(inWindow = true) {
  return { isServiceWindow: vi.fn().mockReturnValue(inWindow) };
}

function makeSessionRecap(sessionId = 'sess-1') {
  return { getActiveSessionId: vi.fn().mockReturnValue(sessionId) };
}

function createAutoPilot(db, opts = {}) {
  const ap = new AutoPilot(db, {
    scheduleEngine: opts.scheduleEngine !== undefined ? opts.scheduleEngine : makeScheduleEngine(),
    sessionRecap: opts.sessionRecap !== undefined ? opts.sessionRecap : makeSessionRecap(),
    billing: opts.billing || null,
  });
  return ap;
}

/** Create a rule for a church and return its ID. */
function createRule(ap, churchId, opts = {}) {
  return ap.createRule(churchId, {
    name: opts.name || 'Test Rule',
    triggerType: opts.triggerType || 'equipment_state_match',
    triggerConfig: opts.triggerConfig || { conditions: { 'obs.streaming': true } },
    actions: opts.actions || [{ command: 'obs.startRecording', params: {} }],
  });
}

// ─── A. Rule CRUD ─────────────────────────────────────────────────────────────

describe('A. Rule CRUD', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('createRule returns an object with id, name, triggerType, enabled=false', () => {
    const rule = createRule(ap, 'ch1');
    expect(rule.id).toBeTruthy();
    expect(rule.name).toBe('Test Rule');
    expect(rule.triggerType).toBe('equipment_state_match');
    expect(rule.enabled).toBe(false);
  });

  it('createRule throws on invalid trigger type', () => {
    expect(() => ap.createRule('ch1', {
      name: 'Bad Rule',
      triggerType: 'invalid_type',
      triggerConfig: {},
      actions: [],
    })).toThrow(/Invalid trigger type/);
  });

  it('createRule accepts all valid trigger types', () => {
    for (const triggerType of TRIGGER_TYPES) {
      expect(() => ap.createRule('ch1', {
        name: `Rule for ${triggerType}`,
        triggerType,
        triggerConfig: {},
        actions: [],
      })).not.toThrow();
    }
  });

  it('getRule retrieves a rule by ID with parsed config and actions', () => {
    const { id } = createRule(ap, 'ch1', {
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.startRecording', params: { delay: 5 } }],
    });

    const rule = ap.getRule(id);
    expect(rule).not.toBeNull();
    expect(rule.trigger_config.conditions['obs.streaming']).toBe(true);
    expect(rule.actions[0].command).toBe('obs.startRecording');
    expect(rule.enabled).toBe(false);
  });

  it('getRule returns null for nonexistent ID', () => {
    expect(ap.getRule('nonexistent-id')).toBeNull();
  });

  it('getRules returns all rules for a church ordered by created_at', () => {
    createRule(ap, 'ch1', { name: 'Rule 1', triggerType: 'schedule_timer' });
    createRule(ap, 'ch1', { name: 'Rule 2', triggerType: 'propresenter_slide_change' });
    createRule(ap, 'ch1', { name: 'Rule 3', triggerType: 'equipment_state_match' });

    const rules = ap.getRules('ch1');
    expect(rules.length).toBe(3);
    const names = rules.map(r => r.name);
    expect(names).toContain('Rule 1');
    expect(names).toContain('Rule 2');
    expect(names).toContain('Rule 3');
  });

  it('getRules returns empty array for church with no rules', () => {
    expect(ap.getRules('ch1')).toEqual([]);
  });

  it('getRules does not return rules from other churches', () => {
    addChurch(db, 'ch2');
    createRule(ap, 'ch1', { name: 'Ch1 Rule' });
    createRule(ap, 'ch2', { name: 'Ch2 Rule' });

    const ch1Rules = ap.getRules('ch1');
    expect(ch1Rules.length).toBe(1);
    expect(ch1Rules[0].name).toBe('Ch1 Rule');
  });

  it('updateRule updates name', () => {
    const { id } = createRule(ap, 'ch1');
    const updated = ap.updateRule(id, { name: 'Renamed Rule' });
    expect(updated.name).toBe('Renamed Rule');
  });

  it('updateRule enables a rule', () => {
    const { id } = createRule(ap, 'ch1');
    const updated = ap.updateRule(id, { enabled: true });
    expect(!!updated.enabled).toBe(true);
  });

  it('updateRule disables a rule', () => {
    const { id } = createRule(ap, 'ch1');
    ap.updateRule(id, { enabled: true });
    const updated = ap.updateRule(id, { enabled: false });
    expect(!!updated.enabled).toBe(false);
  });

  it('updateRule updates triggerType with a valid type', () => {
    const { id } = createRule(ap, 'ch1', { triggerType: 'schedule_timer' });
    ap.updateRule(id, { triggerType: 'propresenter_slide_change' });
    const rule = ap.getRule(id);
    expect(rule.trigger_type).toBe('propresenter_slide_change');
  });

  it('updateRule throws on invalid triggerType', () => {
    const { id } = createRule(ap, 'ch1');
    expect(() => ap.updateRule(id, { triggerType: 'invalid_type' })).toThrow();
  });

  it('updateRule throws when rule not found', () => {
    expect(() => ap.updateRule('bad-id', { name: 'Fail' })).toThrow(/Rule not found/);
  });

  it('updateRule with no fields returns existing rule unchanged', () => {
    const { id } = createRule(ap, 'ch1', { name: 'Unchanged' });
    const result = ap.updateRule(id, {});
    expect(result.name).toBe('Unchanged');
  });

  it('updateRule updates triggerConfig', () => {
    const { id } = createRule(ap, 'ch1');
    ap.updateRule(id, { triggerConfig: { conditions: { 'atem.connected': true } } });
    const rule = ap.getRule(id);
    expect(rule.trigger_config.conditions['atem.connected']).toBe(true);
  });

  it('updateRule updates actions', () => {
    const { id } = createRule(ap, 'ch1');
    const newActions = [{ command: 'atem.fadeToBlack', params: {} }];
    ap.updateRule(id, { actions: newActions });
    const rule = ap.getRule(id);
    expect(rule.actions[0].command).toBe('atem.fadeToBlack');
  });

  it('deleteRule removes the rule and returns true', () => {
    const { id } = createRule(ap, 'ch1');
    expect(ap.deleteRule(id)).toBe(true);
    expect(ap.getRule(id)).toBeNull();
  });

  it('deleteRule returns false for nonexistent rule', () => {
    expect(ap.deleteRule('nonexistent')).toBe(false);
  });
});

// ─── B. Billing tier enforcement ──────────────────────────────────────────────

describe('B. Billing tier enforcement in createRule', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db?.close());

  it('allows creating rules up to the tier limit', () => {
    addChurch(db, 'ch1', 'plus'); // plus = 5 rules max
    const billing = {};
    const ap = createAutoPilot(db, { billing });

    for (let i = 0; i < 5; i++) {
      expect(() => createRule(ap, 'ch1', { name: `Rule ${i}` })).not.toThrow();
    }
  });

  it('throws RULE_LIMIT_REACHED when at tier limit', () => {
    addChurch(db, 'ch1', 'plus'); // plus = 5 rules max
    const billing = {};
    const ap = createAutoPilot(db, { billing });

    // Create 5 rules (limit)
    for (let i = 0; i < 5; i++) {
      createRule(ap, 'ch1', { name: `Rule ${i}` });
    }

    // 6th should fail
    let caught = null;
    try {
      createRule(ap, 'ch1', { name: 'Rule 6' });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('RULE_LIMIT_REACHED');
    expect(caught.ruleLimit).toBe(5);
    expect(caught.currentTier).toBe('plus');
  });

  it('connect tier has 0 rule limit', () => {
    addChurch(db, 'ch1', 'connect');
    const billing = {};
    const ap = createAutoPilot(db, { billing });

    let caught = null;
    try { createRule(ap, 'ch1'); } catch (e) { caught = e; }
    expect(caught?.code).toBe('RULE_LIMIT_REACHED');
    expect(caught?.ruleLimit).toBe(0);
  });

  it('bypasses billing check when no billing system configured', () => {
    addChurch(db, 'ch1', 'connect');
    const ap = createAutoPilot(db, { billing: null }); // no billing

    // Should be allowed without limits
    expect(() => createRule(ap, 'ch1')).not.toThrow();
    expect(() => createRule(ap, 'ch1')).not.toThrow();
  });
});

// ─── C. logCommand / getCommandLog ────────────────────────────────────────────

describe('C. logCommand / getCommandLog', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('logCommand stores a command log entry', () => {
    ap.logCommand('ch1', 'obs.startStream', { quality: 'high' }, 'manual');

    const log = ap.getCommandLog('ch1', 10, 0);
    expect(log.length).toBe(1);
    expect(log[0].command).toBe('obs.startStream');
    expect(log[0].source).toBe('manual');
  });

  it('logCommand stores result up to 500 chars', () => {
    const longResult = 'ok'.repeat(300); // 600 chars
    ap.logCommand('ch1', 'obs.test', {}, 'autopilot', longResult);

    const log = ap.getCommandLog('ch1', 10, 0);
    expect(log[0].result.length).toBeLessThanOrEqual(500);
  });

  it('logCommand stores null result when not provided', () => {
    ap.logCommand('ch1', 'obs.test', {});
    const log = ap.getCommandLog('ch1', 10, 0);
    expect(log[0].result).toBeNull();
  });

  it('logCommand links sessionId from sessionRecap', () => {
    const sessionRecap = makeSessionRecap('sess-xyz');
    const apWithSession = createAutoPilot(db, { sessionRecap });
    apWithSession.logCommand('ch1', 'test.cmd', {}, 'manual');

    const log = apWithSession.getCommandLog('ch1', 10, 0);
    expect(log[0].session_id).toBe('sess-xyz');
  });

  it('getCommandLog returns results ordered newest first', () => {
    // Use fake timers so each insert has a distinct timestamp
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    ap.logCommand('ch1', 'cmd.first', {}, 'manual');
    vi.setSystemTime(new Date('2024-01-01T00:00:01.000Z'));
    ap.logCommand('ch1', 'cmd.second', {}, 'manual');
    vi.setSystemTime(new Date('2024-01-01T00:00:02.000Z'));
    ap.logCommand('ch1', 'cmd.third', {}, 'manual');
    vi.useRealTimers();

    const log = ap.getCommandLog('ch1', 10, 0);
    expect(log[0].command).toBe('cmd.third');
    expect(log[2].command).toBe('cmd.first');
  });

  it('getCommandLog respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      ap.logCommand('ch1', `cmd.${i}`, {}, 'manual');
    }

    const page1 = ap.getCommandLog('ch1', 3, 0);
    const page2 = ap.getCommandLog('ch1', 3, 3);

    expect(page1.length).toBe(3);
    expect(page2.length).toBe(3);
    expect(page1[0].command).not.toBe(page2[0].command);
  });

  it('logCommand stores equipment state as JSON', () => {
    const state = { obs: { streaming: true, bitrate: 6000 } };
    ap.logCommand('ch1', 'obs.check', {}, 'autopilot', null, state);

    const log = ap.getCommandLog('ch1', 1, 0);
    const storedState = JSON.parse(log[0].equipment_state || '{}');
    expect(storedState.obs.streaming).toBe(true);
  });
});

// ─── D. Pause / resume / isPaused ────────────────────────────────────────────

describe('D. Pause / resume / isPaused', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
  });

  afterEach(() => db?.close());

  it('isPaused returns false by default', () => {
    expect(ap.isPaused('ch1')).toBe(false);
  });

  it('pause sets the church as paused', () => {
    ap.pause('ch1');
    expect(ap.isPaused('ch1')).toBe(true);
  });

  it('resume clears the paused state', () => {
    ap.pause('ch1');
    ap.resume('ch1');
    expect(ap.isPaused('ch1')).toBe(false);
  });

  it('pause/resume is scoped per church', () => {
    ap.pause('ch1');
    expect(ap.isPaused('ch2')).toBe(false);
    ap.resume('ch2'); // should be no-op
    expect(ap.isPaused('ch1')).toBe(true);
  });

  it('resume on an unpaused church is a no-op', () => {
    expect(() => ap.resume('ch1')).not.toThrow();
    expect(ap.isPaused('ch1')).toBe(false);
  });
});

// ─── E. onSlideChange ────────────────────────────────────────────────────────

describe('E. onSlideChange trigger evaluation', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('fires rule when presentation name matches pattern (case-insensitive)', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Worship Rule',
      triggerType: 'propresenter_slide_change',
      triggerConfig: { presentationPattern: 'worship' },
      actions: [{ command: 'atem.cut', params: { input: 1 } }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onSlideChange('ch1', { presentationName: 'Sunday Worship Songs', slideIndex: 0 });
    expect(executor).toHaveBeenCalledWith('ch1', 'atem.cut', { input: 1 }, 'autopilot');
  });

  it('does not fire when presentation name does not match', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Sermon Rule',
      triggerType: 'propresenter_slide_change',
      triggerConfig: { presentationPattern: 'sermon' },
      actions: [{ command: 'atem.cut', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onSlideChange('ch1', { presentationName: 'Announcements', slideIndex: 0 });
    expect(executor).not.toHaveBeenCalled();
  });

  it('fires rule when slideIndex matches', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Index Rule',
      triggerType: 'propresenter_slide_change',
      triggerConfig: { slideIndex: 5 },
      actions: [{ command: 'cam.switch', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onSlideChange('ch1', { presentationName: 'Anything', slideIndex: 5 });
    expect(executor).toHaveBeenCalled();
  });

  it('does not fire when slideIndex does not match', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Index Rule',
      triggerType: 'propresenter_slide_change',
      triggerConfig: { slideIndex: 5 },
      actions: [{ command: 'cam.switch', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onSlideChange('ch1', { presentationName: 'Anything', slideIndex: 3 });
    expect(executor).not.toHaveBeenCalled();
  });

  it('fires rule on any slide change when no filter configured', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Any Slide',
      triggerType: 'propresenter_slide_change',
      triggerConfig: {}, // no presentationPattern, no slideIndex
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onSlideChange('ch1', { presentationName: 'Whatever', slideIndex: 0 });
    expect(executor).toHaveBeenCalled();
  });

  it('does not fire when rule is disabled', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    ap.createRule('ch1', {
      name: 'Disabled Rule',
      triggerType: 'propresenter_slide_change',
      triggerConfig: { presentationPattern: 'worship' },
      actions: [{ command: 'obs.record', params: {} }],
    }); // not enabled

    await ap.onSlideChange('ch1', { presentationName: 'Worship', slideIndex: 0 });
    expect(executor).not.toHaveBeenCalled();
  });

  it('does not fire when paused', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Rule',
      triggerType: 'propresenter_slide_change',
      triggerConfig: {},
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });
    ap.pause('ch1');

    await ap.onSlideChange('ch1', { presentationName: 'Worship', slideIndex: 0 });
    expect(executor).not.toHaveBeenCalled();
  });
});

// ─── F. onScheduleTick ────────────────────────────────────────────────────────

describe('F. onScheduleTick trigger evaluation', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('fires when minutesIntoWindow >= triggerMinute', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: '10 Minute Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 10 },
      actions: [{ command: 'obs.startRecording', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onScheduleTick('ch1', 15); // 15 >= 10 → fire
    expect(executor).toHaveBeenCalled();
  });

  it('does not fire when minutesIntoWindow < triggerMinute', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: '10 Minute Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 10 },
      actions: [{ command: 'obs.startRecording', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onScheduleTick('ch1', 5); // 5 < 10 → don't fire
    expect(executor).not.toHaveBeenCalled();
  });

  it('fires at exactly the trigger minute', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Exact Minute Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 20 },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onScheduleTick('ch1', 20); // exactly 20 → fire
    expect(executor).toHaveBeenCalled();
  });

  it('defaults to 0 minutes when minutesIntoService is not set', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Zero Minute Rule',
      triggerType: 'schedule_timer',
      triggerConfig: {}, // no minutesIntoService
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onScheduleTick('ch1', 0); // 0 >= 0 → fire
    expect(executor).toHaveBeenCalled();
  });

  it('does not fire when paused', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Paused Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 5 },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });
    ap.pause('ch1');

    await ap.onScheduleTick('ch1', 10);
    expect(executor).not.toHaveBeenCalled();
  });
});

// ─── G. onEquipmentStateChange ────────────────────────────────────────────────

describe('G. onEquipmentStateChange trigger evaluation', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('fires when all conditions match', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Stream Start Rule',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.startRecording', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).toHaveBeenCalled();
  });

  it('does not fire when a condition does not match', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Stream Stop Rule',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': false } },
      actions: [{ command: 'obs.stopRecording', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } }); // streaming = true, not false
    expect(executor).not.toHaveBeenCalled();
  });

  it('does not fire when conditions object is empty', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Empty Conditions',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: {} }, // no conditions
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).not.toHaveBeenCalled(); // requires at least 1 condition
  });

  it('matches nested state via dot notation', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Nested State Rule',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'camera.primary.signal': false } },
      actions: [{ command: 'atem.switchInput', params: { input: 'backup' } }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { camera: { primary: { signal: false } } });
    expect(executor).toHaveBeenCalledWith('ch1', 'atem.switchInput', { input: 'backup' }, 'autopilot');
  });

  it('requires ALL conditions to match (AND logic)', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Multi Condition',
      triggerType: 'equipment_state_match',
      triggerConfig: {
        conditions: { 'obs.streaming': true, 'audio.silenceDurationSec': 120 },
      },
      actions: [{ command: 'audio.muteStream', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    // Only streaming matches, not silence
    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true }, audio: { silenceDurationSec: 30 } });
    expect(executor).not.toHaveBeenCalled();
  });
});

// ─── H. Session dedup ─────────────────────────────────────────────────────────

describe('H. Session dedup — each rule fires max once per session', () => {
  let db, ap, executor;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
    executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);
  });

  afterEach(() => db?.close());

  it('rule fires once per session even when trigger fires multiple times', async () => {
    const { id } = ap.createRule('ch1', {
      name: 'Once Per Session',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.startRecording', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });

    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('rule can fire again after resetSession', async () => {
    const { id } = ap.createRule('ch1', {
      name: 'Resettable',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).toHaveBeenCalledTimes(1);

    ap.resetSession('ch1');

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('dedup is scoped to session ID (new session fires fresh)', async () => {
    // First session: sess-1
    const sessionRecap = makeSessionRecap('sess-1');
    const apWithSession = new AutoPilot(db, {
      scheduleEngine: makeScheduleEngine(),
      sessionRecap,
    });
    const exec = vi.fn().mockResolvedValue('ok');
    apWithSession.setCommandExecutor(exec);

    const { id } = apWithSession.createRule('ch1', {
      name: 'Session Scoped',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    apWithSession.updateRule(id, { enabled: true });

    await apWithSession.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(exec).toHaveBeenCalledTimes(1);

    // Simulate new session
    sessionRecap.getActiveSessionId.mockReturnValue('sess-2');
    await apWithSession.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('dedup does not apply when sessionRecap returns null', async () => {
    const apNoSession = new AutoPilot(db, {
      scheduleEngine: makeScheduleEngine(),
      sessionRecap: { getActiveSessionId: vi.fn().mockReturnValue(null) },
    });
    const exec = vi.fn().mockResolvedValue('ok');
    apNoSession.setCommandExecutor(exec);

    const { id } = apNoSession.createRule('ch1', {
      name: 'No Session',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    apNoSession.updateRule(id, { enabled: true });

    // Without a session ID, _hasFiredThisSession returns false — rule fires every time
    await apNoSession.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    await apNoSession.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('updates fire_count and last_fired_at in DB', async () => {
    const { id } = ap.createRule('ch1', {
      name: 'Stats Rule',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });

    const row = db.prepare('SELECT fire_count, last_fired_at FROM automation_rules WHERE id = ?').get(id);
    expect(row.fire_count).toBe(1);
    expect(row.last_fired_at).toBeTruthy();
  });
});

// ─── I. Max fire cap ──────────────────────────────────────────────────────────

describe('I. Max fire cap — auto-pause after 50 fires per session', () => {
  let db;

  afterEach(() => db?.close());

  it('auto-pauses the church when 50 rules have fired in the session', async () => {
    db = createTestDb();
    addChurch(db, 'ch1');

    // Use a session recap that always returns the same session ID
    const sessionRecap = makeSessionRecap('sess-cap');
    const ap = new AutoPilot(db, {
      scheduleEngine: makeScheduleEngine(),
      sessionRecap,
    });

    // Pre-fill the fired set to 49 fake rule IDs
    ap._firedThisSession.set('sess-cap', new Set());
    const firedSet = ap._firedThisSession.get('sess-cap');
    for (let i = 0; i < 49; i++) {
      firedSet.add(`fake-rule-${i}`);
    }

    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    // Create and enable a real rule (the 50th fire)
    const { id } = ap.createRule('ch1', {
      name: 'Cap Test',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    // This fires the rule (50th fire) — then tries another (51st) which should be blocked
    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });

    // The rule fired and the church is now paused (post-cap)
    // To verify, try to fire something else — it should be blocked by the pause check
    expect(ap.isPaused('ch1')).toBe(false); // church is NOT paused yet after 50th (cap triggers on 51st attempt)

    // Now trigger again — this time firedSet.size >= 50, so it should auto-pause before executing
    // Reset so same rule can fire again (different fake rule ID approach):
    // Actually let's add 50 fake IDs and watch the NEXT trigger get blocked
    const ap2 = new AutoPilot(db, { scheduleEngine: makeScheduleEngine(), sessionRecap: makeSessionRecap('sess-cap2') });
    ap2._firedThisSession.set('sess-cap2', new Set());
    const firedSet2 = ap2._firedThisSession.get('sess-cap2');
    for (let i = 0; i < 50; i++) {
      firedSet2.add(`fake-rule-${i}`);
    }
    const exec2 = vi.fn().mockResolvedValue('ok');
    ap2.setCommandExecutor(exec2);

    const { id: id2 } = ap2.createRule('ch1', {
      name: 'Cap Trigger',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap2.updateRule(id2, { enabled: true });

    await ap2.onEquipmentStateChange('ch1', { obs: { streaming: true } });

    // At 50 already fired + this one being attempted → cap reached → auto-pause
    expect(ap2.isPaused('ch1')).toBe(true);
    expect(exec2).not.toHaveBeenCalled();
  });
});

// ─── J. Service window gating ────────────────────────────────────────────────

describe('J. Service window gating', () => {
  let db;

  beforeEach(() => { db = createTestDb(); addChurch(db, 'ch1'); });
  afterEach(() => db?.close());

  it('does not fire when outside service window', async () => {
    const ap = createAutoPilot(db, { scheduleEngine: makeScheduleEngine(false) }); // outside window
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Window Gated',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).not.toHaveBeenCalled();
  });

  it('fires when inside service window', async () => {
    const ap = createAutoPilot(db, { scheduleEngine: makeScheduleEngine(true) }); // in window
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'In Window',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).toHaveBeenCalled();
  });

  it('allows all triggers when no scheduleEngine configured', async () => {
    const ap = new AutoPilot(db, { scheduleEngine: null, sessionRecap: makeSessionRecap() });
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'No Schedule Engine',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).toHaveBeenCalled();
  });
});

// ─── K. Billing gating ────────────────────────────────────────────────────────

describe('K. Billing gating for trigger evaluation', () => {
  let db;

  beforeEach(() => { db = createTestDb(); addChurch(db, 'ch1'); });
  afterEach(() => db?.close());

  it('does not fire when billing.checkAccess denies', async () => {
    const billing = { checkAccess: vi.fn().mockReturnValue({ allowed: false }) };
    const ap = createAutoPilot(db, { billing });
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Billing Gated',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).not.toHaveBeenCalled();
  });

  it('fires when billing.checkAccess grants access', async () => {
    const billing = { checkAccess: vi.fn().mockReturnValue({ allowed: true }) };
    const ap = createAutoPilot(db, { billing });
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Billing OK',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).toHaveBeenCalled();
  });
});

// ─── L. testRule (dry-run) ────────────────────────────────────────────────────

describe('L. testRule — dry-run for all trigger types', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('throws when rule not found', () => {
    expect(() => ap.testRule('nonexistent-id')).toThrow(/Rule not found/);
  });

  // propresenter_slide_change

  it('testRule: propresenter_slide_change — wouldFire true when name matches', () => {
    const { id } = ap.createRule('ch1', {
      name: 'PP Test',
      triggerType: 'propresenter_slide_change',
      triggerConfig: { presentationPattern: 'worship' },
      actions: [],
    });
    const result = ap.testRule(id, { slideData: { presentationName: 'Worship 2026', slideIndex: 0 } });
    expect(result.wouldFire).toBe(true);
    expect(result.reason).toContain('matches trigger');
  });

  it('testRule: propresenter_slide_change — wouldFire false when name does not match', () => {
    const { id } = ap.createRule('ch1', {
      name: 'PP Test',
      triggerType: 'propresenter_slide_change',
      triggerConfig: { presentationPattern: 'sermon' },
      actions: [],
    });
    const result = ap.testRule(id, { slideData: { presentationName: 'Announcements', slideIndex: 0 } });
    expect(result.wouldFire).toBe(false);
    expect(result.reason).toContain('does not match');
  });

  it('testRule: propresenter_slide_change — uses default slideData when not provided', () => {
    const { id } = ap.createRule('ch1', {
      name: 'PP Default',
      triggerType: 'propresenter_slide_change',
      triggerConfig: { presentationPattern: 'Sermon', slideIndex: 0 },
      actions: [],
    });
    const result = ap.testRule(id); // no overrides
    expect(result).toHaveProperty('wouldFire');
    expect(result).toHaveProperty('simulatedTrigger');
    expect(result.note).toContain('Dry run');
  });

  // schedule_timer

  it('testRule: schedule_timer — wouldFire true when simMinutes >= triggerMinute', () => {
    const { id } = ap.createRule('ch1', {
      name: 'Timer Test',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 10 },
      actions: [],
    });
    const result = ap.testRule(id, { minutesIntoService: 15 });
    expect(result.wouldFire).toBe(true);
    expect(result.reason).toContain('fires');
  });

  it('testRule: schedule_timer — wouldFire false when simMinutes < triggerMinute', () => {
    const { id } = ap.createRule('ch1', {
      name: 'Timer Not Yet',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 20 },
      actions: [],
    });
    const result = ap.testRule(id, { minutesIntoService: 5 });
    expect(result.wouldFire).toBe(false);
    expect(result.reason).toContain('not yet due');
  });

  it('testRule: schedule_timer — defaults to exact trigger minute when not overridden', () => {
    const { id } = ap.createRule('ch1', {
      name: 'Timer Default',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 15 },
      actions: [],
    });
    const result = ap.testRule(id); // simMinutes defaults to triggerMinute (15)
    expect(result.wouldFire).toBe(true); // 15 >= 15
  });

  // equipment_state_match

  it('testRule: equipment_state_match — wouldFire true when all conditions match', () => {
    const { id } = ap.createRule('ch1', {
      name: 'State Match',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [],
    });
    const result = ap.testRule(id, { state: { obs: { streaming: true } } });
    expect(result.wouldFire).toBe(true);
    expect(result.reason).toContain('match');
  });

  it('testRule: equipment_state_match — wouldFire false on mismatch', () => {
    const { id } = ap.createRule('ch1', {
      name: 'State Mismatch',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': false } },
      actions: [],
    });
    const result = ap.testRule(id, { state: { obs: { streaming: true } } });
    expect(result.wouldFire).toBe(false);
    expect(result.reason).toContain('Condition mismatch');
  });

  it('testRule: equipment_state_match — auto-fills state when no overrides', () => {
    const { id } = ap.createRule('ch1', {
      name: 'Auto State',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [],
    });
    const result = ap.testRule(id); // no overrides → auto-fill matching state
    expect(result.wouldFire).toBe(true);
  });

  it('testRule: equipment_state_match — wouldFire false for empty conditions', () => {
    const { id } = ap.createRule('ch1', {
      name: 'Empty Conditions',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: {} },
      actions: [],
    });
    const result = ap.testRule(id);
    expect(result.wouldFire).toBe(false);
    expect(result.reason).toContain('No conditions');
  });

  it('testRule includes rule metadata in result', () => {
    const { id } = ap.createRule('ch1', {
      name: 'Metadata Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 10 },
      actions: [{ command: 'obs.record', params: {} }],
    });
    const result = ap.testRule(id, { minutesIntoService: 10 });

    expect(result.ruleId).toBe(id);
    expect(result.ruleName).toBe('Metadata Rule');
    expect(result.triggerType).toBe('schedule_timer');
    expect(result.actions).toHaveLength(1);
    expect(result.note).toContain('Dry run');
    expect(result.simulatedTrigger.type).toBe('schedule_timer');
  });

  it('testRule does not execute any commands', async () => {
    const executor = vi.fn();
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'No Execute',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.startRecording', params: {} }],
    });

    ap.testRule(id, { state: { obs: { streaming: true } } });
    expect(executor).not.toHaveBeenCalled();
  });
});

// ─── M. resetSession ──────────────────────────────────────────────────────────

describe('M. resetSession', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('clears fired rules for the current session', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Resettable',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).toHaveBeenCalledTimes(1);

    ap.resetSession('ch1');

    await ap.onEquipmentStateChange('ch1', { obs: { streaming: true } });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no session is active', () => {
    const apNoSession = new AutoPilot(db, {
      scheduleEngine: makeScheduleEngine(),
      sessionRecap: { getActiveSessionId: vi.fn().mockReturnValue(null) },
    });
    expect(() => apNoSession.resetSession('ch1')).not.toThrow();
  });
});

// ─── N. Command executor ──────────────────────────────────────────────────────

describe('N. Command executor', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => db?.close());

  it('logs a warning when no executor is configured (no throw)', async () => {
    // No executor set
    const { id } = ap.createRule('ch1', {
      name: 'No Executor',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [{ command: 'obs.record', params: {} }],
    });
    ap.updateRule(id, { enabled: true });

    await expect(ap.onEquipmentStateChange('ch1', { obs: { streaming: true } })).resolves.not.toThrow();
  });

  it('handles action executor errors gracefully — other actions still run', async () => {
    let callCount = 0;
    const executor = vi.fn().mockImplementation(async (churchId, command) => {
      callCount++;
      if (command === 'cmd.fail') throw new Error('Command failed');
      return 'ok';
    });
    ap.setCommandExecutor(executor);

    const { id } = ap.createRule('ch1', {
      name: 'Multi Action',
      triggerType: 'equipment_state_match',
      triggerConfig: { conditions: { 'obs.streaming': true } },
      actions: [
        { command: 'cmd.fail', params: {} },  // this throws
        { command: 'cmd.ok', params: {} },    // this should still run
      ],
    });
    ap.updateRule(id, { enabled: true });

    await expect(ap.onEquipmentStateChange('ch1', { obs: { streaming: true } })).resolves.not.toThrow();
    expect(callCount).toBe(2); // both actions were attempted
  });

  it('setCommandExecutor stores the function', () => {
    const fn = vi.fn();
    ap.setCommandExecutor(fn);
    expect(ap._executeCommand).toBe(fn);
  });
});
