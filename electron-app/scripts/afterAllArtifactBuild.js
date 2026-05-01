/**
 * afterAllArtifactBuild.js — electron-builder hook that submits each .dmg
 * artifact to Apple's notarization service and staples the resulting ticket.
 *
 * Why: electron-builder's `mac.notarize: true` only notarizes and staples
 * the .app bundle inside the DMG. The DMG container itself ships without a
 * staple, so Gatekeeper falls back to an online check on the embedded .app.
 * Offline machines (church staging boxes, conferences with bad wifi) hit
 * "Apple cannot verify…" warnings until they get internet. Stapling the DMG
 * resolves that by embedding the notarization ticket in the container.
 *
 * Skipped when CSC_IDENTITY_AUTO_DISCOVERY=false (intentional unsigned build)
 * or when the Apple notarization env vars are missing (warns but doesn't
 * fail — matches the dev-friendly behavior of release-readiness-check.js).
 * On any other failure, the hook throws so electron-builder marks the build
 * as failed rather than shipping unstapled DMGs silently.
 */

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

function notarizeAuthArgs() {
  // Two auth modes are supported, matching release-readiness-check.js.
  if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) {
    return [
      '--key', process.env.APPLE_API_KEY,
      '--key-id', process.env.APPLE_API_KEY_ID,
      '--issuer', process.env.APPLE_API_ISSUER,
    ];
  }
  if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) {
    return [
      '--apple-id', process.env.APPLE_ID,
      '--team-id', process.env.APPLE_TEAM_ID,
      '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
    ];
  }
  return null;
}

async function notarizeAndStaple(dmgPath) {
  const name = path.basename(dmgPath);
  const auth = notarizeAuthArgs();
  if (!auth) {
    throw new Error('Notarization auth env not set (APPLE_ID+APPLE_APP_SPECIFIC_PASSWORD+APPLE_TEAM_ID, or APPLE_API_KEY+APPLE_API_KEY_ID+APPLE_API_ISSUER)');
  }

  console.log(`[staple-dmg] Submitting ${name} to Apple notary…`);
  // Use spawnSync so the streamed "In Progress…" output goes to stderr/stdout
  // rather than buffering in memory for the whole multi-minute submission.
  const res = spawnSync('xcrun', ['notarytool', 'submit', dmgPath, ...auth, '--wait'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`notarytool submit exited ${res.status} for ${name}`);
  }
  // notarytool exits 0 even when the submission is Rejected, so check the
  // "status: Accepted" line explicitly. This is the only reliable success signal.
  const stdout = res.stdout || '';
  if (!/status:\s*Accepted/.test(stdout)) {
    console.error(`[staple-dmg] ${name} notary output:\n${stdout}`);
    throw new Error(`Notarization not Accepted for ${name}`);
  }

  console.log(`[staple-dmg] ${name} accepted; stapling…`);
  execFileSync('xcrun', ['stapler', 'staple', dmgPath], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', dmgPath], { stdio: 'inherit' });
  console.log(`[staple-dmg] ${name} stapled and validated.`);
}

module.exports = async function afterAllArtifactBuild(buildResult) {
  // Only relevant on macOS builds.
  if (process.platform !== 'darwin') return [];

  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('[staple-dmg] Code signing disabled (CSC_IDENTITY_AUTO_DISCOVERY=false); skipping DMG staple.');
    return [];
  }

  const auth = notarizeAuthArgs();
  if (!auth) {
    console.warn('[staple-dmg] Apple notarization env not set — skipping DMG staple. Set APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID to enable.');
    return [];
  }

  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) {
    console.log('[staple-dmg] No DMG artifacts to staple.');
    return [];
  }

  // Submit + staple in parallel — Apple's notary service handles concurrent
  // submissions, and this halves wall-clock time for arm64 + x64 builds.
  await Promise.all(dmgs.map(notarizeAndStaple));

  console.log(`[staple-dmg] All ${dmgs.length} DMG(s) stapled.`);
  // Return the (now-modified) DMG paths so electron-builder uploads the
  // stapled versions if a publisher is configured.
  return dmgs;
};
