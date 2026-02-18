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

const { ScheduleEngine } = require('./src/scheduleEngine');
const { AlertEngine } = require('./src/alertEngine');
const { AutoRecovery } = require('./src/autoRecovery');
const { WeeklyDigest } = require('./src/weeklyDigest');
const { TallyBot } = require('./src/telegramBot');
const { PreServiceCheck } = require('./src/preServiceCheck');
const { MonthlyReport } = require('./src/monthlyReport');
const { OnCallRotation } = require('./src/onCallRotation');
const { GuestTdMode } = require('./src/guestTdMode');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key-change-me';
const JWT_SECRET    = process.env.JWT_SECRET    || 'dev-jwt-secret-change-me';

if (ADMIN_API_KEY === 'dev-admin-key-change-me' || JWT_SECRET === 'dev-jwt-secret-change-me') {
  console.warn('\n⚠️  WARNING: Using default dev keys! Set ADMIN_API_KEY and JWT_SECRET env vars for production.\n');
}
const DB_PATH       = process.env.DATABASE_PATH || './data/churches.db';

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

// churchId → { churchId, name, email, token, ws, status, lastSeen, lastHeartbeat, registeredAt, disconnectedAt }
const churches = new Map();
const controllers = new Set();
// SSE clients for the dashboard
const sseClients = new Set();

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
    lastHeartbeat: null, // updated on status_update messages
    registeredAt: row.registeredAt,
    disconnectedAt: null,
    _offlineAlertSent: false, // track whether we've alerted for this offline stretch
  });
}
log(`Loaded ${churches.size} churches from database`);

// ─── EXTRA SQLITE TABLES (new features) ──────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS maintenance_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    churchId TEXT NOT NULL,
    startTime TEXT NOT NULL,
    endTime TEXT NOT NULL,
    reason TEXT DEFAULT ''
  )
`);

// ─── AUTOMATION ENGINES ──────────────────────────────────────────────────────

const scheduleEngine = new ScheduleEngine(db);
const onCallRotation = new OnCallRotation(db);
const alertEngine = new AlertEngine(db, scheduleEngine, { onCallRotation });
const autoRecovery = new AutoRecovery(churches, alertEngine);
const weeklyDigest = new WeeklyDigest(db);
weeklyDigest.startWeeklyTimer();

const guestTdMode = new GuestTdMode(db);
guestTdMode.startCleanupTimer();

const monthlyReport = new MonthlyReport({
  db,
  defaultBotToken: process.env.ALERT_BOT_TOKEN,
  andrewChatId: process.env.ANDREW_TELEGRAM_CHAT_ID,
});
monthlyReport.start();

// ─── TELEGRAM BOT ────────────────────────────────────────────────────────────

const TALLY_BOT_TOKEN = process.env.TALLY_BOT_TOKEN;
const TALLY_BOT_WEBHOOK_URL = process.env.TALLY_BOT_WEBHOOK_URL;
const ANDREW_TELEGRAM_CHAT_ID = process.env.ANDREW_TELEGRAM_CHAT_ID;

let tallyBot = null;
let preServiceCheck = null;

if (TALLY_BOT_TOKEN) {
  tallyBot = new TallyBot({
    botToken: TALLY_BOT_TOKEN,
    adminChatId: ANDREW_TELEGRAM_CHAT_ID,
    db,
    relay: { churches },
    onCallRotation,
    guestTdMode,
  });
  log('Telegram bot initialized');
  if (TALLY_BOT_WEBHOOK_URL) {
    tallyBot.setWebhook(TALLY_BOT_WEBHOOK_URL).catch(e => console.error('Webhook setup failed:', e.message));
  }
} else {
  log('Telegram bot disabled (TALLY_BOT_TOKEN not set)');
}

// Pre-service check — needs tallyBot but can still send Telegram directly
preServiceCheck = new PreServiceCheck({
  db,
  scheduleEngine,
  churches,
  defaultBotToken: process.env.ALERT_BOT_TOKEN,
  andrewChatId: ANDREW_TELEGRAM_CHAT_ID,
});
preServiceCheck.start();

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

// ─── SCHEDULE & ALERT API ─────────────────────────────────────────────────────

app.put('/api/churches/:churchId/schedule', requireAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const { serviceTimes } = req.body;
  if (!Array.isArray(serviceTimes)) return res.status(400).json({ error: 'serviceTimes array required' });
  scheduleEngine.setSchedule(req.params.churchId, serviceTimes);
  res.json({ saved: true, serviceTimes });
});

app.get('/api/churches/:churchId/schedule', requireAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const schedule = scheduleEngine.getSchedule(req.params.churchId);
  const inWindow = scheduleEngine.isServiceWindow(req.params.churchId);
  const next = scheduleEngine.getNextService(req.params.churchId);
  res.json({ schedule, inServiceWindow: inWindow, nextService: next });
});

app.put('/api/churches/:churchId/td-contact', requireAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const { tdChatId, tdName, alertBotToken } = req.body;
  if (tdChatId) db.prepare('UPDATE churches SET td_telegram_chat_id = ? WHERE churchId = ?').run(tdChatId, req.params.churchId);
  if (tdName) db.prepare('UPDATE churches SET td_name = ? WHERE churchId = ?').run(tdName, req.params.churchId);
  if (alertBotToken) db.prepare('UPDATE churches SET alert_bot_token = ? WHERE churchId = ?').run(alertBotToken, req.params.churchId);
  // Update in-memory
  const row = stmtGet.get(req.params.churchId);
  if (row) { church.td_telegram_chat_id = row.td_telegram_chat_id; church.td_name = row.td_name; church.alert_bot_token = row.alert_bot_token; }
  res.json({ saved: true });
});

app.post('/api/alerts/:alertId/acknowledge', requireAdmin, (req, res) => {
  const { responder } = req.body;
  const result = alertEngine.acknowledgeAlert(req.params.alertId, responder || 'admin');
  res.json(result);
});

app.get('/api/digest/latest', requireAdmin, (req, res) => {
  const latest = weeklyDigest.getLatestDigest();
  if (!latest) return res.status(404).json({ error: 'No digest yet' });
  res.json(latest);
});

app.get('/api/digest/generate', requireAdmin, async (req, res) => {
  try {
    const result = await weeklyDigest.saveDigest();
    res.json({ generated: true, filePath: result.filePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MONTHLY REPORT API ───────────────────────────────────────────────────────

app.get('/api/churches/:churchId/report', requireAdmin, async (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const monthStr = req.query.month; // "YYYY-MM" or omit for previous month
  try {
    const dbChurch = stmtGet.get(req.params.churchId);
    const report = await monthlyReport.generateReport(req.params.churchId, monthStr);
    const text = monthlyReport.formatReport(report);
    res.json({ ...report, formatted: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

app.get('/dashboard', (req, res) => {
  const key = req.query.key || req.headers['x-api-key'];
  if (key !== ADMIN_API_KEY) {
    return res.status(401).send('<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;padding:40px"><h1>401 Unauthorized</h1><p>Add <code>?key=YOUR_ADMIN_KEY</code> to the URL.</p></body></html>');
  }
  res.sendFile(path.join(__dirname, 'src', 'dashboard.html'));
});

// ─── SSE Dashboard Stream ─────────────────────────────────────────────────────

app.get('/api/dashboard/stream', (req, res) => {
  const key = req.query.key || req.headers['x-api-key'];
  if (key !== ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if behind proxy
  res.flushHeaders();

  // Send initial state
  const initialState = Array.from(churches.values()).map(c => ({
    churchId: c.churchId,
    name: c.name,
    connected: c.ws?.readyState === WebSocket.OPEN,
    status: c.status,
    lastSeen: c.lastSeen,
    lastHeartbeat: c.lastHeartbeat,
  }));
  res.write(`data: ${JSON.stringify({ type: 'initial', churches: initialState })}\n\n`);

  // Keep-alive ping every 30s
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 30_000);

  sseClients.add(res);
  log(`Dashboard SSE client connected (total: ${sseClients.size})`);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    log(`Dashboard SSE client disconnected (total: ${sseClients.size})`);
  });
});

// ─── MAINTENANCE WINDOWS API ──────────────────────────────────────────────────

app.get('/api/churches/:churchId/maintenance', requireAdmin, (req, res) => {
  const windows = db.prepare('SELECT * FROM maintenance_windows WHERE churchId = ? ORDER BY startTime ASC').all(req.params.churchId);
  res.json(windows);
});

app.post('/api/churches/:churchId/maintenance', requireAdmin, (req, res) => {
  const { startTime, endTime, reason } = req.body;
  if (!startTime || !endTime) return res.status(400).json({ error: 'startTime and endTime required' });
  const result = db.prepare(
    'INSERT INTO maintenance_windows (churchId, startTime, endTime, reason) VALUES (?, ?, ?, ?)'
  ).run(req.params.churchId, startTime, endTime, reason || '');
  res.json({ id: result.lastInsertRowid, churchId: req.params.churchId, startTime, endTime, reason });
});

app.delete('/api/maintenance/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// ─── ON-CALL ROTATION API ─────────────────────────────────────────────────────

app.get('/api/churches/:churchId/oncall', requireAdmin, (req, res) => {
  const onCall = onCallRotation.getOnCallTD(req.params.churchId);
  const all = onCallRotation.getAllTDs(req.params.churchId);
  res.json({ onCall, all });
});

app.post('/api/churches/:churchId/oncall', requireAdmin, (req, res) => {
  const { tdName } = req.body;
  if (!tdName) return res.status(400).json({ error: 'tdName required' });
  const result = onCallRotation.setOnCall(req.params.churchId, tdName);
  res.json(result);
});

app.post('/api/churches/:churchId/tds/add', requireAdmin, (req, res) => {
  const { name, telegramChatId, telegramUserId, phone, isPrimary } = req.body;
  if (!name || !telegramChatId) return res.status(400).json({ error: 'name and telegramChatId required' });
  const id = onCallRotation.addOrUpdateTD({ churchId: req.params.churchId, name, telegramChatId, telegramUserId, phone, isPrimary });
  res.json({ id, name });
});

// ─── GUEST TOKEN API ──────────────────────────────────────────────────────────

app.post('/api/churches/:churchId/guest-token', requireAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const result = guestTdMode.generateToken(req.params.churchId, church.name);
  res.json(result);
});

app.delete('/api/guest-token/:token', requireAdmin, (req, res) => {
  const result = guestTdMode.revokeToken(req.params.token);
  res.json(result);
});

app.get('/api/guest-tokens', requireAdmin, (req, res) => {
  res.json(guestTdMode.listActiveTokens());
});

// ─── TELEGRAM BOT API ─────────────────────────────────────────────────────────

app.post('/api/telegram-webhook', (req, res) => {
  res.sendStatus(200); // Respond immediately to Telegram
  if (tallyBot) tallyBot.handleUpdate(req.body).catch(e => console.error('[TallyBot] webhook error:', e.message));
});

app.post('/api/churches/:churchId/td-register', requireAdmin, (req, res) => {
  const { churchId } = req.params;
  const church = churches.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const { telegram_user_id, telegram_chat_id, name } = req.body;
  if (!telegram_user_id || !name) return res.status(400).json({ error: 'telegram_user_id and name required' });
  if (!tallyBot) return res.status(503).json({ error: 'Telegram bot not configured' });
  tallyBot._stmtRegisterTD.run(churchId, telegram_user_id, telegram_chat_id || telegram_user_id, name, new Date().toISOString());
  res.json({ registered: true, name });
});

app.get('/api/churches/:churchId/tds', requireAdmin, (req, res) => {
  if (!tallyBot) return res.json([]);
  const tds = tallyBot._stmtListTDs.all(req.params.churchId);
  res.json(tds);
});

app.delete('/api/churches/:churchId/tds/:userId', requireAdmin, (req, res) => {
  if (!tallyBot) return res.status(503).json({ error: 'Telegram bot not configured' });
  tallyBot._stmtDeactivateTD.run(req.params.churchId, req.params.userId);
  res.json({ removed: true });
});

app.post('/api/bot/set-webhook', requireAdmin, (req, res) => {
  if (!tallyBot) return res.status(503).json({ error: 'Telegram bot not configured' });
  const { url } = req.body;
  tallyBot.setWebhook(url || TALLY_BOT_WEBHOOK_URL).then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message }));
});

// Include registration_code in church detail
app.get('/api/churches/:churchId', requireAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const row = stmtGet.get(req.params.churchId);
  res.json({
    churchId: church.churchId,
    name: church.name,
    connected: church.ws?.readyState === 1,
    status: church.status,
    lastSeen: church.lastSeen,
    registrationCode: row?.registration_code || null,
    token: row?.token,
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

  // Notify controllers and SSE dashboard
  const connectedEvent = {
    type: 'church_connected',
    churchId: church.churchId,
    name: church.name,
    timestamp: church.lastSeen,
    connected: true,
    status: church.status,
  };
  broadcastToControllers(connectedEvent);
  broadcastToSSE(connectedEvent);

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
    const disconnectEvent = {
      type: 'church_disconnected',
      churchId: church.churchId,
      name: church.name,
      connected: false,
    };
    broadcastToControllers(disconnectEvent);
    broadcastToSSE(disconnectEvent);
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
      church.lastHeartbeat = Date.now(); // track specifically for offline detection
      church._offlineAlertSent = false; // reset offline alert flag on reconnect
      {
        const statusEvent = {
          type: 'status_update',
          churchId: church.churchId,
          name: church.name,
          status: church.status,
          timestamp: church.lastSeen,
          lastHeartbeat: church.lastHeartbeat,
        };
        broadcastToControllers(statusEvent);
        broadcastToSSE(statusEvent);
      }
      break;

    case 'alert':
      log(`ALERT from ${church.name}: ${msg.message}`);
      {
        const alertEvent = {
          type: 'alert',
          churchId: church.churchId,
          name: church.name,
          severity: msg.severity || 'warning',
          message: msg.message,
          timestamp: church.lastSeen,
        };
        broadcastToControllers(alertEvent);
        broadcastToSSE(alertEvent);
      }
      // Automation: process alert through engines
      if (msg.alertType) {
        (async () => {
          try {
            // Log event
            const eventId = weeklyDigest.addEvent(church.churchId, msg.alertType, msg.message);
            // Try auto-recovery first
            const recovery = await autoRecovery.attempt(church, msg.alertType, church.status);
            if (recovery.attempted && recovery.success) {
              weeklyDigest.resolveEvent(eventId, true);
              log(`[AutoRecovery] ✅ ${recovery.event} for ${church.name}`);
            } else {
              // Send alert through escalation ladder
              const dbChurch = stmtGet.get(church.churchId);
              await alertEngine.sendAlert({ ...church, ...dbChurch }, msg.alertType, { message: msg.message, status: church.status });
            }
          } catch (e) {
            console.error(`Alert processing error for ${church.name}:`, e.message);
          }
        })();
      }
      break;

    case 'command_result': {
      const cmdResultMsg = {
        type: 'command_result',
        churchId: church.churchId,
        name: church.name,
        messageId: msg.id,
        result: msg.result,
        error: msg.error,
      };
      broadcastToControllers(cmdResultMsg);
      if (tallyBot) tallyBot.onCommandResult(cmdResultMsg);
      if (preServiceCheck) preServiceCheck.onCommandResult(cmdResultMsg);
      break;
    }

    case 'preview_frame': {
      // Safety: reject frames > 150KB
      if (msg.data && msg.data.length > 150_000) break;
      church.status.previewActive = true;
      const frameMsg = {
        type: 'preview_frame',
        churchId: church.churchId,
        churchName: church.name,
        timestamp: msg.timestamp,
        width: msg.width,
        height: msg.height,
        format: msg.format,
        data: msg.data,
      };
      broadcastToControllers(frameMsg);
      if (tallyBot) tallyBot.onPreviewFrame(frameMsg);
      totalMessagesRelayed++;
      break;
    }

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

function broadcastToSSE(data) {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (key !== ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ─── OFFLINE BETWEEN-SERVICE DETECTION (Feature 12) ──────────────────────────

function isInMaintenanceWindow(churchId) {
  const now = new Date().toISOString();
  const row = db.prepare(
    `SELECT id FROM maintenance_windows WHERE churchId = ? AND startTime <= ? AND endTime >= ? LIMIT 1`
  ).get(churchId, now, now);
  return !!row;
}

function checkOfflineChurches() {
  const now = Date.now();
  const hour = new Date().getHours();
  const isNightTime = hour >= 23 || hour < 6; // 11pm–6am: don't alert

  const allChurches = db.prepare('SELECT * FROM churches').all();
  const botToken = process.env.ALERT_BOT_TOKEN;
  const andrewChatId = process.env.ANDREW_TELEGRAM_CHAT_ID;

  for (const row of allChurches) {
    const church = churches.get(row.churchId);
    if (!church) continue;
    if (!church.lastHeartbeat) continue; // never connected — skip
    if (isInMaintenanceWindow(row.churchId)) continue;
    if (scheduleEngine.isServiceWindow(row.churchId)) continue; // in service — normal

    const offlineMs = now - church.lastHeartbeat;
    const offlineHours = offlineMs / (1000 * 60 * 60);

    // Already connected — reset flag
    if (church.ws?.readyState === WebSocket.OPEN) {
      church._offlineAlertSent = false;
      church._criticalOfflineAlertSent = false;
      continue;
    }

    if (offlineHours >= 24) {
      // Critical: offline for 24+ hours
      if (!church._criticalOfflineAlertSent && botToken && andrewChatId) {
        church._criticalOfflineAlertSent = true;
        const lastSeen = new Date(church.lastHeartbeat).toLocaleString();
        const msg = `🔴 *CRITICAL: ${row.name}* has been offline for 24+ hours\nLast seen: ${lastSeen}\n\nThis church's booth computer may need attention.`;
        alertEngine.sendTelegramMessage(andrewChatId, botToken, msg).catch(() => {});
        log(`[OfflineDetection] 🔴 CRITICAL: ${row.name} offline 24h+`);
      }
    } else if (offlineHours >= 2 && !isNightTime) {
      // Warning: offline 2+ hours outside of nighttime
      if (!church._offlineAlertSent && botToken && andrewChatId) {
        church._offlineAlertSent = true;
        const lastSeen = new Date(church.lastHeartbeat).toLocaleString();
        const msg = `⚠️ *${row.name}* booth computer offline for 2h+\nLast seen: ${lastSeen}\nNot during service hours — may need attention.`;
        alertEngine.sendTelegramMessage(andrewChatId, botToken, msg).catch(() => {});
        log(`[OfflineDetection] ⚠️ ${row.name} offline 2h+ (not in service window)`);
      }
    }
  }
}

// Check every 10 minutes
setInterval(checkOfflineChurches, 10 * 60 * 1000);

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`Tally Relay running on port ${PORT}`);
  log(`Admin API key: configured (${ADMIN_API_KEY.length} chars)`);
});

// Export for testing
module.exports = { app, server, wss, churches, controllers };
