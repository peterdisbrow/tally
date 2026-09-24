/**
 * The device sim suite (stateful mocks, real agent process) must run in CI,
 * not only locally. Guards against silently dropping it from the workflow.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

test('church-client has a test:sim script covering test/sim', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'church-client', 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:sim'] || '', /test\/sim\/\*\.test\.js/);
});

test('root package.json exposes npm run test:sim', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:sim'] || '', /church-client.*test:sim/);
});

test('CI workflow runs npm run test:sim in church-client', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const m = yml.match(/- name: [^\n]*[Ss]im[^\n]*\n\s+(?:timeout-minutes: \d+\n\s+)?working-directory: church-client\n\s+run: npm run test:sim/);
  assert.ok(m, 'church-client job must have a step running npm run test:sim');
});
