/**
 * Tests for src/tally-engineer.js — AI identity, knowledge base, and prompt builders.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  TALLY_ENGINEER_IDENTITY,
  TALLY_ENGINEER_KNOWLEDGE,
  buildCommandPrompt,
  buildDiagnosticPrompt,
  buildAdminPrompt,
  buildBackgroundPrompt,
} = require('../src/tally-engineer');

describe('tally-engineer constants', () => {
  it('exports TALLY_ENGINEER_IDENTITY as a non-empty string', () => {
    expect(typeof TALLY_ENGINEER_IDENTITY).toBe('string');
    expect(TALLY_ENGINEER_IDENTITY.length).toBeGreaterThan(0);
    expect(TALLY_ENGINEER_IDENTITY).toContain('Tally Engineer');
  });

  it('exports TALLY_ENGINEER_KNOWLEDGE as a non-empty string', () => {
    expect(typeof TALLY_ENGINEER_KNOWLEDGE).toBe('string');
    expect(TALLY_ENGINEER_KNOWLEDGE.length).toBeGreaterThan(0);
    expect(TALLY_ENGINEER_KNOWLEDGE).toContain('ATEM');
  });
});

describe('buildCommandPrompt()', () => {
  it('returns a string containing the identity', () => {
    const result = buildCommandPrompt('COMMAND_SIGS_HERE');
    expect(typeof result).toBe('string');
    expect(result).toContain('Tally Engineer');
    expect(result).toContain('COMMAND_SIGS_HERE');
  });

  it('includes response format instructions', () => {
    const result = buildCommandPrompt('');
    expect(result).toContain('type":"command"');
    expect(result).toContain('type":"chat"');
  });
});

describe('buildDiagnosticPrompt()', () => {
  it('returns a string with diagnostic instructions', () => {
    const result = buildDiagnosticPrompt();
    expect(typeof result).toBe('string');
    expect(result).toContain('DIAGNOSTIC INSTRUCTIONS');
    expect(result).toContain('Tally Engineer');
  });
});

describe('buildAdminPrompt()', () => {
  it('returns a string with admin dashboard context', () => {
    const result = buildAdminPrompt();
    expect(typeof result).toBe('string');
    expect(result).toContain('admin dashboard');
    expect(result).toContain('Tally Engineer');
  });
});

describe('buildBackgroundPrompt()', () => {
  it('returns incident_summary prompt', () => {
    const result = buildBackgroundPrompt('incident_summary');
    expect(result).toContain('incident summary');
  });

  it('returns session_recommendations prompt', () => {
    const result = buildBackgroundPrompt('session_recommendations');
    expect(result).toContain('recommendations');
  });

  it('returns post_service_report prompt', () => {
    const result = buildBackgroundPrompt('post_service_report');
    expect(result).toContain('pastor');
  });

  it('returns support_triage prompt', () => {
    const result = buildBackgroundPrompt('support_triage');
    expect(result).toContain('diagnostic');
  });

  it('returns pre_service_rundown prompt', () => {
    const result = buildBackgroundPrompt('pre_service_rundown');
    expect(result).toContain('rundown');
  });

  it('returns default prompt for unknown task', () => {
    const result = buildBackgroundPrompt('unknown_task_xyz');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
