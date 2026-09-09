'use strict';

/**
 * Bake ELECTRON_SENTRY_DSN into src/embedded-sentry-dsn.js for packaged builds.
 * Runtime process.env is empty in a shipped .app/.exe, so the DSN must be
 * written at electron-builder time (GitHub Actions or Mac Studio).
 *
 * Never prints the DSN. Leaves the committed empty file alone when unset.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEST = path.join(__dirname, '..', 'src', 'embedded-sentry-dsn.js');

function isUsableDsn(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith('https://')) return false;
  if (/placeholder/i.test(trimmed)) return false;
  return /ingest\./i.test(trimmed);
}

function writeEmbeddedSentryDsn({ dest = DEFAULT_DEST, env = process.env, log = console.log } = {}) {
  const dsn = String((env && (env.ELECTRON_SENTRY_DSN || env.SENTRY_DSN)) || '').trim();
  if (!isUsableDsn(dsn)) {
    log('[sentry] ELECTRON_SENTRY_DSN unset — packaged booth will not report crashes');
    return { written: false };
  }
  const body = `'use strict';\n// Generated at pack time. Do not commit a real DSN.\nmodule.exports = ${JSON.stringify(dsn)};\n`;
  fs.writeFileSync(dest, body);
  log('[sentry] wrote pack-time DSN for tally-booth (value not printed)');
  return { written: true };
}

if (require.main === module) {
  writeEmbeddedSentryDsn();
}

module.exports = { writeEmbeddedSentryDsn, isUsableDsn };
