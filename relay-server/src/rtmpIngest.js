'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const NodeMediaServer = require('node-media-server');

const HLS_TEMP_DIR = process.env.HLS_TEMP_DIR || path.join(require('os').tmpdir(), 'tally-hls');
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const HTTP_PORT_INTERNAL = Number(process.env.RTMP_HTTP_PORT || 8888); // NMS internal HTTP (not exposed)

// Active streams: streamKey → { churchId, churchName, roomId, roomName, ffmpeg, startedAt }
const activeStreams = new Map();

let _db = null;
let _broadcastToSSE = null;
let _nms = null;
let _queryClient = null;
let _authCacheReady = Promise.resolve();
const _roomAuthCache = new Map();
const _churchAuthCache = new Map();

/**
 * Initialize the RTMP ingest server.
 * @param {object} db - better-sqlite3 database instance
 * @param {function} broadcastToSSE - function to broadcast events to admin SSE clients
 */
function initRtmpIngest(db, broadcastToSSE) {
  _db = db;
  _queryClient = db?.queryClient || null;
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

  async function refreshAuthCache() {
    _roomAuthCache.clear();
    _churchAuthCache.clear();
    if (_queryClient && typeof _queryClient.query === 'function') {
      try {
        const roomRows = await _queryClient.query(`
          SELECT r.id AS roomId, r.name AS roomName, r.stream_key, r.campus_id AS churchId, c.name AS churchName
          FROM rooms r JOIN churches c ON c.churchId = r.campus_id
          WHERE r.deleted_at IS NULL
        `);
        for (const row of roomRows) {
          _roomAuthCache.set(String(row.stream_key || ''), {
            churchId: row.churchId,
            churchName: row.churchName,
            roomId: row.roomId,
            roomName: row.roomName,
          });
        }
        const churchRows = await _queryClient.query(
          'SELECT churchId, name, ingest_stream_key FROM churches WHERE ingest_stream_key IS NOT NULL AND ingest_stream_key != \'\''
        );
        for (const row of churchRows) {
          _churchAuthCache.set(String(row.ingest_stream_key || ''), {
            churchId: row.churchId,
            churchName: row.name,
          });
        }
        return;
      } catch (e) {
        console.error(`[RTMP] Failed to preload stream auth cache: ${e.message}`);
      }
    }

    if (_db && typeof _db.prepare === 'function') {
      try {
        const roomRows = _db.prepare(`
          SELECT r.id AS roomId, r.name AS roomName, r.stream_key, r.campus_id AS churchId, c.name AS churchName
          FROM rooms r JOIN churches c ON c.churchId = r.campus_id
          WHERE r.deleted_at IS NULL
        `).all();
        for (const row of roomRows) {
          _roomAuthCache.set(String(row.stream_key || ''), {
            churchId: row.churchId,
            churchName: row.churchName,
            roomId: row.roomId,
            roomName: row.roomName,
          });
        }
        const churchRows = _db.prepare(
          'SELECT churchId, name, ingest_stream_key FROM churches WHERE ingest_stream_key IS NOT NULL AND ingest_stream_key != \'\''
        ).all();
        for (const row of churchRows) {
          _churchAuthCache.set(String(row.ingest_stream_key || ''), {
            churchId: row.churchId,
            churchName: row.name,
          });
        }
      } catch (e) {
        console.error(`[RTMP] Failed to preload stream auth cache: ${e.message}`);
      }
    }
  }

  // ─── Auth: validate stream key on publish ────────────────────────────────
  // NMS v4.x emits a single session object (not id, streamPath, args)
  _nms.on('prePublish', (session) => {
    const streamPath = session.streamPath; // e.g. /live/STREAM_KEY
    const parts = (streamPath || '').split('/');
    const streamKey = parts[2];

    if (!streamKey) {
      console.log(`[RTMP] Rejected publish — no stream key in path: ${streamPath}`);
      try { session.reject(); } catch {}
      return;
    }

    const room = _roomAuthCache.get(streamKey) || null;

    let churchId, churchName, roomId, roomName;

    if (room) {
      churchId = room.churchId;
      churchName = room.churchName;
      roomId = room.roomId;
      roomName = room.roomName;
    } else {
      // Fallback: church-level key
      const church = _churchAuthCache.get(streamKey) || null;

      if (!church) {
        console.log(`[RTMP] Rejected publish — invalid stream key: ${streamKey.slice(0, 8)}...`);
        try { session.reject(); } catch {}
        return;
      }
      churchId = church.churchId;
      churchName = church.name;
      roomId = null;
      roomName = null;
    }

    // Check if this room/church already has an active stream (reject duplicates)
    const targetId = roomId || churchId;
    for (const [key, info] of activeStreams) {
      const infoTarget = info.roomId || info.churchId;
      if (infoTarget === targetId) {
        console.log(`[RTMP] Rejected duplicate stream for ${roomName || churchName} (${targetId})`);
        try { session.reject(); } catch {}
        return;
      }
    }

    // Tag the session so postPublish can read it
    session._tallyChurchId = churchId;
    session._tallyChurchName = churchName;
    session._tallyRoomId = roomId;
    session._tallyRoomName = roomName;
    session._tallyStreamKey = streamKey;

    console.log(`[RTMP] Authenticated stream for ${churchName}${roomName ? ' / ' + roomName : ''} (${targetId})`);
  });

  // ─── Start FFmpeg HLS transcoding on successful publish ──────────────────
  _nms.on('postPublish', (session) => {
    if (!session?._tallyChurchId) return;

    const churchId = session._tallyChurchId;
    const churchName = session._tallyChurchName;
    const roomId = session._tallyRoomId;
    const roomName = session._tallyRoomName;
    const streamKey = session._tallyStreamKey;
    const streamPath = session.streamPath;

    // Use roomId for HLS directory when available, else churchId
    const hlsTargetId = roomId || churchId;
    const hlsDir = path.join(HLS_TEMP_DIR, hlsTargetId);
    fs.mkdirSync(hlsDir, { recursive: true });

    const ffmpegArgs = [
      '-i', `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'hls',
      '-hls_time', '4',
      '-hls_list_size', '10',
      '-hls_delete_threshold', '5',
      '-hls_flags', 'delete_segments+temp_file',
      '-hls_segment_filename', path.join(hlsDir, 'seg%03d.ts'),
      path.join(hlsDir, 'live.m3u8'),
    ];

    // Add -progress for real-time stats and -v info for stream detection
    ffmpegArgs.unshift('-v', 'info', '-progress', 'pipe:2');

    console.log(`[RTMP] Starting HLS transcoding for ${churchName}${roomName ? ' / ' + roomName : ''} → ${hlsDir}`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Parse FFmpeg stderr for stream metadata (bitrate, fps, resolution)
    const streamMeta = { bitrateKbps: 0, fps: 0, resolution: '', codec: '', audioCodec: '' };
    let stderrBuf = '';
    let metaParsed = false;
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      stderrBuf += msg;

      if (msg.includes('error') || msg.includes('Error')) {
        console.error(`[RTMP/FFmpeg] ${churchName}: ${msg.trim()}`);
      }

      // Parse stream info (only need to do this once)
      if (!metaParsed) {
        // Video: "Stream #0:0: Video: h264 ..." with various formats
        const videoMatch = stderrBuf.match(/Video:\s*(\w+)[^,]*,\s*\w+[^,]*,\s*(\d+x\d+)/);
        if (videoMatch) {
          streamMeta.codec = videoMatch[1];
          streamMeta.resolution = videoMatch[2];
        }
        // FPS: look for "fps" or "tb(r)" patterns
        const fpsMatch = stderrBuf.match(/(\d+(?:\.\d+)?)\s*fps/);
        if (fpsMatch) {
          streamMeta.fps = parseFloat(fpsMatch[1]);
        }
        // Audio: "Stream #0:1: Audio: aac ..."
        const audioMatch = stderrBuf.match(/Audio:\s*(\w+)/);
        if (audioMatch) {
          streamMeta.audioCodec = audioMatch[1];
        }
        if (streamMeta.codec && streamMeta.fps) {
          metaParsed = true;
          console.log(`[RTMP] Stream info for ${churchName}: ${streamMeta.codec} ${streamMeta.resolution} ${streamMeta.fps}fps ${streamMeta.audioCodec}`);
        }
      }

      // Parse bitrate from -progress output: "bitrate=4361.2kbits/s"
      const brMatch = msg.match(/bitrate=\s*([\d.]+)kbits\/s/);
      if (brMatch) {
        streamMeta.bitrateKbps = Math.round(parseFloat(brMatch[1]));
      }
      // Also check for "total_size=" to estimate bitrate from progress
      const sizeMatch = msg.match(/total_size=(\d+)/);
      const timeMatch = msg.match(/out_time_us=(\d+)/);
      if (sizeMatch && timeMatch && parseInt(timeMatch[1]) > 0) {
        const bytes = parseInt(sizeMatch[1]);
        const seconds = parseInt(timeMatch[1]) / 1000000;
        if (seconds > 1) {
          streamMeta.bitrateKbps = Math.round((bytes * 8) / seconds / 1000);
        }
      }

      // Keep buffer manageable
      if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-8000);
    });

    ffmpeg.on('close', (code) => {
      console.log(`[RTMP] FFmpeg exited for ${churchName} with code ${code}`);
    });

    activeStreams.set(streamKey, {
      churchId,
      churchName,
      roomId,
      roomName,
      ffmpeg,
      startedAt: new Date().toISOString(),
      sessionId: session.id,
      meta: streamMeta,
    });

    // Broadcast to admin SSE
    if (_broadcastToSSE) {
      _broadcastToSSE({
        type: 'ingest_stream_start',
        churchId,
        churchName,
        roomId,
        roomName,
        startedAt: new Date().toISOString(),
      });
    }
  });

  // ─── Clean up on stream end ──────────────────────────────────────────────
  _nms.on('donePublish', (session) => {
    const parts = (session.streamPath || '').split('/');
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

      // Clean up HLS files (use roomId if available, else churchId)
      const hlsTargetId = info.roomId || info.churchId;
      const hlsDir = path.join(HLS_TEMP_DIR, hlsTargetId);
      cleanupHlsDir(hlsDir);

      // Broadcast to admin SSE
      if (_broadcastToSSE) {
        _broadcastToSSE({
          type: 'ingest_stream_stop',
          churchId: info.churchId,
          churchName: info.churchName,
          roomId: info.roomId,
          roomName: info.roomName,
        });
      }

      activeStreams.delete(streamKey);
    }
  });

  _authCacheReady = refreshAuthCache().then(() => {
    _nms.run();
    console.log(`[RTMP] Ingest server listening on port ${RTMP_PORT}`);
  });
  void _authCacheReady.catch(() => {});

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
    const activeTargetIds = new Set([...activeStreams.values()].map(s => s.roomId || s.churchId));
    for (const dir of dirs) {
      if (!activeTargetIds.has(dir)) {
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
      roomId: info.roomId || null,
      roomName: info.roomName || null,
      startedAt: info.startedAt,
      meta: info.meta || {},
    });
  }
  return result;
}

/**
 * Get stream metadata for a target (roomId or churchId).
 */
function getStreamMeta(targetId) {
  for (const info of activeStreams.values()) {
    if (info.roomId === targetId || info.churchId === targetId) return info.meta || {};
  }
  return null;
}

/**
 * Get full stream info for a target (roomId or churchId).
 */
function getStreamInfo(targetId) {
  for (const info of activeStreams.values()) {
    if (info.roomId === targetId || info.churchId === targetId) {
      return {
        startedAt: info.startedAt,
        meta: info.meta || {},
        roomId: info.roomId,
        roomName: info.roomName,
      };
    }
  }
  return null;
}

/**
 * Check if a target (roomId or churchId) has an active stream.
 */
function isStreamActive(targetId) {
  for (const info of activeStreams.values()) {
    if (info.roomId === targetId || info.churchId === targetId) return true;
  }
  return false;
}

/**
 * Disconnect a target's active stream (e.g. when key is regenerated).
 * Matches by roomId or churchId.
 */
function disconnectStream(targetId) {
  for (const [key, info] of activeStreams) {
    if (info.roomId === targetId || info.churchId === targetId) {
      const session = _nms?.getSession(info.sessionId);
      if (session) session.reject();
      // donePublish handler will clean up
      return true;
    }
  }
  return false;
}

/**
 * Get the HLS directory path for a target (roomId or churchId).
 */
function getHlsDir(targetId) {
  return path.join(HLS_TEMP_DIR, targetId);
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
    const hlsTargetId = info.roomId || info.churchId;
    cleanupHlsDir(path.join(HLS_TEMP_DIR, hlsTargetId));
  }
  activeStreams.clear();
  _roomAuthCache.clear();
  _churchAuthCache.clear();

  // NMS doesn't expose a stop() method — sockets are cleaned up on process exit
}

module.exports = {
  initRtmpIngest,
  shutdownRtmpIngest,
  generateStreamKey,
  getActiveStreams,
  getStreamMeta,
  getStreamInfo,
  isStreamActive,
  disconnectStream,
  getHlsDir,
  HLS_TEMP_DIR,
};
