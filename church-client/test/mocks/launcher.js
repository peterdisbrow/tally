#!/usr/bin/env node
/**
 * Boots every mock device server in this directory on its default port and
 * keeps them alive until SIGINT/SIGTERM. Each mock also exposes a control
 * API on a sequential port starting at CONTROL_BASE (default 9100) so tests
 * and dev sessions can manipulate state without speaking the device protocol.
 *
 * Usage:
 *   npm run mocks                       # all mocks, default ports
 *   MOCKS=companion,propresenter \      # subset
 *     node test/mocks/launcher.js
 *   PORT_companion=8001 npm run mocks   # override individual device port
 *
 * Each mock prints `[mock-<name>] device=<url>  control=<url>` on startup
 * so tests can scrape ports from stdout when needed.
 */

'use strict';

const path = require('node:path');

// `defaultPort` is the documented real-world port for that device. Where two
// real devices clash on the same port (Resolume + BirdDog both default to
// 8080 in production), we move the less common one to a free port in the
// launcher and document the override; tests can pin either via PORT_<name>
// or pass `port: 0` for ephemeral allocation.
const REGISTRY = [
  { name: 'companion',       file: 'companionServer.js',       defaultPort: 8000 },
  { name: 'propresenter',    file: 'propresenterServer.js',    defaultPort: 1025 },
  { name: 'videohub',        file: 'videohubServer.js',        defaultPort: 9990 },
  { name: 'obs',             file: 'obsServer.js',             defaultPort: 4455 },
  { name: 'atem',            file: 'atemServer.js',            defaultPort: 9910 },
  { name: 'tricaster',       file: 'tricasterServer.js',       defaultPort: 5951 },
  { name: 'birddog',         file: 'birddogServer.js',         defaultPort: 8081 }, // real default 8080 — moved to avoid Resolume collision
  { name: 'teradek',         file: 'teradekServer.js',         defaultPort: 8082 }, // real default 80 — moved (privileged port)
  { name: 'resolume',        file: 'resolumeServer.js',        defaultPort: 8080 },
  { name: 'sq',              file: 'sqMixerServer.js',         defaultPort: 51325 }, // also opens 51326 for OSC
  { name: 'planning-center', file: 'planningCenterServer.js',  defaultPort: 8083 },
];

async function main() {
  const enabled = process.env.MOCKS
    ? process.env.MOCKS.split(',').map((s) => s.trim()).filter(Boolean)
    : REGISTRY.map((m) => m.name);

  const controlBase = Number(process.env.CONTROL_BASE) || 9100;
  let controlOffset = 0;
  const running = [];

  for (const entry of REGISTRY) {
    if (!enabled.includes(entry.name)) continue;
    const mod = require(path.join(__dirname, entry.file));
    const port = Number(process.env[`PORT_${entry.name}`]) || entry.defaultPort;
    const controlPort = controlBase + controlOffset++;
    try {
      const handle = await mod.start({ port, controlPort });
      console.log(`[mock-${entry.name}] device=${handle.url}  control=${handle.control.url}`);
      running.push(handle);
    } catch (err) {
      console.error(`[mock-${entry.name}] failed to start on port ${port}: ${err.message}`);
    }
  }

  if (!running.length) {
    console.error('No mocks started — check MOCKS env or port conflicts.');
    process.exit(1);
  }

  console.log(`\n${running.length} mock(s) running. Ctrl-C to stop.`);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[launcher] received ${signal}, stopping ${running.length} mock(s)…`);
    await Promise.allSettled(running.map((h) => h.stop()));
    console.log('[launcher] stopped.');
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { REGISTRY };
