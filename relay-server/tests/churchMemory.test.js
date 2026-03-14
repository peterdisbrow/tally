'use strict';

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChurchMemory } from '../src/churchMemory.js';

function createTestDb() {
  const db = new Database(':memory:');
  // Create the churches table that churchMemory._rebuildSummary writes to
  db.exec(`
    CREATE TABLE IF NOT EXISTS churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      memory_summary TEXT DEFAULT ''
    )
  `);
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run('test-church', 'Test Church');
  return db;
}

function seedMemories(memory, churchId) {
  // Equipment quirk
  memory._upsertMemory(churchId, 'equipment_quirk', 'quirk:obs_crash',
    'OBS crash occurs in 3/5 recent services',
    { eventType: 'obs_crash', sessionCount: 3, outOf: 5 }, 'post_service');

  // Recurring issue
  memory._upsertMemory(churchId, 'recurring_issue', 'recurring:audio_silence',
    'audio silence 2x/week around 10:30 AM',
    { eventType: 'audio_silence', frequency: 2, timeWindow: '10:30 AM', recommendation: 'Check mixer levels before service' },
    'weekly_digest');

  // Fix outcome (success)
  memory._upsertMemory(churchId, 'fix_outcome', 'fix:stream_drop',
    'Auto-recovery works 80% for stream drop',
    { alertType: 'stream_drop', success: true, successRate: 80 }, 'post_service');

  // Fix outcome (failure)
  memory._upsertMemory(churchId, 'fix_outcome', 'fail:atem_connection_lost',
    'atem connection lost required manual intervention',
    { alertType: 'atem_connection_lost', success: false }, 'post_service');

  // Reliability trend
  memory._upsertMemory(churchId, 'reliability_trend', 'overall',
    'Reliability 92% uptime (improving from 85%)',
    { current: 92, previous: 85, trend: 'improving' }, 'weekly_digest');

  // User note
  memory.saveUserNote(churchId, 'Pastor likes tight shot during prayer');
}

describe('ChurchMemory', () => {
  let db;
  let memory;
  const CHURCH_ID = 'test-church';

  beforeEach(() => {
    db = createTestDb();
    memory = new ChurchMemory(db);
  });

  // ─── getPreServiceContext ─────────────────────────────────────────────────

  describe('getPreServiceContext', () => {
    it('returns empty string when no memories exist', () => {
      expect(memory.getPreServiceContext(CHURCH_ID)).toBe('');
    });

    it('returns formatted context with quirks, failures, recurring issues, and notes', () => {
      seedMemories(memory, CHURCH_ID);
      const ctx = memory.getPreServiceContext(CHURCH_ID);

      expect(ctx).toContain('Pre-service watch list:');
      expect(ctx).toContain('[QUIRK]');
      expect(ctx).toContain('[RECURRING]');
      expect(ctx).toContain('[PAST FAILURE]');
      expect(ctx).toContain('[NOTE]');
      expect(ctx).toContain('OBS crash');
      expect(ctx).toContain('audio silence');
    });

    it('labels successful fix outcomes with [FIX]', () => {
      memory._upsertMemory(CHURCH_ID, 'fix_outcome', 'fix:test',
        'Auto-recovery works for test issue',
        { success: true }, 'post_service');
      const ctx = memory.getPreServiceContext(CHURCH_ID);
      expect(ctx).toContain('[FIX]');
    });

    it('prioritizes equipment quirks over other categories', () => {
      seedMemories(memory, CHURCH_ID);
      const ctx = memory.getPreServiceContext(CHURCH_ID);
      const lines = ctx.split('\n').filter(l => l.startsWith('- '));
      // First line should be a quirk
      expect(lines[0]).toContain('[QUIRK]');
    });

    it('enforces 600 char budget', () => {
      // Create many long memories
      for (let i = 0; i < 20; i++) {
        memory._upsertMemory(CHURCH_ID, 'equipment_quirk', `quirk:long_${i}`,
          `This is a very long quirk description number ${i} that takes up a lot of space in the output string`,
          { eventType: `long_${i}` }, 'post_service');
      }
      const ctx = memory.getPreServiceContext(CHURCH_ID);
      expect(ctx.length).toBeLessThanOrEqual(600);
    });

    it('returns empty string on database error', () => {
      db.close();
      expect(memory.getPreServiceContext(CHURCH_ID)).toBe('');
    });
  });

  // ─── getSessionContext ────────────────────────────────────────────────────

  describe('getSessionContext', () => {
    it('returns empty string when no memories exist', () => {
      expect(memory.getSessionContext(CHURCH_ID)).toBe('');
    });

    it('returns formatted context with patterns, fixes, and trends', () => {
      seedMemories(memory, CHURCH_ID);
      const ctx = memory.getSessionContext(CHURCH_ID);

      expect(ctx).toContain('Session history:');
      expect(ctx).toContain('Known fix:');
      expect(ctx).toContain('Unresolved:');
      expect(ctx).toContain('Pattern:');
      expect(ctx).toContain('Trend:');
    });

    it('includes recommendation tips for recurring issues', () => {
      seedMemories(memory, CHURCH_ID);
      const ctx = memory.getSessionContext(CHURCH_ID);
      expect(ctx).toContain('tip: Check mixer levels before service');
    });

    it('includes equipment quirks', () => {
      seedMemories(memory, CHURCH_ID);
      const ctx = memory.getSessionContext(CHURCH_ID);
      expect(ctx).toContain('Quirk:');
    });

    it('enforces 600 char budget', () => {
      for (let i = 0; i < 20; i++) {
        memory._upsertMemory(CHURCH_ID, 'recurring_issue', `recurring:long_${i}`,
          `Very long recurring issue description number ${i} that eats up character budget significantly`,
          { eventType: `long_${i}`, frequency: i, recommendation: 'A very long recommendation' },
          'weekly_digest');
      }
      const ctx = memory.getSessionContext(CHURCH_ID);
      expect(ctx.length).toBeLessThanOrEqual(600);
    });

    it('returns empty string on database error', () => {
      db.close();
      expect(memory.getSessionContext(CHURCH_ID)).toBe('');
    });
  });

  // ─── getOnboardingContext ─────────────────────────────────────────────────

  describe('getOnboardingContext', () => {
    it('returns empty string when no memories exist', () => {
      expect(memory.getOnboardingContext(CHURCH_ID)).toBe('');
    });

    it('returns formatted context with preferences and equipment notes', () => {
      seedMemories(memory, CHURCH_ID);
      const ctx = memory.getOnboardingContext(CHURCH_ID);

      expect(ctx).toContain('Church history:');
      expect(ctx).toContain('Preference:');
      expect(ctx).toContain('Equipment note:');
      expect(ctx).toContain('Past experience:');
    });

    it('prioritizes user notes over other categories', () => {
      seedMemories(memory, CHURCH_ID);
      const ctx = memory.getOnboardingContext(CHURCH_ID);
      const lines = ctx.split('\n').filter(l => l.startsWith('- '));
      expect(lines[0]).toContain('Preference:');
    });

    it('includes reliability trend', () => {
      seedMemories(memory, CHURCH_ID);
      const ctx = memory.getOnboardingContext(CHURCH_ID);
      expect(ctx).toContain('Reliability 92%');
    });

    it('enforces 600 char budget', () => {
      for (let i = 0; i < 20; i++) {
        memory.saveUserNote(CHURCH_ID, `Very long user note number ${i} with extra details about church preferences and configurations`);
      }
      const ctx = memory.getOnboardingContext(CHURCH_ID);
      expect(ctx.length).toBeLessThanOrEqual(600);
    });

    it('returns empty string on database error', () => {
      db.close();
      expect(memory.getOnboardingContext(CHURCH_ID)).toBe('');
    });
  });

  // ─── recordIncidentLearning ───────────────────────────────────────────────

  describe('recordIncidentLearning', () => {
    it('creates a new memory from an incident with resolution', () => {
      const isNew = memory.recordIncidentLearning(CHURCH_ID, {
        type: 'atem_connection_lost',
        summary: 'ATEM needed power cycle after firmware update',
        resolution: 'Power cycled the ATEM switcher',
        device: 'ATEM',
      });

      expect(isNew).toBe(true);

      const all = memory.getAll(CHURCH_ID);
      const incident = all.find(m => m.summary === 'ATEM needed power cycle after firmware update');
      expect(incident).toBeTruthy();
      expect(incident.category).toBe('fix_outcome'); // has resolution
      expect(incident.source).toBe('incident_learning');

      const details = JSON.parse(incident.details);
      expect(details.resolution).toBe('Power cycled the ATEM switcher');
      expect(details.device).toBe('ATEM');
    });

    it('creates equipment_quirk category when no resolution provided', () => {
      const isNew = memory.recordIncidentLearning(CHURCH_ID, {
        type: 'obs_crash',
        summary: 'OBS crashes when switching to scene 4',
        device: 'OBS',
      });

      expect(isNew).toBe(true);
      const all = memory.getAll(CHURCH_ID);
      const incident = all.find(m => m.summary === 'OBS crashes when switching to scene 4');
      expect(incident.category).toBe('equipment_quirk');
    });

    it('merges with existing incident of same type and device', () => {
      memory.recordIncidentLearning(CHURCH_ID, {
        type: 'obs_crash',
        summary: 'OBS crashed during service',
        device: 'OBS',
      });

      const isNew = memory.recordIncidentLearning(CHURCH_ID, {
        type: 'obs_crash',
        summary: 'OBS crashed again — seems related to scene transitions',
        device: 'OBS',
      });

      expect(isNew).toBe(false); // merged
      const all = memory.getAll(CHURCH_ID);
      const obsMemories = all.filter(m => JSON.parse(m.details).eventType === 'obs_crash');
      expect(obsMemories).toHaveLength(1);
      expect(obsMemories[0].observation_count).toBe(2);
    });

    it('returns false for invalid incident (missing type)', () => {
      const result = memory.recordIncidentLearning(CHURCH_ID, {
        summary: 'Something happened',
      });
      expect(result).toBe(false);
    });

    it('returns false for invalid incident (missing summary)', () => {
      const result = memory.recordIncidentLearning(CHURCH_ID, {
        type: 'some_event',
      });
      expect(result).toBe(false);
    });

    it('returns false for null incident', () => {
      expect(memory.recordIncidentLearning(CHURCH_ID, null)).toBe(false);
    });

    it('truncates long summaries to 120 chars', () => {
      const longSummary = 'A'.repeat(200);
      memory.recordIncidentLearning(CHURCH_ID, {
        type: 'test_event',
        summary: longSummary,
        device: 'Test',
      });

      const all = memory.getAll(CHURCH_ID);
      const m = all.find(m => m.category === 'equipment_quirk');
      expect(m.summary.length).toBeLessThanOrEqual(120);
    });

    it('includes metadata in details', () => {
      memory.recordIncidentLearning(CHURCH_ID, {
        type: 'encoder_fail',
        summary: 'Encoder dropped frames',
        device: 'Encoder',
        metadata: { frameDropCount: 150, duration: '5 min' },
      });

      const all = memory.getAll(CHURCH_ID);
      const m = all.find(m => m.summary === 'Encoder dropped frames');
      const details = JSON.parse(m.details);
      expect(details.frameDropCount).toBe(150);
      expect(details.duration).toBe('5 min');
    });

    it('rebuilds summary after recording', () => {
      memory.recordIncidentLearning(CHURCH_ID, {
        type: 'test_incident',
        summary: 'Test incident for summary rebuild',
        device: 'Test',
      });

      const row = db.prepare('SELECT memory_summary FROM churches WHERE churchId = ?').get(CHURCH_ID);
      expect(row.memory_summary).toContain('Test incident for summary rebuild');
    });

    it('returns false on database error', () => {
      db.close();
      expect(memory.recordIncidentLearning(CHURCH_ID, {
        type: 'test',
        summary: 'test',
      })).toBe(false);
    });
  });

  // ─── getRecentInsights ────────────────────────────────────────────────────

  describe('getRecentInsights', () => {
    it('returns empty array when no memories exist', () => {
      expect(memory.getRecentInsights(CHURCH_ID)).toEqual([]);
    });

    it('returns structured insights sorted by confidence', () => {
      seedMemories(memory, CHURCH_ID);
      const insights = memory.getRecentInsights(CHURCH_ID);

      expect(insights.length).toBeGreaterThan(0);
      expect(insights.length).toBeLessThanOrEqual(5);

      // Check structure
      for (const insight of insights) {
        expect(insight).toHaveProperty('summary');
        expect(insight).toHaveProperty('category');
        expect(insight).toHaveProperty('confidence');
        expect(insight).toHaveProperty('lastSeen');
        expect(insight).toHaveProperty('observationCount');
        expect(insight).toHaveProperty('details');
        expect(typeof insight.summary).toBe('string');
        expect(typeof insight.confidence).toBe('number');
      }
    });

    it('sorts by confidence descending', () => {
      seedMemories(memory, CHURCH_ID);
      const insights = memory.getRecentInsights(CHURCH_ID, 10);

      for (let i = 1; i < insights.length; i++) {
        // Confidence should be non-increasing (may have ties broken by last_seen)
        expect(insights[i].confidence).toBeLessThanOrEqual(insights[i - 1].confidence);
      }
    });

    it('respects limit parameter', () => {
      seedMemories(memory, CHURCH_ID);
      const insights = memory.getRecentInsights(CHURCH_ID, 2);
      expect(insights.length).toBeLessThanOrEqual(2);
    });

    it('defaults to limit of 5', () => {
      // Seed more than 5 memories
      seedMemories(memory, CHURCH_ID);
      for (let i = 0; i < 5; i++) {
        memory._upsertMemory(CHURCH_ID, 'equipment_quirk', `quirk:extra_${i}`,
          `Extra quirk ${i}`, { eventType: `extra_${i}` }, 'post_service');
      }
      const insights = memory.getRecentInsights(CHURCH_ID);
      expect(insights.length).toBeLessThanOrEqual(5);
    });

    it('strips _matchKey from returned details', () => {
      seedMemories(memory, CHURCH_ID);
      const insights = memory.getRecentInsights(CHURCH_ID);

      for (const insight of insights) {
        expect(insight.details).not.toHaveProperty('_matchKey');
      }
    });

    it('returns empty array on database error', () => {
      db.close();
      expect(memory.getRecentInsights(CHURCH_ID)).toEqual([]);
    });
  });

  // ─── Integration: context methods work with seeded data ───────────────────

  describe('integration', () => {
    it('all context methods return non-empty strings with seeded data', () => {
      seedMemories(memory, CHURCH_ID);

      expect(memory.getPreServiceContext(CHURCH_ID).length).toBeGreaterThan(0);
      expect(memory.getSessionContext(CHURCH_ID).length).toBeGreaterThan(0);
      expect(memory.getOnboardingContext(CHURCH_ID).length).toBeGreaterThan(0);
      expect(memory.getRecentInsights(CHURCH_ID).length).toBeGreaterThan(0);
    });

    it('incident learning feeds into context methods', () => {
      memory.recordIncidentLearning(CHURCH_ID, {
        type: 'ptz_timeout',
        summary: 'PTZ camera times out after 2 hours idle',
        device: 'PTZ',
        resolution: 'Set keep-alive ping every 30 min',
      });

      // Should appear in pre-service context as a fix
      const preCtx = memory.getPreServiceContext(CHURCH_ID);
      expect(preCtx).toContain('PTZ camera times out');

      // Should appear in session context
      const sessCtx = memory.getSessionContext(CHURCH_ID);
      expect(sessCtx).toContain('PTZ camera times out');

      // Should appear in onboarding context
      const onbCtx = memory.getOnboardingContext(CHURCH_ID);
      expect(onbCtx).toContain('PTZ camera times out');

      // Should appear in recent insights
      const insights = memory.getRecentInsights(CHURCH_ID);
      expect(insights.some(i => i.summary.includes('PTZ camera times out'))).toBe(true);
    });

    it('context methods handle church with no data gracefully', () => {
      expect(memory.getPreServiceContext('nonexistent')).toBe('');
      expect(memory.getSessionContext('nonexistent')).toBe('');
      expect(memory.getOnboardingContext('nonexistent')).toBe('');
      expect(memory.getRecentInsights('nonexistent')).toEqual([]);
    });
  });

  // ─── Character budget enforcement edge cases ──────────────────────────────

  describe('character budget edge cases', () => {
    it('_rebuildSummary enforces MAX_SUMMARY_CHARS (800) limit', () => {
      // Create many memories with long summaries
      for (let i = 0; i < 8; i++) {
        memory._upsertMemory(CHURCH_ID, 'equipment_quirk', `quirk:budget_${i}`,
          'A'.repeat(150), // 150 chars each
          { eventType: `budget_${i}` }, 'post_service');
      }
      memory._rebuildSummary(CHURCH_ID);

      const row = db.prepare('SELECT memory_summary FROM churches WHERE churchId = ?').get(CHURCH_ID);
      expect(row.memory_summary.length).toBeLessThanOrEqual(800);
    });

    it('_rebuildSummary produces valid bracket-wrapped text even when truncated', () => {
      for (let i = 0; i < 8; i++) {
        memory._upsertMemory(CHURCH_ID, 'user_note', `note:long_${i}`,
          'B'.repeat(200),
          {}, 'user_note');
      }
      memory._rebuildSummary(CHURCH_ID);

      const row = db.prepare('SELECT memory_summary FROM churches WHERE churchId = ?').get(CHURCH_ID);
      expect(row.memory_summary.startsWith('[Memory: ')).toBe(true);
      expect(row.memory_summary.endsWith(']')).toBe(true);
    });

    it('_rebuildSummary with single memory exceeding budget truncates gracefully', () => {
      memory._upsertMemory(CHURCH_ID, 'equipment_quirk', 'quirk:huge',
        'C'.repeat(900), // exceeds budget alone
        { eventType: 'huge' }, 'post_service');
      memory._rebuildSummary(CHURCH_ID);

      const row = db.prepare('SELECT memory_summary FROM churches WHERE churchId = ?').get(CHURCH_ID);
      expect(row.memory_summary.length).toBeLessThanOrEqual(800);
      expect(row.memory_summary.endsWith(']')).toBe(true);
    });

    it('empty memories result in empty summary string', () => {
      memory._rebuildSummary(CHURCH_ID);
      const row = db.prepare('SELECT memory_summary FROM churches WHERE churchId = ?').get(CHURCH_ID);
      expect(row.memory_summary).toBe('');
    });
  });

  // ─── Very long memory text ─────────────────────────────────────────────────

  describe('very long memory text', () => {
    it('saveUserNote with very long note truncates to 120 chars', () => {
      const longNote = 'X'.repeat(500);
      memory.saveUserNote(CHURCH_ID, longNote);

      const notes = memory.getUserNotes(CHURCH_ID);
      expect(notes).toHaveLength(1);
      expect(notes[0].summary.length).toBeLessThanOrEqual(120);
    });

    it('recordIncidentLearning with 5000-char summary truncates', () => {
      memory.recordIncidentLearning(CHURCH_ID, {
        type: 'massive_incident',
        summary: 'Y'.repeat(5000),
        device: 'TestDevice',
      });

      const all = memory.getAll(CHURCH_ID);
      const m = all.find(m => JSON.parse(m.details).eventType === 'massive_incident');
      expect(m.summary.length).toBeLessThanOrEqual(120);
    });

    it('getParserContext returns content within budget even with many memories', () => {
      for (let i = 0; i < 30; i++) {
        memory._upsertMemory(CHURCH_ID, 'equipment_quirk', `quirk:vol_${i}`,
          `Long quirk description ${i} with extra detail to consume space: ${'Z'.repeat(80)}`,
          { eventType: `vol_${i}` }, 'post_service');
      }

      const ctx = memory.getParserContext(CHURCH_ID);
      expect(ctx.length).toBeLessThanOrEqual(800);
    });
  });

  // ─── Concurrent recordIncidentLearning calls ──────────────────────────────

  describe('concurrent recordIncidentLearning calls', () => {
    it('handles rapid sequential recordIncidentLearning for same type+device', () => {
      // Simulate rapid concurrent-like calls (SQLite is synchronous, so these are sequential)
      for (let i = 0; i < 10; i++) {
        memory.recordIncidentLearning(CHURCH_ID, {
          type: 'obs_crash',
          summary: `OBS crashed iteration ${i}`,
          device: 'OBS',
        });
      }

      // Should merge into one memory with observation_count 10
      const all = memory.getAll(CHURCH_ID);
      const obsMemories = all.filter(m => JSON.parse(m.details).eventType === 'obs_crash');
      expect(obsMemories).toHaveLength(1);
      expect(obsMemories[0].observation_count).toBe(10);
      // Summary should be the last one written
      expect(obsMemories[0].summary).toBe('OBS crashed iteration 9');
    });

    it('handles rapid recordIncidentLearning for different types', () => {
      const types = ['obs_crash', 'atem_timeout', 'ptz_error', 'encoder_fail', 'mixer_dropout'];
      for (const type of types) {
        memory.recordIncidentLearning(CHURCH_ID, {
          type,
          summary: `${type} happened`,
          device: type.split('_')[0],
        });
      }

      const all = memory.getAll(CHURCH_ID);
      expect(all.length).toBe(types.length);
    });

    it('confidence increases correctly with repeated recordIncidentLearning', () => {
      // First call: confidence starts at 50
      memory.recordIncidentLearning(CHURCH_ID, {
        type: 'test_event',
        summary: 'Test event happened',
        device: 'Test',
      });

      let all = memory.getAll(CHURCH_ID);
      expect(all[0].confidence).toBe(50);

      // Second call: confidence should increase by 5
      memory.recordIncidentLearning(CHURCH_ID, {
        type: 'test_event',
        summary: 'Test event happened again',
        device: 'Test',
      });

      all = memory.getAll(CHURCH_ID);
      expect(all[0].confidence).toBe(55);
      expect(all[0].observation_count).toBe(2);
    });

    it('confidence caps at 100', () => {
      for (let i = 0; i < 20; i++) {
        memory.recordIncidentLearning(CHURCH_ID, {
          type: 'freq_event',
          summary: `Frequent event ${i}`,
          device: 'Test',
        });
      }

      const all = memory.getAll(CHURCH_ID);
      const m = all.find(m => JSON.parse(m.details).eventType === 'freq_event');
      expect(m.confidence).toBeLessThanOrEqual(100);
    });
  });
});
