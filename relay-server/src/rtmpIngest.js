'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const NodeMediaServer = require('node-media-server');

const HLS_TEMP_DIR = process.env.HLS_TEMP_DIR || path.join(require('os').tmpdir(), 'tally-hls');
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const HTTP_PORT_INTERNAL = Number(process.env.RTMP_HTTP_PORT || 8888); // NMS internal HTTP (not exposed)

// Active streams: streamKey → { churchId, churchName, ffmpeg, startedAt }
const activeStreams = new Map();

let _db = null;
let _broadcastToSSE = null;
let _nms = null;

/**
 * Initialize the RTMP ingest server.
 * @param {object} db - better-sqlite3 database instance
 * @param {function} broadcastToSSE - function to broadcast events to admin SSE clients
 */
function initRtmpIngest(db, broadcastToSSE) {
  _db = db;
  _broadcastToSSE = broadcastToSSE;

  // Ensure HLS temp directory exists
  fs.mkdirSync(HLS_TEMP_DIR, { recursive: true });

  const config = {
    logType: 1, // 0=none, 1=error, 2=debug
    rtmp: {
      port: RTMP_PORT,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
    http: {
      port: HTTP_PORT_INTERNAL,
      allow_origin: '*',
      mediaroot: HLS_TEMP_DIR,
    },
  };

  _nms = new NodeMediaServer(config);

  // ─── Auth: validate stream key on publish ────────────────────────────────
  _nms.on('prePublish', (id, streamPath, args) => {
    // streamPath = /live/STREAM_KEY
    const parts = streamPath.split('/');
    const streamKey = parts[2];

    if (!streamKey) {
      console.log(`[RTMP] Rejected publish — no stream key in path: ${streamPath}`);
      const session = _nms.getSession(id);
      if (session) session.reject();
      return;
    }

    const church = _db.prepare(
      'SELECT churchId, name FROM churches WHERE ingest_stream_key = ?'
    ).get(streamKey);

    if (!church) {
      console.log(`[RTMP] Rejected publish — invalid stream key: ${streamKey.slice(0, 8)}...`);
      const session = _nms.getSession(id);
      if (session) session.reject();
      return;
    }

    // Check if church already has an active stream (reject duplicates)
    for (const [key, info] of activeStreams) {
      if (info.churchId === church.churchId) {
        console.log(`[RTMP] Rejected duplicate stream for church ${church.name} (${church.churchId})`);
        const session = _nms.getSession(id);
        if (session) session.reject();
        return;
      }
    }

    // Tag the session so postPublish can read it
    const session = _nms.getSession(id);
    if (session) {
      session._tallyChurchId = church.churchId;
      session._tallyChurchName = church.name;
      session._tallyStreamKey = streamKey;
    }

    console.log(`[RTMP] Authenticated stream for ${church.name} (${church.churchId})`);
  });

  // ─── Start FFmpeg HLS transcoding on successful publish ──────────────────
  _nms.on('postPublish', (id, streamPath, args) => {
    const session = _nms.getSession(id);
    if (!session?._tallyChurchId) return;

    const churchId = session._tallyChurchId;
    const churchName = session._tallyChurchName;
    const streamKey = session._tallyStreamKey;

    const hlsDir = path.join(HLS_TEMP_DIR, churchId);
    fs.mkdirSync(hlsDir, { recursive: true });

    const ffmpegArgs = [
      '-i', `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '4',
      '-hls_flags', 'delete_segments',
      '-hls_segment_filename', path.join(hlsDir, 'seg%03d.ts'),
      path.join(hlsDir, 'live.m3u8'),
    ];

    console.log(`[RTMP] Starting HLS transcoding for ${churchName} → ${hlsDir}`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stderr.on('data', (data) => {
      // FFmpeg logs to stderr; only log errors
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error(`[RTMP/FFmpeg] ${churchName}: ${msg.trim()}`);
      }
    });

    ffmpeg.on('close', (code) => {
      console.log(`[RTMP] FFmpeg exited for ${churchName} with code ${code}`);
    });

    activeStreams.set(streamKey, {
      churchId,
      churchName,
      ffmpeg,
      startedAt: new Date().toISOString(),
      sessionId: id,
    });

    // Broadcast to admin SSE
    if (_broadcastToSSE) {
      _broadcastToSSE({
        type: 'ingest_stream_start',
        churchId,
        churchName,
        startedAt: new Date().toISOString(),
      });
    }
  });

  // ─── Clean up on stream end ──────────────────────────────────────────────
  _nms.on('donePublish', (id, streamPath, args) => {
    const parts = streamPath.split('/');
    const streamKey = parts[2];
    const info = activeStreams.get(streamKey);

    if (info) {
      console.log(`[RTMP] Stream ended for ${info.churchName} (${info.churchId})`);

      // Kill FFmpeg process
      if (info.ffmpeg && !info.ffmpeg.killed) {
        info.ffmpeg.kill('SIGTERM');
        // Force kill after 5s if still alive
        setTimeout(() => {
          if (!info.ffmpeg.killed) info.ffmpeg.kill('SIGKILL');
        }, 5000);
      }

      // Clean up HLS files
      const hlsDir = path.join(HLS_TEMP_DIR, info.churchId);
      cleanupHlsDir(hlsDir);

      // Broadcast to admin SSE
      if (_broadcastToSSE) {
        _broadcastToSSE({
          type: 'ingest_stream_stop',
          churchId: info.churchId,
          churchName: info.churchName,
        });
      }

      activeStreams.delete(streamKey);
    }
  });

  _nms.run();
  console.log(`[RTMP] Ingest server listening on port ${RTMP_PORT}`);

  // Periodic stale cleanup every 5 minutes
  const cleanupInterval = setInterval(() => cleanupStaleStreams(), 5 * 60 * 1000);
  cleanupInterval.unref();

  return _nms;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function cleanupHlsDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        fs.unlinkSync(path.join(dir, f));
      }
      fs.rmdirSync(dir);
    }
  } catch (e) {
    console.error(`[RTMP] Failed to cleanup HLS dir ${dir}: ${e.message}`);
  }
}

function cleanupStaleStreams() {
  // Clean up HLS directories that don't have an active stream
  try {
    if (!fs.existsSync(HLS_TEMP_DIR)) return;
    const dirs = fs.readdirSync(HLS_TEMP_DIR);
    const activeChurchIds = new Set([...activeStreams.values()].map(s => s.churchId));
    for (const dir of dirs) {
      if (!activeChurchIds.has(dir)) {
        cleanupHlsDir(path.join(HLS_TEMP_DIR, dir));
      }
    }
  } catch (e) {
    console.error(`[RTMP] Stale cleanup error: ${e.message}`);
  }
}

/**
 * Generate an ingest stream key for a church.
 */
function generateStreamKey() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Get the list of currently active streams.
 */
function getActiveStreams() {
  const result = [];
  for (const [key, info] of activeStreams) {
    result.push({
      churchId: info.churchId,
      churchName: info.churchName,
      startedAt: info.startedAt,
    });
  }
  return result;
}

/**
 * Check if a church has an active stream.
 */
function isStreamActive(churchId) {
  for (const info of activeStreams.values()) {
    if (info.churchId === churchId) return true;
  }
  return false;
}

/**
 * Disconnect a church's active stream (e.g. when key is regenerated).
 */
function disconnectStream(churchId) {
  for (const [key, info] of activeStreams) {
    if (info.churchId === churchId) {
      const session = _nms?.getSession(info.sessionId);
      if (session) session.reject();
      // donePublish handler will clean up
      return true;
    }
  }
  return false;
}

/**
 * Get the HLS directory path for a church.
 */
function getHlsDir(churchId) {
  return path.join(HLS_TEMP_DIR, churchId);
}

/**
 * Gracefully shut down the RTMP server and kill all FFmpeg processes.
 */
function shutdownRtmpIngest() {
  console.log('[RTMP] Shutting down...');

  // Kill all FFmpeg processes
  for (const [key, info] of activeStreams) {
    if (info.ffmpeg && !info.ffmpeg.killed) {
      info.ffmpeg.kill('SIGTERM');
    }
    const hlsDir = path.join(HLS_TEMP_DIR, info.churchId);
    cleanupHlsDir(hlsDir);
  }
  activeStreams.clear();

  // NMS doesn't expose a stop() method — sockets are cleaned up on process exit
}

module.exports = {
  initRtmpIngest,
  shutdownRtmpIngest,
  generateStreamKey,
  getActiveStreams,
  isStreamActive,
  disconnectStream,
  getHlsDir,
  HLS_TEMP_DIR,
};
