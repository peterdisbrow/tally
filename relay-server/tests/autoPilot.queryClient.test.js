import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AutoPilot } from '../src/autoPilot.js';
import { createQueryClient } from '../src/db/queryClient.js';

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'pro',
      billing_status TEXT DEFAULT 'active'
    )
  `);
  db.prepare('INSERT INTO churches (churchId, name, billing_tier, billing_status) VALUES (?, ?, ?, ?)')
    .run('ch1', 'Grace Church', 'pro', 'active');
  return db;
}

function makeScheduleEngine(inWindow = true) {
  return { isServiceWindow: vi.fn().mockReturnValue(inWindow) };
}

function makeSessionRecap(sessionId = 'sess-1') {
  return { getActiveSessionId: vi.fn().mockReturnValue(sessionId) };
}

describe('AutoPilot query client mode', () => {
  let db;
  let queryClient;
  let autoPilot;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    autoPilot = new AutoPilot(queryClient, {
      scheduleEngine: makeScheduleEngine(),
      sessionRecap: makeSessionRecap(),
      billing: { checkAccess: vi.fn(() => ({ allowed: true })) },
    });
    await autoPilot.ready;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await queryClient?.close();
    db?.close();
  });

  it('creates rules through the shared client while keeping sync reads', async () => {
    const rule = autoPilot.createRule('ch1', {
      name: 'Start Recording',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 10 },
      actions: [{ command: 'obs.startRecording', params: {} }],
    });

    const rules = autoPilot.getRules('ch1');
    expect(rule.name).toBe('Start Recording');
    expect(rules).toHaveLength(1);
    expect(rules[0].trigger_config.minutesIntoService).toBe(10);

    await autoPilot.flushWrites();
    const row = db.prepare('SELECT name, trigger_type FROM automation_rules WHERE id = ?').get(rule.id);
    expect(row).toMatchObject({
      name: 'Start Recording',
      trigger_type: 'schedule_timer',
    });
  });

  it('stores command logs in cache immediately and persists them on flush', async () => {
    const id = autoPilot.logCommand('ch1', 'obs.startStream', { quality: 'high' }, 'manual');

    const log = autoPilot.getCommandLog('ch1', 10, 0);
    expect(log).toHaveLength(1);
    expect(log[0].id).toBe(id);
    expect(log[0].command).toBe('obs.startStream');

    await autoPilot.flushWrites();
    const row = db.prepare('SELECT command, source FROM command_log WHERE id = ?').get(id);
    expect(row).toMatchObject({
      command: 'obs.startStream',
      source: 'manual',
    });
  });

  it('fires enabled rules through the shared client path and persists session dedup', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    autoPilot.setCommandExecutor(executor);
    const rule = autoPilot.createRule('ch1', {
      name: 'Auto Record',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 0 },
      actions: [{ command: 'obs.startRecording', params: {} }],
    });
    autoPilot.updateRule(rule.id, { enabled: true });

    await autoPilot.onScheduleTick('ch1', 0);

    expect(executor).toHaveBeenCalledWith('ch1', 'obs.startRecording', {}, 'autopilot');
    expect(autoPilot.getCommandLog('ch1', 10, 0)[0].command).toBe('obs.startRecording');

    await autoPilot.flushWrites();
    const ruleRow = db.prepare('SELECT fire_count, last_fired_at FROM automation_rules WHERE id = ?').get(rule.id);
    const dedupRow = db.prepare('SELECT session_id, rule_id FROM autopilot_session_fires WHERE session_id = ? AND rule_id = ?').get('sess-1', rule.id);
    expect(ruleRow.fire_count).toBe(1);
    expect(ruleRow.last_fired_at).toBeTruthy();
    expect(dedupRow).toMatchObject({
      session_id: 'sess-1',
      rule_id: rule.id,
    });
  });

  it('activates templates through the shared client and exposes them synchronously', async () => {
    const result = autoPilot.activateTemplate('ch1', 'auto_start_recording');

    const active = autoPilot.getActiveTemplates('ch1');
    expect(result.templateId).toBe('auto_start_recording');
    expect(active).toHaveLength(1);
    expect(active[0].templateId).toBe('auto_start_recording');

    await autoPilot.flushWrites();
    const row = db.prepare('SELECT template_id, enabled FROM automation_rules WHERE id = ?').get(result.id);
    expect(row).toMatchObject({
      template_id: 'auto_start_recording',
      enabled: 1,
    });
  });
});
