/**
 * Tally Relay Server
 * Bridges OpenClaw/Telegram (controller) ↔ Church Client App (on-site)
 *
 * Deploy to Railway: https://railway.app
 *
 * ENV VARS:
 *   PORT            (default 3000)
 *   ADMIN_API_KEY   Secret key for Andrew's OpenClaw skill
 *   JWT_SECRET      Secret for signing church tokens
 *   DATABASE_PATH   Path to SQLite DB (default ./data/churches.db)
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key-change-me';
const JWT_SECRET    = process.env.JWT_SECRET    || 'dev-jwt-secret-change-me';

if (ADMIN_API_KEY === 'dev-admin-key-change-me' || JWT_SECRET === 'dev-jwt-secret-change-me') {
  console.warn('\n⚠️  WARNING: Using default dev keys! Set ADMIN_API_KEY and JWT_SECRET env vars for production.\n');
}
const DB_PATH       = process.env.DATABASE_PATH || './data/churches.db';

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── SQLITE PERSISTENCE ──────────────────────────────────────────────────────

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS churches (
    churchId TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    email TEXT DEFAULT '',
    token TEXT NOT NULL,
    registeredAt TEXT NOT NULL
  )
`);

const stmtInsert = db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)');
const stmtAll = db.prepare('SELECT * FROM churches');
const stmtGet = db.prepare('SELECT * FROM churches WHERE churchId = ?');
const stmtDelete = db.prepare('DELETE FROM churches WHERE churchId = ?');
const stmtFindByName = db.prepare('SELECT * FROM churches WHERE name = ?');

// ─── IN-MEMORY RUNTIME STATE ─────────────────────────────────────────────────

// churchId → { churchId, name, email, token, ws, status, lastSeen, registeredAt, disconnectedAt }
const churches = new Map();
const controllers = new Set();

// Stats
let totalMessagesRelayed = 0;

// Message queue: churchId → [{ msg, queuedAt }]
const messageQueues = new Map();
const MAX_QUEUE_SIZE = 10;
const QUEUE_TTL_MS = 30_000; // 30 seconds

// Rate limiting: churchId → { tokens, lastRefill }
const rateLimiters = new Map();
const RATE_LIMIT = 10; // commands per second

// Load churches from DB
for (const row of stmtAll.all()) {
  churches.set(row.churchId, {
    churchId: row.churchId,
    name: row.name,
    email: row.email,
    token: row.token,
    ws: null,
    status: { connected: false, atem: null, obs: null },
    lastSeen: null,
    registeredAt: row.registeredAt,
    disconnectedAt: null,
  });
}
log(`Loaded ${churches.size} churches from database`);

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────

function checkRateLimit(churchId) {
  const now = Date.now();
  let bucket = rateLimiters.get(churchId);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT, lastRefill: now };
    rateLimiters.set(churchId, bucket);
  }
  // Refill tokens based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + elapsed * RATE_LIMIT);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ─── MESSAGE QUEUE ────────────────────────────────────────────────────────────

function queueMessage(churchId, msg) {
  if (!messageQueues.has(churchId)) messageQueues.set(churchId, []);
  const queue = messageQueues.get(churchId);
  if (queue.length >= MAX_QUEUE_SIZE) queue.shift(); // drop oldest
  queue.push({ msg, queuedAt: Date.now() });
}

function drainQueue(churchId, ws) {
  const queue = messageQueues.get(churchId);
  if (!queue || queue.length === 0) return;
  const now = Date.now();
  let delivered = 0;
  for (const item of queue) {
    if (now - item.queuedAt < QUEUE_TTL_MS) {
      ws.send(JSON.stringify(item.msg));
      delivered++;
    }
  }
  messageQueues.delete(churchId);
  if (delivered > 0) log(`Delivered ${delivered} queued messages to church ${churchId}`);
}

// ─── HTTP API ────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'tally-relay',
    churches: churches.size,
    controllers: controllers.size,
  });
});

// Detailed health/stats
app.get('/api/health', (req, res) => {
  const connectedCount = Array.from(churches.values()).filter(c => c.ws?.readyState === WebSocket.OPEN).length;
  res.json({
    service: 'tally-relay',
    uptime: Math.floor(process.uptime()),
    registeredChurches: churches.size,
    connectedChurches: connectedCount,
    controllers: controllers.size,
    totalMessagesRelayed,
  });
});

// Register a new church and get a connection token
app.post('/api/churches/register', requireAdmin, (req, res) => {
  const { name, email } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Check uniqueness
  const existing = stmtFindByName.get(name);
  if (existing) return res.status(409).json({ error: `A church named "${name}" already exists` });

  const churchId = uuidv4();
  const token = jwt.sign({ churchId, name }, JWT_SECRET, { expiresIn: '365d' });
  const registeredAt = new Date().toISOString();

  stmtInsert.run(churchId, name, email || '', token, registeredAt);

  churches.set(churchId, {
    churchId, name, email: email || '',
    token, ws: null,
    status: { connected: false, atem: null, obs: null },
    lastSeen: null, registeredAt, disconnectedAt: null,
  });

  log(`Registered church: ${name} (${churchId})`);
  res.json({ churchId, name, token, message: 'Share this token with the church to connect their client app.' });
});

// List all registered churches + their current status
app.get('/api/churches', requireAdmin, (req, res) => {
  const list = Array.from(churches.values()).map(c => ({
    churchId: c.churchId,
    name: c.name,
    connected: c.ws?.readyState === WebSocket.OPEN,
    status: c.status,
    lastSeen: c.lastSeen,
  }));
  res.json(list);
});

// Delete a church
app.delete('/api/churches/:churchId', requireAdmin, (req, res) => {
  const { churchId } = req.params;
  const church = churches.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  // Close WS if connected
  if (church.ws?.readyState === WebSocket.OPEN) {
    church.ws.close(1000, 'church deleted');
  }

  stmtDelete.run(churchId);
  churches.delete(churchId);
  messageQueues.delete(churchId);
  rateLimiters.delete(churchId);

  log(`Deleted church: ${church.name} (${churchId})`);
  res.json({ deleted: true, name: church.name });
});

// Send a command to a specific church
app.post('/api/command', requireAdmin, (req, res) => {
  const { churchId, command, params = {} } = req.body;
  if (!churchId || !command) return res.status(400).json({ error: 'churchId and command required' });

  if (!checkRateLimit(churchId)) {
    return res.status(429).json({ error: 'Rate limit exceeded (max 10 commands/second)' });
  }

  const church = churches.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  const msg = { type: 'command', command, params, id: uuidv4() };
  totalMessagesRelayed++;

  if (!church.ws || church.ws.readyState !== WebSocket.OPEN) {
    // Check if briefly offline — queue the message
    if (church.disconnectedAt && (Date.now() - church.disconnectedAt) < QUEUE_TTL_MS) {
      queueMessage(churchId, msg);
      log(`CMD → ${church.name}: ${command} (queued — church offline)`);
      return res.json({ sent: false, queued: true, messageId: msg.id });
    }
    return res.status(503).json({ error: 'Church client not connected' });
  }

  church.ws.send(JSON.stringify(msg));
  log(`CMD → ${church.name}: ${command} ${JSON.stringify(params)}`);
  res.json({ sent: true, messageId: msg.id });
});

// Broadcast a command to ALL connected churches
app.post('/api/broadcast', requireAdmin, (req, res) => {
  const { command, params = {} } = req.body;
  let sent = 0;
  for (const church of churches.values()) {
    if (church.ws?.readyState === WebSocket.OPEN) {
      church.ws.send(JSON.stringify({ type: 'command', command, params, id: uuidv4() }));
      sent++;
      totalMessagesRelayed++;
    }
  }
  res.json({ sent, total: churches.size });
});

// Get latest status from a church
app.get('/api/churches/:churchId/status', requireAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  res.json({
    name: church.name,
    connected: church.ws?.readyState === WebSocket.OPEN,
    status: church.status,
    lastSeen: church.lastSeen,
  });
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const role = url.pathname.replace(/^\//, '');
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (role === 'church') {
    handleChurchConnection(ws, url, clientIp);
  } else if (role === 'controller') {
    handleControllerConnection(ws, url);
  } else {
    ws.close(1008, 'Unknown role');
  }
});

function handleChurchConnection(ws, url, clientIp) {
  const token = url.searchParams.get('token');
  if (!token) return ws.close(1008, 'token required');

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return ws.close(1008, 'invalid token');
  }

  const church = churches.get(payload.churchId);
  if (!church) return ws.close(1008, 'church not registered');

  // Close any existing connection from this church
  if (church.ws?.readyState === WebSocket.OPEN) {
    church.ws.close(1000, 'replaced by new connection');
  }

  church.ws = ws;
  church.lastSeen = new Date().toISOString();
  church.disconnectedAt = null;
  log(`Church "${church.name}" connected from ${clientIp}`);

  // Drain any queued messages
  drainQueue(church.churchId, ws);

  // Notify controllers
  broadcastToControllers({
    type: 'church_connected',
    churchId: church.churchId,
    name: church.name,
    timestamp: church.lastSeen,
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleChurchMessage(church, msg);
      totalMessagesRelayed++;
    } catch (e) {
      console.error('Invalid message from church:', e.message);
    }
  });

  ws.on('close', () => {
    church.lastSeen = new Date().toISOString();
    church.disconnectedAt = Date.now();
    log(`Church "${church.name}" disconnected`);
    broadcastToControllers({
      type: 'church_disconnected',
      churchId: church.churchId,
      name: church.name,
    });
  });

  ws.send(JSON.stringify({ type: 'connected', churchId: church.churchId, name: church.name }));
}

function handleControllerConnection(ws, url) {
  const apiKey = url.searchParams.get('apikey');
  if (apiKey !== ADMIN_API_KEY) return ws.close(1008, 'invalid api key');

  controllers.add(ws);
  log(`Controller connected (total: ${controllers.size})`);

  const churchList = Array.from(churches.values()).map(c => ({
    churchId: c.churchId,
    name: c.name,
    connected: c.ws?.readyState === WebSocket.OPEN,
    status: c.status,
  }));
  ws.send(JSON.stringify({ type: 'church_list', churches: churchList }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleControllerMessage(ws, msg);
    } catch (e) {
      console.error('Invalid message from controller:', e.message);
    }
  });

  ws.on('close', () => {
    controllers.delete(ws);
    log(`Controller disconnected (total: ${controllers.size})`);
  });
}

function handleChurchMessage(church, msg) {
  church.lastSeen = new Date().toISOString();

  switch (msg.type) {
    case 'status_update':
      church.status = { ...church.status, ...msg.status };
      broadcastToControllers({
        type: 'status_update',
        churchId: church.churchId,
        name: church.name,
        status: church.status,
        timestamp: church.lastSeen,
      });
      break;

    case 'alert':
      log(`ALERT from ${church.name}: ${msg.message}`);
      broadcastToControllers({
        type: 'alert',
        churchId: church.churchId,
        name: church.name,
        severity: msg.severity || 'warning',
        message: msg.message,
        timestamp: church.lastSeen,
      });
      break;

    case 'command_result':
      broadcastToControllers({
        type: 'command_result',
        churchId: church.churchId,
        name: church.name,
        messageId: msg.id,
        result: msg.result,
        error: msg.error,
      });
      break;

    case 'preview_frame':
      // Safety: reject frames > 150KB
      if (msg.data && msg.data.length > 150_000) break;
      church.status.previewActive = true;
      broadcastToControllers({
        type: 'preview_frame',
        churchId: church.churchId,
        churchName: church.name,
        timestamp: msg.timestamp,
        width: msg.width,
        height: msg.height,
        format: msg.format,
        data: msg.data,
      });
      totalMessagesRelayed++;
      break;

    case 'ping':
      church.ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      broadcastToControllers({ ...msg, churchId: church.churchId, churchName: church.name });
  }
}

function handleControllerMessage(ws, msg) {
  if (msg.type === 'command' && msg.churchId) {
    if (!checkRateLimit(msg.churchId)) {
      ws.send(JSON.stringify({ type: 'error', error: 'Rate limit exceeded', churchId: msg.churchId }));
      return;
    }
    const church = churches.get(msg.churchId);
    if (church?.ws?.readyState === WebSocket.OPEN) {
      church.ws.send(JSON.stringify(msg));
      totalMessagesRelayed++;
    } else {
      ws.send(JSON.stringify({ type: 'error', error: 'Church not connected', churchId: msg.churchId }));
    }
  }
}

function broadcastToControllers(msg) {
  const data = JSON.stringify(msg);
  for (const ws of controllers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (key !== ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`Tally Relay running on port ${PORT}`);
  log(`Admin API key: configured (${ADMIN_API_KEY.length} chars)`);
});

// Export for testing
module.exports = { app, server, wss, churches, controllers };
