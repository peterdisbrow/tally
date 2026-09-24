/**
 * Mock OBS WebSocket v5 server (default port 4455) — protocol-faithful subset.
 *
 * Fidelity (checked against obs-websocket 5.x protocol.md):
 *   - Hello (op 0) → Identify (op 1) → Identified (op 2). When a password is
 *     set, Hello carries authentication { challenge, salt } and Identify must
 *     carry base64(sha256(base64(sha256(password + salt)) + challenge)).
 *     Wrong/missing auth → close 4009 "Authentication failed." (real OBS).
 *     rpcVersion > 1 → close 4010 UnsupportedRpcVersion.
 *     Request before Identify → close 4007 NotIdentified.
 *   - RequestResponse (op 7) requestStatus codes: 100 ok, 204 UnknownRequestType,
 *     300 MissingRequestField, 500 OutputRunning, 501 OutputNotRunning,
 *     506 StudioModeNotActive, 600 ResourceNotFound.
 *   - Events (op 5): StreamStateChanged / RecordStateChanged go STARTING
 *     (outputActive:false) → STARTED (true) and STOPPING → STOPPED like real
 *     OBS; CurrentProgramSceneChanged / CurrentPreviewSceneChanged; ExitStarted
 *     on graceful quit.
 *   - GetStats / GetStreamStatus carry the full v5 field set; outputBytes grows
 *     while streaming so bitrate math is exercised.
 *
 * More forgiving than real OBS (documented, not hidden):
 *   - Only the requests Tally uses are modeled; others return 204 like real
 *     OBS would for an unknown type, NOT a fake success.
 *   - No RequestBatch (op 8) / Reidentify (op 3) semantics.
 *   - Output start is instant (real OBS takes ~0.5–3 s to reach STARTED and
 *     can fail with an encoder/network error).
 *
 * Control API (tests / `npm run mocks`):
 *   setStreaming {active} · setRecording {active} · setProgramScene {scene}
 *   setPreviewScene {scene} · setScenes [..] · setStats {..} · setPassword {password}
 *   crash  → abrupt TCP drop of every client (OBS crash / cable pull)
 *   quit   → ExitStarted event then close 1001 (operator quits OBS)
 *   stop() → terminates clients AND the listener (process gone)
 */

'use strict';

const crypto = require('node:crypto');
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
  streaming: {
    outputActive: false, outputReconnecting: false, outputTimecode: '00:00:00.000',
    outputDuration: 0, outputCongestion: 0, outputBytes: 0, outputSkippedFrames: 0, outputTotalFrames: 0,
  },
  recording: { outputActive: false, outputPaused: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputBytes: 0 },
  studioMode: true,
  streamKbps: 4500,
  stats: {
    cpuUsage: 5.2, memoryUsage: 512.3, availableDiskSpace: 102400, activeFps: 60,
    averageFrameRenderTime: 1.2, renderSkippedFrames: 0, renderTotalFrames: 1000,
    outputSkippedFrames: 0, outputTotalFrames: 1000,
    webSocketSessionIncomingMessages: 0, webSocketSessionOutgoingMessages: 0,
  },
  password: '',
  connections: 0,
  authFailures: 0,
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

function makeError(requestType, requestId, code, comment) {
  return { op: 7, d: { requestType, requestId, requestStatus: { result: false, code, comment } } };
}

// ── Mutation modes (red-proof) ────────────────────────────────────────────
// OBS_MOCK_BREAK=<mode> deliberately makes this mock sloppy in ONE way, the way
// a canned auto-responder would be. The sim tests must go red under every mode;
// that is how we prove they test Tally against a device that can say no.
//   accept-any-password  auth always succeeds
//   no-hello             never sends Hello (handshake never completes)
//   no-events            never emits events (state changes invisible)
//   crash-keeps-socket   'crash'/'stop' leave client sockets open
//   always-ok            every request succeeds, even unknown scenes
const BREAK = String(process.env.OBS_MOCK_BREAK || '');

function handleRequest(state, requestType, requestId, requestData, emit = () => {}) {
  if (BREAK === 'always-ok') return makeResponse(state, requestType, requestId, {});
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
      return makeResponse(state, requestType, requestId, { ...state.stats });
    case 'GetStreamStatus':
      return makeResponse(state, requestType, requestId, streamStatus(state));
    case 'GetRecordStatus':
      return makeResponse(state, requestType, requestId, { ...state.recording });
    case 'GetSceneList':
      return makeResponse(state, requestType, requestId, {
        currentProgramSceneName: state.programScene,
        currentPreviewSceneName: state.studioMode ? state.previewScene : null,
        // Real obs-websocket returns scenes bottom-up: array[0] is the bottom
        // of the OBS scene list (sceneIndex 0). state.scenes is top-down.
        scenes: [...state.scenes].reverse().map((name, i) => ({ sceneName: name, sceneIndex: i, sceneUuid: `mock-${name}` })),
      });
    case 'GetCurrentProgramScene':
      return makeResponse(state, requestType, requestId, { currentProgramSceneName: state.programScene, sceneName: state.programScene });
    case 'GetCurrentPreviewScene':
      if (!state.studioMode) return makeError(requestType, requestId, 506, 'Studio mode is not enabled.');
      return makeResponse(state, requestType, requestId, { currentPreviewSceneName: state.previewScene, sceneName: state.previewScene });
    case 'SetCurrentProgramScene': {
      const name = requestData?.sceneName;
      if (!name) return makeError(requestType, requestId, 300, 'Your request is missing the `sceneName` field.');
      if (!state.scenes.includes(name)) return makeError(requestType, requestId, 600, `No source was found by the name of \`${name}\`.`);
      if (state.programScene !== name) { state.programScene = name; emit('CurrentProgramSceneChanged', { sceneName: name }); }
      return makeResponse(state, requestType, requestId, undefined);
    }
    case 'SetCurrentPreviewScene': {
      if (!state.studioMode) return makeError(requestType, requestId, 506, 'Studio mode is not enabled.');
      const name = requestData?.sceneName;
      if (!name) return makeError(requestType, requestId, 300, 'Your request is missing the `sceneName` field.');
      if (!state.scenes.includes(name)) return makeError(requestType, requestId, 600, `No source was found by the name of \`${name}\`.`);
      if (state.previewScene !== name) { state.previewScene = name; emit('CurrentPreviewSceneChanged', { sceneName: name }); }
      return makeResponse(state, requestType, requestId, undefined);
    }
    case 'GetStudioModeEnabled':
      return makeResponse(state, requestType, requestId, { studioModeEnabled: state.studioMode });
    case 'StartStream':
      if (state.streaming.outputActive) return makeError(requestType, requestId, 500, 'The stream output is already running.');
      setOutput(state, 'streaming', true, emit);
      return makeResponse(state, requestType, requestId, undefined);
    case 'StopStream':
      if (!state.streaming.outputActive) return makeError(requestType, requestId, 501, 'The stream output is not running.');
      setOutput(state, 'streaming', false, emit);
      return makeResponse(state, requestType, requestId, undefined);
    case 'StartRecord':
      if (state.recording.outputActive) return makeError(requestType, requestId, 500, 'The record output is already running.');
      setOutput(state, 'recording', true, emit);
      return makeResponse(state, requestType, requestId, undefined);
    case 'StopRecord':
      if (!state.recording.outputActive) return makeError(requestType, requestId, 501, 'The record output is not running.');
      setOutput(state, 'recording', false, emit);
      return makeResponse(state, requestType, requestId, { outputPath: '/tmp/mock-recording.mkv' });
    case 'PauseRecord':
      if (!state.recording.outputActive) return makeError(requestType, requestId, 501, 'The record output is not running.');
      state.recording.outputPaused = true;
      return makeResponse(state, requestType, requestId, undefined);
    case 'ResumeRecord':
      if (!state.recording.outputActive) return makeError(requestType, requestId, 501, 'The record output is not running.');
      state.recording.outputPaused = false;
      return makeResponse(state, requestType, requestId, undefined);
    default:
      // Real OBS: unknown request type → 204, never a fake success.
      return makeError(requestType, requestId, 204, 'Your request type is not valid.');
  }
}

function streamStatus(state) {
  const s = state.streaming;
  if (s.outputActive && s._startedAt) {
    const secs = (Date.now() - s._startedAt) / 1000;
    s.outputDuration = Math.round(secs * 1000);
    s.outputBytes = Math.round(secs * (state.streamKbps * 1000 / 8));
    s.outputTotalFrames = Math.round(secs * state.stats.activeFps);
  }
  const { _startedAt, ...pub } = s;
  return pub;
}

// Real OBS emits STARTING (outputActive:false) then STARTED (true); STOPPING then STOPPED.
function setOutput(state, key, active, emit) {
  const ev = key === 'streaming' ? 'StreamStateChanged' : 'RecordStateChanged';
  const out = state[key];
  if (out.outputActive === active) return;
  emit(ev, { outputActive: !active ? true : false, outputState: active ? 'OBS_WEBSOCKET_OUTPUT_STARTING' : 'OBS_WEBSOCKET_OUTPUT_STOPPING' });
  out.outputActive = active;
  if (key === 'streaming') {
    out._startedAt = active ? Date.now() : null;
    if (!active) { out.outputBytes = 0; out.outputDuration = 0; }
  }
  const data = { outputActive: active, outputState: active ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED' };
  if (key === 'recording' && !active) data.outputPath = '/tmp/mock-recording.mkv';
  emit(ev, data);
}

function authString(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

async function start({ port = 4455, controlPort = 0, password = '' } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));
  state.password = password || '';

  if (!WebSocketServer) {
    throw new Error('mock OBS server requires `ws` package (transitive via obs-websocket-js)');
  }

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    // obs-websocket-js (CommonJS) offers obswebsocket.msgpack; real OBS speaks
    // both msgpack and json, so we do too.
    handleProtocols: (offered) => {
      for (const p of SUPPORTED_PROTOCOLS) if (offered.has(p)) return p;
      return SUPPORTED_PROTOCOLS[0];
    },
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  const actualPort = wss.address().port;

  // Identified clients only (real OBS never sends events before Identified).
  const clients = new Set();
  const allSockets = new Set();
  const encodeFor = (c, obj) => ((c.protocol === 'obswebsocket.msgpack' && !!msgpackEncode)
    ? Buffer.from(msgpackEncode(obj)) : JSON.stringify(obj));
  const broadcastEvent = (eventType, eventData) => {
    if (BREAK === 'no-events') return;
    const frame = { op: 5, d: { eventType, eventIntent: 0, eventData } };
    for (const c of clients) { try { c.send(encodeFor(c, frame)); } catch { /* closing */ } }
  };

  wss.on('connection', (socket) => {
    state.connections++;
    allSockets.add(socket);
    const send = (obj) => { try { socket.send(encodeFor(socket, obj)); } catch { /* closed */ } };
    const decode = (raw) => {
      if (socket.protocol === 'obswebsocket.msgpack' && msgpackDecode) {
        try { return msgpackDecode(raw); } catch { return null; }
      }
      try { return JSON.parse(raw.toString()); } catch { return null; }
    };
    let identified = false;
    socket.on('close', () => { clients.delete(socket); allSockets.delete(socket); });
    socket.on('error', () => {});

    const hello = { obsWebSocketVersion: state.obsWebSocketVersion, rpcVersion: 1 };
    let challenge = null, salt = null;
    if (state.password) {
      challenge = crypto.randomBytes(32).toString('base64');
      salt = crypto.randomBytes(32).toString('base64');
      hello.authentication = { challenge, salt };
    }
    if (BREAK !== 'no-hello') send({ op: 0, d: hello });

    socket.on('message', (raw) => {
      const msg = decode(raw);
      if (!msg || typeof msg.op !== 'number') return;
      state.stats.webSocketSessionIncomingMessages++;

      if (msg.op === 1) {
        if (identified) return; // real OBS ignores a second Identify (use Reidentify)
        const d = msg.d || {};
        if (typeof d.rpcVersion === 'number' && d.rpcVersion > 1) {
          socket.close(4010, 'Your requested RPC version is not supported by this server.');
          return;
        }
        if (state.password && BREAK !== 'accept-any-password') {
          const expected = authString(state.password, salt, challenge);
          if (!d.authentication || d.authentication !== expected) {
            state.authFailures++;
            socket.close(4009, 'Authentication failed.');
            return;
          }
        }
        send({ op: 2, d: { negotiatedRpcVersion: 1 } });
        state.lastIdentifiedAt = Date.now();
        identified = true;
        clients.add(socket);
        return;
      }
      if (!identified) {
        socket.close(4007, 'The session has not been identified.');
        return;
      }
      if (msg.op === 6) {
        const { requestType, requestId, requestData } = msg.d || {};
        send(handleRequest(state, requestType, requestId, requestData, broadcastEvent));
        return;
      }
      // Reidentify (3) / RequestBatch (8): not modeled.
    });
  });

  const dropAll = () => { if (BREAK === 'crash-keeps-socket') return; for (const s of allSockets) { try { s.terminate(); } catch { /* */ } } };

  const control = await createControlServer({
    device: 'obs',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setStreaming: ({ active }) => setOutput(state, 'streaming', !!active, broadcastEvent),
      setRecording: ({ active }) => setOutput(state, 'recording', !!active, broadcastEvent),
      setProgramScene: ({ scene }) => {
        if (scene && state.programScene !== scene) { state.programScene = scene; broadcastEvent('CurrentProgramSceneChanged', { sceneName: scene }); }
      },
      setPreviewScene: ({ scene }) => {
        if (scene && state.previewScene !== scene) { state.previewScene = scene; broadcastEvent('CurrentPreviewSceneChanged', { sceneName: scene }); }
      },
      setScenes: (scenes) => { if (Array.isArray(scenes)) state.scenes = scenes; },
      setStats: (stats) => { Object.assign(state.stats, stats || {}); },
      setPassword: ({ password: pw }) => { state.password = pw || ''; },
      // OBS crash / network cable pull: sockets die without a close frame.
      crash: () => { dropAll(); return { dropped: true }; },
      // Operator quits OBS: ExitStarted, then a normal close (1001 going away).
      quit: () => {
        broadcastEvent('ExitStarted', {});
        for (const s of allSockets) { try { s.close(1001, 'OBS is shutting down'); } catch { /* */ } }
        return { quit: true };
      },
    },
  });

  return {
    device: 'obs',
    port: actualPort,
    url: `ws://127.0.0.1:${actualPort}`,
    control,
    state,
    crash: dropAll,
    stop: async () => {
      // ws.Server.close() does NOT close open sockets — terminate them so a
      // stopped mock really looks like a dead OBS to the client.
      dropAll();
      await new Promise((r) => wss.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 4455, controlPort: Number(process.env.CONTROL_PORT) || 0, password: process.env.OBS_PASSWORD || '' })
    .then((s) => console.log(`[mock-obs] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
