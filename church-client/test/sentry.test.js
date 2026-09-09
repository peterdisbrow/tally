'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sentry = require('../src/sentry');

const SAMPLE_DSN = 'https://abc123@o1.ingest.us.sentry.io/99';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjaHVyY2hJZCI6InRlc3QifQ.signaturexx';

function mockSentry({ throwOnInit = false, throwOnCapture = false, throwOnFlush = false } = {}) {
  const captured = [];
  return {
    captured,
    init(opts) {
      if (throwOnInit) throw new Error('init boom');
      this.opts = opts;
    },
    withScope(fn) {
      const scope = {
        tags: {},
        extra: {},
        setTag(k, v) { this.tags[k] = v; },
        setExtra(k, v) { this.extra[k] = v; },
      };
      fn(scope);
      this.lastScope = scope;
    },
    captureException(err) {
      if (throwOnCapture) throw new Error('capture boom');
      captured.push(err);
    },
    async flush() {
      if (throwOnFlush) throw new Error('flush boom');
      return true;
    },
  };
}

test.afterEach(() => {
  sentry._resetForTests();
});

test('init is a no-op when DSN unset so local CLI still works', () => {
  assert.equal(sentry.resolveSentryDsn({}), '');
  assert.equal(sentry.initBoothSentry({ env: {} }).enabled, false);
  assert.equal(sentry.isSentryEnabled(), false);
  assert.equal(sentry.captureBoothException(new Error('nope')), false);
});

test('ELECTRON_SENTRY_DSN wins over SENTRY_DSN', () => {
  const electronDsn = 'https://booth@o1.ingest.us.sentry.io/2';
  assert.equal(
    sentry.resolveSentryDsn({ ELECTRON_SENTRY_DSN: electronDsn, SENTRY_DSN: SAMPLE_DSN }),
    electronDsn,
  );
  assert.equal(sentry.resolveSentryDsn({ SENTRY_DSN: SAMPLE_DSN }), SAMPLE_DSN);
});

test('placeholder and non-ingest DSNs are rejected', () => {
  assert.equal(sentry.isUsableDsn('https://placeholder@sentry.io/0'), false);
  assert.equal(sentry.isUsableDsn('not-a-url'), false);
  assert.equal(sentry.scrubString(42), 42);
});

test('beforeSend scrubs JWTs, bearer tokens, webhooks, and secrets', () => {
  const event = sentry.beforeSend({
    message: `Authorization Bearer ${JWT}`,
    request: {
      url: 'wss://api.tallyconnect.app/church?token=abc',
      headers: { authorization: 'Bearer x', cookie: 'a=b' },
    },
    extra: { token: 'leak', jwt: JWT },
    user: { id: 'c1', email: 'td@church.org' },
    breadcrumbs: [{ message: 'https://api.telegram.org/bot111:SECRET/sendMessage' }],
    exception: { values: [{ value: `https://hooks.slack.com/services/T/B/XXX` }] },
  });
  assert.equal(event.extra.token, '[Filtered]');
  assert.equal(event.extra.jwt, '[Filtered]');
  assert.match(event.request.url, /token=\[Filtered\]/);
  assert.equal(event.request.headers.authorization, undefined);
  assert.deepEqual(event.user, { id: 'c1' });
  assert.match(event.breadcrumbs[0].message, /\[Filtered webhook\]/);
  assert.match(event.exception.values[0].value, /\[Filtered webhook\]/);
  assert.doesNotMatch(JSON.stringify(event), /SECRET|td@church\.org|leak/);
});

test('beforeSend leaves non-objects alone', () => {
  assert.equal(sentry.beforeSend(null), null);
});

test('initBoothSentry with injected SDK captures and flushes', async () => {
  const sdk = mockSentry();
  const result = sentry.initBoothSentry({
    env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN },
    sentryModule: sdk,
    processName: 'church-client',
    release: '1.1.67',
  });
  assert.equal(result.enabled, true);
  assert.equal(sdk.opts.release, 'tally-booth@1.1.67');
  assert.equal(sentry.initBoothSentry({ env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN }, sentryModule: sdk }).already, true);
  assert.equal(sentry.captureBoothException(new Error('agent boom'), { tags: { kind: 'uncaughtException' } }), true);
  assert.equal(sdk.captured.length, 1);
  assert.equal(sdk.lastScope.tags.kind, 'uncaughtException');
  assert.equal(await sentry.flushBoothSentry(10), true);
});

test('init and capture failures do not throw', async () => {
  assert.equal(
    sentry.initBoothSentry({
      env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN },
      sentryModule: mockSentry({ throwOnInit: true }),
    }).enabled,
    false,
  );
  sentry._resetForTests();
  const sdk = mockSentry({ throwOnCapture: true, throwOnFlush: true });
  sentry.initBoothSentry({ env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN }, sentryModule: sdk });
  assert.equal(sentry.captureBoothException('x'), false);
  assert.equal(await sentry.flushBoothSentry(), false);
});

test('missing @sentry/node does not crash the agent', () => {
  const Module = require('module');
  const originalLoad = Module._load;
  try {
    delete require.cache[require.resolve('@sentry/node')];
  } catch { /* not loaded yet */ }
  Module._load = function (request, parent, isMain) {
    if (request === '@sentry/node') throw new Error('Cannot find module');
    return originalLoad(request, parent, isMain);
  };
  try {
    assert.equal(sentry.initBoothSentry({ env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN } }).enabled, false);
  } finally {
    Module._load = originalLoad;
  }
});

test('flush is a no-op when disabled', async () => {
  assert.equal(await sentry.flushBoothSentry(), false);
});

test('index.js inits Sentry and captures uncaught exceptions', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(src, /require\('\.\/sentry'\)/);
  assert.match(src, /initBoothSentry/);
  assert.match(src, /captureBoothException/);
  assert.match(src, /flushBoothSentry/);
});
