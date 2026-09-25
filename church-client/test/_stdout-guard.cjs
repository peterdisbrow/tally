/**
 * Loaded with `node --require` by the test scripts (propagates to every test child).
 *
 * node:test runs each file in a child process and multiplexes that child's stdout with its
 * v8-serialized result frames on one pipe. Text written to stdout (product code logs emoji
 * banners like "✅ Video Hub connected") can corrupt the framing under concurrency, and the
 * runner then fails the whole file with "Unable to deserialize cloned data due to invalid or
 * unsupported version" (nodejs/node#56802, #64061). Seen once in 16 church-client unit runs
 * (pco1, integration-mocks.test.js); reproduced 5/5 with a noisy fixture, 0/5 with this guard.
 *
 * console.log/info/debug go to stderr instead — nothing is hidden, it just stays off the
 * result channel. Tests that spy on console.* replace these functions and are unaffected.
 */
'use strict';
const { format } = require('node:util');
for (const m of ['log', 'info', 'debug']) {
  console[m] = (...args) => { process.stderr.write(`${format(...args)}\n`); };
}
