/**
 * Mock VISCA-over-TCP PTZ camera (default port 5678).
 *
 * VISCA is a stateful binary serial protocol; every command frame ends with
 * 0xff. The church-client (src/ptz.js ViscaPtzCamera) opens a fresh TCP socket
 * for each command, writes the bytes, waits ~70ms for an ACK window, and
 * closes — so this mock only needs to accept connections, parse VISCA frames
 * out of the byte stream, and update its tracked state.
 *
 * Implemented commands (a useful subset; everything else is acked silently):
 *   - 81 01 06 01 PP TT DD EE ff   Pan/Tilt drive (PP/TT speed, DD/EE direction)
 *   - 81 01 06 04 ff               Pan/Tilt home
 *   - 81 01 04 07 CC ff            Zoom (CC encodes speed + direction)
 *   - 81 01 04 3f 02 PP ff         Recall preset PP
 *   - 81 01 04 3f 01 PP ff         Memorize preset PP
 *   - 81 01 04 38 02 ff            Auto focus
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setReachable", args: { reachable: false } }
 *     → start refusing TCP connections (simulate camera offline)
 *   POST /action { action: "setPosition", args: { pan, tilt, zoom } }
 */

'use strict';

const net = require('node:net');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  reachable: true,
  panSpeed: 0,         // -1 .. +1 (direction × normalised speed)
  tiltSpeed: 0,
  zoomSpeed: 0,
  lastPreset: null,    // last recalled preset number
  presets: {},         // { presetNumber: { stored: true } } for set-preset operations
  panTiltMoves: 0,
  zoomMoves: 0,
  presetRecalls: 0,
  presetStores: 0,
  homeCalls: 0,
  bytesReceived: 0,
  framesReceived: 0,
  log: [],             // last N { kind, ... } entries
};

const LOG_LIMIT = 50;

// Decode the byte that VISCA uses for pan direction (DD): 0x01=left, 0x02=right, 0x03=stop.
function panDirToNorm(dir, speed) {
  if (dir === 0x01) return -Math.abs(speed) / 0x18; // left
  if (dir === 0x02) return  Math.abs(speed) / 0x18; // right
  return 0;
}
function tiltDirToNorm(dir, speed) {
  if (dir === 0x01) return  Math.abs(speed) / 0x14; // up
  if (dir === 0x02) return -Math.abs(speed) / 0x14; // down
  return 0;
}
function zoomCmdToNorm(cc) {
  if (cc === 0x00) return 0;
  if ((cc & 0xF0) === 0x20) return  (cc & 0x0F) / 0x07; // tele
  if ((cc & 0xF0) === 0x30) return -(cc & 0x0F) / 0x07; // wide
  return 0;
}

function parseFrame(state, frame) {
  state.framesReceived += 1;
  // All church-client VISCA frames begin with 0x81 0x01.
  if (frame[0] !== 0x81 || frame[1] !== 0x01) {
    state.log.push({ kind: 'unknown', bytes: frame.toString('hex') });
    return;
  }
  // Pan/Tilt: 81 01 06 01 PP TT DD EE ff   (length 9)
  if (frame[2] === 0x06 && frame[3] === 0x01 && frame.length === 9) {
    const panSpeed = frame[4];
    const tiltSpeed = frame[5];
    const panDir = frame[6];
    const tiltDir = frame[7];
    state.panSpeed = panDirToNorm(panDir, panSpeed);
    state.tiltSpeed = tiltDirToNorm(tiltDir, tiltSpeed);
    state.panTiltMoves += 1;
    state.log.push({ kind: 'pan_tilt', panSpeed: state.panSpeed, tiltSpeed: state.tiltSpeed });
    return;
  }
  // Pan/Tilt home: 81 01 06 04 ff
  if (frame[2] === 0x06 && frame[3] === 0x04 && frame.length === 5) {
    state.panSpeed = 0;
    state.tiltSpeed = 0;
    state.homeCalls += 1;
    state.log.push({ kind: 'home' });
    return;
  }
  // Zoom: 81 01 04 07 CC ff   (length 6)
  if (frame[2] === 0x04 && frame[3] === 0x07 && frame.length === 6) {
    state.zoomSpeed = zoomCmdToNorm(frame[4]);
    state.zoomMoves += 1;
    state.log.push({ kind: 'zoom', zoomSpeed: state.zoomSpeed });
    return;
  }
  // Preset recall/memorize: 81 01 04 3f OP PP ff   (length 7)
  if (frame[2] === 0x04 && frame[3] === 0x3f && frame.length === 7) {
    const op = frame[4];
    const presetNumber = frame[5];
    if (op === 0x02) {
      state.lastPreset = presetNumber;
      state.presetRecalls += 1;
      state.log.push({ kind: 'preset_recall', preset: presetNumber });
      return;
    }
    if (op === 0x01) {
      state.presets[presetNumber] = { stored: true };
      state.presetStores += 1;
      state.log.push({ kind: 'preset_store', preset: presetNumber });
      return;
    }
  }
  // Auto/Manual focus toggles: 81 01 04 38 ?? ff  (length 6) — accept silently.
  if (frame[2] === 0x04 && frame[3] === 0x38) {
    state.log.push({ kind: 'focus', mode: frame[4] });
    return;
  }
  // Anything else — log as unknown but ack.
  state.log.push({ kind: 'unknown', bytes: frame.toString('hex') });
}

function trimLog(state) {
  while (state.log.length > LOG_LIMIT) state.log.shift();
}

async function start({ port = 5678, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  const server = net.createServer((socket) => {
    if (!state.reachable) {
      socket.destroy();
      return;
    }
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      state.bytesReceived += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      // Frames terminate with 0xff. Drain every complete frame from the buffer.
      let i = buffer.indexOf(0xff);
      while (i !== -1) {
        const frame = buffer.slice(0, i + 1);
        buffer = buffer.slice(i + 1);
        parseFrame(state, frame);
        trimLog(state);
        // Send a minimal VISCA Completion reply so the agent's 70ms ACK window
        // sees something on the wire. Real VISCA replies are 90 4? FF; this is
        // close enough for any client that just checks "did anything come back?"
        try { socket.write(Buffer.from([0x90, 0x41, 0xff, 0x90, 0x51, 0xff])); } catch { /* ignore */ }
        i = buffer.indexOf(0xff);
      }
    });
    socket.on('error', () => { /* per-connection errors are non-fatal */ });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  const control = await createControlServer({
    device: 'visca-ptz',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setReachable: ({ reachable }) => { state.reachable = !!reachable; },
      setPosition: ({ pan, tilt, zoom }) => {
        if (pan !== undefined) state.panSpeed = Number(pan);
        if (tilt !== undefined) state.tiltSpeed = Number(tilt);
        if (zoom !== undefined) state.zoomSpeed = Number(zoom);
      },
      clearLog: () => { state.log = []; },
    },
  });

  return {
    device: 'visca-ptz',
    port: actualPort,
    url: `tcp://127.0.0.1:${actualPort}`,
    control,
    state,
    stop: async () => {
      await new Promise((r) => server.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 5678, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-visca-ptz] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
