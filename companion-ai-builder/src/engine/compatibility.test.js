'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeCompanionCompatibility } = require('./compatibility');
const { generateLayout } = require('./generator');

test('compatibility passes when required module family is present', () => {
  const generated = generateLayout({
    prompt: 'Build an M/E 2 control surface for stream deck xl',
    gear: [{ type: 'atem', connectionId: 'atem-main', name: 'ATEM' }]
  });

  const result = analyzeCompanionCompatibility(generated.layout, [
    { id: 'atem1', moduleId: 'bmd-atem', label: 'ATEM Module', status: 'ok' }
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.missingModules.length, 0);
  assert.equal(result.unresolved.length, 0);
});

test('compatibility flags missing module families', () => {
  const generated = generateLayout({
    prompt: 'Build an M/E 2 control surface for stream deck xl',
    gear: [{ type: 'atem', connectionId: 'atem-main', name: 'ATEM' }]
  });

  const result = analyzeCompanionCompatibility(generated.layout, [
    { id: 'obs1', moduleId: 'obs-studio', label: 'OBS Module', status: 'ok' }
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.missingModules.some((m) => m.gearType === 'atem'));
  assert.ok(result.unresolved.length > 0);
});

test('compatibility ignores internal builder actions', () => {
  const layout = {
    pages: [
      {
        page: 1,
        name: 'Test',
        buttons: [
          { row: 0, col: 0, label: 'Internal', action: { id: 'builder.status', params: {} }, feedback: [] },
          { row: 0, col: 1, label: 'Custom', action: { id: 'custom.action', params: {} }, feedback: [] }
        ]
      }
    ]
  };

  const result = analyzeCompanionCompatibility(layout, []);
  assert.equal(result.ok, true);
  assert.equal(result.moduleChecks.length, 0);
});
