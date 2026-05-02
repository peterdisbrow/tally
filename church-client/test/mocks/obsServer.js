/**
 * Mock OBS WebSocket v5 server (port 4455) — STUB IMPLEMENTATION.
 *
 * Implements the v5 Hello/Identify auth handshake and a small subset of
 * canned responses for the most common requests the church-client makes
 * (GetVersion, GetStats, GetStreamStatus, GetRecordStatus, GetSceneList,
 * GetCurrentProgramScene, GetStudioModeEnabled). Anything not in the canned
 * map is echoed back with a generic success envelope so request/response
 * patterns won't crash the bridge.
 *
 * Limitations:
 *   - Auth is accepted unconditionally (no real challenge/response check).
 *   - State is not authoritative — SetCurrentProgramScene updates the cached
 *     value but does not emit SceneChanged events.
 *   - WebSocket framing uses Node's experimental `ws` from devDeps if present,
 *     and falls back to a TCP-accept stub if not — see comment in `start()`.
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setStreaming", args: { active: true } }
 *   POST /action { action: "setProgramScene", args: { scene: "Scene 1" } }
 *   POST /action { action: "setScenes", args: ["Scene 1", "Scene 2"] }
 */

'use strict';

const { createControlServer } = require('./_lib/control');

// `ws` is a transitive dependency of obs-websocket-js, which church-client
// already pins, so it should always be resolvable from the workspace.
let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch {
  WebSocketServer = null;
}

// obs-websocket-js v5 ships two transports: `obswebsocket.json` (text frames,
// JSON.stringify) and `obswebsocket.msgpack` (binary frames, MessagePack
// encoding). The CommonJS default export resolves to the msgpack variant via
// the package's `exports` map (`require → ./dist/msgpack.cjs`), so the
// church-client agent connects with subprotocol `obswebsocket.msgpack`. If
// the mock only spoke JSON, the server would still negotiate "msgpack" via
// ws's default subprotocol echoing — then every Identify/Request frame would
// arrive as a binary msgpack buffer, JSON.parse would silently throw, and
// the agent's `await obs.connect()` would hang forever waiting for an
// Identified that never comes. Real OBS speaks both, so we do too.
let msgpackEncode = null;
let msgpackDecode = null;
try {
  ({ encode: msgpackEncode, decode: msgpackDecode } = require('@msgpack/msgpack'));
} catch {
  // @msgpack/msgpack is a transitive dep of obs-websocket-js, but if it's
  // ever missing the mock will simply refuse the msgpack subprotocol and
  // force the client onto JSON.
}

const SUPPORTED_PROTOCOLS = msgpackEncode
  ? ['obswebsocket.msgpack', 'obswebsocket.json']
  : ['obswebsocket.json'];

const DEFAULTS = {
  obsVersion: '30.0.0',
  obsWebSocketVersion: '5.4.0',
  programScene: 'Scene 1',
  previewScene: 'Scene 2',
  scenes: ['Scene 1', 'Scene 2', 'Scene 3'],
  streaming: { outputActive: false, outputDuration: 0, outputBytes: 0 },
  recording: { outputActive: false, outputPaused: false, outputTimecode: '00:00:00.000', outputBytes: 0 },
  studioMode: true,
  stats: { cpuUsage: 5.2, activeFps: 60, renderTotalFrames: 1000, outputSkippedFrames: 0 },
};

function makeResponse(state, requestType, requestId, data) {
  return {
    op: 7, // RequestResponse
    d: {
      requestType,
      requestId,
      requestStatus: { result: true, code: 100 },
      responseData: data,
    },
  };
}

function handleRequest(state, requestType, requestId, requestData) {
  switch (requestType) {
    case 'GetVersion':
      return makeResponse(state, requestType, requestId, {
        obsVersion: state.obsVersion,
        obsWebSocketVersion: state.obsWebSocketVersion,
        rpcVersion: 1,
        availableRequests: [],
        supportedImageFormats: ['png', 'jpg'],
        platform: 'mock',
        platformDescription: 'mock OBS',
      });
    case 'GetStats':
      return makeResponse(state, requestType, requestId, state.stats);
    case 'GetStreamStatus':
      return makeResponse(state, requestType, requestId, state.streaming);
    case 'GetRecordStatus':
      return makeResponse(state, requestType, requestId, state.recording);
    case 'GetSceneList':
      return makeResponse(state, requestType, requestId, {
        currentProgramSceneName: state.programScene,
        currentPreviewSceneName: state.previewScene,
        scenes: state.scenes.map((name, i) => ({ sceneName: name, sceneIndex: i })),
      });
    case 'GetCurrentProgramScene':
      return makeResponse(state, requestType, requestId, { currentProgramSceneName: state.programScene });
    case 'GetCurrentPreviewScene':
      return makeResponse(state, requestType, requestId, { currentPreviewSceneName: state.previewScene });
    case 'SetCurrentProgramScene': {
      const name = requestData?.sceneName;
      if (name) state.programScene = name;
      return makeResponse(state, requestType, requestId, {});
    }
    case 'SetCurrentPreviewScene': {
      const name = requestData?.sceneName;
      if (name) state.previewScene = name;
      return makeResponse(state, requestType, requestId, {});
    }
    case 'GetStudioModeEnabled':
      return makeResponse(state, requestType, requestId, { studioModeEnabled: state.studioMode });
    case 'StartStream':
      state.streaming.outputActive = true;
      return makeResponse(state, requestType, requestId, {});
    case 'StopStream':
      state.streaming.outputActive = false;
      return makeResponse(state, requestType, requestId, {});
    default:
      // Generic success envelope for anything unmodeled.
      return makeResponse(state, requestType, requestId, {});
  }
}

async function start({ port = 4455, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  if (!WebSocketServer) {
    throw new Error('mock OBS server requires `ws` package (transitive via obs-websocket-js)');
  }

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    // Pick the first subprotocol the client offers that we actually support,
    // preferring msgpack (which is the obs-websocket-js v5 default for
    // CommonJS consumers like the church-client agent). Returning `false`
    // would reject the connection — instead we fall through to JSON when
    // msgpack isn't available so a degraded client can still speak to us.
    handleProtocols: (offered) => {
      // ws v8 passes `offered` as a Set (not an Array). Use .has() to test.
      for (const p of SUPPORTED_PROTOCOLS) if (offered.has(p)) return p;
      return SUPPORTED_PROTOCOLS[0];
    },
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  const actualPort = wss.address().port;

  wss.on('connection', (socket) => {
    const isMsgpack = socket.protocol === 'obswebsocket.msgpack' && !!msgpackEncode;
    const send = (obj) => {
      if (isMsgpack) {
        // msgpackEncode returns Uint8Array — ws.send(buffer) sends a binary frame.
        socket.send(Buffer.from(msgpackEncode(obj)));
      } else {
        socket.send(JSON.stringify(obj));
      }
    };
    const decode = (raw) => {
      if (isMsgpack) {
        try { return msgpackDecode(raw); } catch { return null; }
      }
      try { return JSON.parse(raw.toString()); } catch { return null; }
    };

    // Track only AFTER the client identifies — broadcasting before Identify
    // confuses obs-websocket-js (it'll throw "Socket not identified").
    let identified = false;
    socket.on('close', () => clients.delete(socket));

    // Hello — initiate handshake (no auth challenge for simplicity).
    send({
      op: 0,
      d: { obsWebSocketVersion: state.obsWebSocketVersion, rpcVersion: 1 },
    });

    socket.on('message', (raw) => {
      const msg = decode(raw);
      if (!msg || typeof msg.op !== 'number') return;

      if (msg.op === 1) {
        // Identify → respond with Identified
        send({ op: 2, d: { negotiatedRpcVersion: 1 } });
        identified = true;
        clients.add(socket);
        return;
      }
      if (msg.op === 6) {
        // Request
        if (!identified) return; // protocol violation
        const { requestType, requestId, requestData } = msg.d || {};
        const response = handleRequest(state, requestType, requestId, requestData);
        send(response);
        return;
      }
      // Other ops (Reidentify=3, RequestBatch=8) — ignore for stub.
    });
  });

  // Track every connected client so control-API mutations can broadcast the
  // matching obs-websocket Event (op:5) to all of them. Real OBS does this:
  // SetStreaming → it pushes StreamStateChanged. The agent's bridge listens
  // for those events and updates `status.obs.streaming` immediately. Without
  // them, the agent only catches state changes via its 15s GetStats poll —
  // far too slow for a 10s scenario predicate.
  const clients = new Set();
  const broadcastEvent = (eventType, eventData) => {
    const frame = { op: 5, d: { eventType, eventIntent: 0, eventData } };
    for (const c of clients) {
      const isMsgpack = c.protocol === 'obswebsocket.msgpack' && !!msgpackEncode;
      try {
        c.send(isMsgpack ? Buffer.from(msgpackEncode(frame)) : JSON.stringify(frame));
      } catch { /* socket may have just closed */ }
    }
  };

  const control = await createControlServer({
    device: 'obs',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setStreaming: ({ active }) => {
        const next = !!active;
        if (state.streaming.outputActive === next) return;
        state.streaming.outputActive = next;
        broadcastEvent('StreamStateChanged', {
          outputActive: next,
          outputState: next ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED',
        });
      },
      setRecording: ({ active }) => {
        const next = !!active;
        if (state.recording.outputActive === next) return;
        state.recording.outputActive = next;
        broadcastEvent('RecordStateChanged', {
          outputActive: next,
          outputState: next ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED',
        });
      },
      setProgramScene: ({ scene }) => { state.programScene = scene; },
      setPreviewScene: ({ scene }) => { state.previewScene = scene; },
      setScenes: (scenes) => { if (Array.isArray(scenes)) state.scenes = scenes; },
      setStats: (stats) => { Object.assign(state.stats, stats || {}); },
    },
  });

  return {
    device: 'obs',
    port: actualPort,
    url: `ws://127.0.0.1:${actualPort}`,
    control,
    state,
    stop: async () => {
      await new Promise((r) => wss.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 4455, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-obs] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
