/**
 * Tests for AutoPilot rule templates — pre-built one-click automation rules.
 *
 * Covers: RULE_TEMPLATES structure, getTemplates tier gating,
 * activateTemplate, deactivateTemplate, getActiveTemplates, and customization.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { AutoPilot, RULE_TEMPLATES } from '../src/autoPilot.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'connect'
    )
  `);
  return db;
}

function addChurch(db, churchId, tier = 'pro') {
  db.prepare('INSERT INTO churches (churchId, name, billing_tier) VALUES (?, ?, ?)')
    .run(churchId, 'Test Church', tier);
}

function createAutoPilot(db, opts = {}) {
  return new AutoPilot(db, opts);
}

// ─── RULE_TEMPLATES constant ──────────────────────────────────────────────────

describe('RULE_TEMPLATES constant', () => {
  it('exports RULE_TEMPLATES as an array', () => {
    expect(Array.isArray(RULE_TEMPLATES)).toBe(true);
    expect(RULE_TEMPLATES.length).toBe(12);
  });

  it('every template has required fields', () => {
    const requiredFields = ['id', 'name', 'description', 'trigger', 'action', 'conditions', 'tier', 'category'];
    for (const tmpl of RULE_TEMPLATES) {
      for (const field of requiredFields) {
        expect(tmpl).toHaveProperty(field);
      }
    }
  });

  it('all template ids are unique', () => {
    const ids = RULE_TEMPLATES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('template tiers are valid', () => {
    const validTiers = ['plus', 'pro', 'enterprise'];
    for (const tmpl of RULE_TEMPLATES) {
      expect(validTiers).toContain(tmpl.tier);
    }
  });

  it('each template trigger has type and config', () => {
    for (const tmpl of RULE_TEMPLATES) {
      expect(tmpl.trigger).toHaveProperty('type');
      expect(tmpl.trigger).toHaveProperty('config');
    }
  });

  it('each template action is an array of command objects', () => {
    for (const tmpl of RULE_TEMPLATES) {
      expect(Array.isArray(tmpl.action)).toBe(true);
      for (const a of tmpl.action) {
        expect(a).toHaveProperty('command');
        expect(a).toHaveProperty('params');
      }
    }
  });

  it('contains the expected template IDs', () => {
    const ids = RULE_TEMPLATES.map(t => t.id);
    expect(ids).toContain('auto_start_recording');
    expect(ids).toContain('auto_stop_recording');
    expect(ids).toContain('silence_alert_escalation');
    expect(ids).toContain('camera_failover');
    expect(ids).toContain('auto_fade_to_black');
    expect(ids).toContain('pre_service_camera_check');
    expect(ids).toContain('low_bitrate_recovery');
    expect(ids).toContain('propresenter_follow');
  });
});

// ─── getTemplates (tier gating) ───────────────────────────────────────────────

describe('getTemplates', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    ap = createAutoPilot(db);
  });

  it('returns no templates for unknown/connect tier', () => {
    expect(ap.getTemplates('connect')).toHaveLength(0);
    expect(ap.getTemplates('free')).toHaveLength(0);
  });

  it('plus tier returns only plus-tier templates', () => {
    const templates = ap.getTemplates('plus');
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t.tier).toBe('plus');
    }
  });

  it('pro tier returns plus + pro templates', () => {
    const templates = ap.getTemplates('pro');
    const plusCount = RULE_TEMPLATES.filter(t => t.tier === 'plus').length;
    const proCount = RULE_TEMPLATES.filter(t => t.tier === 'pro').length;
    expect(templates.length).toBe(plusCount + proCount);
  });

  it('enterprise tier returns all templates', () => {
    const templates = ap.getTemplates('enterprise');
    expect(templates.length).toBe(RULE_TEMPLATES.length);
  });
});

// ─── activateTemplate ─────────────────────────────────────────────────────────

describe('activateTemplate', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 'pro');
    ap = createAutoPilot(db);
  });

  it('creates an enabled rule from a template', () => {
    const result = ap.activateTemplate('church-1', 'auto_start_recording');
    expect(result).toHaveProperty('id');
    expect(result.templateId).toBe('auto_start_recording');
    expect(result.name).toBe('Auto-Start Recording');
    expect(result.enabled).toBe(true);
  });

  it('stores the rule in the database', () => {
    ap.activateTemplate('church-1', 'auto_start_recording');
    const rules = ap.getRules('church-1');
    expect(rules).toHaveLength(1);
    expect(rules[0].template_id).toBe('auto_start_recording');
    expect(rules[0].enabled).toBe(true);
  });

  it('throws on unknown template ID', () => {
    expect(() => ap.activateTemplate('church-1', 'nonexistent')).toThrow('Template not found');
  });

  it('throws when template already activated', () => {
    ap.activateTemplate('church-1', 'auto_start_recording');
    expect(() => ap.activateTemplate('church-1', 'auto_start_recording')).toThrow('already active');
  });

  it('allows activating multiple different templates', () => {
    ap.activateTemplate('church-1', 'auto_start_recording');
    ap.activateTemplate('church-1', 'auto_stop_recording');
    const rules = ap.getRules('church-1');
    expect(rules).toHaveLength(2);
  });
});

// ─── activateTemplate with billing tier gating ────────────────────────────────

describe('activateTemplate tier gating (with billing)', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    const billing = {
      checkAccess: () => ({ allowed: true }),
    };
    ap = createAutoPilot(db, { billing });
  });

  it('rejects enterprise-tier template for plus-tier church', () => {
    addChurch(db, 'church-plus', 'plus');
    expect(() => ap.activateTemplate('church-plus', 'low_bitrate_recovery'))
      .toThrow('requires enterprise tier');
  });

  it('rejects pro-tier template for plus-tier church', () => {
    addChurch(db, 'church-plus', 'plus');
    expect(() => ap.activateTemplate('church-plus', 'camera_failover'))
      .toThrow('requires pro tier');
  });

  it('allows plus-tier template for plus-tier church', () => {
    addChurch(db, 'church-plus', 'plus');
    const result = ap.activateTemplate('church-plus', 'auto_start_recording');
    expect(result.templateId).toBe('auto_start_recording');
  });

  it('allows pro-tier template for pro-tier church', () => {
    addChurch(db, 'church-pro', 'pro');
    const result = ap.activateTemplate('church-pro', 'camera_failover');
    expect(result.templateId).toBe('camera_failover');
  });

  it('allows plus-tier template for pro-tier church (higher includes lower)', () => {
    addChurch(db, 'church-pro', 'pro');
    const result = ap.activateTemplate('church-pro', 'auto_start_recording');
    expect(result.templateId).toBe('auto_start_recording');
  });

  it('allows enterprise-tier template for enterprise-tier church', () => {
    addChurch(db, 'church-ent', 'enterprise');
    const result = ap.activateTemplate('church-ent', 'low_bitrate_recovery');
    expect(result.templateId).toBe('low_bitrate_recovery');
  });
});

// ─── activateTemplate with customization ──────────────────────────────────────

describe('activateTemplate customization', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 'pro');
    ap = createAutoPilot(db);
  });

  it('allows custom triggerConfig to override template defaults', () => {
    ap.activateTemplate('church-1', 'propresenter_follow', {
      triggerConfig: { presentationPattern: 'worship', slideIndex: 3 },
    });
    const active = ap.getActiveTemplates('church-1');
    expect(active).toHaveLength(1);
    expect(active[0].triggerConfig.presentationPattern).toBe('worship');
    expect(active[0].triggerConfig.slideIndex).toBe(3);
  });

  it('allows custom actionParams to override template action params', () => {
    ap.activateTemplate('church-1', 'auto_stop_recording', {
      actionParams: { delaySeconds: 60 },
    });
    const active = ap.getActiveTemplates('church-1');
    expect(active).toHaveLength(1);
    expect(active[0].actions[0].params.delaySeconds).toBe(60);
  });

  it('allows entirely custom actions array', () => {
    const customActions = [{ command: 'custom.command', params: { key: 'value' } }];
    ap.activateTemplate('church-1', 'auto_start_recording', {
      actions: customActions,
    });
    const active = ap.getActiveTemplates('church-1');
    expect(active[0].actions).toEqual(customActions);
  });

  it('merges triggerConfig with template defaults (not replaces)', () => {
    // auto_stop_recording trigger config has conditions: { 'obs.streaming': false }
    ap.activateTemplate('church-1', 'auto_stop_recording', {
      triggerConfig: { extraField: 'hello' },
    });
    const active = ap.getActiveTemplates('church-1');
    expect(active[0].triggerConfig.conditions).toEqual({ 'obs.streaming': false });
    expect(active[0].triggerConfig.extraField).toBe('hello');
  });
});

// ─── deactivateTemplate ───────────────────────────────────────────────────────

describe('deactivateTemplate', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 'pro');
    ap = createAutoPilot(db);
  });

  it('removes the template-based rule', () => {
    ap.activateTemplate('church-1', 'auto_start_recording');
    const removed = ap.deactivateTemplate('church-1', 'auto_start_recording');
    expect(removed).toBe(true);
    expect(ap.getRules('church-1')).toHaveLength(0);
  });

  it('returns false if template was not active', () => {
    const removed = ap.deactivateTemplate('church-1', 'auto_start_recording');
    expect(removed).toBe(false);
  });

  it('does not affect other templates', () => {
    ap.activateTemplate('church-1', 'auto_start_recording');
    ap.activateTemplate('church-1', 'auto_stop_recording');
    ap.deactivateTemplate('church-1', 'auto_start_recording');
    const rules = ap.getRules('church-1');
    expect(rules).toHaveLength(1);
    expect(rules[0].template_id).toBe('auto_stop_recording');
  });

  it('allows re-activating after deactivation', () => {
    ap.activateTemplate('church-1', 'auto_start_recording');
    ap.deactivateTemplate('church-1', 'auto_start_recording');
    const result = ap.activateTemplate('church-1', 'auto_start_recording');
    expect(result.templateId).toBe('auto_start_recording');
  });
});

// ─── getActiveTemplates ───────────────────────────────────────────────────────

describe('getActiveTemplates', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 'pro');
    ap = createAutoPilot(db);
  });

  it('returns empty array when no templates active', () => {
    expect(ap.getActiveTemplates('church-1')).toEqual([]);
  });

  it('returns active templates with metadata', () => {
    ap.activateTemplate('church-1', 'auto_start_recording');
    const active = ap.getActiveTemplates('church-1');
    expect(active).toHaveLength(1);
    expect(active[0].templateId).toBe('auto_start_recording');
    expect(active[0].name).toBe('Auto-Start Recording');
    expect(active[0].description).toBe('When stream starts, automatically start recording');
    expect(active[0].category).toBe('recording');
    expect(active[0].tier).toBe('plus');
    expect(active[0].enabled).toBe(true);
    expect(active[0]).toHaveProperty('ruleId');
    expect(active[0]).toHaveProperty('triggerConfig');
    expect(active[0]).toHaveProperty('actions');
    expect(active[0]).toHaveProperty('createdAt');
  });

  it('does not include manually created rules', () => {
    ap.createRule('church-1', {
      name: 'Manual Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 5 },
      actions: [{ command: 'test', params: {} }],
    });
    ap.activateTemplate('church-1', 'auto_start_recording');
    const active = ap.getActiveTemplates('church-1');
    expect(active).toHaveLength(1);
    expect(active[0].templateId).toBe('auto_start_recording');
  });

  it('returns multiple active templates in creation order', () => {
    ap.activateTemplate('church-1', 'auto_start_recording');
    ap.activateTemplate('church-1', 'camera_failover');
    const active = ap.getActiveTemplates('church-1');
    expect(active).toHaveLength(2);
    expect(active[0].templateId).toBe('auto_start_recording');
    expect(active[1].templateId).toBe('camera_failover');
  });

  it('does not return templates from other churches', () => {
    addChurch(db, 'church-2', 'pro');
    ap.activateTemplate('church-1', 'auto_start_recording');
    ap.activateTemplate('church-2', 'camera_failover');
    const active1 = ap.getActiveTemplates('church-1');
    const active2 = ap.getActiveTemplates('church-2');
    expect(active1).toHaveLength(1);
    expect(active1[0].templateId).toBe('auto_start_recording');
    expect(active2).toHaveLength(1);
    expect(active2[0].templateId).toBe('camera_failover');
  });
});

// ─── Activate all templates at once ─────────────────────────────────────────────

describe('activateTemplate — all templates at once', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 'enterprise');
    ap = createAutoPilot(db);
  });

  it('can activate all templates for an enterprise-tier church', () => {
    for (const tmpl of RULE_TEMPLATES) {
      const result = ap.activateTemplate('church-1', tmpl.id);
      expect(result.templateId).toBe(tmpl.id);
      expect(result.enabled).toBe(true);
    }

    const active = ap.getActiveTemplates('church-1');
    expect(active).toHaveLength(RULE_TEMPLATES.length);

    const rules = ap.getRules('church-1');
    expect(rules).toHaveLength(RULE_TEMPLATES.length);
  });

  it('all activated templates have correct trigger types', () => {
    for (const tmpl of RULE_TEMPLATES) {
      ap.activateTemplate('church-1', tmpl.id);
    }

    const active = ap.getActiveTemplates('church-1');
    for (const a of active) {
      const tmpl = RULE_TEMPLATES.find(t => t.id === a.templateId);
      expect(a.name).toBe(tmpl.name);
    }
  });

  it('deactivating all templates leaves no rules', () => {
    for (const tmpl of RULE_TEMPLATES) {
      ap.activateTemplate('church-1', tmpl.id);
    }

    for (const tmpl of RULE_TEMPLATES) {
      ap.deactivateTemplate('church-1', tmpl.id);
    }

    expect(ap.getRules('church-1')).toHaveLength(0);
    expect(ap.getActiveTemplates('church-1')).toHaveLength(0);
  });
});

// ─── Template with invalid customParams ──────────────────────────────────────

describe('activateTemplate — invalid customParams', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 'enterprise');
    ap = createAutoPilot(db);
  });

  it('handles empty customParams object gracefully', () => {
    const result = ap.activateTemplate('church-1', 'auto_start_recording', {});
    expect(result.templateId).toBe('auto_start_recording');
    expect(result.enabled).toBe(true);
  });

  it('handles null-like customParams values', () => {
    const result = ap.activateTemplate('church-1', 'auto_start_recording', {
      triggerConfig: null,
      actionParams: null,
      actions: null,
    });
    expect(result.templateId).toBe('auto_start_recording');
  });

  it('preserves template defaults when customParams has unrelated keys', () => {
    ap.activateTemplate('church-1', 'auto_start_recording', {
      someRandomKey: 'value',
      anotherKey: 42,
    });

    const active = ap.getActiveTemplates('church-1');
    expect(active).toHaveLength(1);
    // Should use template defaults
    expect(active[0].triggerConfig.conditions).toEqual({ 'obs.streaming': true });
    expect(active[0].actions[0].command).toBe('obs.startRecording');
  });

  it('custom actionParams with extra fields are included in stored action', () => {
    ap.activateTemplate('church-1', 'auto_stop_recording', {
      actionParams: { delaySeconds: 120, customFlag: true },
    });

    const active = ap.getActiveTemplates('church-1');
    expect(active[0].actions[0].params.delaySeconds).toBe(120);
    expect(active[0].actions[0].params.customFlag).toBe(true);
  });
});

// ─── Template activation does not break manual rules ─────────────────────────

describe('template activation vs manual rules', () => {
  let db, ap;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 'pro');
    ap = createAutoPilot(db);
  });

  it('manual rules are preserved when templates are activated', () => {
    // Create a manual rule first
    const manual = ap.createRule('church-1', {
      name: 'Custom Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 10 },
      actions: [{ command: 'obs.switchScene', params: { scene: 'Worship' } }],
    });

    // Activate a template
    ap.activateTemplate('church-1', 'auto_start_recording');

    // Both should exist
    const rules = ap.getRules('church-1');
    expect(rules).toHaveLength(2);

    // Manual rule should still be accessible
    const manualRule = ap.getRule(manual.id);
    expect(manualRule).toBeTruthy();
    expect(manualRule.name).toBe('Custom Rule');
  });

  it('deactivating template does not delete manual rules', () => {
    ap.createRule('church-1', {
      name: 'Manual Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 5 },
      actions: [{ command: 'test', params: {} }],
    });

    ap.activateTemplate('church-1', 'auto_start_recording');
    ap.deactivateTemplate('church-1', 'auto_start_recording');

    const rules = ap.getRules('church-1');
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('Manual Rule');
  });

  it('manual rule can be enabled independently from templates', () => {
    const manual = ap.createRule('church-1', {
      name: 'Manual Rule',
      triggerType: 'schedule_timer',
      triggerConfig: { minutesIntoService: 5 },
      actions: [{ command: 'test', params: {} }],
    });

    ap.updateRule(manual.id, { enabled: true });
    ap.activateTemplate('church-1', 'auto_start_recording');

    const rules = ap.getRules('church-1');
    const manualRule = rules.find(r => r.name === 'Manual Rule');
    const templateRule = rules.find(r => r.template_id === 'auto_start_recording');

    expect(manualRule.enabled).toBe(true);
    expect(templateRule.enabled).toBe(true);
  });
});
