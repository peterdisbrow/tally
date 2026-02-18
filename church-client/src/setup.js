#!/usr/bin/env node
/**
 * Tally Interactive Setup Wizard
 * Run: npx tally-connect setup
 *
 * Walks a church TD through first-time configuration:
 *   1. Token entry + validation
 *   2. ATEM IP (manual or auto-scan)
 *   3. Software detection (OBS / vMix)
 *   4. Optional: Companion, ProPresenter, audio console
 *   5. Save config + test connection
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const net = require('net');
const dgram = require('dgram');
const { encryptConfig } = require('./secureStorage');

const CONFIG_PATH = path.join(os.homedir(), '.church-av', 'config.json');
const CONFIG_DIR = path.dirname(CONFIG_PATH);

// ─── TERMINAL HELPERS ─────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function print(msg = '') { process.stdout.write(msg + '\n'); }
function printGray(msg) { print(`${C.gray}${msg}${C.reset}`); }
function printGreen(msg) { print(`${C.green}${msg}${C.reset}`); }
function printYellow(msg) { print(`${C.yellow}${msg}${C.reset}`); }
function printRed(msg) { print(`${C.red}${msg}${C.reset}`); }
function printBold(msg) { print(`${C.bold}${msg}${C.reset}`); }
function printCyan(msg) { print(`${C.cyan}${msg}${C.reset}`); }

function ask(question, defaultVal = '') {
  return new Promise((resolve) => {
    const prompt = defaultVal
      ? `${question} ${C.gray}[${defaultVal}]${C.reset} `
      : `${question} `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function askPassword(question) {
  return new Promise((resolve) => {
    process.stdout.write(question + ' ');
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let pw = '';
    const handler = (char) => {
      char = char.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(pw);
      } else if (char === '\u0003') {
        process.exit();
      } else if (char === '\u007f') {
        if (pw.length > 0) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        pw += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', handler);
  });
}

function askYesNo(question, defaultYes = true) {
  return ask(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'}`)
    .then(ans => {
      if (!ans) return defaultYes;
      return ans.toLowerCase().startsWith('y');
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── NETWORK UTILITIES ────────────────────────────────────────────────────────

function tryTcp(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.connect(port, host, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function tryHttp(url, timeoutMs = 3000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const text = await resp.text().catch(() => '');
    return { ok: resp.ok, text };
  } catch {
    return { ok: false, text: '' };
  }
}

function getLocalSubnet() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  return '192.168.1';
}

async function scanForATEM(onProgress) {
  const subnet = getLocalSubnet();
  const found = [];
  const ATEM_PORT = 9910;
  const BATCH = 30;
  const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);

  for (let i = 0; i < hosts.length; i += BATCH) {
    const batch = hosts.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(h => tryTcp(h, ATEM_PORT, 800).then(ok => ({ host: h, ok }))));
    for (const r of results) {
      if (r.ok) found.push(r.host);
    }
    onProgress(Math.round((i / hosts.length) * 100));
  }
  return found;
}

// ─── STEP HELPERS ─────────────────────────────────────────────────────────────

async function stepBanner() {
  print();
  print(`${C.bold}${C.cyan}╔═══════════════════════════════════════════╗${C.reset}`);
  print(`${C.bold}${C.cyan}║       Tally by ATEM School — Setup        ║${C.reset}`);
  print(`${C.bold}${C.cyan}╚═══════════════════════════════════════════╝${C.reset}`);
  print();
  printGray('This wizard will configure Tally on this computer.');
  printGray('It takes about 5 minutes. You can re-run it anytime.');
  print();
}

async function stepToken(config) {
  printBold('Step 1 of 5 — Connection Token');
  print();
  printGray('Your token was emailed when you signed up.');
  printGray('It looks like: eyJhbGci...');
  print();

  if (config.token) {
    printGreen(`✓ Token already set (${config.token.slice(0, 20)}...)`);
    const change = await askYesNo('Change it?', false);
    if (!change) return;
  }

  let token = '';
  while (!token) {
    token = await ask('Paste your token:');
    if (!token) printRed('Token is required. Get it from tally.atemschool.com');
  }
  config.token = token;
  printGreen('✓ Token saved');
}

async function stepSystemName(config) {
  print();
  printBold('Step 2 of 5 — System Name');
  printGray('Give this installation a name. Shows up in alerts and the dashboard.');
  printGray('Examples: "Main Sanctuary", "Chapel", "Overflow Room"');
  print();
  config.name = await ask('System name:', config.name || 'Main Sanctuary');
  printGreen(`✓ Named: ${config.name}`);
}

async function stepATEM(config) {
  print();
  printBold('Step 3 of 5 — ATEM Switcher');
  print();

  if (config.atemIp) {
    process.stdout.write(`  Checking existing IP (${config.atemIp})... `);
    const ok = await tryTcp(config.atemIp, 9910, 2000);
    if (ok) {
      printGreen('reachable ✓');
      const change = await askYesNo('Change ATEM IP?', false);
      if (!change) return;
    } else {
      printYellow('not reachable');
    }
  }

  print();
  const method = await ask('How to find your ATEM? (1) Enter IP manually  (2) Auto-scan network', '1');

  if (method === '2') {
    print();
    print('Scanning network for ATEM switchers...');
    let lastPct = -1;
    const found = await scanForATEM((pct) => {
      if (pct !== lastPct && pct % 10 === 0) {
        process.stdout.write(`\r  ${pct}%... `);
        lastPct = pct;
      }
    });
    print('\r              \r');

    if (found.length === 0) {
      printYellow('No ATEM switchers found on network.');
      printGray('Check that the ATEM is powered on and on the same network.');
      config.atemIp = await ask('Enter ATEM IP manually:', config.atemIp || '');
    } else if (found.length === 1) {
      printGreen(`Found ATEM at: ${found[0]}`);
      config.atemIp = found[0];
    } else {
      print('Multiple ATEM-compatible devices found:');
      found.forEach((ip, i) => print(`  ${i + 1}. ${ip}`));
      const choice = parseInt(await ask('Enter number:', '1')) - 1;
      config.atemIp = found[Math.max(0, Math.min(found.length - 1, choice))];
    }
  } else {
    config.atemIp = await ask('ATEM IP address:', config.atemIp || '192.168.1.10');
  }

  if (config.atemIp) {
    process.stdout.write(`  Testing connection to ${config.atemIp}... `);
    const ok = await tryTcp(config.atemIp, 9910, 3000);
    ok ? printGreen('✓ Connected') : printYellow('⚠ Not reachable — check the IP after setup');
  }
}

async function stepStreamingSoftware(config) {
  print();
  printBold('Step 4 of 5 — Streaming Software');
  print();

  // Detect OBS
  process.stdout.write('  Checking for OBS Studio (localhost:4455)... ');
  const obsOk = await tryTcp('localhost', 4455, 1500);
  obsOk ? printGreen('found ✓') : printGray('not detected');

  // Detect vMix
  process.stdout.write('  Checking for vMix (localhost:8088)... ');
  const vmixResp = await tryHttp('http://localhost:8088/api/?Function=GetShortXML', 2000);
  const vmixOk = vmixResp.ok;
  vmixOk ? printGreen('found ✓') : printGray('not detected');

  print();

  if (obsOk && !vmixOk) {
    printGreen('Using OBS Studio (auto-detected)');
    config.obsUrl = config.obsUrl || 'ws://localhost:4455';
    const needsPass = await askYesNo('Does OBS have a WebSocket password set?', false);
    if (needsPass) {
      config.obsPassword = await askPassword('OBS WebSocket password:');
    }
  } else if (vmixOk && !obsOk) {
    printGreen('Using vMix (auto-detected)');
    config.vmix = { host: 'localhost', port: 8088 };
  } else if (obsOk && vmixOk) {
    const choice = await ask('Both OBS and vMix detected. Use which? (1) OBS  (2) vMix', '2');
    if (choice === '2') {
      config.vmix = { host: 'localhost', port: 8088 };
    } else {
      config.obsUrl = config.obsUrl || 'ws://localhost:4455';
    }
  } else {
    print('Neither OBS nor vMix detected. Options:');
    print('  1. OBS Studio (free, cross-platform)');
    print('  2. vMix (paid, Windows only — recommended for volunteers)');
    print('  3. Skip for now');
    const choice = await ask('Choice:', '1');
    if (choice === '1') {
      config.obsUrl = await ask('OBS WebSocket URL:', 'ws://localhost:4455');
    } else if (choice === '2') {
      const vmixHost = await ask('vMix computer IP:', 'localhost');
      config.vmix = { host: vmixHost, port: 8088 };
    }
  }
}

async function stepOptional(config) {
  print();
  printBold('Step 5 of 5 — Optional Devices');
  printGray('These can be configured later in the Equipment tab.');
  print();

  // Detect Companion
  process.stdout.write('  Checking for Bitfocus Companion (localhost:8888)... ');
  const companionOk = await tryTcp('localhost', 8888, 1500);
  if (companionOk) {
    printGreen('found ✓');
    config.companionUrl = config.companionUrl || 'http://localhost:8888';
    printGreen('  → Companion auto-configured');
  } else {
    print(C.gray + 'not found' + C.reset);
    const addCompanion = await askYesNo('Configure Companion manually?', false);
    if (addCompanion) {
      config.companionUrl = await ask('Companion URL:', 'http://localhost:8888');
    }
  }

  // ProPresenter
  process.stdout.write('  Checking for ProPresenter (localhost:1025)... ');
  const ppOk = await tryHttp('http://localhost:1025/v1/version', 2000);
  if (ppOk.ok) {
    printGreen('found ✓');
    config.proPresenter = { host: 'localhost', port: 1025 };
    printGreen('  → ProPresenter auto-configured');
  } else {
    printGray('not found');
  }

  // Audio console
  print();
  const hasConsole = await askYesNo('Do you have a digital audio console? (Behringer, Allen & Heath, Yamaha, Midas)', false);
  if (hasConsole) {
    print('Console type:');
    print('  1. Behringer X32 / X-Air');
    print('  2. Midas M32 / M32R');
    print('  3. Allen & Heath SQ / dLive');
    print('  4. Yamaha CL / QL / TF');
    const type = await ask('Choice:', '1');
    const types = ['behringer', 'midas', 'allenheath', 'yamaha'];
    const defaultPorts = [10023, 10023, 51326, 8765];
    const idx = Math.max(0, Math.min(3, parseInt(type) - 1));
    const consoleType = types[idx];
    const consoleIp = await ask('Console IP address:');
    if (consoleIp) {
      config.mixer = { type: consoleType, host: consoleIp, port: defaultPorts[idx] };
      printGreen(`✓ ${consoleType} console configured at ${consoleIp}`);
    }
  }

  // Resolume
  process.stdout.write('  Checking for Resolume Arena (localhost:8080)... ');
  const resolumeResp = await tryHttp('http://localhost:8080/api/v1/product', 2000);
  if (resolumeResp.ok) {
    printGreen('found ✓');
    config.resolume = { host: 'localhost', port: 8080 };
    printGreen('  → Resolume auto-configured');
  } else {
    printGray('not found');
  }
}

async function stepSave(config) {
  print();
  printBold('Saving configuration...');

  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const toSave = encryptConfig(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));

  printGreen(`✓ Config saved to ${CONFIG_PATH}`);
  print();
  printBold('Setup complete! 🎉');
  print();
  print('To start Tally:');
  printCyan('  npx tally-connect');
  print();
  printGray('The tray icon shows connection status:');
  printGray('  🟢 Green  = all systems connected');
  printGray('  🟡 Yellow = relay connected, ATEM not found');
  printGray('  ⚫ Grey   = not connected');
  printGray('  🔴 Red    = issue detected');
  print();
  printGray('For help: support@atemschool.com | tally.atemschool.com/docs');
  print();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function runSetup() {
  await stepBanner();

  // Load existing config if present
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const { decryptConfig } = require('./secureStorage');
      config = decryptConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
      printGray(`Existing config found at ${CONFIG_PATH}`);
      print();
    } catch { config = {}; }
  }

  try {
    await stepToken(config);
    await stepSystemName(config);
    await stepATEM(config);
    await stepStreamingSoftware(config);
    await stepOptional(config);
    await stepSave(config);
  } catch (err) {
    if (err.code === 'ERR_USE_AFTER_CLOSE') {
      // User hit Ctrl+C
      print();
      printYellow('Setup cancelled. Run again anytime: npx tally-connect setup');
    } else {
      printRed(`Setup error: ${err.message}`);
    }
  } finally {
    rl.close();
    process.exit(0);
  }
}

module.exports = { runSetup };

// Run if called directly
if (require.main === module) runSetup();
