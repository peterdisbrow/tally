'use strict';
/**
 * RTMP Ingest — accepts encoder streams from Tally Encoder devices
 *
 * Uses node-media-server to run an RTMP server on port 1935.
 * Stream key format: {CHURCH_TOKEN}
 *
 * On connect:  validates token → marks church.encoderActive = true
 * On data:     emits 'frame' events for dashboard preview
 * On disconnect: clears encoderActive flag
 *
 * @module rtmpIngest
 * @exports setupRtmpIngest
 */

const NodeMediaServer = require('node-media-server');
const { EventEmitter } = require('events');

// ── Emitter for downstream consumers (dashboard preview frames, etc.) ─────────
const rtmpEvents = new EventEmitter();
rtmpEvents.setMaxListeners(50);

// ── In-memory stream metadata ─────────────────────────────────────────────────
// churchId → { startedAt, bytesReceived, lastFrameAt }
const streamMeta = new Map();

/**
 * Set up the RTMP ingest server.
 *
 * @param {import('better-sqlite3').Database} db       - SQLite database
 * @param {Map<string, object>}               churches - In-memory church runtime map
 * @param {function(string): void}            notifyUpdate - Call to push SSE update for a churchId
 * @returns {{ rtmpEvents: EventEmitter, getStreamMeta: function }}
 */
function setupRtmpIngest(db, churches, notifyUpdate) {
  const RTMP_PORT = parseInt(process.env.RTMP_PORT || '1935', 10);
  const HTTP_PORT = parseInt(process.env.RTMP_HTTP_PORT || '8888', 10);

  // Prepared statement: look up church by token
  const stmtFindByToken = db.prepare('SELECT * FROM churches WHERE token = ?');

  // ── NMS config ─────────────────────────────────────────────────────────────
  const nmsConfig = {
    rtmp: {
      port:  RTMP_PORT,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
    http: {
      port: HTTP_PORT,
      allow_origin: '*',
      mediaroot: '/tmp/tally-media',
    },
    logType: process.env.NODE_ENV === 'development' ? 1 : 0,
  };

  const nms = new NodeMediaServer(nmsConfig);

  // ── Pre-connect: validate stream key ───────────────────────────────────────
  nms.on('preConnect', (id, args) => {
    // args.app is the app name (e.g. "live"), args.stream is the stream key
    console.log(`[RTMP] Pre-connect id=${id}`, args);
  });

  // ── Pre-publish: validate church token ────────────────────────────────────
  nms.on('prePublish', (id, StreamPath, args) => {
    // StreamPath = "/live/<token>"
    const streamKey = extractStreamKey(StreamPath);
    if (!streamKey) {
      console.warn(`[RTMP] Rejected: no stream key in path ${StreamPath}`);
      const session = nms.getSession(id);
      if (session) session.reject();
      return;
    }

    const church = stmtFindByToken.get(streamKey);
    if (!church) {
      console.warn(`[RTMP] Rejected: unknown token for stream key ${streamKey}`);
      const session = nms.getSession(id);
      if (session) session.reject();
      return;
    }

    console.log(`[RTMP] Auth OK: church="${church.name}" (${church.churchId})`);
    // Store mapping for postPublish
    storeSessionChurch(id, church);
  });

  // ── Post-publish: stream is live ──────────────────────────────────────────
  nms.on('postPublish', (id, StreamPath, args) => {
    const church = getSessionChurch(id);
    if (!church) return;

    const churchId = church.churchId;
    console.log(`[RTMP] Stream LIVE: church="${church.name}" id=${id} path=${StreamPath}`);

    // Update runtime state
    const runtime = churches.get(churchId);
    if (runtime) {
      runtime.encoderActive = true;
      runtime.encoderStreamPath = StreamPath;
      runtime.encoderSessionId  = id;
      runtime.encoderStartedAt  = new Date().toISOString();
    }

    streamMeta.set(churchId, {
      churchId,
      sessionId:    id,
      streamPath:   StreamPath,
      startedAt:    new Date().toISOString(),
      bytesReceived: 0,
      lastFrameAt:  null,
    });

    rtmpEvents.emit('streamStart', { churchId, churchName: church.name, StreamPath });
    notifyUpdate(churchId);
  });

  // ── Done-publish: stream ended ────────────────────────────────────────────
  nms.on('donePublish', (id, StreamPath, args) => {
    const church = getSessionChurch(id);
    if (!church) {
      // Try to find by session ID in meta
      for (const [cId, meta] of streamMeta.entries()) {
        if (meta.sessionId === id) {
          handleStreamEnd(cId, StreamPath, id);
          break;
        }
      }
      return;
    }
    handleStreamEnd(church.churchId, StreamPath, id);
    clearSessionChurch(id);
  });

  function handleStreamEnd(churchId, StreamPath, sessionId) {
    console.log(`[RTMP] Stream ENDED: churchId=${churchId} path=${StreamPath}`);

    const runtime = churches.get(churchId);
    if (runtime) {
      runtime.encoderActive = false;
      runtime.encoderStreamPath = null;
      runtime.encoderSessionId  = null;
      runtime.encoderEndedAt    = new Date().toISOString();
    }

    streamMeta.delete(churchId);
    rtmpEvents.emit('streamEnd', { churchId, StreamPath });
    notifyUpdate(churchId);
  }

  // ── Post-play: viewer connected (for preview relay, future use) ───────────
  nms.on('postPlay', (id, StreamPath, args) => {
    console.log(`[RTMP] Viewer connected: path=${StreamPath}`);
  });

  // ── donePlay ──────────────────────────────────────────────────────────────
  nms.on('donePlay', (id, StreamPath, args) => {
    console.log(`[RTMP] Viewer disconnected: path=${StreamPath}`);
  });

  // ── Run the server ────────────────────────────────────────────────────────
  nms.run();
  console.log(`[RTMP] Ingest server listening on port ${RTMP_PORT}`);
  console.log(`[RTMP] HTTP preview server on port ${HTTP_PORT}`);

  // ── Session → church mapping helpers ─────────────────────────────────────
  const sessionMap = new Map(); // sessionId → church row

  function storeSessionChurch(sessionId, church) {
    sessionMap.set(sessionId, church);
  }

  function getSessionChurch(sessionId) {
    return sessionMap.get(sessionId) || null;
  }

  function clearSessionChurch(sessionId) {
    sessionMap.delete(sessionId);
  }

  // ── Helper: extract stream key from NMS StreamPath ────────────────────────
  // StreamPath = "/live/<streamKey>"
  function extractStreamKey(streamPath) {
    if (!streamPath) return null;
    const parts = streamPath.split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
  }

  // ── Public helper: get metadata for all active streams ────────────────────
  function getStreamMeta(churchId) {
    if (churchId) return streamMeta.get(churchId) || null;
    return Object.fromEntries(streamMeta);
  }

  return { rtmpEvents, getStreamMeta, nms };
}

module.exports = { setupRtmpIngest, rtmpEvents };
