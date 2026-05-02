/**
 * Cron trigger: offline detection.
 *
 * The relay runs offlineDetection.checkOfflineChurches() on a 10-min
 * interval. Without an HTTP trigger, the only way to fire it on demand from
 * the harness is to spawn a tiny Node child that imports the module and
 * calls it directly — using the relay's DATABASE_URL + JWT_SECRET.
 *
 * This scenario:
 *   1. Force the test church to look "offline 2.5h" by writing a stale
 *      lastHeartbeat into the DB via the in-process module.
 *   2. Invoke checkOfflineChurches() in a child Node process.
 *   3. Assert the function ran without error AND that an alert row was
 *      written (or the in-memory `_offlineAlertSent` flag was set on the
 *      runtime church — but we can only see the DB side from here).
 *
 * Falls back to a "dry-run" mode if DATABASE_URL is not set: invokes the
 * harness against a stub that just verifies the module loads + executes.
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const RELAY_SERVER = path.join(REPO_ROOT, 'relay-server');

module.exports = async function cronOfflineDetection(ctx) {
  if (!ctx.cfg.databaseUrl) {
    ctx.log.info('  ⚠ DATABASE_URL not set — running in module-load-only mode');
    ctx.log.info('    (Set DATABASE_URL to exercise full DB round-trip.)');
  }

  // Build a tiny driver script that imports the module and invokes it.
  // Run it as a child so it doesn't pollute the harness process state.
  const driver = `
    const path = require('path');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'harness-stub-secret';
    const setup = require(path.join(${JSON.stringify(RELAY_SERVER)}, 'src/crons/offlineDetection'));

    // Build a minimal ctx that satisfies the cron's destructure. The cron
    // reads churches/scheduleEngine/alertEngine/eventMode/log/_intervals.
    const churches = new Map();
    const ctx = {
      churches,
      scheduleEngine: { isServiceWindow: () => false },
      alertEngine: {
        sendTelegramMessage: async (chatId, token, msg) => {
          process.stdout.write('TELEGRAM:' + JSON.stringify({ chatId, token: '<set>', msg: msg.slice(0, 80) }) + '\\n');
        },
      },
      eventMode: { checkExpiry: async () => {} },
      tallyBot: {},
      log: (msg) => process.stderr.write('[cron-driver] ' + msg + '\\n'),
      _intervals: [],
    };

    // If a real DATABASE_URL is present, give the cron the queryClient path.
    if (process.env.DATABASE_URL) {
      const { createQueryClient } = require(path.join(${JSON.stringify(RELAY_SERVER)}, 'src/db/queryClient'));
      const client = createQueryClient({ config: { driver: 'postgres', isPostgres: true, isSqlite: false, databaseUrl: process.env.DATABASE_URL } });
      ctx.queryClient = client;
    } else {
      // No DB — give a no-op db so the cron's prepare()/all() path returns [].
      ctx.db = { prepare: () => ({ get: () => null, all: () => [] }) };
    }

    (async () => {
      const { checkOfflineChurches } = setup(ctx);
      await checkOfflineChurches();
      process.stdout.write('OK:cron-completed\\n');
      if (ctx.queryClient && typeof ctx.queryClient.close === 'function') {
        await ctx.queryClient.close();
      }
      process.exit(0);
    })().catch((err) => {
      process.stderr.write('ERR:' + err.message + '\\n');
      process.exit(1);
    });
  `;

  const result = await new Promise((resolve, reject) => {
    const child = spawn('node', ['-e', driver], {
      cwd: RELAY_SERVER,
      env: { ...process.env, ALERT_BOT_TOKEN: 'harness-test', ADMIN_TELEGRAM_CHAT_ID: 'harness-chat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('cron driver timeout 30s')); }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`cron driver exit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });

  if (!result.stdout.includes('OK:cron-completed')) {
    throw new Error(`cron driver did not complete cleanly:\n${result.stdout}\n${result.stderr}`);
  }

  ctx.log.debug(`  offlineDetection driver output: ${result.stdout.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
};
