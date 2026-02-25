#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function hasAny(keys) {
  return keys.some((k) => String(process.env[k] || '').trim().length > 0);
}

function checkFile(root, relativePath) {
  const target = path.join(root, relativePath);
  return fs.existsSync(target);
}

function printResult(ok, label, details = '') {
  const prefix = ok ? 'PASS' : 'FAIL';
  const suffix = details ? ` - ${details}` : '';
  console.log(`${prefix}: ${label}${suffix}`);
}

function main() {
  const root = path.resolve(__dirname, '..');
  let failures = 0;

  const files = [
    'assets/icon.icns',
    'assets/icon.ico',
    'assets/entitlements.mac.plist',
  ];

  for (const file of files) {
    const ok = checkFile(root, file);
    printResult(ok, `required file ${file}`);
    if (!ok) failures++;
  }

  const macSignConfigured = hasAny(['CSC_LINK', 'CSC_NAME']);
  printResult(
    macSignConfigured,
    'macOS signing identity env (CSC_LINK or CSC_NAME)',
    macSignConfigured ? '' : 'set CSC_LINK/CSC_KEY_PASSWORD (or CSC_NAME)'
  );
  if (!macSignConfigured) failures++;

  const macNotarizeConfigured = hasAny(['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'])
    || hasAny(['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']);
  printResult(
    macNotarizeConfigured,
    'macOS notarization env',
    macNotarizeConfigured ? '' : 'set APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or API key triple'
  );
  if (!macNotarizeConfigured) failures++;

  const winSignConfigured = hasAny(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_LINK']);
  printResult(
    winSignConfigured,
    'Windows signing env',
    winSignConfigured ? '' : 'set WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD (or CSC_LINK)'
  );
  if (!winSignConfigured) failures++;

  if (failures > 0) {
    console.error(`\nRelease readiness check failed: ${failures} item(s) missing.`);
    process.exit(1);
  }

  console.log('\nRelease readiness check passed.');
}

main();
