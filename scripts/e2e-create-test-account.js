#!/usr/bin/env node
/**
 * Idempotent test-account provisioner for the E2E harness.
 *
 * Default behavior: ensures a single labeled test church exists in the
 * production Neon DB and prints its credentials (churchId, email, password,
 * tokens, roomId). Re-running picks up the existing church + room rather than
 * creating duplicates.
 *
 * Test data is labeled with E2E_TEST_PREFIX (default 'test-e2e-') so it's
 * obvious in any admin query. The harness cleans up at the end of a run, but
 * if a run dies mid-flight, you can purge orphans with:
 *
 *   node scripts/e2e-create-test-account.js --cleanup
 *
 * Required env: ADMIN_API_KEY (for /api/churches/* admin endpoints).
 * Optional env: RELAY_URL (defaults to https://api.tallyconnect.app).
 */

'use strict';

const { loadConfig } = require('./e2e/lib/config');
const { makeLogger } = require('./e2e/lib/log');
const { apiAdmin, apiBearer } = require('./e2e/lib/api');
const { createTestChurch, deleteTestChurch, loginAsExisting, createRoom } = require('./e2e/lib/auth');

const ACCOUNT_NAME = 'TallyConnect Test Church';
// Stable email/password so re-runs find the same account. Using `+e2e` so
// any real Resend dispatch can be filtered or routed by Andrew.
function accountEmail(prefix) { return `${prefix}harness@harness.test`; }
const ACCOUNT_PASSWORD = 'E2E-Harness-Pw-1!';
const ROOM_NAME = 'E2E Studio';

async function findExistingChurchByName(cfg, name) {
  const admin = apiAdmin(cfg.relayUrl, cfg.adminApiKey);
  try {
    const { body } = await admin.get('/api/churches');
    const list = Array.isArray(body) ? body : (body.churches || []);
    return list.find((c) => c.name === name) || null;
  } catch (err) {
    // /api/churches may 404 on some routes; fall back to silent null so the
    // create path runs.
    return null;
  }
}

async function findRoomByName(cfg, appToken, name) {
  const bearer = apiBearer(cfg.relayUrl, appToken);
  try {
    const { body } = await bearer.get('/api/church/app/rooms');
    const list = Array.isArray(body) ? body : (body.rooms || []);
    return list.find((r) => r.name === name) || null;
  } catch {
    return null;
  }
}

async function ensureAccount(cfg, log) {
  const email = accountEmail(cfg.testPrefix);
  const password = ACCOUNT_PASSWORD;

  // First try: see if the church already exists. If so, just log in for fresh tokens.
  const existing = await findExistingChurchByName(cfg, ACCOUNT_NAME);
  let church;
  if (existing) {
    log.info(`Found existing test church (churchId=${existing.churchId}); logging in for fresh tokens…`);
    const appToken = await loginAsExisting(cfg, { email, password });
    if (!appToken) {
      throw new Error(`Existing church found but login failed — email/password mismatch? (${email})`);
    }
    // wsToken is on the church row but admin GET may not include it. Re-issue
    // by calling register with billingStatus 'active' is risky (might reset
    // billing); instead pull from admin /api/churches/:id which includes token.
    const admin = apiAdmin(cfg.relayUrl, cfg.adminApiKey);
    const { body: detail } = await admin.get(`/api/churches/${encodeURIComponent(existing.churchId)}`);
    if (!detail.token) {
      throw new Error(`Could not retrieve WS token for existing church (admin endpoint omitted it)`);
    }
    church = {
      churchId: existing.churchId,
      name: existing.name,
      email,
      password,
      wsToken: detail.token,
      appToken,
    };
  } else {
    log.info(`Creating new test church "${ACCOUNT_NAME}"…`);
    church = await createTestChurch(cfg, { name: ACCOUNT_NAME, email, password, tier: 'pro' });
  }

  // Ensure the test room exists.
  let roomId = null;
  const existingRoom = await findRoomByName(cfg, church.appToken, ROOM_NAME);
  if (existingRoom) {
    roomId = existingRoom.id || existingRoom.roomId;
    log.info(`Using existing room (roomId=${roomId})`);
  } else {
    roomId = await createRoom(cfg, church.appToken, { name: ROOM_NAME });
    log.info(`Created room (roomId=${roomId})`);
  }
  church.roomId = roomId;

  return church;
}

async function cleanupAccount(cfg, log) {
  const existing = await findExistingChurchByName(cfg, ACCOUNT_NAME);
  if (!existing) {
    log.info(`No test church to clean up.`);
    return;
  }
  log.info(`Deleting test church (churchId=${existing.churchId})…`);
  await deleteTestChurch(cfg, existing.churchId);
  log.info(`Deleted.`);
}

async function main() {
  const args = process.argv.slice(2);
  const cleanup = args.includes('--cleanup') || args.includes('--purge');
  const cfg = loadConfig();
  const log = makeLogger(cfg.logLevel, 'create-test-account');

  if (cleanup) {
    await cleanupAccount(cfg, log);
    return;
  }

  const account = await ensureAccount(cfg, log);

  // Print credentials in a copy/pasteable block so Andrew can stash them.
  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log('TallyConnect E2E Test Account');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Account name : ${account.name}`);
  console.log(`  churchId     : ${account.churchId}`);
  console.log(`  email        : ${account.email}`);
  console.log(`  password     : ${account.password}`);
  console.log(`  roomId       : ${account.roomId}`);
  console.log(`  WS token     : ${account.wsToken.slice(0, 20)}…${account.wsToken.slice(-8)}`);
  console.log(`  App token    : ${account.appToken.slice(0, 20)}…${account.appToken.slice(-8)}`);
  console.log('════════════════════════════════════════════════════════');
  console.log('  Stash full tokens with:');
  console.log(`    E2E_WS_TOKEN='${account.wsToken}'`);
  console.log(`    E2E_APP_TOKEN='${account.appToken}'`);
  console.log('════════════════════════════════════════════════════════');
  console.log('');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[create-test-account] FAILED: ${err.message}`);
    if (process.env.E2E_LOG_LEVEL === 'debug') console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { ensureAccount, cleanupAccount, ACCOUNT_NAME, ROOM_NAME };
