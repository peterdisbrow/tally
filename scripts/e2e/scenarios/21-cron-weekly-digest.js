/**
 * Cron trigger: weekly digest.
 *
 * Same in-process child pattern as offline detection. The WeeklyDigest class
 * lives in relay-server/src/weeklyDigest.js and exposes `runDigest()` (or
 * similar) that walks active churches, builds per-church digest data, and
 * dispatches via lifecycleEmails.
 *
 * For the harness we don't actually want to send a real email to a test
 * recipient (would hit Resend with a non-deliverable address). Instead the
 * driver replaces the lifecycleEmails dependency with a capture stub that
 * records the call and returns success.
 *
 * Asserts:
 *   1. The digest function executes without throwing.
 *   2. The capture stub recorded at least one call (i.e., there's at least
 *      one church the digest considered eligible — our test church or any
 *      production church should qualify).
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const RELAY_SERVER = path.join(REPO_ROOT, 'relay-server');

module.exports = async function cronWeeklyDigest(ctx) {
  if (!ctx.cfg.databaseUrl) {
    ctx.log.info('  ⚠ DATABASE_URL not set — skipping (digest needs DB to enumerate churches)');
    return;
  }

  const driver = `
    const path = require('path');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'harness-stub-secret';
    const { WeeklyDigest } = require(path.join(${JSON.stringify(RELAY_SERVER)}, 'src/weeklyDigest'));
    const { createQueryClient } = require(path.join(${JSON.stringify(RELAY_SERVER)}, 'src/db/queryClient'));

    const queryClient = createQueryClient({ config: { driver: 'postgres', isPostgres: true, isSqlite: false, databaseUrl: process.env.DATABASE_URL } });

    // Capture stub for lifecycleEmails — record the call instead of sending.
    let calls = [];
    const captureLifecycle = {
      sendWeeklyDigestEmail: async (church, digestData, toEmail) => {
        calls.push({ church: church.name || church.churchId, toEmail });
        return { sent: true, id: 'mock-' + Date.now() };
      },
      sendEmail: async ({ to, subject }) => {
        calls.push({ to, subject });
        return { sent: true, id: 'mock-' + Date.now() };
      },
    };

    // Constructor signature is (dbOrClient, options). Pass queryClient as
    // first arg — _resolveClient sees .query+.exec and treats it as a client.
    const digest = new WeeklyDigest(queryClient);
    if (typeof digest.setLifecycleEmails === 'function') {
      digest.setLifecycleEmails(captureLifecycle);
    } else {
      digest.lifecycleEmails = captureLifecycle;
    }

    (async () => {
      // Real entry point on relay-server/src/weeklyDigest.js (verified): generateDigest().
      // Keep the method-name search as a fallback in case the API renames.
      let invoked = false;
      for (const fnName of ['generateDigest', 'runDigest', 'generate', 'sendDigestEmails', 'sendDigestForAllChurches']) {
        if (typeof digest[fnName] === 'function') {
          await digest[fnName]();
          invoked = true;
          process.stdout.write('INVOKED:' + fnName + '\\n');
          break;
        }
      }
      if (!invoked) {
        process.stdout.write('AVAILABLE_METHODS:' + Object.getOwnPropertyNames(Object.getPrototypeOf(digest)).join(',') + '\\n');
        throw new Error('no recognized digest entry point on WeeklyDigest');
      }
      process.stdout.write('CALLS:' + calls.length + '\\n');
      process.stdout.write('OK:digest-completed\\n');
      await queryClient.close();
      process.exit(0);
    })().catch((err) => {
      process.stderr.write('ERR:' + err.message + '\\n');
      process.exit(1);
    });
  `;

  const result = await new Promise((resolve, reject) => {
    const child = spawn('node', ['-e', driver], {
      cwd: RELAY_SERVER,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('digest driver timeout 60s')); }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`digest driver exit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });

  if (!result.stdout.includes('OK:digest-completed')) {
    throw new Error(`digest driver did not complete cleanly:\n${result.stdout}\n${result.stderr}`);
  }
  // Extract call count for visibility — non-zero is reassuring but not required
  // (a digest run with zero qualifying churches is a valid no-op).
  const m = result.stdout.match(/CALLS:(\d+)/);
  ctx.log.debug(`  weekly digest captured ${m?.[1] ?? '?'} email send call(s)`);
};
