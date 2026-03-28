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

    const church = _db.prepare(
      'SELECT churchId, name FROM churches WHERE ingest_stream_key = ?'
    ).get(streamKey);

    if (!church) {
      console.log(`[RTMP] Rejected publish — invalid stream key: ${streamKey.slice(0, 8)}...`);
      try { session.reject(); } catch {}
      return;
    }

    // Check if church already has an active stream (reject duplicates)
    for (const [key, info] of activeStreams) {
      if (info.churchId === church.churchId) {
        console.log(`[RTMP] Rejected duplicate stream for church ${church.name} (${church.churchId})`);
        try { session.reject(); } catch {}
        return;
      }
    }

    // Tag the session so postPublish can read it
    session._tallyChurchId = church.churchId;
    session._tallyChurchName = church.name;
    session._tallyStreamKey = streamKey;

    console.log(`[RTMP] Authenticated stream for ${church.name} (${church.churchId})`);
  });

  // ─── Start FFmpeg HLS transcoding on successful publish ──────────────────
  _nms.on('postPublish', (session) => {
    if (!session?._tallyChurchId) return;

    const churchId = session._tallyChurchId;
    const churchName = session._tallyChurchName;
    const streamKey = session._tallyStreamKey;
    const streamPath = session.streamPath;

    const hlsDir = path.join(HLS_TEMP_DIR, churchId);
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

    console.log(`[RTMP] Starting HLS transcoding for ${churchName} → ${hlsDir}`);
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
      meta: info.meta || {},
    });
  }
  return result;
}

/**
 * Get stream metadata for a specific church.
 */
function getStreamMeta(churchId) {
  for (const info of activeStreams.values()) {
    if (info.churchId === churchId) return info.meta || {};
  }
  return null;
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
  getStreamMeta,
  isStreamActive,
  disconnectStream,
  getHlsDir,
  HLS_TEMP_DIR,
};
