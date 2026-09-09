'use strict';

/**
 * electron-builder hook: bake ELECTRON_SENTRY_DSN into the asar before pack.
 */

const { writeEmbeddedSentryDsn } = require('./write-embedded-sentry-dsn');

module.exports = async function beforePack() {
  writeEmbeddedSentryDsn();
};
