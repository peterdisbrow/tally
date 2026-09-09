'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sentry = require('../src/sentry');
const { writeEmbeddedSentryDsn } = require('../scripts/write-embedded-sentry-dsn');

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

test('resolveSentryDsn is empty when unset (local still works)', () => {
  assert.equal(sentry.resolveSentryDsn({}, ''), '');
  assert.equal(sentry.resolveSentryDsn({ ELECTRON_SENTRY_DSN: '  ' }, ''), '');
  assert.equal(sentry.initBoothSentry({ env: {}, embeddedDsn: '' }).enabled, false);
  assert.equal(sentry.isSentryEnabled(), false);
  assert.equal(sentry.captureBoothException(new Error('nope')), false);
});

test('resolveSentryDsn prefers ELECTRON_SENTRY_DSN over SENTRY_DSN and embed', () => {
  assert.equal(
    sentry.resolveSentryDsn(
      { ELECTRON_SENTRY_DSN: SAMPLE_DSN, SENTRY_DSN: 'https://other@o1.ingest.us.sentry.io/1' },
      'https://embed@o1.ingest.us.sentry.io/2',
    ),
    SAMPLE_DSN,
  );
});

test('resolveSentryDsn falls back to SENTRY_DSN then embed', () => {
  assert.equal(
    sentry.resolveSentryDsn({ SENTRY_DSN: SAMPLE_DSN }, ''),
    SAMPLE_DSN,
  );
  assert.equal(sentry.resolveSentryDsn({}, SAMPLE_DSN), SAMPLE_DSN);
});

test('resolveSentryDsn rejects placeholder and non-ingest URLs', () => {
  assert.equal(sentry.isUsableDsn('https://placeholder@sentry.io/0'), false);
  assert.equal(sentry.isUsableDsn('https://example.com/dsn'), false);
  assert.equal(sentry.isUsableDsn('http://abc@o1.ingest.us.sentry.io/1'), false);
  assert.equal(sentry.isUsableDsn(null), false);
});

test('git-committed embedded DSN is empty (no hardcoded secret)', () => {
  const embedded = require('../src/embedded-sentry-dsn');
  assert.equal(embedded, '');
});

test('beforeSend scrubs tokens, JWTs, webhook URLs, and auth headers', () => {
  const event = sentry.beforeSend({
    message: `Bearer abcdef.token ${JWT}`,
    request: {
      url: 'https://api.tallyconnect.app/church?token=super-secret',
      headers: { authorization: 'Bearer abc', cookie: 'sid=1', 'x-other': 'ok' },
    },
    extra: {
      token: 'leak-me',
      nested: { password: 'pw', note: `hook https://hooks.slack.com/services/T/B/XXX` },
    },
    contexts: { telegram: 'https://api.telegram.org/bot111:AAHsecret/sendMessage' },
    user: { id: 'u1', email: 'td@church.org' },
    breadcrumbs: [{ message: `auth=${JWT}`, data: { apiKey: 'k' } }],
    exception: { values: [{ type: 'Error', value: `token=${JWT}` }, 'skip'] },
  });

  assert.equal(event.request.headers.authorization, undefined);
  assert.equal(event.request.headers.cookie, undefined);
  assert.match(event.request.url, /token=\[Filtered\]/);
  assert.equal(event.extra.token, '[Filtered]');
  assert.equal(event.extra.nested.password, '[Filtered]');
  assert.match(event.extra.nested.note, /\[Filtered webhook\]/);
  assert.match(event.contexts.telegram, /\[Filtered webhook\]/);
  assert.deepEqual(event.user, { id: 'u1' });
  assert.doesNotMatch(JSON.stringify(event), /super-secret|AAHsecret|td@church\.org|leak-me/);
  assert.match(event.exception.values[0].value, /\[Filtered\]/);
  assert.equal(event.exception.values[1], 'skip');
  assert.match(event.message, /Bearer \[Filtered\]/);
});

test('beforeSend returns non-objects unchanged', () => {
  assert.equal(sentry.beforeSend(null), null);
  assert.equal(sentry.beforeSend('x'), 'x');
});

test('initBoothSentry uses injected SDK and is idempotent', () => {
  const sdk = mockSentry();
  const first = sentry.initBoothSentry({
    env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN },
    sentryModule: sdk,
    processName: 'electron-main',
    release: '1.2.3',
    environment: 'test',
  });
  assert.equal(first.enabled, true);
  assert.equal(sdk.opts.dsn, SAMPLE_DSN);
  assert.equal(sdk.opts.sendDefaultPii, false);
  assert.equal(sdk.opts.tracesSampleRate, 0);
  assert.equal(sdk.opts.release, 'tally-booth@1.2.3');
  assert.equal(typeof sdk.opts.beforeSend, 'function');
  const second = sentry.initBoothSentry({ env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN }, sentryModule: sdk });
  assert.equal(second.already, true);
});

test('initBoothSentry no-ops when SDK init throws', () => {
  assert.equal(
    sentry.initBoothSentry({
      env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN },
      sentryModule: mockSentry({ throwOnInit: true }),
    }).enabled,
    false,
  );
});

test('initBoothSentry returns disabled when require of SDK is injected as missing', () => {
  const Module = require('module');
  const originalLoad = Module._load;
  try {
    delete require.cache[require.resolve('@sentry/node')];
  } catch { /* not loaded yet */ }
  Module._load = function (request, parent, isMain) {
    if (request === '@sentry/node') {
      const err = new Error('Cannot find module');
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const result = sentry.initBoothSentry({ env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN } });
    assert.equal(result.enabled, false);
  } finally {
    Module._load = originalLoad;
  }
});

test('captureBoothException and renderer crash report through SDK', () => {
  const sdk = mockSentry();
  sentry.initBoothSentry({ env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN }, sentryModule: sdk });
  assert.equal(sentry.captureBoothException('plain string'), true);
  assert.equal(sdk.captured[0] instanceof Error, true);
  assert.equal(
    sentry.captureRendererCrash({
      type: 'unhandledrejection',
      message: 'boom',
      stack: 'stack',
      filename: 'renderer.js',
      lineno: 10,
      colno: 2,
    }),
    true,
  );
  assert.equal(sdk.captured[1].name, 'UnhandledRejection');
  assert.equal(sdk.lastScope.tags.surface, 'electron-renderer');
  assert.equal(sentry.captureBoothException(new Error('x'), { tags: { a: 1 }, extra: { b: 2 } }), true);
});

test('captureBoothException and flush swallow SDK failures', async () => {
  const sdk = mockSentry({ throwOnCapture: true, throwOnFlush: true });
  sentry.initBoothSentry({ env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN }, sentryModule: sdk });
  assert.equal(sentry.captureBoothException(new Error('x')), false);
  assert.equal(await sentry.flushBoothSentry(10), false);
});

test('flushBoothSentry is a no-op when disabled', async () => {
  assert.equal(await sentry.flushBoothSentry(), false);
});

test('flushBoothSentry succeeds when enabled', async () => {
  const sdk = mockSentry();
  sentry.initBoothSentry({ env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN }, sentryModule: sdk });
  assert.equal(await sentry.flushBoothSentry(10), true);
});

test('writeEmbeddedSentryDsn writes dest when DSN is usable', () => {
  const dest = path.join(os.tmpdir(), `tally-sentry-dsn-${Date.now()}.js`);
  const logs = [];
  const result = writeEmbeddedSentryDsn({
    dest,
    env: { ELECTRON_SENTRY_DSN: SAMPLE_DSN },
    log: (msg) => logs.push(msg),
  });
  assert.equal(result.written, true);
  assert.equal(require(dest), SAMPLE_DSN);
  assert.match(logs.join('\n'), /value not printed/);
  fs.unlinkSync(dest);
});

test('writeEmbeddedSentryDsn skips when DSN unset', () => {
  const dest = path.join(os.tmpdir(), `tally-sentry-dsn-skip-${Date.now()}.js`);
  const result = writeEmbeddedSentryDsn({ dest, env: {}, log() {} });
  assert.equal(result.written, false);
  assert.equal(fs.existsSync(dest), false);
});

test('main.js inits booth Sentry and captures agent / renderer crashes', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.match(main, /require\('\.\/sentry'\)/);
  assert.match(main, /initBoothSentry/);
  assert.match(main, /report-crash/);
  assert.match(main, /captureRendererCrash/);
  assert.match(main, /ELECTRON_SENTRY_DSN/);
  assert.match(main, /repeated-crash|crashCount/);
});

test('preload exposes reportCrash and renderer attaches window error handlers', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  assert.match(preload, /reportCrash/);
  assert.match(preload, /report-crash/);
  assert.match(renderer, /reportCrash/);
  assert.match(renderer, /unhandledrejection/);
});

test('electron-builder bakes DSN via beforePack', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.build.beforePack, './scripts/beforePack.js');
});
