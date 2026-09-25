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
  const m = yml.match(/- name: [^\n]*[Ss]im[^\n]*\n\s+(?:timeout-minutes: \d+\n\s+)?working-directory: church-client\n(?:\s+env:\n(?:\s+[A-Z_]+: [^\n]+\n)+)?\s+run: npm run test:sim/);
  assert.ok(m, 'church-client job must have a step running npm run test:sim');
});

test('CI installs relay-server deps so the remote-engineer relay-loop sims RUN (not skip) and requires them', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = yml.slice(yml.indexOf('\n  church-client:'), yml.indexOf('\n  electron-app:'));
  assert.match(job, /working-directory: relay-server\n\s+run: npm ci/, 'relay-server npm ci in church-client job');
  assert.match(job, /cache-dependency-path:[\s\S]*relay-server\/package-lock\.json/);
  assert.match(job, /TALLY_REQUIRE_RELAY_LOOP: ['"]?1/);
});

test('relayLoop refuses to silently skip when TALLY_REQUIRE_RELAY_LOOP=1 and the relay is missing', () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', `
    process.env.TALLY_RELAY_DIR='/nonexistent'; process.env.TALLY_REQUIRE_RELAY_LOOP='1';
    try { require(${JSON.stringify(path.join(__dirname, 'helpers', 'relayLoop.js'))}).relayAvailable(); console.log('NO-THROW'); }
    catch (e) { console.log('THREW ' + e.message); }`], { encoding: 'utf8' });
  assert.match(out, /THREW/);
});
