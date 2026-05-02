/**
 * Mock ATEM UDP server (port 9910) — STUB IMPLEMENTATION ONLY.
 *
 * The Blackmagic ATEM control protocol is a proprietary stateful binary UDP
 * protocol with retransmission, sequencing, and a multi-thousand-line state
 * dictionary. Implementing it from scratch is a multi-day undertaking and
 * out of scope for the current mock-devices PR.
 *
 * This stub:
 *   - Opens a UDP socket on the requested port
 *   - Logs every datagram received (length + first 16 bytes hex)
 *   - Echoes back a minimal `Hello-Acked` style packet that satisfies the
 *     atem-connection library's initial SYN well enough to mark the socket
 *     as "reachable"
 *   - Does NOT implement state, command parsing, or any device control flow
 *
 * For positive-path ATEM testing, keep using the in-process simulator at
 * church-client/src/fakeAtem.js (gated by the _fakeAtemMode flag in
 * src/index.js). This stub exists so integration tests can verify
 * "ATEM unreachable" / connection-failure code paths without the test
 * machine needing real BMD hardware.
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setReachable", args: { reachable: false } }
 *     → start dropping all incoming packets to simulate a network blackhole
 */

'use strict';

const dgram = require('node:dgram');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  reachable: true,
  packetsReceived: 0,
  bytesReceived: 0,
  lastPacketAt: 0,
};

function ackPacket() {
  // 12-byte minimal ATEM "Hello answer" stand-in: command flag + length + sessionId.
  // Real ATEM packets are far more complex; this is enough to make a
  // half-open client retry instead of failing immediately.
  const buf = Buffer.alloc(12);
  buf[0] = 0x10; // ack flag
  buf[1] = 0x0C; // length lo
  buf[2] = 0x53; buf[3] = 0x00; // session id placeholder
  return buf;
}

async function start({ port = 9910, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, '127.0.0.1', () => resolve());
  });
  const actualPort = sock.address().port;

  sock.on('message', (msg, rinfo) => {
    state.packetsReceived += 1;
    state.bytesReceived += msg.length;
    state.lastPacketAt = Date.now();
    if (!state.reachable) return; // simulate blackhole
    // Reply with a minimal ack so the client doesn't hard-fail its first SYN.
    sock.send(ackPacket(), rinfo.port, rinfo.address);
  });

  const control = await createControlServer({
    device: 'atem',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setReachable: ({ reachable }) => { state.reachable = !!reachable; },
    },
  });

  return {
    device: 'atem',
    port: actualPort,
    url: `udp://127.0.0.1:${actualPort}`,
    control,
    state,
    stop: async () => {
      await new Promise((r) => sock.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 9910, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-atem] device=${s.url} (stub)  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
