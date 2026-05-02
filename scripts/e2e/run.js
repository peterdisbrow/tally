#!/usr/bin/env node
/**
 * E2E Test Harness — main orchestrator.
 *
 * Single command (from repo root): `npm run test:e2e`.
 *
 * What this script does, in order:
 *   1. Load env (RELAY_URL, ADMIN_API_KEY, optional DATABASE_URL).
 *   2. Ensure the labeled test church + room exist (idempotent — re-uses).
 *   3. Boot all 11 mocks via the church-client launcher subprocess.
 *   4. Spawn the church-client agent as a subprocess pointed at the test
 *      account + the mocks.
 *   5. Subscribe to /api/church/app/status/stream (SSE) for the test church.
 *   6. Run scenarios:
 *        - 7 service-sequence scenarios (PP, OBS, VideoHub, Companion,
 *          ATEM, Teradek, SQ)
 *        - 11 recovery scenarios (one per device — kill + reconnect)
 *        - 3 cron / automation scenarios (offline detection, weekly digest,
 *          stream protection)
 *        - 1 AI engineer fault diagnostic
 *   7. Print pass/fail summary table.
 *   8. Tear down: stop agent, stop mocks, optionally delete test church
 *      (skip with E2E_KEEP_ACCOUNT=1 for post-mortem debugging).
 *   9. Exit non-zero if any scenario failed.
 */

'use strict';

const { loadConfig } = require('./lib/config');
const { makeLogger } = require('./lib/log');
const { apiAdmin, apiBearer } = require('./lib/api');
const { ScenarioRunner } = require('./lib/scenarios');
const { MockLauncher } = require('./lib/spawnMocks');
const { AgentRunner } = require('./lib/spawnAgent');
const { MockControl } = require('./lib/mockControl');
const { StatusStream } = require('./lib/sse');
const { ensureAccount, cleanupAccount } = require('../e2e-create-test-account');

const SERVICE_SCENARIOS = [
  { name: 'A. ProPresenter slide advance',   fn: require('./scenarios/01-propresenter-slide') },
  { name: 'B. OBS goes live',                 fn: require('./scenarios/02-obs-streaming') },
  { name: 'C. VideoHub route change',         fn: require('./scenarios/03-videohub-routing') },
  { name: 'D. Companion press dispatched',    fn: require('./scenarios/04-companion-press') },
  { name: 'E. ATEM disconnect + recovery',    fn: require('./scenarios/05-atem-disconnect-recovery') },
  { name: 'F. Teradek battery alert',         fn: require('./scenarios/06-teradek-battery-alert') },
  { name: 'G. SQ channel rename',             fn: require('./scenarios/07-sq-channel-rename') },
];

const buildRecoverySuite     = require('./scenarios/10-recovery-all-mocks');
const cronOfflineDetection   = require('./scenarios/20-cron-offline-detection');
const cronWeeklyDigest       = require('./scenarios/21-cron-weekly-digest');
const streamProtection       = require('./scenarios/22-stream-protection');
const aiEngineer             = require('./scenarios/30-ai-engineer');

async function main() {
  const cfg = loadConfig();
  const log = makeLogger(cfg.logLevel, 'e2e');

  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info('TallyConnect E2E Harness');
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info(`Relay        : ${cfg.relayUrl}`);
  log.info(`Database     : ${cfg.databaseUrl ? 'configured' : 'not set (cron tests will run module-load-only)'}`);
  log.info(`Test prefix  : ${cfg.testPrefix}`);
  log.info(`Keep account : ${cfg.keepAccount ? 'yes (debug mode)' : 'no'}`);
  log.info('');

  // 1. Account
  log.info('Phase 1: ensure test account exists');
  const account = await ensureAccount(cfg, log.child('account'));
  log.info(`  ✓ churchId=${account.churchId}  roomId=${account.roomId}`);

  // 2. Mocks
  log.info('Phase 2: boot mocks');
  const mocksLauncher = new MockLauncher({ log: log.child('mocks') });
  await mocksLauncher.start();
  // Brief settle so all listening sockets are fully bound before the agent
  // starts probing. The launcher reports "ready" as soon as every mock's
  // start() resolves, but TCP listeners can need an extra tick to accept
  // connections — without this, agent bridges sometimes hit ECONNREFUSED
  // on their FIRST probe and then enter retry-with-backoff (PP retries
  // every 30s, which is too slow for the harness budget).
  await new Promise((r) => setTimeout(r, 1_500));
  log.info('  ✓ all 11 mocks running');
  const mocks = new MockControl();

  // 3. Agent
  log.info('Phase 3: spawn church-client agent');
  const agent = new AgentRunner({
    log: log.child('agent'),
    relayUrl: cfg.relayUrl,
    wsToken: account.wsToken,
    churchName: account.name,
    roomId: account.roomId,
  });
  await agent.start();
  await agent.waitConnected({ timeoutMs: 30_000 });
  log.info('  ✓ agent connected to relay');

  // 4. SSE — subscribe AND seed from REST. The relay's SSE only pushes
  // deltas after subscribe, so if a bridge connected before our subscriber
  // joined, that "connected:true" field never appears as a delta. Seeding
  // from /api/church/app/me gives us authoritative current state.
  log.info('Phase 4: subscribe to status SSE + start REST poll');
  const sse = new StatusStream({ url: cfg.relayUrl, token: account.appToken, log: log.child('sse') });
  await sse.connect({ timeoutMs: 15_000 });
  // The relay's SSE channel only pushes the initial snapshot + sporadic
  // deltas. Bridges that connect AFTER subscribe never trigger a republish.
  // Background REST poll keeps `sse.latest` aligned with the authoritative
  // /api/church/app/me state throughout the run.
  sse.startPolling({ intervalMs: 1_000 });

  // 4b. Wait for the agent's bridges to actually connect, polling REST
  // until the critical-bridge predicate holds (or 45s elapses). The poll
  // overlays REST snapshots into `sse.latest` so SSE deltas continue to
  // merge naturally on top during the rest of the run.
  //
  // 45s is calibrated to PP's retry interval (30s) — if PP fails its
  // first connection attempt (e.g. mock not fully bound when agent
  // probes), it retries at +30s. Anything shorter than ~35s loses to
  // the retry race when mocks are sluggish to bind.
  log.info('Phase 4b: wait for agent bridges to connect');
  const bridgeDeadline = Date.now() + 45_000;
  let bridgesReady = false;
  while (Date.now() < bridgeDeadline) {
    await sse.refresh();
    const s = sse.latest || {};
    if (s.companion?.connected === true
        && s.proPresenter?.connected === true
        && s.obs?.connected === true
        && Array.isArray(s.videoHubs) && s.videoHubs.some((h) => h?.connected === true)
        && s.mixer?.connected === true) {
      bridgesReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  if (bridgesReady) {
    log.info('  ✓ all critical bridges connected (companion, PP, OBS, VideoHub, mixer)');
  } else {
    const s = sse.latest || {};
    const status = {
      companion: s.companion?.connected,
      proPresenter: s.proPresenter?.connected,
      obs: s.obs?.connected,
      videoHubs: s.videoHubs?.[0]?.connected,
      mixer: s.mixer?.connected,
    };
    log.info(`  ⚠ Not all bridges connected within 45s: ${JSON.stringify(status)} — proceeding anyway`);
    log.info(`    (Likely cause: relay-side stale status cache. The agent connects to the`);
    log.info(`     bridges locally but the relay's church.status doesn't update after the`);
    log.info(`     initial WS push. Worth a separate investigation in relay-server.)`);
  }

  // 5. Build harness context for scenarios.
  const ctx = {
    cfg,
    log,
    account,
    mocks,
    sse,
    admin: apiAdmin(cfg.relayUrl, cfg.adminApiKey),
    bearer: apiBearer(cfg.relayUrl, account.appToken),
    mocksLauncher,
  };
  // Recovery scenarios need to restart the launcher so attach it to mocks
  // namespace too.
  ctx.mocks.restartWithout = mocksLauncher.restartWithout.bind(mocksLauncher);
  ctx.mocks.waitReady = ctx.mocks.waitReady.bind(ctx.mocks);

  // 6. Run scenarios.
  log.info('');
  log.info('Phase 5: run scenarios');
  log.info('');
  const runner = new ScenarioRunner({ log });

  log.info('── Service sequence ──');
  for (const s of SERVICE_SCENARIOS) {
    await runner.run(s.name, s.fn, ctx);
  }

  log.info('');
  log.info('── Recovery (kill + reconnect, per device) ──');
  for (const s of buildRecoverySuite()) {
    await runner.run(s.name, s.fn, ctx);
  }

  log.info('');
  log.info('── Automation / cron ──');
  await runner.run('Cron: offline detection', cronOfflineDetection, ctx);
  await runner.run('Cron: weekly digest',     cronWeeklyDigest,     ctx);
  await runner.run('Cron: stream protection', streamProtection,     ctx);

  log.info('');
  log.info('── AI engineer ──');
  await runner.run('AI: fault diagnostic',    aiEngineer,           ctx);

  // 7. Summary
  const failed = runner.summary();

  // 8. Teardown
  log.info('');
  log.info('Phase 6: teardown');
  sse.close();
  await agent.stop();
  await mocksLauncher.stop();
  if (!cfg.keepAccount) {
    await cleanupAccount(cfg, log.child('account'));
  } else {
    log.info(`  E2E_KEEP_ACCOUNT=1 — leaving test church in place (churchId=${account.churchId})`);
  }
  log.info('  ✓ teardown complete');

  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('E2E HARNESS FATAL ERROR');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(err.message);
    if (process.env.E2E_LOG_LEVEL === 'debug') console.error(err.stack);
    console.error('');
    console.error('NOTE: A fatal error before scenarios run leaves resources allocated.');
    console.error('  - Test church may need manual cleanup: node scripts/e2e-create-test-account.js --cleanup');
    console.error('  - Mock processes may need manual kill: pkill -f "test/mocks/launcher.js"');
    process.exit(1);
  });
}
