// The test scripts must load test/_stdout-guard.cjs so console output never reaches the
// node:test result channel (stdout) — see the guard file for the Node bug it avoids.
const test = require('node:test');
const assert = require('node:assert');

test('console.log from code under test goes to stderr, not the runner\'s stdout channel', () => {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let out = '', err = '';
  process.stdout.write = (c, ...r) => { out += c; return true; };
  process.stderr.write = (c, ...r) => { err += c; return true; };
  try {
    console.log('✅ Video Hub "probe" connected');
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.equal(out, '', 'nothing written to stdout');
  assert.match(err, /Video Hub "probe" connected/);
});
