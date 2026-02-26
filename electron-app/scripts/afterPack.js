/**
 * afterPack.js — electron-builder hook that runs after the app is packed
 * but before code-signing and DMG creation.
 *
 * Problem: The root .gitignore excludes node_modules/, so electron-builder
 * doesn't copy church-client/node_modules into the extraResources bundle.
 *
 * Fix: Run `npm ci --omit=dev` inside the bundled church-client directory
 * so the agent process has its dependencies at runtime.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  const appDir = context.appOutDir;

  // macOS:  Foo.app/Contents/Resources/church-client
  // Windows: resources/church-client
  const isMac = process.platform === 'darwin';
  const resourceBase = isMac
    ? path.join(appDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appDir, 'resources');

  const churchClient = path.join(resourceBase, 'church-client');

  if (!fs.existsSync(path.join(churchClient, 'package.json'))) {
    console.log('[afterPack] church-client not found in resources — skipping npm install');
    return;
  }

  const nodeModules = path.join(churchClient, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    console.log('[afterPack] church-client/node_modules already present — skipping');
    return;
  }

  console.log('[afterPack] Installing church-client dependencies...');
  execSync('npm ci --omit=dev', {
    cwd: churchClient,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  console.log('[afterPack] church-client dependencies installed ✅');
};
