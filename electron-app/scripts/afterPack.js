/**
 * afterPack.js — electron-builder hook that runs after the app is packed
 * but before code-signing and DMG creation.
 *
 * Problem: The root .gitignore excludes node_modules/, so electron-builder
 * doesn't copy extraResources' node_modules into the bundle.
 *
 * Fix: Run `npm ci --omit=dev` inside each bundled extraResource directory
 * that has a package.json so dependencies are available at runtime.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function installDeps(resourceDir, label, targetArch, targetPlatform) {
  if (!fs.existsSync(path.join(resourceDir, 'package.json'))) {
    console.log(`[afterPack] ${label} not found in resources — skipping npm install`);
    return;
  }

  if (fs.existsSync(path.join(resourceDir, 'node_modules'))) {
    console.log(`[afterPack] ${label}/node_modules already present — skipping`);
    return;
  }

  console.log(`[afterPack] Installing ${label} dependencies for ${targetPlatform}-${targetArch}...`);
  execSync(`npm ci --omit=dev --cpu=${targetArch} --os=${targetPlatform}`, {
    cwd: resourceDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', npm_config_arch: targetArch, npm_config_platform: targetPlatform },
  });
  console.log(`[afterPack] ${label} dependencies installed`);
}

module.exports = async function afterPack(context) {
  const appDir = context.appOutDir;

  // macOS:  Foo.app/Contents/Resources/<resource>
  // Windows: resources/<resource>
  const isMac = process.platform === 'darwin';
  const resourceBase = isMac
    ? path.join(appDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appDir, 'resources');

  const targetArch = context.arch ? { 1: 'x64', 3: 'arm64' }[context.arch] || context.arch : process.arch;
  const targetPlatform = context.electronPlatformName || process.platform;

  installDeps(path.join(resourceBase, 'church-client'), 'church-client', targetArch, targetPlatform);
  installDeps(path.join(resourceBase, 'shared', 'network-scanner'), 'shared/network-scanner', targetArch, targetPlatform);
};
