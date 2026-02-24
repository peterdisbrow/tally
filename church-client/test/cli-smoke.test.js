const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('CLI help renders without booting agent runtime', () => {
  const cliPath = path.join(__dirname, '..', 'src', 'index.js');
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  assert.equal(result.status, 0, result.stderr || 'CLI --help exited non-zero');
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /tally-connect/i);
  assert.match(output, /--token/i);
  assert.match(output, /--relay/i);
});
