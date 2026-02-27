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
const helmet = require('helmet');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('node:crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const cookieParser = require('cookie-parser');

const app = express();

// ─── SECURITY HEADERS ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // portal uses inline scripts
      scriptSrcAttr: ["'unsafe-inline'"],         // portal uses inline onclick handlers
      styleSrc: ["'self'", "'unsafe-inline'"],    // portal uses inline styles
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      fontSrc: ["'self'"],
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
// Capture raw JSON body for Stripe webhook signature verification without
// consuming the stream before body-parser.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    const url = req.originalUrl || req.url || '';
    if (url.startsWith('/api/billing/webhook')) {
      req.rawBody = buf.toString('utf8');
    }
  },
}));
app.use(cookieParser());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 }); // 256 KB max message

const { ScheduleEngine } = require('./src/scheduleEngine');
const { AlertEngine } = require('./src/alertEngine');
const { AutoRecovery } = require('./src/autoRecovery');
const { WeeklyDigest } = require('./src/weeklyDigest');
const { TallyBot, parseCommand } = require('./src/telegramBot');
const { aiParseCommand } = require('./src/ai-parser');
const { detectSetupIntent, detectIntentWithAttachment, parsePatchList, generateMixerSetup, parseCameraPlot, buildCameraCommands } = require('./src/ai-setup-assistant');
const { isOnTopic, OFF_TOPIC_RESPONSE } = require('./src/chat-guard');
const { PreServiceCheck } = require('./src/preServiceCheck');
const { MonthlyReport } = require('./src/monthlyReport');
const { OnCallRotation } = require('./src/onCallRotation');
const { GuestTdMode } = require('./src/guestTdMode');
const { SessionRecap } = require('./src/sessionRecap');
const { PlanningCenter } = require('./src/planningCenter');
const { PresetLibrary } = require('./src/presetLibrary');
const { EventMode } = require('./src/eventMode');
const { ResellerSystem } = require('./src/reseller');
const { AutoPilot } = require('./src/autoPilot');
const { ChatEngine } = require('./src/chatEngine');
const { LifecycleEmails } = require('./src/lifecycleEmails');

const { BillingSystem, BILLING_INTERVALS, TRIAL_PERIOD_DAYS } = require('./src/billing');
const { buildDashboardHtml, buildResellerPortalHtml } = require('./src/dashboard');
const { setupSyncMonitor } = require('./src/syncMonitor');
const { setupChurchPortal } = require('./src/churchPortal');
const { setupResellerPortal } = require('./src/resellerPortal');
const { setupStatusPage } = require('./src/statusPage');
const { hasStreamSignal, isStreamActive, isRecordingActive } = require('./src/status-utils');
const { createBackupSnapshot } = require('./src/dbBackup');
const { createRateLimit, consumeRateLimit } = require('./src/rateLimit');
const relayPackage = require('./package.json');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key-change-me';
const JWT_SECRET    = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
const ADMIN_SESSION_COOKIE = 'tally_admin_key';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const CHURCH_APP_TOKEN_TTL = process.env.TALLY_CHURCH_APP_TOKEN_TTL || '30d';
const REQUIRE_ACTIVE_BILLING = (process.env.TALLY_REQUIRE_ACTIVE_BILLING || (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';
const RELAY_VERSION = process.env.RELAY_VERSION || relayPackage.version;
const RELAY_BUILD = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null;
const SUPPORT_TRIAGE_WINDOW_HOURS = Number(process.env.SUPPORT_TRIAGE_WINDOW_HOURS || 24);
const PORT = Number(process.env.PORT || 3000);

// Onboarding email configuration
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Tally by ATEM School <noreply@atemschool.com>';
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://tallyconnect.app';

if (process.env.NODE_ENV === 'production') {
  if (process.env.ADMIN_API_KEY === undefined || process.env.JWT_SECRET === undefined) {
    throw new Error('ADMIN_API_KEY and JWT_SECRET are required in production. Set both in environment variables.');
  }
}
if (ADMIN_API_KEY === 'dev-admin-key-change-me' || JWT_SECRET === 'dev-jwt-secret-change-me') {
  console.warn('\n⚠️  WARNING: Using default dev keys! Set ADMIN_API_KEY and JWT_SECRET env vars for production.\n');
}
const DB_PATH       = process.env.DATABASE_PATH || './data/churches.db';

// ─── TIMER COORDINATION ─────────────────────────────────────────────────────
// Track all setInterval IDs so graceful shutdown can clear them, preventing
// timer leaks and post-close errors.
const _intervals = [];

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const isAdminRoute = (req.path.startsWith('/api/') && !req.path.startsWith('/api/public/')) || req.path.startsWith('/dashboard');

  if (isAdminRoute) {
    // Admin routes: allow explicitly configured origins, localhost for dev, or same-origin flows (no Origin header).
    const isProduction = process.env.NODE_ENV === 'production';
    const allowAdminOrigin =
      !origin ||
      (!isProduction && (origin.startsWith('http://localhost') || origin.startsWith('https://localhost'))) ||
      ALLOWED_ORIGINS.includes(origin);

    if (allowAdminOrigin) {
      if (origin) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
      }
    }
  } else {
    // Public routes (church client WebSocket upgrade, health check): allow all
    res.header('Access-Control-Allow-Origin', '*');
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-reseller-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── SECURITY: CONSTANT-TIME KEY COMPARISON ──────────────────────────────────
// Prevents timing attacks on API key validation by always comparing in constant
// time regardless of where the mismatch occurs.

function safeCompareKey(untrusted, trusted) {
  if (typeof untrusted !== 'string' || typeof trusted !== 'string') return false;
  if (untrusted.length === 0 || trusted.length === 0) return false;
  const a = Buffer.from(untrusted, 'utf8');
  const b = Buffer.from(trusted, 'utf8');
  // timingSafeEqual requires equal-length buffers; pad the shorter one
  // to avoid leaking length information.
  if (a.length !== b.length) {
    const padded = Buffer.alloc(b.length);
    a.copy(padded, 0, 0, Math.min(a.length, b.length));
    return crypto.timingSafeEqual(padded, b) && a.length === b.length;
  }
  return crypto.timingSafeEqual(a, b);
}

// ─── ERROR DETAIL MASKING ────────────────────────────────────────────────────
// In production, internal error details are replaced with a generic message to
// avoid leaking stack traces or implementation details to clients.

function safeErrorMessage(err, fallback = 'Internal server error') {
  if (process.env.NODE_ENV === 'production') return fallback;
  return err?.message || fallback;
}

// ─── ONBOARDING EMAILS (via Resend) ─────────────────────────────────────────

async function sendOnboardingEmail({ to, subject, html, text, tag }) {
  if (!RESEND_API_KEY) {
    log(`[onboarding-email] No RESEND_API_KEY — would send "${subject}" to ${to}`);
    return { sent: false, reason: 'no-api-key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject,
        html,
        text,
        tags: [{ name: 'category', value: tag || 'onboarding' }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text();
      log(`[onboarding-email] Resend failed (${res.status}): ${err}`);
      return { sent: false, reason: 'resend-error' };
    }
    const data = await res.json();
    log(`[onboarding-email] Sent "${subject}" to ${to}, id: ${data.id}`);
    return { sent: true, id: data.id };
  } catch (e) {
    log(`[onboarding-email] Send failed: ${e.message}`);
    return { sent: false, reason: 'network-error' };
  }
}

function buildConnectionEmailHtml({ churchName, registrationCode, portalUrl }) {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 0;">
      <div style="margin-bottom: 24px;">
        <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-right: 8px;"></span>
        <strong style="font-size: 16px; color: #111;">Tally</strong>
      </div>

      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Tally is live at ${churchName}!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6; margin: 0 0 24px;">
        Your booth computer just connected to Tally. You're now being monitored in real-time.
      </p>

      <div style="margin-bottom: 20px; padding: 16px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 8px;">What Tally is doing for you right now:</div>
        <ul style="font-size: 14px; color: #333; margin: 0; padding-left: 20px; line-height: 1.8;">
          <li>Monitoring your ATEM, OBS, and connected devices</li>
          <li>Watching for stream drops, disconnects, and audio issues</li>
          <li>Ready to auto-recover if anything goes wrong</li>
          <li>Pre-service checks will run 30 minutes before your scheduled services</li>
        </ul>
      </div>

      <div style="margin-bottom: 20px; padding: 16px; background: #f8faf9; border-radius: 10px; border: 1px solid #e5e7eb;">
        <div style="font-size: 14px; font-weight: 700; color: #111; margin-bottom: 8px;">Tips for your first Sunday:</div>
        <ol style="font-size: 14px; color: #555; margin: 0; padding-left: 20px; line-height: 1.8;">
          <li>Make sure the booth computer stays on and connected to the internet</li>
          <li>Check the dashboard before service to confirm all devices are green</li>
          <li>If something auto-recovers during service, you'll get a Telegram alert</li>
        </ol>
      </div>

      ${registrationCode ? `
      <div style="margin-bottom: 20px; padding: 16px; background: #fffbeb; border-radius: 10px; border: 1px solid #fde68a;">
        <div style="font-size: 13px; font-weight: 700; color: #b45309; margin-bottom: 6px;">SET UP TELEGRAM ALERTS</div>
        <p style="font-size: 14px; color: #555; margin: 0 0 8px; line-height: 1.5;">
          Have your tech directors send this command to <strong>@tallybot</strong> on Telegram:
        </p>
        <div style="font-family: ui-monospace, monospace; font-size: 18px; font-weight: 700; color: #111; letter-spacing: 0.08em; padding: 6px 0;">
          /register ${registrationCode}
        </div>
      </div>
      ` : ''}

      <p style="margin: 24px 0;">
        <a href="${portalUrl}" style="
          display: inline-block; padding: 12px 28px; font-size: 15px; font-weight: 700;
          background: #22c55e; color: #000; text-decoration: none; border-radius: 8px;
        ">Open Church Portal</a>
      </p>

      <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
      <p style="font-size: 12px; color: #999;">
        Tally by ATEM School &mdash; <a href="https://tallyconnect.app" style="color: #999;">tallyconnect.app</a>
      </p>
    </div>
  `;
}

function buildConnectionEmailText({ churchName, registrationCode, portalUrl }) {
  return `Tally is live at ${churchName}!

Your booth computer just connected to Tally. You're now being monitored in real-time.

What Tally is doing for you right now:
- Monitoring your ATEM, OBS, and connected devices
- Watching for stream drops, disconnects, and audio issues
- Ready to auto-recover if anything goes wrong
- Pre-service checks will run 30 min before scheduled services

Tips for your first Sunday:
1. Make sure the booth computer stays on and connected to the internet
2. Check the dashboard before service to confirm all devices are green
3. If something auto-recovers during service, you'll get a Telegram alert
${registrationCode ? `
Set up Telegram alerts — have your TDs send this to @tallybot:
/register ${registrationCode}
` : ''}
Church Portal: ${portalUrl}

Tally by ATEM School — tallyconnect.app`;
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

const resellerSystem = new ResellerSystem(db);

// ─── SCHEMA MIGRATIONS ───────────────────────────────────────────────────────
// Run safe ALTER TABLE migrations for new columns — ignore "column already exists" errors

const _schemaMigrations = [
  "ALTER TABLE churches ADD COLUMN church_type TEXT DEFAULT 'recurring'",
  "ALTER TABLE churches ADD COLUMN event_expires_at TEXT",
  "ALTER TABLE churches ADD COLUMN event_label TEXT",
  "ALTER TABLE churches ADD COLUMN reseller_id TEXT",
  "ALTER TABLE churches ADD COLUMN registration_code TEXT",
  "ALTER TABLE churches ADD COLUMN portal_email TEXT",
  "ALTER TABLE churches ADD COLUMN portal_password_hash TEXT",
  "ALTER TABLE churches ADD COLUMN tos_accepted_at TEXT",
  "ALTER TABLE churches ADD COLUMN billing_interval TEXT",
  // Onboarding milestone tracking
  "ALTER TABLE churches ADD COLUMN onboarding_app_connected_at TEXT",
  "ALTER TABLE churches ADD COLUMN onboarding_atem_connected_at TEXT",
  "ALTER TABLE churches ADD COLUMN onboarding_first_session_at TEXT",
  "ALTER TABLE churches ADD COLUMN onboarding_telegram_registered_at TEXT",
  "ALTER TABLE churches ADD COLUMN onboarding_dismissed INTEGER DEFAULT 0",
  // Email verification
  "ALTER TABLE churches ADD COLUMN email_verified INTEGER DEFAULT 0",
  "ALTER TABLE churches ADD COLUMN email_verify_token TEXT",
  "ALTER TABLE churches ADD COLUMN email_verify_sent_at TEXT",
];
for (const m of _schemaMigrations) {
  try { db.exec(m); } catch { /* column already exists */ }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_churches_portal_email ON churches(portal_email)');

// Performance indexes for commonly queried columns
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_church_tds_church_id ON church_tds(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_church_id ON alerts(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_events_church_id ON service_events(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_sessions_church_id ON service_sessions(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_guest_tokens_church_id ON guest_tokens(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_churches_reseller_id ON churches(reseller_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_billing_customers_church_id ON billing_customers(church_id)');
} catch { /* tables may not exist yet — indexes will be created when they are */ }

// ─── ADMIN USERS TABLE ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'admin',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    created_by    TEXT,
    last_login_at TEXT,
    updated_at    TEXT
  )
`);

// Seed initial super_admin from env vars (only when table is empty)
{
  const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM admin_users').get().cnt;
  if (adminCount === 0 && process.env.ADMIN_SEED_EMAIL && process.env.ADMIN_SEED_PASSWORD) {
    const { v4: _uuid } = require('uuid');
    const _seedSalt = crypto.randomBytes(16).toString('hex');
    const _seedHash = crypto.scryptSync(process.env.ADMIN_SEED_PASSWORD, _seedSalt, 64).toString('hex');
    db.prepare(
      'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(_uuid(), process.env.ADMIN_SEED_EMAIL.trim().toLowerCase(), `${_seedSalt}:${_seedHash}`, 'Admin', 'super_admin', 1, new Date().toISOString());
    console.log(`[AdminUsers] Seeded initial super_admin: ${process.env.ADMIN_SEED_EMAIL}`);
  } else if (adminCount === 0) {
    console.log('[AdminUsers] No admin users exist. Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD to create the first super_admin.');
  }
}

const stmtInsert = db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)');
const stmtUpdateRegistrationCode = db.prepare('UPDATE churches SET registration_code = ? WHERE churchId = ?');
const stmtAll = db.prepare('SELECT * FROM churches');
const stmtGet = db.prepare('SELECT * FROM churches WHERE churchId = ?');
const stmtFindByName = db.prepare('SELECT * FROM churches WHERE name = ?');
const stmtFindByRegistrationCode = db.prepare('SELECT 1 FROM churches WHERE registration_code = ?');
const stmtDelete = db.prepare('DELETE FROM churches WHERE churchId = ?');

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

const RATE_LIMIT = 10; // commands per second
const STATUS_STATES = ['operational', 'degraded', 'outage'];
const supportCategories = new Set([
  'stream_down',
  'no_audio_stream',
  'slides_issue',
  'atem_connectivity',
  'recording_issue',
  'other',
]);
const supportSeverities = new Set(['P1', 'P2', 'P3', 'P4']);
const supportTicketStates = new Set(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed']);
let statusCheckInFlight = false;
let lastStatusCheckAt = null;

// Load churches from DB
for (const row of stmtAll.all()) {
  let registrationCode = row.registration_code || null;
  if (!registrationCode) {
    registrationCode = generateRegistrationCode();
    stmtUpdateRegistrationCode.run(registrationCode, row.churchId);
  }

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
    // Event mode fields
    church_type:      row.church_type      || 'recurring',
    event_expires_at: row.event_expires_at || null,
    event_label:      row.event_label      || null,
    // Reseller field
    reseller_id:      row.reseller_id      || null,
    registrationCode,
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

db.exec(`
  CREATE TABLE IF NOT EXISTS support_triage_runs (
    id TEXT PRIMARY KEY,
    church_id TEXT NOT NULL,
    issue_category TEXT NOT NULL,
    severity TEXT NOT NULL,
    summary TEXT DEFAULT '',
    triage_result TEXT NOT NULL,
    diagnostics_json TEXT NOT NULL,
    autofix_attempts_json TEXT DEFAULT '[]',
    timezone TEXT,
    app_version TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    church_id TEXT NOT NULL,
    triage_id TEXT,
    issue_category TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    forced_bypass INTEGER NOT NULL DEFAULT 0,
    diagnostics_json TEXT DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS support_ticket_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    message TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS status_components (
    component_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL,
    latency_ms INTEGER,
    detail TEXT DEFAULT '',
    last_checked_at TEXT NOT NULL,
    last_changed_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS status_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component_id TEXT NOT NULL,
    previous_state TEXT NOT NULL,
    new_state TEXT NOT NULL,
    message TEXT DEFAULT '',
    started_at TEXT NOT NULL,
    resolved_at TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_support_triage_church ON support_triage_runs(church_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_support_ticket_church ON support_tickets(church_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_support_ticket_status ON support_tickets(status, updated_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_support_ticket_updates_ticket ON support_ticket_updates(ticket_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_status_incidents_component ON status_incidents(component_id, started_at DESC)');

// ─── Problem Finder reports table ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS problem_finder_reports (
    id TEXT PRIMARY KEY,
    church_id TEXT NOT NULL,
    trigger_type TEXT DEFAULT 'manual',
    status TEXT NOT NULL,
    issue_count INTEGER DEFAULT 0,
    auto_fixed_count INTEGER DEFAULT 0,
    coverage_score REAL DEFAULT 0,
    blocker_count INTEGER DEFAULT 0,
    issues_json TEXT DEFAULT '[]',
    blockers_json TEXT DEFAULT '[]',
    auto_fixed_json TEXT DEFAULT '[]',
    needs_attention_json TEXT DEFAULT '[]',
    top_actions_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_pf_reports_church ON problem_finder_reports(church_id, created_at DESC)');

// Slack integration columns (safe to run multiple times)
for (const col of ['slack_webhook_url', 'slack_channel']) {
  try { db.exec(`ALTER TABLE churches ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
}

// Preset library table
const presetLibrary = new PresetLibrary(db);

// ─── AUTOMATION ENGINES ──────────────────────────────────────────────────────

const scheduleEngine = new ScheduleEngine(db);
const billing = new BillingSystem(db);
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

// ─── SESSION RECAP ────────────────────────────────────────────────────────────

const sessionRecap = new SessionRecap(db);
sessionRecap.setNotificationConfig(
  process.env.ALERT_BOT_TOKEN,
  process.env.ANDREW_TELEGRAM_CHAT_ID
);

// Hook schedule engine window transitions → session lifecycle
scheduleEngine.addWindowOpenCallback((churchId) => {
  try {
    const onCallTd = onCallRotation.getOnCallTD(churchId);
    sessionRecap.startSession(churchId, onCallTd?.name || null);
  } catch (e) {
    console.error(`[SessionRecap] onWindowOpen error for ${churchId}:`, e.message);
  }
});

scheduleEngine.addWindowCloseCallback(async (churchId) => {
  try {
    const sessionData = await sessionRecap.endSession(churchId);
    // Write production notes back to Planning Center
    if (sessionData) {
      planningCenter.writeServiceNotes(churchId, sessionData).catch(e =>
        console.warn(`[PlanningCenter] Write-back error for ${churchId}:`, e.message)
      );
    }
  } catch (e) {
    console.error(`[SessionRecap] onWindowClose error for ${churchId}:`, e.message);
  }
});

scheduleEngine.startPolling();

// ─── AUTOPILOT ───────────────────────────────────────────────────────────────

const autoPilot = new AutoPilot(db, { scheduleEngine, sessionRecap, billing });

// Set command executor — sends commands to church clients via WebSocket
autoPilot.setCommandExecutor(async (churchId, command, params, source) => {
  const church = churches.get(churchId);
  if (!church) throw new Error('Church not found');
  const sender = makeCommandSender(church);
  return await sender(command, params);
});

// Reset autopilot session dedup on window open
scheduleEngine.addWindowOpenCallback((churchId) => {
  try { autoPilot.resetSession(churchId); } catch {}
});

// Schedule timer — check every minute for schedule_timer triggers
_intervals.push(setInterval(() => {
  for (const [churchId] of churches) {
    if (!scheduleEngine.isServiceWindow(churchId)) continue;
    // Use session start time to calculate minutes into service
    const session = sessionRecap.activeSessions.get(churchId);
    if (!session?.startedAt) continue;
    const minutesIn = Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 60000);
    autoPilot.onScheduleTick(churchId, minutesIn).catch(e =>
      console.error(`[AutoPilot] Schedule tick error for ${churchId}:`, e.message)
    );
  }
}, 60000));

// ─── CHAT ENGINE ─────────────────────────────────────────────────────────────

const chatEngine = new ChatEngine(db, { sessionRecap });

// ─── PLANNING CENTER ──────────────────────────────────────────────────────────

const planningCenter = new PlanningCenter(db);
planningCenter.setScheduleEngine(scheduleEngine);
planningCenter.start();

// ─── TRIAL EXPIRATION CRON ────────────────────────────────────────────────────
// Every hour, check for expired trials and deactivate them.

function checkExpiredTrials() {
  try {
    const now = new Date().toISOString();
    const expired = db.prepare(`
      SELECT churchId, name, billing_trial_ends
      FROM churches
      WHERE billing_status = 'trialing'
        AND billing_trial_ends IS NOT NULL
        AND billing_trial_ends < ?
    `).all(now);

    for (const church of expired) {
      db.prepare('UPDATE churches SET billing_status = ? WHERE churchId = ?')
        .run('trial_expired', church.churchId);
      // Also update billing_customers if a record exists
      db.prepare(`UPDATE billing_customers SET status = 'trial_expired', updated_at = ? WHERE church_id = ?`)
        .run(now, church.churchId);

      log(`[TrialExpiry] Trial expired for "${church.name}" (${church.churchId}) — trial ended ${church.billing_trial_ends}`);

      // Send trial-expired email (non-blocking)
      if (lifecycleEmails) {
        const fullChurch = db.prepare('SELECT churchId, name, portal_email FROM churches WHERE churchId = ?').get(church.churchId);
        if (fullChurch) lifecycleEmails.sendTrialExpired(fullChurch).catch(() => {});
      }

      // Disconnect the church if it's currently connected
      const runtime = churches.get(church.churchId);
      if (runtime?.ws?.readyState === 1) {
        runtime.ws.close(1008, 'billing_trial_expired');
        log(`[TrialExpiry] Disconnected "${church.name}" due to expired trial`);
      }
    }

    if (expired.length > 0) {
      log(`[TrialExpiry] Deactivated ${expired.length} expired trial(s)`);
    }
  } catch (e) {
    console.error('[TrialExpiry] Error:', e.message);
  }
}

// ─── GRACE PERIOD ENFORCEMENT ─────────────────────────────────────────────
// Deactivate churches whose payment grace period has expired.
function enforceGracePeriods() {
  try {
    const now = new Date().toISOString();
    const expired = db.prepare(`
      SELECT bc.church_id, bc.grace_ends_at, c.name
      FROM billing_customers bc
      LEFT JOIN churches c ON c.churchId = bc.church_id
      WHERE bc.status = 'past_due'
        AND bc.grace_ends_at IS NOT NULL
        AND bc.grace_ends_at < ?
    `).all(now);

    for (const row of expired) {
      db.prepare("UPDATE billing_customers SET status = 'inactive', updated_at = ? WHERE church_id = ?").run(now, row.church_id);
      db.prepare("UPDATE churches SET billing_status = 'inactive' WHERE churchId = ?").run(row.church_id);

      // Disconnect client
      const runtime = churches.get(row.church_id);
      if (runtime?.ws?.readyState === 1) {
        runtime.ws.close(1008, 'billing_grace_expired');
      }

      log(`[GracePeriod] ⏰ Grace period expired for "${row.name}" (${row.church_id}) — deactivated`);

      // Send grace-expired email
      if (lifecycleEmails) {
        const church = db.prepare('SELECT churchId, name, portal_email FROM churches WHERE churchId = ?').get(row.church_id);
        if (church) lifecycleEmails.sendGraceExpired(church).catch(() => {});
      }
    }

    if (expired.length > 0) {
      log(`[GracePeriod] Deactivated ${expired.length} church(es) with expired grace periods`);
    }
  } catch (e) {
    console.error('[GracePeriod] Error:', e.message);
  }
}

// Run immediately on startup, then every hour
checkExpiredTrials();
enforceGracePeriods();
_intervals.push(setInterval(checkExpiredTrials, 60 * 60 * 1000));
_intervals.push(setInterval(enforceGracePeriods, 60 * 60 * 1000));

// ─── CHAT LOG PRUNING (nightly, 30-day retention) ────────────────────────────
chatEngine.pruneOldMessages(30); // run on startup
_intervals.push(setInterval(() => chatEngine.pruneOldMessages(30), 24 * 60 * 60 * 1000));

// ─── LIFECYCLE EMAILS ────────────────────────────────────────────────────────
// Automated email sequences: setup nudge, first-sunday prep, check-in,
// trial warnings, trial expired, payment failed, weekly digest.

const lifecycleEmails = new LifecycleEmails(db, {
  resendApiKey: RESEND_API_KEY,
  fromEmail: FROM_EMAIL,
  appUrl: APP_URL,
});
billing.setLifecycleEmails(lifecycleEmails);

// Run lifecycle email checks every hour
_intervals.push(setInterval(() => {
  lifecycleEmails.runCheck().catch(e =>
    console.error('[LifecycleEmails] Check failed:', e.message)
  );
}, 60 * 60 * 1000));

// ─── RESELLER SYSTEM (needed early for TallyBot) ────────────────────────────

// Initialized earlier after DB setup so it is always available before any dependent services start.

// ─── TELEGRAM BOT ────────────────────────────────────────────────────────────

const TALLY_BOT_TOKEN = process.env.TALLY_BOT_TOKEN;
const TALLY_BOT_WEBHOOK_URL = process.env.TALLY_BOT_WEBHOOK_URL;
const TALLY_BOT_WEBHOOK_SECRET = process.env.TALLY_BOT_WEBHOOK_SECRET || '';
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
    presetLibrary,
    planningCenter,
    resellerSystem,
    autoPilot,
    chatEngine,
  });
  log('Telegram bot initialized');
  // Non-blocking webhook setup (fires after app is ready)
  if (TALLY_BOT_WEBHOOK_URL) {
    const webhookPayload = { url: TALLY_BOT_WEBHOOK_URL };
    if (TALLY_BOT_WEBHOOK_SECRET) {
      webhookPayload.secret_token = TALLY_BOT_WEBHOOK_SECRET;
    }
    setImmediate(() => {
      tallyBot.setWebhook(webhookPayload).catch(e => console.error('[TallyBot] Webhook setup failed:', e.message));
    });
  }
} else {
  log('Telegram bot disabled (TALLY_BOT_TOKEN not set)');
}

// ─── PLATFORM STATUS CHECKS (1-minute synthetic monitor) ────────────────────

_intervals.push(setInterval(() => {
  runStatusChecks().catch((e) => {
    console.error('[StatusChecks] scheduled run failed:', e.message);
  });
}, 60_000));

// ─── DB BACKUP SCHEDULER ─────────────────────────────────────────────────────

const DB_BACKUP_INTERVAL_MINUTES = Number(process.env.DB_BACKUP_INTERVAL_MINUTES || 0);
if (Number.isFinite(DB_BACKUP_INTERVAL_MINUTES) && DB_BACKUP_INTERVAL_MINUTES > 0) {
  log(`[Backup] Scheduled snapshots every ${DB_BACKUP_INTERVAL_MINUTES} minute(s)`);
  _intervals.push(setInterval(() => {
    try {
      const snapshot = runManualDbSnapshot('auto');
      log(`[Backup] Snapshot created: ${snapshot.fullPath}`);
    } catch (e) {
      console.error('[Backup] Scheduled snapshot failed:', e.message);
    }
  }, DB_BACKUP_INTERVAL_MINUTES * 60 * 1000));
}

// Wire chat engine broadcast functions (uses hoisted broadcastToControllers)
chatEngine.setBroadcasters({
  broadcastToChurch: (churchId, msg) => {
    const church = churches.get(churchId);
    if (church?.ws?.readyState === WebSocket.OPEN) {
      church.ws.send(JSON.stringify(msg));
    }
  },
  broadcastToControllers: (msg) => broadcastToControllers(msg),
  notifyTelegram: (churchId, savedMsg) => {
    if (!tallyBot) return;
    const sourceIcon = { app: '💻', dashboard: '🌐', telegram: '📱' }[savedMsg.source] || '💬';
    const text = `${sourceIcon} *${savedMsg.sender_name}*:\n${savedMsg.message}`;
    // Notify TD(s) for this church
    const tds = db.prepare('SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1').all(churchId);
    for (const td of tds) {
      if (td.telegram_chat_id && savedMsg.source !== 'telegram') {
        tallyBot.sendMessage(td.telegram_chat_id, text).catch(() => {});
      }
    }
    // Notify admin if message is from a TD
    if (savedMsg.sender_role === 'td' && tallyBot.adminChatId) {
      const churchRow = db.prepare('SELECT name FROM churches WHERE churchId = ?').get(churchId);
      const adminText = `${sourceIcon} *${savedMsg.sender_name}* (${churchRow?.name || churchId}):\n${savedMsg.message}`;
      tallyBot.sendMessage(tallyBot.adminChatId, adminText).catch(() => {});
    }
  },
});

// ─── A/V SYNC MONITOR ────────────────────────────────────────────────────────

setupSyncMonitor(db, { churches }, tallyBot, (churchId) => {
  broadcastToSSE({ type: 'sync_update', churchId });
});

// ─── EVENT MODE & RESELLER SYSTEM ────────────────────────────────────────────

const eventMode = new EventMode(db);
eventMode.start(tallyBot, churches);

// Wire resellerSystem into alertEngine for white-label brand names
alertEngine.resellerSystem = resellerSystem;

// ─── ADMIN + RESELLER PORTALS ─────────────────────────────────────────────────
const { setupAdminPanel } = require('./src/adminPanel');
setupAdminPanel(app, db, churches, resellerSystem);

// Church Portal — self-service login for individual churches
setupChurchPortal(app, db, churches, JWT_SECRET, requireAdmin, { billing, lifecycleEmails });
console.log('[Server] ✓ Church Portal routes registered');

// Reseller Portal — self-service login for integrators/resellers
setupResellerPortal(app, db, churches, resellerSystem, JWT_SECRET, requireAdmin);
console.log('[Server] ✓ Reseller Portal routes registered');

// Public status page
setupStatusPage(app);
console.log('[Server] ✓ Status page route registered');

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

async function checkCommandRateLimit(churchId) {
  const state = await consumeRateLimit({
    scope: 'ws-command',
    key: churchId,
    maxAttempts: RATE_LIMIT,
    windowMs: 1000,
  });
  return {
    ok: !state.limited,
    retryAfterSec: state.retryAfterSec,
  };
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

// Health / root endpoints (extracted)
require('./src/routes/health')(app, {
  churches, controllers, RELAY_VERSION, RELAY_BUILD, WebSocket,
  get totalMessagesRelayed() { return totalMessagesRelayed; },
});

// Shared auth utilities (single source of truth — also used by churchPortal.js)
const { hashPassword, verifyPassword, generateRegistrationCode: _genRegCode } = require('./src/auth');
function generateRegistrationCode() {
  return _genRegCode(db);
}

function issueChurchAppToken(churchId, name) {
  return jwt.sign({ type: 'church_app', churchId, name }, JWT_SECRET, { expiresIn: CHURCH_APP_TOKEN_TTL });
}

function rateLimit(maxAttempts = 10, windowMs = 15 * 60 * 1000) {
  return createRateLimit({
    scope: 'api',
    maxAttempts,
    windowMs,
  });
}

const BILLING_TIERS = new Set(['connect', 'plus', 'pro', 'managed', 'event']);
const BILLING_STATUSES = new Set(['active', 'trialing', 'inactive', 'pending', 'past_due', 'canceled', 'trial_expired']);
const BILLING_INTERVAL_ALIASES = new Map([
  ['monthly', 'monthly'],
  ['month', 'monthly'],
  ['annual', 'annual'],
  ['annually', 'annual'],
  ['yearly', 'annual'],
  ['year', 'annual'],
  ['one_time', 'one_time'],
  ['one-time', 'one_time'],
  ['event', 'one_time'],
]);

function normalizeBillingInterval(raw, tier, fallback) {
  const normalizedTier = String(tier || '').toLowerCase();
  if (normalizedTier === 'event') return 'one_time';
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const key = String(raw).trim().toLowerCase();
  const normalized = BILLING_INTERVAL_ALIASES.get(key) || BILLING_INTERVAL_ALIASES.get(key.replace(/\s+/g, '_')) || null;
  if (!normalized || normalized === 'one_time') return null;
  return BILLING_INTERVALS.has(normalized) ? normalized : null;
}

function getChurchBillingSnapshot(churchId) {
  const church = stmtGet.get(churchId);
  if (!church) {
    return { exists: false, tier: null, status: 'not_found' };
  }

  const billingRow = db.prepare(`
    SELECT tier, status, trial_ends_at, grace_ends_at, billing_interval
    FROM billing_customers
    WHERE church_id = ?
    ORDER BY datetime(updated_at) DESC
    LIMIT 1
  `).get(churchId);

  const resolvedTier = church.billing_tier || billingRow?.tier || null;
  const resolvedInterval =
    normalizeBillingInterval(church.billing_interval || billingRow?.billing_interval, resolvedTier, resolvedTier === 'event' ? 'one_time' : 'monthly') ||
    (resolvedTier === 'event' ? 'one_time' : 'monthly');

  return {
    exists: true,
    tier: resolvedTier,
    billingInterval: resolvedInterval,
    status: String(church.billing_status || billingRow?.status || 'inactive').toLowerCase(),
    trialEndsAt: church.billing_trial_ends || billingRow?.trial_ends_at || null,
    graceEndsAt: billingRow?.grace_ends_at || null,
  };
}

function checkChurchPaidAccess(churchId) {
  const snapshot = getChurchBillingSnapshot(churchId);
  if (!snapshot.exists) {
    return { allowed: false, status: 'not_found', message: 'Church account not found.' };
  }

  if (!REQUIRE_ACTIVE_BILLING || !billing.isEnabled()) {
    return { allowed: true, ...snapshot, bypassed: true };
  }

  if (snapshot.status === 'active') {
    return { allowed: true, ...snapshot };
  }

  // For trialing: check if trial has expired
  if (snapshot.status === 'trialing') {
    if (snapshot.trialEndsAt && new Date(snapshot.trialEndsAt) < new Date()) {
      return {
        allowed: false,
        ...snapshot,
        status: 'trial_expired',
        message: 'Your free trial has ended. Subscribe at tallyconnect.app to continue.',
      };
    }
    return { allowed: true, ...snapshot };
  }

  // Grace period for past_due: allow access during the grace window
  if (snapshot.status === 'past_due') {
    if (snapshot.graceEndsAt && new Date(snapshot.graceEndsAt) > new Date()) {
      return { allowed: true, ...snapshot, inGracePeriod: true };
    }
    return {
      allowed: false,
      ...snapshot,
      message: 'Payment is overdue and grace period has ended. Update payment at tallyconnect.app to restore access.',
    };
  }

  return {
    allowed: false,
    ...snapshot,
    message: `Subscription is "${snapshot.status}". Complete billing to connect this system.`,
  };
}

function normalizeSupportCategory(value) {
  const normalized = String(value || 'other').trim().toLowerCase().replace(/\s+/g, '_');
  return supportCategories.has(normalized) ? normalized : 'other';
}

function normalizeSupportSeverity(value) {
  const normalized = String(value || 'P3').trim().toUpperCase();
  return supportSeverities.has(normalized) ? normalized : 'P3';
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildSupportDiagnostics(churchId, options = {}) {
  const runtime = churches.get(churchId);
  const now = Date.now();
  const sinceIso = new Date(now - 15 * 60 * 1000).toISOString();
  const recentAlerts = db.prepare(`
    SELECT id, alert_type, severity, context, created_at, acknowledged_at, resolved
    FROM alerts
    WHERE church_id = ? AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 25
  `).all(churchId, sinceIso).map((row) => ({
    id: row.id,
    alertType: row.alert_type,
    severity: row.severity,
    context: safeJsonParse(row.context, {}),
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    resolved: !!row.resolved,
  }));

  return {
    churchId,
    campusId: options.campusId || null,
    room: options.room || null,
    timezone: options.timezone || null,
    issueCategory: normalizeSupportCategory(options.issueCategory),
    severity: normalizeSupportSeverity(options.severity),
    relayVersion: RELAY_VERSION,
    appVersion: options.appVersion || null,
    generatedAt: new Date().toISOString(),
    connection: {
      churchClientConnected: runtime?.ws?.readyState === WebSocket.OPEN,
      lastSeen: runtime?.lastSeen || null,
      lastHeartbeat: runtime?.lastHeartbeat || null,
      secondsSinceHeartbeat: runtime?.lastHeartbeat ? Math.floor((now - runtime.lastHeartbeat) / 1000) : null,
    },
    deviceHealth: runtime?.status || {},
    recentAlerts,
    serviceWindow: scheduleEngine.isServiceWindow(churchId),
    autoFixAttempts: Array.isArray(options.autoFixAttempts) ? options.autoFixAttempts : [],
  };
}

function computeTriageResult(diagnostics) {
  const checks = [];
  const issueCategory = diagnostics.issueCategory;
  const status = diagnostics.deviceHealth || {};

  checks.push({
    key: 'church_client_connection',
    ok: !!diagnostics.connection.churchClientConnected,
    note: diagnostics.connection.churchClientConnected
      ? 'Church client currently connected'
      : 'Church client is offline',
  });

  if (issueCategory === 'stream_down') {
    const streaming = isStreamActive(status);
    checks.push({
      key: 'stream_state',
      ok: streaming,
      note: streaming ? 'Stream appears active' : 'Stream appears inactive',
    });
  }

  if (issueCategory === 'no_audio_stream') {
    const audioOk = status.obs?.audioConnected !== false
      && status.mixer?.mainMuted !== true
      && status.audio?.silenceDetected !== true;
    checks.push({
      key: 'audio_path',
      ok: audioOk,
      note: audioOk ? 'No hard audio mute detected' : 'Audio path likely muted/disconnected',
    });
  }

  if (issueCategory === 'atem_connectivity') {
    checks.push({
      key: 'atem_link',
      ok: status.atem?.connected === true,
      note: status.atem?.connected ? 'ATEM reports connected' : 'ATEM disconnected',
    });
  }

  if (issueCategory === 'recording_issue') {
    const recording = isRecordingActive(status);
    checks.push({
      key: 'recording_state',
      ok: recording,
      note: recording ? 'Recording appears active' : 'Recording appears inactive',
    });
  }

  const autoFixed = (diagnostics.autoFixAttempts || []).some((attempt) => attempt && attempt.success === true);
  const failedChecks = checks.filter((check) => !check.ok).length;
  const triageResult = autoFixed
    ? 'auto_resolved'
    : failedChecks > 0
      ? 'needs_escalation'
      : 'monitoring';

  return { checks, triageResult };
}

function requireSupportAccess(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
      if (payload.type === 'church_app') {
        const church = db.prepare('SELECT churchId, name FROM churches WHERE churchId = ?').get(payload.churchId);
        if (!church) return res.status(404).json({ error: 'Church not found' });
        req.supportActor = { type: 'church', churchId: church.churchId, name: church.name };
        return next();
      }
    } catch {
      // Continue to admin auth fallback
    }
  }

  return requireAdminJwt()(req, res, () => {
    req.supportActor = {
      type: 'admin',
      adminUser: req.adminUser || { id: 'unknown', role: 'super_admin' },
    };
    next();
  });
}

function resolveSupportChurchId(req) {
  if (req.supportActor?.type === 'church') {
    return req.supportActor.churchId;
  }
  return req.params.churchId || req.body?.churchId || req.query?.churchId || null;
}

function statusByResult(ok, detailOk, detailFail) {
  if (ok) return { state: 'operational', detail: detailOk };
  return { state: 'outage', detail: detailFail };
}

async function timedFetch(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 5000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      body: options.readJson ? await response.json() : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function upsertStatusComponent({ componentId, name, state, latencyMs = null, detail = '' }) {
  if (!STATUS_STATES.includes(state)) state = 'degraded';
  const nowIso = new Date().toISOString();
  const previous = db.prepare('SELECT state FROM status_components WHERE component_id = ?').get(componentId);

  if (!previous) {
    db.prepare(`
      INSERT INTO status_components (component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(componentId, name, state, latencyMs, detail, nowIso, nowIso);
    if (state !== 'operational') {
      db.prepare(`
        INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(componentId, 'unknown', state, detail, nowIso);
    }
    return;
  }

  const changed = previous.state !== state;
  db.prepare(`
    UPDATE status_components
    SET name = ?, state = ?, latency_ms = ?, detail = ?, last_checked_at = ?, last_changed_at = ?
    WHERE component_id = ?
  `).run(name, state, latencyMs, detail, nowIso, changed ? nowIso : db.prepare('SELECT last_changed_at FROM status_components WHERE component_id = ?').pluck().get(componentId), componentId);

  if (!changed) return;

  db.prepare(`
    UPDATE status_incidents
    SET resolved_at = ?
    WHERE id = (
      SELECT id FROM status_incidents
      WHERE component_id = ? AND resolved_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    )
  `).run(nowIso, componentId);

  if (state !== 'operational') {
    db.prepare(`
      INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(componentId, previous.state, state, detail, nowIso);
  }
}

async function runStatusChecks() {
  if (statusCheckInFlight) return;
  statusCheckInFlight = true;
  try {
    const normalizeUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        parsed.hash = '';
        parsed.search = '';
        return parsed.toString().replace(/\/$/, '');
      } catch {
        return '';
      }
    };

    const adminProxyTargets = [];
    const addAdminProxyTarget = (value) => {
      const normalized = normalizeUrl(value);
      if (!normalized) return;
      if (!adminProxyTargets.includes(normalized)) adminProxyTargets.push(normalized);
    };

    addAdminProxyTarget(process.env.ADMIN_PROXY_URL || process.env.ADMIN_API_PROXY_URL || '');
    addAdminProxyTarget(process.env.APP_URL || '');

    // Auto-fallback: if APP_URL is a web app domain, also try api.<domain>.
    const appUrl = normalizeUrl(process.env.APP_URL || '');
    if (appUrl) {
      try {
        const parsed = new URL(appUrl);
        const host = parsed.hostname || '';
        const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        if (host && !host.startsWith('api.') && !isIp && !isLocal) {
          parsed.hostname = `api.${host}`;
          addAdminProxyTarget(parsed.toString());
        }
      } catch {
        // noop
      }
    }

    const checks = [];

    checks.push({
      componentId: 'relay_api',
      name: 'Relay API',
      result: { state: 'operational', latencyMs: 1, detail: 'Relay process responding' },
    });

    try {
      const localPortalResp = await timedFetch(`http://127.0.0.1:${PORT}/church-login`, { timeoutMs: 4000 });
      checks.push({
        componentId: 'church_portal',
        name: 'Church Portal',
        result: localPortalResp.ok
          ? { state: 'operational', latencyMs: localPortalResp.latencyMs, detail: `HTTP ${localPortalResp.status}` }
          : { state: 'outage', latencyMs: localPortalResp.latencyMs, detail: `HTTP ${localPortalResp.status}` },
      });
    } catch (error) {
      checks.push({
        componentId: 'church_portal',
        name: 'Church Portal',
        result: { state: 'outage', detail: error.message },
      });
    }

    if (adminProxyTargets.length > 0) {
      let resolved = null;
      let lastFailure = null;

      for (const target of adminProxyTargets) {
        try {
          const resp = await timedFetch(`${target}/api/churches`, {
            timeoutMs: 7000,
            headers: { 'x-api-key': ADMIN_API_KEY },
          });
          if (resp.ok) {
            resolved = {
              state: 'operational',
              latencyMs: resp.latencyMs,
              detail: `HTTP ${resp.status} via ${target}`,
            };
            break;
          }

          lastFailure = {
            state: 'outage',
            latencyMs: resp.latencyMs,
            detail: `HTTP ${resp.status} via ${target}`,
          };

          // Try next candidate if this host simply doesn't expose the proxy path.
          if (resp.status === 404) continue;
          break;
        } catch (error) {
          lastFailure = { state: 'outage', detail: `${error.message} via ${target}` };
        }
      }

      checks.push({
        componentId: 'admin_api_proxy',
        name: 'Admin API Proxy',
        result: resolved || lastFailure || { state: 'degraded', detail: 'No reachable admin proxy target' },
      });
    } else {
      checks.push({
        componentId: 'admin_api_proxy',
        name: 'Admin API Proxy',
        result: { state: 'degraded', detail: 'APP_URL/ADMIN_PROXY_URL not configured for synthetic check' },
      });
    }

    if (TALLY_BOT_TOKEN) {
      try {
        const webhookInfo = await timedFetch(`https://api.telegram.org/bot${TALLY_BOT_TOKEN}/getWebhookInfo`, {
          timeoutMs: 8000,
          readJson: true,
        });
        const payload = webhookInfo.body || {};
        const webhookUrl = payload.result?.url || '';
        const expectedUrl = TALLY_BOT_WEBHOOK_URL || '';
        const urlMismatch = expectedUrl && webhookUrl && expectedUrl !== webhookUrl;
        const backlogCount = Number(payload.result?.pending_update_count || 0);
        const result = statusByResult(
          webhookInfo.ok && !urlMismatch,
          `Webhook OK (${webhookUrl || 'configured'})`,
          urlMismatch ? `Webhook mismatch (expected ${expectedUrl}, got ${webhookUrl})` : `HTTP ${webhookInfo.status}`
        );
        if (result.state === 'operational' && backlogCount > 100) {
          result.state = 'degraded';
          result.detail = `High Telegram pending_update_count (${backlogCount})`;
        }
        checks.push({
          componentId: 'telegram_bot_webhook',
          name: 'Telegram Bot Webhook',
          result: { ...result, latencyMs: webhookInfo.latencyMs },
        });
      } catch (error) {
        checks.push({
          componentId: 'telegram_bot_webhook',
          name: 'Telegram Bot Webhook',
          result: { state: 'outage', detail: error.message },
        });
      }
    } else {
      checks.push({
        componentId: 'telegram_bot_webhook',
        name: 'Telegram Bot Webhook',
        result: { state: 'degraded', detail: 'TALLY_BOT_TOKEN not configured' },
      });
    }

    const hasEmailProvider = !!(
      process.env.RESEND_API_KEY ||
      process.env.SMTP_HOST ||
      process.env.SMTP_URL ||
      process.env.SENDGRID_API_KEY
    );
    if (hasEmailProvider) {
      checks.push({
        componentId: 'password_reset_email',
        name: 'Password Reset Email',
        result: { state: 'operational', detail: 'Email provider configured' },
      });
    } else {
      const resetHost = String(APP_URL || '').replace(/\/+$/, '');
      if (resetHost) {
        try {
          const resetPage = await timedFetch(`${resetHost}/forgot-password`, { timeoutMs: 8000 });
          checks.push({
            componentId: 'password_reset_email',
            name: 'Password Reset Email',
            result: statusByResult(
              resetPage.ok,
              `Hosted reset flow reachable (${resetHost}/forgot-password)`,
              `Hosted reset flow unavailable (HTTP ${resetPage.status})`
            ),
          });
        } catch (error) {
          checks.push({
            componentId: 'password_reset_email',
            name: 'Password Reset Email',
            result: { state: 'degraded', detail: `Hosted reset flow check failed: ${error.message}` },
          });
        }
      } else {
        checks.push({
          componentId: 'password_reset_email',
          name: 'Password Reset Email',
          result: { state: 'degraded', detail: 'No email provider env configured' },
        });
      }
    }

    const stripeConfigured = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
    checks.push({
      componentId: 'stripe_webhook',
      name: 'Stripe Webhook',
      result: stripeConfigured
        ? { state: 'operational', detail: 'Stripe keys configured' }
        : { state: 'degraded', detail: 'Stripe not configured yet' },
    });

    for (const check of checks) {
      upsertStatusComponent({
        componentId: check.componentId,
        name: check.name,
        state: check.result.state,
        latencyMs: check.result.latencyMs || null,
        detail: check.result.detail || '',
      });
    }

    lastStatusCheckAt = new Date().toISOString();
  } finally {
    statusCheckInFlight = false;
  }
}

function runManualDbSnapshot(label = 'manual') {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const backupDir = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
  return createBackupSnapshot({
    dbPath: DB_PATH,
    backupDir,
    encryptionKey: process.env.BACKUP_ENCRYPTION_KEY || '',
    retainCount: Number(process.env.BACKUP_RETAIN_COUNT || 96),
    label,
  });
}

/**
 * Feature-level access gating middleware.
 * Uses billing.checkAccess() to enforce tier-based feature limits.
 * Extracts churchId from req.params.churchId, req.body.churchId, or req.church.churchId.
 *
 * Usage: app.post('/route', requireAdmin, requireFeature('planning_center'), handler)
 */
function requireFeature(featureName) {
  return (req, res, next) => {
    // Skip feature gating if billing isn't enforced
    if (!REQUIRE_ACTIVE_BILLING || !billing.isEnabled()) return next();

    const churchId = req.params?.churchId || req.body?.churchId || req.church?.churchId;
    if (!churchId) return next(); // no church context — let route handle it

    const church = stmtGet.get(churchId);
    if (!church) return next(); // let route's own 404 handle it

    const access = billing.checkAccess(church, featureName);
    if (!access.allowed) {
      return res.status(403).json({ error: access.reason, feature: featureName });
    }
    next();
  };
}

// Register a new church and get a connection token
app.post('/api/churches/register', requireAdmin, rateLimit(10, 60_000), (req, res) => {
  const { name, email, portalEmail, password, tier, billingStatus } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (password && !portalEmail) return res.status(400).json({ error: 'portalEmail is required when password is provided' });
  if (portalEmail && !password) return res.status(400).json({ error: 'password is required when portalEmail is provided' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  // Check uniqueness
  const existing = stmtFindByName.get(name);
  if (existing) return res.status(409).json({ error: `A church named "${name}" already exists` });

  const cleanPortalEmail = String(portalEmail || '').trim().toLowerCase();
  if (cleanPortalEmail) {
    const existingEmail = db.prepare('SELECT churchId FROM churches WHERE portal_email = ?').get(cleanPortalEmail);
    if (existingEmail) return res.status(409).json({ error: 'portalEmail already exists' });
  }

  const normalizedTier = tier ? String(tier).toLowerCase() : null;
  if (normalizedTier && !BILLING_TIERS.has(normalizedTier)) {
    return res.status(400).json({ error: 'invalid tier' });
  }
  const intervalInput = req.body?.billingInterval ?? req.body?.billingCycle;
  const resolvedTier = normalizedTier || 'connect';
  const normalizedInterval = normalizeBillingInterval(
    intervalInput,
    resolvedTier,
    resolvedTier === 'event' ? 'one_time' : 'monthly',
  );
  if (intervalInput !== undefined && intervalInput !== null && !normalizedInterval) {
    return res.status(400).json({ error: 'invalid billingInterval' });
  }

  const normalizedStatus = billingStatus ? String(billingStatus).toLowerCase() : null;
  if (normalizedStatus && !BILLING_STATUSES.has(normalizedStatus)) {
    return res.status(400).json({ error: 'invalid billingStatus' });
  }

  // Allow admin to specify churchId + token for DB recovery / migration
  const churchId = (req.body.churchId && typeof req.body.churchId === 'string') ? req.body.churchId : uuidv4();
  const token = (req.body.token && typeof req.body.token === 'string') ? req.body.token : jwt.sign({ churchId, name }, JWT_SECRET, { expiresIn: '365d' });
  const registeredAt = new Date().toISOString();
  const registrationCode = generateRegistrationCode();

  // Compute trial end date if status is trialing
  const finalStatus = normalizedStatus || 'active';
  const trialEndsAt = finalStatus === 'trialing'
    ? new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  stmtInsert.run(churchId, name, email || '', token, registeredAt);
  stmtUpdateRegistrationCode.run(registrationCode, churchId);
  db.prepare(`
    UPDATE churches
    SET portal_email = ?, portal_password_hash = ?, billing_tier = ?, billing_status = ?, billing_trial_ends = ?, billing_interval = ?
    WHERE churchId = ?
  `).run(
    cleanPortalEmail || null,
    password ? hashPassword(password) : null,
    resolvedTier,
    finalStatus,
    trialEndsAt,
    normalizedInterval,
    churchId
  );

  churches.set(churchId, {
    churchId, name, email: email || '',
    token, ws: null,
    status: { connected: false, atem: null, obs: null },
    lastSeen: null, registeredAt, disconnectedAt: null,
    registrationCode,
  });

  log(`Registered church: ${name} (${churchId})`);
  res.json({
    churchId,
    name,
    token,
    portalEmail: cleanPortalEmail || null,
    billing: {
      tier: resolvedTier,
      billingInterval: normalizedInterval,
      status: finalStatus,
      trialEndsAt,
    },
    registrationCode,
    message: 'Share this token with the church to connect their client app. Also share the 6-char code with a TD for Telegram registration.',
  });
});

// Self-serve onboarding from website signup flow
app.post('/api/church/app/onboard', rateLimit(5, 60_000), async (req, res) => {
  const { name, email, password, tier, successUrl, cancelUrl, tosAcceptedAt, referralCode } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanReferralCode = String(referralCode || '').trim().toUpperCase();
  const planTier = String(tier || 'connect').toLowerCase();
  const planInterval = normalizeBillingInterval(
    req.body?.billingInterval ?? req.body?.billingCycle,
    planTier,
    planTier === 'event' ? 'one_time' : 'monthly',
  );

  if (!cleanName) return res.status(400).json({ error: 'name required' });
  if (!cleanEmail) return res.status(400).json({ error: 'email required' });
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (!['connect', 'plus', 'pro', 'managed', 'event'].includes(planTier)) {
    return res.status(400).json({ error: 'invalid tier' });
  }
  if (!planInterval) {
    return res.status(400).json({ error: 'invalid billingInterval' });
  }

  const existingByName = stmtFindByName.get(cleanName);
  if (existingByName) {
    // Allow re-onboarding if church was abandoned (pending checkout never completed)
    const isPending = existingByName.billing_status === 'pending' || existingByName.billing_status === 'inactive';
    if (!isPending) return res.status(409).json({ error: `A church named "${cleanName}" already exists` });
  }

  const existingByEmail = db.prepare('SELECT churchId, billing_status FROM churches WHERE portal_email = ?').get(cleanEmail);
  if (existingByEmail) {
    // Allow re-onboarding if previous signup was abandoned (pending/inactive = never completed checkout)
    const isPending = existingByEmail.billing_status === 'pending' || existingByEmail.billing_status === 'inactive';
    if (!isPending) return res.status(409).json({ error: 'An account with this email already exists' });

    // Clean up the abandoned record so we can create a fresh one
    const oldChurchId = existingByEmail.churchId;
    churches.delete(oldChurchId);
    db.prepare('DELETE FROM billing_customers WHERE church_id = ?').run(oldChurchId);
    db.prepare('DELETE FROM churches WHERE churchId = ?').run(oldChurchId);
    log(`[Onboarding] Cleaned up abandoned signup for ${cleanEmail} (old churchId: ${oldChurchId})`);
  }

  // Also clean up abandoned name match (different email, same name)
  if (existingByName) {
    const oldChurchId = existingByName.churchId;
    churches.delete(oldChurchId);
    db.prepare('DELETE FROM billing_customers WHERE church_id = ?').run(oldChurchId);
    db.prepare('DELETE FROM churches WHERE churchId = ?').run(oldChurchId);
    log(`[Onboarding] Cleaned up abandoned signup for "${cleanName}" (old churchId: ${oldChurchId})`);
  }

  const churchId = uuidv4();
  const connectionToken = jwt.sign({ churchId, name: cleanName }, JWT_SECRET, { expiresIn: '365d' });
  const registeredAt = new Date().toISOString();
  const registrationCode = generateRegistrationCode();

  // Self-service onboarding: start as trialing with 60-day trial
  // When Stripe is enabled, status starts as 'pending' until checkout completes → 'trialing'
  // When Stripe is disabled, start directly as 'trialing' with local trial expiration
  const onboardStatus = billing.isEnabled() ? 'pending' : 'trialing';
  const trialEndsAt = new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  stmtInsert.run(churchId, cleanName, cleanEmail, connectionToken, registeredAt);
  stmtUpdateRegistrationCode.run(registrationCode, churchId);

  // Generate a referral code for the new church
  const newReferralCode = generateRegistrationCode().toUpperCase();

  // Generate email verification token
  const emailVerifyToken = crypto.randomBytes(32).toString('hex');

  db.prepare(`
    UPDATE churches
    SET portal_email = ?, portal_password_hash = ?, billing_tier = ?, billing_status = ?, billing_trial_ends = ?, billing_interval = ?, tos_accepted_at = ?, referral_code = ?,
        email_verify_token = ?, email_verify_sent_at = ?
    WHERE churchId = ?
  `).run(cleanEmail, hashPassword(password), planTier, onboardStatus, trialEndsAt, planInterval, tosAcceptedAt || null, newReferralCode, emailVerifyToken, new Date().toISOString(), churchId);

  // Track referral if a valid referral code was provided
  let referrerId = null;
  if (cleanReferralCode) {
    const referrer = db.prepare('SELECT churchId, name FROM churches WHERE referral_code = ? AND churchId != ?').get(cleanReferralCode, churchId);
    if (referrer) {
      referrerId = referrer.churchId;
      db.prepare('UPDATE churches SET referred_by = ? WHERE churchId = ?').run(referrer.churchId, churchId);
      try {
        db.prepare(`
          INSERT INTO referrals (id, referrer_id, referred_id, referred_name, status, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?)
        `).run(require('crypto').randomUUID(), referrer.churchId, churchId, cleanName, registeredAt);
        log(`[Referral] ${cleanName} referred by ${referrer.name} (code: ${cleanReferralCode})`);
      } catch (e) { log(`[Referral] Failed to record: ${e.message}`); }
    }
  }

  churches.set(churchId, {
    churchId,
    name: cleanName,
    email: cleanEmail,
    token: connectionToken,
    ws: null,
    status: { connected: false, atem: null, obs: null },
    lastSeen: null,
    lastHeartbeat: null,
    registeredAt,
    disconnectedAt: null,
    _offlineAlertSent: false,
    church_type: 'recurring',
    event_expires_at: null,
    event_label: null,
    reseller_id: null,
    registrationCode,
  });

  let checkoutUrl = null;
  let checkoutSessionId = null;
  let checkoutError = null;

  if (billing.isEnabled()) {
    try {
      const checkout = await billing.createCheckout({
        tier: planTier,
        billingInterval: planInterval,
        churchId,
        email: cleanEmail,
        successUrl,
        cancelUrl,
        isEvent: planTier === 'event',
      });
      checkoutUrl = checkout.url || null;
      checkoutSessionId = checkout.sessionId || null;
    } catch (e) {
      checkoutError = e.message;
      log(`[Onboarding] Checkout setup failed for ${churchId}: ${e.message}`);
    }
  }

  // Send email verification (non-blocking)
  const verifyUrl = `${process.env.RELAY_URL || 'https://tally-production-cde2.up.railway.app'}/api/church/verify-email?token=${emailVerifyToken}`;
  sendOnboardingEmail({
    to: cleanEmail,
    subject: 'Verify your Tally email',
    tag: 'email-verification',
    html: `<div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 0;">
      <div style="margin-bottom: 24px;">
        <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-right: 8px;"></span>
        <strong style="font-size: 16px; color: #111;">Tally</strong>
      </div>
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Verify your email</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">Click below to verify the email address for <strong>${cleanName}</strong>:</p>
      <p style="margin: 28px 0;">
        <a href="${verifyUrl}" style="display: inline-block; padding: 12px 28px; font-size: 15px; font-weight: 700; background: #22c55e; color: #000; text-decoration: none; border-radius: 8px;">Verify Email</a>
      </p>
      <p style="font-size: 13px; color: #666;">If you didn't sign up for Tally, ignore this email.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
      <p style="font-size: 12px; color: #999;">Tally by ATEM School</p>
    </div>`,
    text: `Verify your Tally email\n\nClick this link to verify: ${verifyUrl}\n\nIf you didn't sign up for Tally, ignore this email.`,
  }).catch(() => {});

  const appToken = issueChurchAppToken(churchId, cleanName);
  const access = checkChurchPaidAccess(churchId);

  res.status(201).json({
    created: true,
    churchId,
    name: cleanName,
    email: cleanEmail,
    registrationCode,
    token: appToken,
    tokenExpiresIn: CHURCH_APP_TOKEN_TTL,
    billing: {
      required: REQUIRE_ACTIVE_BILLING && billing.isEnabled(),
      status: access.status,
      tier: planTier,
      billingInterval: planInterval,
      trialEndsAt,
    },
    checkoutUrl,
    checkoutSessionId,
    checkoutError,
  });
});

// Email verification (extracted)
require('./src/routes/emailVerification')(app, { db, APP_URL, sendOnboardingEmail, rateLimit, log });

// Credential-based app login (used by Electron setup flow)
app.post('/api/church/app/login', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  const church = db.prepare('SELECT * FROM churches WHERE portal_email = ?').get(cleanEmail);
  if (!church || !church.portal_password_hash || !verifyPassword(password, church.portal_password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const access = checkChurchPaidAccess(church.churchId);
  if (!access.allowed) {
    return res.status(402).json({
      error: access.message,
      billing: {
        status: access.status,
        tier: access.tier,
        billingInterval: access.billingInterval,
      },
    });
  }

  const token = issueChurchAppToken(church.churchId, church.name);
  res.json({
    token,
    tokenType: 'Bearer',
    tokenExpiresIn: CHURCH_APP_TOKEN_TTL,
    church: {
      churchId: church.churchId,
      name: church.name,
      email: church.portal_email || church.email || '',
    },
    billing: {
      status: access.status,
      tier: access.tier,
      billingInterval: access.billingInterval,
      bypassed: !!access.bypassed,
    },
  });
});

// ─── CHURCH APP API (Bearer token auth) ──────────────────────────────────────
// These routes mirror /api/church/me but use JWT Bearer tokens instead of cookies.
// Used by the tallyconnect.app landing-site portal.

function requireChurchAppAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.type !== 'church_app') throw new Error('wrong token type');
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    req.church = church;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /api/church/app/me — church profile + live status
app.get('/api/church/app/me', requireChurchAppAuth, (req, res) => {
  const c = req.church;
  const runtime = churches.get(c.churchId);
  let tds = [];
  try {
    tds = db.prepare('SELECT * FROM church_tds WHERE church_id = ? AND active = 1 ORDER BY registered_at ASC').all(c.churchId);
  } catch { /* schema may vary */ }
  const { portal_password_hash, token, ...safe } = c;

  let notifications = {};
  try { notifications = JSON.parse(c.notifications || '{}'); } catch {}

  res.json({
    ...safe,
    notifications,
    tds,
    connected: runtime?.ws?.readyState === 1,
    status: runtime?.status || {},
    lastSeen: runtime?.lastSeen || null,
  });
});

// POST /api/pf/report — Electron app pushes Problem Finder analysis results
app.post('/api/pf/report', requireChurchAppAuth, (req, res) => {
  try {
    const churchId = req.church.churchId;
    const b = req.body || {};
    const id = b.runId || uuidv4();
    const status = String(b.status || 'NO_GO').toUpperCase();
    if (status !== 'GO' && status !== 'NO_GO') {
      return res.status(400).json({ error: 'status must be GO or NO_GO' });
    }

    const issueCount = parseInt(b.issueCount, 10) || 0;
    const autoFixedCount = parseInt(b.autoFixedCount, 10) || 0;
    const coverageScore = parseFloat(b.coverageScore) || 0;
    const blockerCount = parseInt(b.blockerCount, 10) || 0;
    const triggerType = String(b.triggerType || 'manual').slice(0, 50);

    const issuesJson = JSON.stringify(Array.isArray(b.issues) ? b.issues : []);
    const blockersJson = JSON.stringify(Array.isArray(b.blockers) ? b.blockers : []);
    const autoFixedJson = JSON.stringify(Array.isArray(b.autoFixed) ? b.autoFixed : []);
    const needsAttentionJson = JSON.stringify(Array.isArray(b.needsAttention) ? b.needsAttention : []);
    const topActionsJson = JSON.stringify(Array.isArray(b.topActions) ? b.topActions : []);
    const createdAt = b.createdAt || new Date().toISOString();

    db.prepare(`
      INSERT OR REPLACE INTO problem_finder_reports
        (id, church_id, trigger_type, status, issue_count, auto_fixed_count, coverage_score,
         blocker_count, issues_json, blockers_json, auto_fixed_json, needs_attention_json,
         top_actions_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, churchId, triggerType, status, issueCount, autoFixedCount, coverageScore,
      blockerCount, issuesJson, blockersJson, autoFixedJson, needsAttentionJson,
      topActionsJson, createdAt);

    // Broadcast update to SSE clients so portal refreshes if open
    broadcastToSSE({
      type: 'pf_report',
      churchId,
      status,
      issueCount,
      blockerCount,
      autoFixedCount,
      timestamp: createdAt,
    });

    log(`[PF] Report saved for ${req.church.name}: ${status} (${issueCount} issues, ${blockerCount} blockers)`);
    res.status(201).json({ id, status: 'saved' });
  } catch (e) {
    log(`[PF] Report save error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/church/app/me — update profile, email, password
app.put('/api/church/app/me', requireChurchAppAuth, (req, res) => {
  const { email, phone, location, notes, notifications, telegramChatId, newPassword, currentPassword, password } = req.body;
  const churchId = req.church.churchId;

  // Password change: require current password verification
  const newPw = newPassword || password;
  if (newPw) {
    if (currentPassword) {
      if (!req.church.portal_password_hash || !verifyPassword(currentPassword, req.church.portal_password_hash)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
    }
    if (newPw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    db.prepare('UPDATE churches SET portal_password_hash = ? WHERE churchId = ?')
      .run(hashPassword(newPw), churchId);
  }

  // Whitelist of allowed columns to prevent SQL injection via dynamic column names
  const ALLOWED_PROFILE_COLUMNS = ['portal_email', 'phone', 'location', 'notes', 'telegram_chat_id', 'notifications'];
  const patch = {};
  if (email          !== undefined) patch.portal_email     = email.trim().toLowerCase();
  if (phone          !== undefined) patch.phone            = phone;
  if (location       !== undefined) patch.location         = location;
  if (notes          !== undefined) patch.notes            = notes;
  if (telegramChatId !== undefined) patch.telegram_chat_id = telegramChatId;
  if (notifications  !== undefined) patch.notifications    = JSON.stringify(notifications);

  // Filter to only whitelisted column names (defense-in-depth)
  const safePatch = {};
  for (const [col, val] of Object.entries(patch)) {
    if (ALLOWED_PROFILE_COLUMNS.includes(col)) safePatch[col] = val;
  }

  if (Object.keys(safePatch).length) {
    const sets = Object.keys(safePatch).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE churches SET ${sets} WHERE churchId = ?`).run(...Object.values(safePatch), churchId);
  }
  res.json({ ok: true });
});

// POST /api/church/app/reset-password — admin-only, set new password by email
app.post('/api/church/app/reset-password', requireAdmin, (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const church = db.prepare('SELECT churchId FROM churches WHERE portal_email = ?').get(cleanEmail);
  if (!church) {
    return res.status(404).json({ error: 'No account found with that email' });
  }

  db.prepare('UPDATE churches SET portal_password_hash = ? WHERE churchId = ?')
    .run(hashPassword(password), church.churchId);

  log(`[ResetPassword] Password updated for ${cleanEmail} (church ${church.churchId})`);
  res.json({ ok: true });
});

// ─── SUPPORT TRIAGE + TICKETS ────────────────────────────────────────────────

app.post('/api/support/triage', requireSupportAccess, (req, res) => {
  const churchId = resolveSupportChurchId(req);
  if (!churchId) {
    return res.status(400).json({ error: 'churchId required' });
  }
  const church = stmtGet.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  const issueCategory = normalizeSupportCategory(req.body?.issueCategory);
  const severity = normalizeSupportSeverity(req.body?.severity);
  const summary = String(req.body?.summary || req.body?.description || '').trim().slice(0, 2000);
  const actor = req.supportActor?.type === 'church'
    ? `church:${churchId}`
    : `admin:${req.supportActor?.adminUser?.id || 'unknown'}`;
  const diagnostics = buildSupportDiagnostics(churchId, {
    issueCategory,
    severity,
    timezone: req.body?.timezone,
    appVersion: req.body?.appVersion,
    autoFixAttempts: req.body?.autoFixAttempts,
    campusId: req.body?.campusId,
    room: req.body?.room,
  });
  const triage = computeTriageResult(diagnostics);
  diagnostics.checks = triage.checks;

  const triageId = uuidv4();
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO support_triage_runs (
      id, church_id, issue_category, severity, summary, triage_result,
      diagnostics_json, autofix_attempts_json, timezone, app_version, created_by, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    triageId,
    churchId,
    issueCategory,
    severity,
    summary,
    triage.triageResult,
    JSON.stringify(diagnostics),
    JSON.stringify(diagnostics.autoFixAttempts || []),
    diagnostics.timezone || null,
    diagnostics.appVersion || null,
    actor,
    createdAt
  );

  res.status(201).json({
    triageId,
    churchId,
    triageResult: triage.triageResult,
    checks: triage.checks,
    diagnostics,
    createdAt,
  });
});

app.post('/api/support/tickets', requireSupportAccess, rateLimit(5, 60_000), (req, res) => {
  const churchId = resolveSupportChurchId(req);
  if (!churchId) return res.status(400).json({ error: 'churchId required' });

  const church = stmtGet.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  let severity = normalizeSupportSeverity(req.body?.severity);
  let issueCategory = normalizeSupportCategory(req.body?.issueCategory);
  const triageId = String(req.body?.triageId || '').trim() || null;
  const forceBypass = req.body?.forceBypass === true;

  if (!triageId && !(forceBypass && severity === 'P1')) {
    return res.status(400).json({ error: 'triageId required unless forceBypass=true with P1 severity' });
  }
  if (forceBypass && severity !== 'P1') {
    return res.status(400).json({ error: 'forceBypass is only allowed for P1 tickets' });
  }

  let triageRow = null;
  if (triageId) {
    triageRow = db.prepare('SELECT * FROM support_triage_runs WHERE id = ? AND church_id = ?').get(triageId, churchId);
    if (!triageRow) return res.status(404).json({ error: 'triageId not found for church' });
    const triageAgeMs = Date.now() - new Date(triageRow.created_at).getTime();
    if (triageAgeMs > SUPPORT_TRIAGE_WINDOW_HOURS * 60 * 60 * 1000) {
      return res.status(400).json({ error: `triageId is older than ${SUPPORT_TRIAGE_WINDOW_HOURS} hours; rerun triage first` });
    }
    if (!req.body?.severity) severity = normalizeSupportSeverity(triageRow.severity);
    if (!req.body?.issueCategory) issueCategory = normalizeSupportCategory(triageRow.issue_category);
  }

  const title = String(req.body?.title || triageRow?.summary || issueCategory.replace(/_/g, ' ')).trim().slice(0, 160);
  if (!title) return res.status(400).json({ error: 'title required' });
  const description = String(req.body?.description || '').trim().slice(0, 4000);
  const actor = req.supportActor?.type === 'church'
    ? `church:${churchId}`
    : `admin:${req.supportActor?.adminUser?.id || 'unknown'}`;
  const nowIso = new Date().toISOString();
  const ticketId = uuidv4();
  const diagnostics = triageRow
    ? safeJsonParse(triageRow.diagnostics_json, {})
    : buildSupportDiagnostics(churchId, { issueCategory, severity });

  db.prepare(`
    INSERT INTO support_tickets (
      id, church_id, triage_id, issue_category, severity, title, description,
      status, forced_bypass, diagnostics_json, created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    churchId,
    triageId,
    issueCategory,
    severity,
    title,
    description,
    'open',
    forceBypass ? 1 : 0,
    JSON.stringify(diagnostics),
    actor,
    nowIso,
    nowIso
  );

  db.prepare(`
    INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    ticketId,
    description || 'Ticket opened',
    req.supportActor?.type === 'church' ? 'church' : 'admin',
    req.supportActor?.type === 'church' ? churchId : (req.supportActor?.adminUser?.id || ''),
    nowIso
  );

  res.status(201).json({
    ticketId,
    churchId,
    triageId,
    status: 'open',
    severity,
    issueCategory,
    title,
    forceBypass,
    createdAt: nowIso,
  });
});

app.get('/api/support/tickets', requireSupportAccess, (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200));
  const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;

  if (status && !supportTicketStates.has(status)) {
    return res.status(400).json({ error: 'invalid status filter' });
  }

  if (req.supportActor?.type === 'church') {
    const churchId = req.supportActor.churchId;
    const rows = status
      ? db.prepare(`
          SELECT * FROM support_tickets
          WHERE church_id = ? AND status = ?
          ORDER BY datetime(updated_at) DESC
          LIMIT ?
        `).all(churchId, status, limit)
      : db.prepare(`
          SELECT * FROM support_tickets
          WHERE church_id = ?
          ORDER BY datetime(updated_at) DESC
          LIMIT ?
        `).all(churchId, limit);

    return res.json(rows.map((row) => ({
      ...row,
      forcedBypass: !!row.forced_bypass,
      diagnostics: safeJsonParse(row.diagnostics_json, {}),
    })));
  }

  const churchId = String(req.query.churchId || '').trim() || null;
  let query = 'SELECT * FROM support_tickets WHERE 1 = 1';
  const params = [];
  if (churchId) {
    query += ' AND church_id = ?';
    params.push(churchId);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  query += ' ORDER BY datetime(updated_at) DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params);
  return res.json(rows.map((row) => ({
    ...row,
    forcedBypass: !!row.forced_bypass,
    diagnostics: safeJsonParse(row.diagnostics_json, {}),
  })));
});

app.get('/api/support/tickets/:ticketId', requireSupportAccess, (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (req.supportActor?.type === 'church' && ticket.church_id !== req.supportActor.churchId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const updates = db.prepare(`
    SELECT id, message, actor_type, actor_id, created_at
    FROM support_ticket_updates
    WHERE ticket_id = ?
    ORDER BY created_at ASC
  `).all(ticket.id);

  res.json({
    ...ticket,
    forcedBypass: !!ticket.forced_bypass,
    diagnostics: safeJsonParse(ticket.diagnostics_json, {}),
    updates,
  });
});

app.post('/api/support/tickets/:ticketId/updates', requireSupportAccess, (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (req.supportActor?.type === 'church' && ticket.church_id !== req.supportActor.churchId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  const nowIso = new Date().toISOString();

  const requestedStatus = req.body?.status ? String(req.body.status).trim().toLowerCase() : null;
  let nextStatus = ticket.status;
  if (requestedStatus) {
    if (!supportTicketStates.has(requestedStatus)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    if (req.supportActor?.type === 'church' && !['waiting_customer', 'closed'].includes(requestedStatus)) {
      return res.status(403).json({ error: 'church users can only set waiting_customer or closed' });
    }
    nextStatus = requestedStatus;
  }

  db.prepare(`
    INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    ticket.id,
    message.slice(0, 4000),
    req.supportActor?.type === 'church' ? 'church' : 'admin',
    req.supportActor?.type === 'church' ? req.supportActor.churchId : (req.supportActor?.adminUser?.id || ''),
    nowIso
  );

  db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, nowIso, ticket.id);
  res.json({ ok: true, ticketId: ticket.id, status: nextStatus, updatedAt: nowIso });
});

app.put('/api/support/tickets/:ticketId', requireSupportAccess, (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (req.supportActor?.type === 'church') {
    if (ticket.church_id !== req.supportActor.churchId) return res.status(403).json({ error: 'forbidden' });
    return res.status(403).json({ error: 'church users cannot edit ticket metadata' });
  }

  const patch = {};
  if (req.body?.status !== undefined) {
    const status = String(req.body.status).trim().toLowerCase();
    if (!supportTicketStates.has(status)) return res.status(400).json({ error: 'invalid status' });
    patch.status = status;
  }
  if (req.body?.severity !== undefined) patch.severity = normalizeSupportSeverity(req.body.severity);
  if (req.body?.title !== undefined) patch.title = String(req.body.title).trim().slice(0, 160);
  if (req.body?.description !== undefined) patch.description = String(req.body.description).trim().slice(0, 4000);

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no changes supplied' });

  patch.updated_at = new Date().toISOString();
  const columns = Object.keys(patch);
  const sets = columns.map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE support_tickets SET ${sets} WHERE id = ?`).run(...columns.map((key) => patch[key]), ticket.id);

  res.json({ ok: true, ticketId: ticket.id, ...patch });
});

// Status components & incidents (extracted)
require('./src/routes/statusComponents')(app, {
  db, requireAdmin, runStatusChecks,
  lastStatusCheckAt: () => lastStatusCheckAt,
});

app.post('/api/internal/backups/snapshot', requireAdmin, (req, res) => {
  try {
    const label = String(req.body?.label || 'manual').trim().slice(0, 40) || 'manual';
    const snapshot = runManualDbSnapshot(label);
    res.status(201).json({ ok: true, snapshot });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ─── ADMIN USER AUTH & MANAGEMENT ────────────────────────────────────────────

// POST /api/admin/login — multi-user admin login
app.post('/api/admin/login', rateLimit(5, 15 * 60 * 1000), (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM admin_users WHERE email = ?').get(cleanEmail);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Update last login
  db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?')
    .run(new Date().toISOString(), user.id);

  const token = jwt.sign(
    { type: 'admin', userId: user.id, role: user.role, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  log(`[AdminLogin] ${user.email} (${user.role}) logged in`);
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// GET /api/admin/me — current admin user profile
app.get('/api/admin/me', requireAdminJwt(), (req, res) => {
  const u = req.adminUser;
  res.json({ id: u.id, email: u.email, name: u.name, role: u.role });
});

// PUT /api/admin/me/password — change own password
app.put('/api/admin/me/password', requireAdminJwt(), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const user = db.prepare('SELECT password_hash FROM admin_users WHERE id = ?').get(req.adminUser.id);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(newPassword), new Date().toISOString(), req.adminUser.id);

  log(`[AdminUsers] ${req.adminUser.email} changed their password`);
  res.json({ ok: true });
});

// GET /api/admin/users — list all admin users (super_admin only)
app.get('/api/admin/users', requireAdminJwt('super_admin'), (req, res) => {
  const users = db.prepare(
    'SELECT id, email, name, role, active, created_at, created_by, last_login_at, updated_at FROM admin_users ORDER BY created_at ASC'
  ).all();
  res.json(users);
});

// POST /api/admin/users — create an admin user (super_admin only)
app.post('/api/admin/users', requireAdminJwt('super_admin'), (req, res) => {
  const { email, password, name, role } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !password || !name) {
    return res.status(400).json({ error: 'email, password, and name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!ADMIN_ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${ADMIN_ROLES.join(', ')}` });
  }

  // Check duplicate email
  const existing = db.prepare('SELECT id FROM admin_users WHERE email = ?').get(cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'An admin with this email already exists' });
  }

  const id = uuidv4();
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, cleanEmail, hashPassword(password), name.trim(), role, 1, new Date().toISOString(), req.adminUser.id);

  log(`[AdminUsers] ${req.adminUser.email} created ${role} user: ${cleanEmail}`);
  res.status(201).json({ id, email: cleanEmail, name: name.trim(), role, active: 1 });
});

// PUT /api/admin/users/:userId — update an admin user (super_admin only)
app.put('/api/admin/users/:userId', requireAdminJwt('super_admin'), (req, res) => {
  const { name, role, active } = req.body || {};
  const target = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Guard: cannot demote/deactivate the last super_admin
  if (target.role === 'super_admin' && (role !== 'super_admin' || active === 0 || active === false)) {
    const superCount = db.prepare("SELECT COUNT(*) as cnt FROM admin_users WHERE role = 'super_admin' AND active = 1").get().cnt;
    if (superCount <= 1) {
      return res.status(400).json({ error: 'Cannot demote or deactivate the last super_admin' });
    }
  }

  if (role !== undefined && !ADMIN_ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${ADMIN_ROLES.join(', ')}` });
  }

  const patch = {};
  if (name   !== undefined) patch.name   = name.trim();
  if (role   !== undefined) patch.role   = role;
  if (active !== undefined) patch.active = active ? 1 : 0;

  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
    const sets = Object.keys(patch).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE admin_users SET ${sets} WHERE id = ?`).run(...Object.values(patch), req.params.userId);
  }

  log(`[AdminUsers] ${req.adminUser.email} updated user ${target.email}: ${JSON.stringify(patch)}`);
  res.json({ ok: true });
});

// PUT /api/admin/users/:userId/password — reset another user's password (super_admin only)
app.put('/api/admin/users/:userId/password', requireAdminJwt('super_admin'), (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const target = db.prepare('SELECT email FROM admin_users WHERE id = ?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(password), new Date().toISOString(), req.params.userId);

  log(`[AdminUsers] ${req.adminUser.email} reset password for ${target.email}`);
  res.json({ ok: true });
});

// DELETE /api/admin/users/:userId — soft-delete (deactivate) an admin user (super_admin only)
app.delete('/api/admin/users/:userId', requireAdminJwt('super_admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Cannot delete self
  if (target.id === req.adminUser.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  // Cannot delete last super_admin
  if (target.role === 'super_admin') {
    const superCount = db.prepare("SELECT COUNT(*) as cnt FROM admin_users WHERE role = 'super_admin' AND active = 1").get().cnt;
    if (superCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last super_admin' });
    }
  }

  db.prepare('UPDATE admin_users SET active = 0, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), req.params.userId);

  log(`[AdminUsers] ${req.adminUser.email} deactivated user ${target.email}`);
  res.json({ ok: true });
});

// List all registered event churches + current expiry status

app.get('/api/events', requireAdmin, (req, res) => {
  const events = db.prepare("SELECT * FROM churches WHERE church_type = 'event' ORDER BY registeredAt DESC").all();
  res.json(events.map(e => ({ ...e, timeRemaining: eventMode.getTimeRemaining(e), expired: eventMode.isEventExpired(e) })));
});

// ─── BILLING ROUTES ───────────────────────────────────────────────────────────

// Create Stripe Checkout session
app.post('/api/billing/checkout', requireAdmin, rateLimit(5, 60_000), async (req, res) => {
  try {
    const { tier, churchId, email, successUrl, cancelUrl } = req.body;
    if (!tier || !['connect', 'plus', 'pro', 'managed', 'event'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid tier. Must be connect, plus, pro, managed, or event.' });
    }
    const billingInterval = normalizeBillingInterval(
      req.body?.billingInterval ?? req.body?.billingCycle,
      tier,
      String(tier).toLowerCase() === 'event' ? 'one_time' : 'monthly',
    );
    if (!billingInterval) {
      return res.status(400).json({ error: 'Invalid billingInterval. Must be monthly or annual.' });
    }
    const result = await billing.createCheckout({
      tier, churchId, email, successUrl, cancelUrl, billingInterval,
      isEvent: tier === 'event',
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// Create Stripe Billing Portal session (self-service subscription management)
app.post('/api/billing/portal', requireAdmin, async (req, res) => {
  try {
    const { churchId, returnUrl } = req.body;
    if (!churchId) return res.status(400).json({ error: 'churchId required' });
    const result = await billing.createPortalSession({ churchId, returnUrl });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// Stripe webhook (must receive raw body — mounted before express.json())
app.post('/api/billing/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });
  try {
    // req.rawBody must be set — see express setup below
    const result = await billing.handleWebhook(req.rawBody || req.body, sig);
    res.json(result);
  } catch (e) {
    console.error('[Billing] Webhook error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Get billing status for a church
app.get('/api/billing/status/:churchId', requireAdmin, (req, res) => {
  const status = billing.getStatus(req.params.churchId);
  res.json(status);
});

// List all billing records (admin)
app.get('/api/billing', requireAdmin, (req, res) => {
  res.json(billing.listAll());
});

// ─── CHURCHES ────────────────────────────────────────────────────────────────

app.get('/api/churches', requireAdmin, (req, res) => {
  // Single DB query instead of N+1 per-church lookups
  const allRows = db.prepare('SELECT * FROM churches').all();
  const rowMap = new Map(allRows.map(r => [r.churchId, r]));

  const list = Array.from(churches.values()).map(c => {
    const row = rowMap.get(c.churchId) || {};
    return {
      churchId:         c.churchId,
      name:             c.name,
      connected:        c.ws?.readyState === WebSocket.OPEN,
      status:           c.status,
      lastSeen:         c.lastSeen,
      church_type:      c.church_type      || 'recurring',
      event_expires_at: c.event_expires_at || null,
      event_label:      c.event_label      || null,
      reseller_id:      c.reseller_id      || null,
      portal_email:        row.portal_email || null,
      billing_tier:        row.billing_tier || null,
      billing_interval:    row.billing_interval || null,
      billing_status:      row.billing_status || 'inactive',
      billing_trial_ends:  row.billing_trial_ends || null,
      has_slack:            !!row.slack_webhook_url,
      registrationCode:    row.registration_code || c.registrationCode || null,
      token:               row.token || c.token || null,
    };
  });
  res.json(list);
});

// Manually set billing plan/status (for pre-Stripe or manual ops flows)
app.put('/api/churches/:churchId/billing', requireAdmin, (req, res) => {
  const { churchId } = req.params;
  const church = churches.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  const row = stmtGet.get(churchId);
  if (!row) return res.status(404).json({ error: 'Church not found' });

  const inTier = req.body?.tier;
  const inStatus = req.body?.status;
  const inInterval = req.body?.billingInterval ?? req.body?.billingCycle ?? req.body?.interval;
  if (!inTier && !inStatus && inInterval === undefined) return res.status(400).json({ error: 'tier, status, or billingInterval required' });

  const nextTier = inTier ? String(inTier).toLowerCase() : String(row.billing_tier || 'connect').toLowerCase();
  const nextStatus = inStatus ? String(inStatus).toLowerCase() : String(row.billing_status || 'inactive').toLowerCase();
  const currentInterval = normalizeBillingInterval(
    row.billing_interval,
    nextTier,
    nextTier === 'event' ? 'one_time' : 'monthly',
  ) || (nextTier === 'event' ? 'one_time' : 'monthly');
  const nextInterval = inInterval === undefined
    ? currentInterval
    : normalizeBillingInterval(inInterval, nextTier, currentInterval);

  if (!BILLING_TIERS.has(nextTier)) return res.status(400).json({ error: 'invalid tier' });
  if (!BILLING_STATUSES.has(nextStatus)) return res.status(400).json({ error: 'invalid status' });
  if (!nextInterval) return res.status(400).json({ error: 'invalid billingInterval' });

  db.prepare('UPDATE churches SET billing_tier = ?, billing_status = ?, billing_interval = ? WHERE churchId = ?')
    .run(nextTier, nextStatus, nextInterval, churchId);

  const now = new Date().toISOString();
  const billingRecord = db.prepare('SELECT id FROM billing_customers WHERE church_id = ?').get(churchId);
  if (billingRecord?.id) {
    db.prepare('UPDATE billing_customers SET tier = ?, billing_interval = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(nextTier, nextInterval, nextStatus, now, billingRecord.id);
  } else {
    db.prepare(`
      INSERT INTO billing_customers
        (id, church_id, tier, billing_interval, status, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`manual_${churchId}`, churchId, nextTier, nextInterval, nextStatus, row.portal_email || row.email || '', now, now);
  }

  res.json({
    ok: true,
    churchId,
    billing: { tier: nextTier, billingInterval: nextInterval, status: nextStatus },
  });
});

function deleteChurchCascade(churchId) {
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all();

  const tx = db.transaction((id) => {
    for (const row of tables) {
      const table = row?.name;
      if (!table || table === 'churches' || !ident.test(table)) continue;
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
      for (const fk of fks) {
        if (fk.table !== 'churches') continue;
        const col = fk.from;
        if (!col || !ident.test(col)) continue;
        db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(id);
      }
    }
    stmtDelete.run(id);
  });

  tx(churchId);
}

// Delete a church
app.delete('/api/churches/:churchId', requireAdmin, (req, res) => {
  const { churchId } = req.params;
  const church = churches.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  // Close WS if connected
  if (church.ws?.readyState === WebSocket.OPEN) {
    church.ws.close(1000, 'church deleted');
  }

  try {
    deleteChurchCascade(churchId);
  } catch (e) {
    console.error(`[DeleteChurch] Failed for ${churchId}:`, e.message);
    return res.status(500).json({ error: 'Failed to delete church', details: e.message });
  }
  churches.delete(churchId);
  messageQueues.delete(churchId);

  log(`Deleted church: ${church.name} (${churchId})`);
  res.json({ deleted: true, name: church.name });
});

// Map command prefixes to device types for tier-based gating
// Connect tier: atem, obs, vmix only. Plus+: everything.
const COMMAND_DEVICE_MAP = {
  atem: 'atem', hyperdeck: 'atem', ptz: 'atem',
  obs: 'obs',
  vmix: 'vmix',
  propresenter: 'propresenter',
  companion: 'companion',
  resolume: 'resolume',
  mixer: 'audio', dante: 'audio',
  videohub: 'videohub',
  // system/status/preview/preset always allowed (no device mapping)
};

function getDeviceTypeForCommand(command) {
  const cmdPrefix = String(command || '').split('.')[0];
  return COMMAND_DEVICE_MAP[cmdPrefix] || null;
}

function checkBillingAccessForCommand(churchId, command) {
  if (!(REQUIRE_ACTIVE_BILLING && billing.isEnabled())) {
    return { allowed: true };
  }

  const deviceType = getDeviceTypeForCommand(command);
  if (!deviceType) return { allowed: true };

  const dbChurch = stmtGet.get(churchId);
  if (!dbChurch) return { allowed: true };

  const access = billing.checkDeviceAccess(dbChurch, deviceType);
  if (!access.allowed) {
    return { allowed: false, status: 403, error: access.reason, device: deviceType };
  }
  return { allowed: true };
}

function formatResultForChat(result) {
  if (result === null || result === undefined) return 'OK';
  if (typeof result === 'string') return result.slice(0, 300);
  try {
    return JSON.stringify(result).slice(0, 300);
  } catch {
    return 'OK';
  }
}

function postSystemChatMessage(churchId, message) {
  const saved = chatEngine.saveMessage({
    churchId,
    senderName: 'Tally',
    senderRole: 'system',
    source: 'system',
    message,
  });
  chatEngine.broadcastChat(saved);
}

async function executeChurchCommandWithResult(churchId, command, params = {}) {
  const rateLimit = await checkCommandRateLimit(churchId);
  if (!rateLimit.ok) {
    return { ok: false, status: 429, error: 'Rate limit exceeded (max 10 commands/second)' };
  }

  const church = churches.get(churchId);
  if (!church) return { ok: false, status: 404, error: 'Church not found' };

  const access = checkBillingAccessForCommand(churchId, command);
  if (!access.allowed) {
    return { ok: false, status: access.status, error: access.error, device: access.device };
  }

  try {
    const sendCommand = makeCommandSender(church);
    totalMessagesRelayed++;
    const result = await sendCommand(command, params);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, status: 503, error: err.message || 'Command failed' };
  }
}

function parseChatCommandIntent(rawMessage) {
  const text = String(rawMessage || '').trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  if (lower.startsWith('/cmd')) {
    const commandText = text.slice(4).trim();
    if (!commandText) return { type: 'invalid', reason: 'Usage: /cmd cut to camera 2' };
    const parsed = parseCommand(commandText);
    if (!parsed) {
      return { type: 'invalid', reason: 'I could not parse that command. Example: /cmd cut to camera 2' };
    }
    return { type: 'command', parsed };
  }

  if (text.startsWith('!')) {
    const commandText = text.slice(1).trim();
    if (!commandText) return { type: 'invalid', reason: 'Usage: !cut to camera 2' };
    const parsed = parseCommand(commandText);
    if (!parsed) {
      return { type: 'invalid', reason: 'I could not parse that command. Example: !cut to camera 2' };
    }
    return { type: 'command', parsed };
  }

  if (lower.startsWith('/ai')) {
    const prompt = text.slice(3).trim();
    if (!prompt) return { type: 'invalid', reason: 'Usage: /ai move to the pastor shot and start stream' };
    return { type: 'ai', prompt };
  }

  // All other messages: try pattern parsing first, then AI as fallback.
  // This lets TDs type naturally ("switch to camera 2", "start recording")
  // without needing a prefix.
  const parsed = parseCommand(text);
  if (parsed) return { type: 'command', parsed };

  // Fall through to AI for conversational commands
  return { type: 'ai', prompt: text };
}

async function handleSetupRequest(churchId, rawMessage, attachment) {
  const mimeType = attachment?.mimeType || '';
  const intentType = detectIntentWithAttachment(rawMessage, mimeType);
  if (!intentType) return;

  const church = churches.get(churchId);

  try {
    if (intentType === 'media') {
      // Direct image upload to ATEM media player
      if (!attachment?.data) {
        postSystemChatMessage(churchId, '⚠️ Please attach an image to upload to the ATEM media player.');
        return;
      }

      // Parse which media player slot (mp1=index 0, mp2=index 1)
      const lower = (rawMessage || '').toLowerCase();
      let mpIndex = 0; // default to MP1
      if (/mp\s*2|media\s*player\s*2/.test(lower)) mpIndex = 1;

      postSystemChatMessage(churchId, `📤 Uploading image to ATEM media player ${mpIndex + 1}...`);

      // Step 1: Upload still to media pool
      const uploadResult = await executeChurchCommandWithResult(churchId, 'atem.uploadStill', {
        index: mpIndex, data: attachment.data, name: attachment.fileName || 'Still', mimeType,
      });
      if (!uploadResult.ok) {
        postSystemChatMessage(churchId, `❌ Upload failed: ${uploadResult.error}`);
        return;
      }
      postSystemChatMessage(churchId, `✅ Image uploaded to media pool slot ${mpIndex + 1}`);

      // Step 2: Set media player source to the uploaded still
      const mpResult = await executeChurchCommandWithResult(churchId, 'atem.setMediaPlayer', {
        player: mpIndex, sourceType: 'still', stillIndex: mpIndex,
      });
      if (mpResult.ok) {
        postSystemChatMessage(churchId, `✅ Media player ${mpIndex + 1} set to still ${mpIndex + 1}`);
      }

      // Step 3: Route to aux/program/preview if requested
      // ATEM media players are typically on inputs 3010 (MP1) and 3020 (MP2)
      const mpInputNumber = mpIndex === 0 ? 3010 : 3020;
      const followUpCommands = [];

      if (/\b(aux|aux\s*\d*)\b/.test(lower)) {
        const auxMatch = lower.match(/aux\s*(\d+)/);
        const auxNum = auxMatch ? parseInt(auxMatch[1], 10) - 1 : 0; // default aux 1
        followUpCommands.push({
          command: 'atem.setAux', params: { aux: auxNum, input: mpInputNumber },
          label: `Aux ${auxNum + 1} → MP${mpIndex + 1}`,
        });
      }
      if (/\bpgm\b|\bprogram\b/.test(lower)) {
        followUpCommands.push({
          command: 'atem.setProgram', params: { input: mpInputNumber },
          label: `Program → MP${mpIndex + 1}`,
        });
      }
      if (/\bpvw\b|\bpreview\b/.test(lower)) {
        followUpCommands.push({
          command: 'atem.setPreview', params: { input: mpInputNumber },
          label: `Preview → MP${mpIndex + 1}`,
        });
      }

      for (const fc of followUpCommands) {
        const result = await executeChurchCommandWithResult(churchId, fc.command, fc.params);
        postSystemChatMessage(churchId, result.ok
          ? `✅ ${fc.label}`
          : `❌ ${fc.label} failed: ${result.error}`);
      }

      if (!followUpCommands.length) {
        postSystemChatMessage(churchId, `📺 Say "send mp${mpIndex + 1} to program" or "send mp${mpIndex + 1} to aux 1" to route it.`);
      }
      return;
    }

    if (intentType === 'camera') {
      postSystemChatMessage(churchId, '🎥 Parsing camera plot...');
      const cameraSetup = await parseCameraPlot(
        rawMessage,
        attachment?.data || null,
        mimeType || 'image/jpeg'
      );
      const commands = buildCameraCommands(cameraSetup);
      if (!commands.length) {
        postSystemChatMessage(churchId, '⚠️ Could not identify any cameras from the input.');
        return;
      }
      postSystemChatMessage(churchId, `🎥 Setting up ${commands.length} ATEM inputs...`);
      for (const cmd of commands) {
        const executed = await executeChurchCommandWithResult(churchId, cmd.command, cmd.params);
        if (executed.ok) {
          postSystemChatMessage(churchId, `✅ Input ${cmd.params.input} → "${cmd.params.longName}"`);
        } else {
          postSystemChatMessage(churchId, `❌ Input ${cmd.params.input} failed: ${executed.error}`);
        }
      }
      postSystemChatMessage(churchId, '✅ Camera setup complete.');
      return;
    }

    if (intentType === 'mixer') {
      postSystemChatMessage(churchId, '🎛️ Parsing patch list...');
      const patchList = await parsePatchList(
        rawMessage,
        attachment?.data || null,
        mimeType || 'image/jpeg'
      );
      if (!patchList.channels || patchList.channels.length === 0) {
        postSystemChatMessage(churchId, '⚠️ Could not identify any channels from the input.');
        return;
      }
      postSystemChatMessage(churchId, `🎛️ Found ${patchList.channels.length} channels. Generating channel strip settings...`);

      const mixerType = church?.status?.mixer?.type || 'behringer';
      const setup = await generateMixerSetup(patchList, mixerType);
      if (!setup.channels || setup.channels.length === 0) {
        postSystemChatMessage(churchId, '⚠️ AI could not generate mixer settings.');
        return;
      }

      postSystemChatMessage(churchId, `🎛️ Applying ${setup.channels.length} channel strips to ${mixerType} console...`);
      const executed = await executeChurchCommandWithResult(churchId, 'mixer.setupFromPatchList', {
        channels: setup.channels,
        saveScene: true,
        sceneName: `AI Setup ${new Date().toLocaleDateString()}`,
      });

      postSystemChatMessage(churchId, executed.ok
        ? `✅ ${formatResultForChat(executed.result)}`
        : `❌ Mixer setup failed: ${executed.error}`);
      return;
    }
  } catch (err) {
    postSystemChatMessage(churchId, `❌ Setup assistant error: ${err.message}`);
  }
}

async function handleChatCommandMessage(churchId, rawMessage, attachment) {
  // If there's an attachment or a setup intent, route through the setup assistant
  if (attachment?.data || detectSetupIntent(rawMessage)) {
    return handleSetupRequest(churchId, rawMessage, attachment);
  }

  const intent = parseChatCommandIntent(rawMessage);
  if (!intent) return;

  if (intent.type === 'invalid') {
    postSystemChatMessage(churchId, `⚠️ ${intent.reason}`);
    return;
  }

  if (intent.type === 'command') {
    const { command, params } = intent.parsed;
    const executed = await executeChurchCommandWithResult(churchId, command, params || {});
    if (!executed.ok) {
      postSystemChatMessage(churchId, `❌ ${command} failed: ${executed.error}`);
      return;
    }
    postSystemChatMessage(churchId, `✅ ${command} ${formatResultForChat(executed.result)}`);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    postSystemChatMessage(churchId, '❌ AI command parsing is not configured (ANTHROPIC_API_KEY missing).');
    return;
  }

  const church = churches.get(churchId);
  const conversationHistory = chatEngine.getRecentConversation(churchId);
  const churchRow = stmtGet.get(churchId);
  const aiResult = await aiParseCommand(intent.prompt, {
    churchId,
    churchName: church?.name || '',
    status: church?.status || {},
    tier: churchRow?.billing_tier || 'connect',
  }, conversationHistory);

  if (aiResult.type === 'error') {
    postSystemChatMessage(churchId, `❌ ${aiResult.message || 'AI parser failed.'}`);
    return;
  }

  if (aiResult.type === 'chat') {
    postSystemChatMessage(churchId, aiResult.text || 'I could not map that to a command.');
    return;
  }

  const steps = aiResult.type === 'commands'
    ? (Array.isArray(aiResult.steps) ? aiResult.steps : [])
    : [{ command: aiResult.command, params: aiResult.params || {} }];

  if (!steps.length) {
    postSystemChatMessage(churchId, '⚠️ AI parser returned no executable command.');
    return;
  }

  for (const step of steps) {
    if (!step?.command) continue;

    // Handle system.wait pseudo-command (delay between steps)
    if (step.command === 'system.wait') {
      const seconds = Math.min(Math.max(Number(step.params?.seconds) || 1, 0.5), 30);
      postSystemChatMessage(churchId, `⏳ Waiting ${seconds}s...`);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      continue;
    }

    const executed = await executeChurchCommandWithResult(churchId, step.command, step.params || {});
    if (!executed.ok) {
      postSystemChatMessage(churchId, `❌ ${step.command} failed: ${executed.error}`);
      return;
    }
    postSystemChatMessage(churchId, `✅ ${step.command} ${formatResultForChat(executed.result)}`);
  }
}

// Send a command to a specific church
app.post('/api/command', requireAdmin, async (req, res) => {
  const { churchId, command, params = {} } = req.body;
  if (!churchId || !command) return res.status(400).json({ error: 'churchId and command required' });

  const rateLimit = await checkCommandRateLimit(churchId);
  if (!rateLimit.ok) {
    return res.status(429).json({ error: 'Rate limit exceeded (max 10 commands/second)' });
  }

  const church = churches.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  // Device-level billing gate: check if the church's tier allows this command's device
  const access = checkBillingAccessForCommand(churchId, command);
  if (!access.allowed) {
    return res.status(access.status).json({ error: access.error, command, device: access.device });
  }

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
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// ─── AI CHAT (Dashboard panel) ───────────────────────────────────────────────

app.post('/api/chat', requireAdmin, async (req, res) => {
  const { message, churchStates, history = [] } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message (string) required' });

  // Pre-filter: block off-topic messages before calling AI
  if (!isOnTopic(message)) {
    return res.json({ reply: OFF_TOPIC_RESPONSE });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });

  const systemPrompt = 'You are Tally AI, the admin assistant for Tally — a church AV monitoring and control system. '
    + 'You ONLY answer questions about: church AV equipment (ATEM switchers, audio mixers, cameras, encoders, video hubs, etc.), '
    + 'production troubleshooting, equipment status, alerts, streaming/recording, and church service technical operations. '
    + 'If a message is not about church AV production or equipment, reply with exactly: '
    + '"I\'m only here for production and equipment. Try \'help\' to see what I can do." '
    + 'Never discuss politics, religion (beyond service logistics), personal advice, coding, or any non-AV topic. '
    + 'Be concise. Church states: ' + JSON.stringify(churchStates || {});

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        system: systemPrompt,
        messages: [
          // Include conversation history from the frontend (validated to user/assistant roles)
          ...(Array.isArray(history) ? history : []).filter(
            (m) => m?.role && ['user', 'assistant'].includes(m.role) && m.content
          ).slice(-20),
          { role: 'user', content: message },
        ],
        temperature: 0.7,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      throw new Error(`Anthropic ${aiRes.status}: ${errBody.slice(0, 100)}`);
    }

    const data = await aiRes.json();
    const reply = data?.content?.[0]?.text || 'No response.';
    res.json({ reply });
  } catch (err) {
    console.error(`[Dashboard Chat] Error: ${err.message}`);
    res.status(503).json({ error: `AI unavailable: ${err.message}` });
  }
});

// ─── MONTHLY REPORT API ───────────────────────────────────────────────────────

// Monthly report — Pro/Managed only
app.get('/api/churches/:churchId/report', requireAdmin, requireFeature('monthly_report'), async (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const monthStr = req.query.month; // "YYYY-MM" or omit for previous month
  try {
    const dbChurch = stmtGet.get(req.params.churchId);
    const report = await monthlyReport.generateReport(req.params.churchId, monthStr);
    const text = monthlyReport.formatReport(report);
    res.json({ ...report, formatted: text });
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// ─── SESSION RECAP API ────────────────────────────────────────────────────────

app.get('/api/churches/:churchId/sessions', requireAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const sessions = db.prepare(
    'SELECT * FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
  ).all(req.params.churchId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM service_sessions WHERE church_id = ?').get(req.params.churchId);
  res.json({ sessions, total: total?.count || 0, limit, offset });
});

app.get('/api/churches/:churchId/sessions/current', requireAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const active = sessionRecap.getActiveSession(req.params.churchId);
  if (!active) return res.json({ active: false });
  res.json({ active: true, ...active });
});

// ─── SESSION TIMELINE — Merged chronological events + alerts for a session ──
app.get('/api/churches/:churchId/sessions/:sessionId/timeline', requireAdmin, (req, res) => {
  const { churchId, sessionId } = req.params;
  const church = churches.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  const session = db.prepare('SELECT * FROM service_sessions WHERE id = ? AND church_id = ?').get(sessionId, churchId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Get events linked to this session
  const events = db.prepare(
    'SELECT *, \'event\' as _type FROM service_events WHERE session_id = ? ORDER BY timestamp ASC'
  ).all(sessionId);

  // Get alerts linked to this session
  const alerts = db.prepare(
    'SELECT *, \'alert\' as _type FROM alerts WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId);

  // Get chat messages linked to this session
  const chatMsgs = db.prepare(
    'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC'
  ).all(sessionId);

  // Merge into a single chronological timeline
  const timeline = [
    // Session start marker
    { _type: 'marker', timestamp: session.started_at, label: 'Session Started', severity: 'INFO', td_name: session.td_name },
    // Events
    ...events.map(e => ({
      _type: 'event',
      id: e.id,
      timestamp: e.timestamp,
      event_type: e.event_type,
      details: e.details,
      resolved: !!e.resolved,
      auto_resolved: !!e.auto_resolved,
      resolved_at: e.resolved_at,
    })),
    // Alerts
    ...alerts.map(a => ({
      _type: 'alert',
      id: a.id,
      timestamp: a.created_at,
      alert_type: a.alert_type,
      severity: a.severity,
      context: (() => { try { return JSON.parse(a.context); } catch { return {}; } })(),
      acknowledged_at: a.acknowledged_at,
      acknowledged_by: a.acknowledged_by,
      escalated: !!a.escalated,
      resolved: !!a.resolved,
    })),
    // Chat messages
    ...chatMsgs.map(c => ({
      _type: 'chat',
      id: c.id,
      timestamp: c.timestamp,
      sender_name: c.sender_name,
      sender_role: c.sender_role,
      source: c.source,
      message: c.message,
    })),
    // Session end marker (if ended)
    ...(session.ended_at ? [{
      _type: 'marker',
      timestamp: session.ended_at,
      label: 'Session Ended',
      severity: 'INFO',
      grade: session.grade,
      duration_minutes: session.duration_minutes,
    }] : []),
  ];

  // Sort by timestamp
  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  res.json({ session, timeline });
});

// ─── SESSION DEBRIEF — Auto-generated text summary ─────────────────────────
app.get('/api/churches/:churchId/sessions/:sessionId/debrief', requireAdmin, (req, res) => {
  const { churchId, sessionId } = req.params;
  const church = churches.get(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  const session = db.prepare('SELECT * FROM service_sessions WHERE id = ? AND church_id = ?').get(sessionId, churchId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const events = db.prepare('SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId);
  const alerts = db.prepare('SELECT * FROM alerts WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
  const chatMsgs = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId);

  // Build debrief text
  const startTime = new Date(session.started_at);
  const endTime = session.ended_at ? new Date(session.ended_at) : null;
  const gradeIcon = session.grade === 'Clean' ? '\u{1F7E2}' : session.grade === 'Minor issues' ? '\u{1F7E1}' : '\u{1F534}';

  const lines = [
    `SERVICE DEBRIEF — ${church.name}`,
    `${'─'.repeat(40)}`,
    `Date: ${startTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
    `Time: ${startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${endTime ? ' – ' + endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ' (in progress)'}`,
    `Duration: ${session.duration_minutes ? session.duration_minutes + ' min' : 'In progress'}`,
    `TD: ${session.td_name || 'Unknown'}`,
    `Grade: ${gradeIcon} ${session.grade || 'N/A'}`,
    '',
    `STATS`,
    `${'─'.repeat(20)}`,
    `Alerts: ${session.alert_count || 0}`,
    `Auto-recovered: ${session.auto_recovered_count || 0}`,
    `Escalated: ${session.escalated_count || 0}`,
    `Audio silences: ${session.audio_silence_count || 0}`,
    `Stream ran: ${session.stream_ran ? 'Yes' : 'No'}${session.stream_runtime_minutes ? ' (' + session.stream_runtime_minutes + ' min)' : ''}`,
    `Recording: ${session.recording_confirmed ? 'Confirmed' : 'Not confirmed'}`,
    `Peak viewers: ${session.peak_viewers || 'N/A'}`,
    `Chat messages: ${chatMsgs.length}`,
  ];

  if (events.length > 0 || alerts.length > 0 || chatMsgs.length > 0) {
    lines.push('', `ACTIVITY LOG`, `${'─'.repeat(20)}`);

    const merged = [
      ...events.map(e => ({ time: e.timestamp, text: `[EVENT] ${e.event_type}${e.auto_resolved ? ' (auto-resolved)' : e.resolved ? ' (resolved)' : ''}${e.details ? ': ' + e.details.substring(0, 80) : ''}` })),
      ...alerts.map(a => ({ time: a.created_at, text: `[${a.severity}] ${a.alert_type}${a.acknowledged_at ? ' (ack by ' + (a.acknowledged_by || '?') + ')' : ''}${a.escalated ? ' ESCALATED' : ''}` })),
      ...chatMsgs.map(c => ({ time: c.timestamp, text: `[CHAT] ${c.sender_name} (${c.source}): ${c.message.substring(0, 80)}` })),
    ].sort((a, b) => new Date(a.time) - new Date(b.time));

    for (const item of merged) {
      const t = new Date(item.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      lines.push(`  ${t}  ${item.text}`);
    }
  } else {
    lines.push('', 'No activity recorded during this session.');
  }

  lines.push('', `— Generated by Tally • ${new Date().toLocaleDateString()}`);

  res.json({ debrief: lines.join('\n'), session });
});

// ─── PLANNING CENTER API ──────────────────────────────────────────────────────

// GET current PC status (no credentials in response) — Pro/Managed only
app.get('/api/churches/:churchId/planning-center', requireAdmin, requireFeature('planning_center'), (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const status = planningCenter.getStatus(req.params.churchId);
  res.json(status);
});

// PUT set credentials — Pro/Managed only
app.put('/api/churches/:churchId/planning-center', requireAdmin, requireFeature('planning_center'), (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const { appId, secret, serviceTypeId, syncEnabled } = req.body;
  planningCenter.setCredentials(req.params.churchId, { appId, secret, serviceTypeId, syncEnabled });
  res.json({ saved: true });
});

// POST manual sync now — Pro/Managed only
app.post('/api/churches/:churchId/planning-center/sync', requireAdmin, requireFeature('planning_center'), async (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  try {
    const result = await planningCenter.syncChurch(req.params.churchId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// GET preview upcoming services without saving — Pro/Managed only
app.get('/api/churches/:churchId/planning-center/preview', requireAdmin, requireFeature('planning_center'), async (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  try {
    const services = await planningCenter.getUpcomingServicesForChurch(req.params.churchId);
    res.json({ services });
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// ─── EVENT MODE API ───────────────────────────────────────────────────────────

// Create a time-limited event church (admin only)
app.post('/api/events/create', requireAdmin, (req, res) => {
  const { name, eventLabel, durationHours = 72, tdName, tdTelegramChatId, contactEmail } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const existing = stmtFindByName.get(name);
  if (existing) return res.status(409).json({ error: `A church named "${name}" already exists` });

  try {
    const result = eventMode.createEvent({ name, eventLabel, durationHours, tdName, tdTelegramChatId, contactEmail });

    // Add to in-memory map so it's immediately visible
    churches.set(result.churchId, {
      churchId:         result.churchId,
      name,
      email:            contactEmail || '',
      token:            result.token,
      ws:               null,
      status:           { connected: false, atem: null, obs: null },
      lastSeen:         null,
      lastHeartbeat:    null,
      registeredAt:     new Date().toISOString(),
      disconnectedAt:   null,
      _offlineAlertSent: false,
      church_type:      'event',
      event_expires_at: result.expiresAt,
      event_label:      eventLabel || name,
      reseller_id:      null,
    });

    log(`Event church created: "${name}" (${result.churchId}), expires ${result.expiresAt}`);
    res.json({ churchId: result.churchId, token: result.token, expiresAt: result.expiresAt, name });
  } catch (e) {
    console.error('[/api/events/create]', e.message);
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// ─── RESELLER API (admin) ─────────────────────────────────────────────────────

// Create a new reseller
app.post('/api/resellers', requireAdmin, (req, res) => {
  const { name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = resellerSystem.createReseller({ name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit });
    res.json(result);
  } catch (e) {
    console.error('[/api/resellers POST]', e.message);
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// List all resellers with church counts
app.get('/api/resellers', requireAdmin, (req, res) => {
  try {
    res.json(resellerSystem.listResellers());
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// Reseller details + their churches
app.get('/api/resellers/:resellerId', requireAdmin, (req, res) => {
  const detail = resellerSystem.getResellerDetail(req.params.resellerId);
  if (!detail) return res.status(404).json({ error: 'Reseller not found' });
  res.json(detail);
});

// ─── RESELLER-AUTHENTICATED API ───────────────────────────────────────────────

// Register a church under this reseller's account
app.post('/api/reseller/churches/register', requireReseller, (req, res) => {
  const reseller = req.reseller;
  const { name, email } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Check church limit
  if (!resellerSystem.canAddChurch(reseller.id)) {
    return res.status(403).json({ error: `Church limit reached (max ${reseller.church_limit})` });
  }

  // Check uniqueness
  const existing = stmtFindByName.get(name);
  if (existing) return res.status(409).json({ error: `A church named "${name}" already exists` });

  try {
    const churchId     = require('uuid').v4();
    const token        = jwt.sign({ churchId, name }, JWT_SECRET, { expiresIn: '365d' });
    const registeredAt = new Date().toISOString();

    stmtInsert.run(churchId, name, email || '', token, registeredAt);
    resellerSystem.registerChurch(reseller.id, churchId, name);

    // Add to in-memory map
    churches.set(churchId, {
      churchId,
      name,
      email:            email || '',
      token,
      ws:               null,
      status:           { connected: false, atem: null, obs: null },
      lastSeen:         null,
      lastHeartbeat:    null,
      registeredAt,
      disconnectedAt:   null,
      _offlineAlertSent: false,
      church_type:      'recurring',
      event_expires_at: null,
      event_label:      null,
      reseller_id:      reseller.id,
    });

    log(`Reseller "${reseller.name}" registered church: ${name} (${churchId})`);
    res.json({
      churchId, name, token, resellerId: reseller.id,
      message: 'Church registered. Share this token with the church client app.',
    });
  } catch (e) {
    console.error('[/api/reseller/churches/register]', e.message);
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// List this reseller's churches
app.get('/api/reseller/churches', requireReseller, (req, res) => {
  try {
    const dbChurches = resellerSystem.getResellerChurches(req.reseller.id);
    const list = dbChurches.map(c => {
      const runtime = churches.get(c.churchId);
      return {
        churchId:  c.churchId,
        name:      c.name,
        connected: runtime?.ws?.readyState === WebSocket.OPEN,
        status:    runtime?.status || null,
        lastSeen:  runtime?.lastSeen || null,
      };
    });
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// Single church detail for reseller (must belong to them)
app.get('/api/reseller/churches/:churchId', requireReseller, (req, res) => {
  const row = db.prepare('SELECT * FROM churches WHERE churchId = ? AND reseller_id = ?')
    .get(req.params.churchId, req.reseller.id);
  if (!row) return res.status(404).json({ error: 'Church not found or does not belong to your account' });
  const runtime = churches.get(row.churchId);
  res.json({
    churchId:  row.churchId,
    name:      row.name,
    connected: runtime?.ws?.readyState === WebSocket.OPEN,
    status:    runtime?.status || null,
    lastSeen:  runtime?.lastSeen || null,
  });
});

// Branding info for white-labeling the client UI
app.get('/api/reseller/branding', requireReseller, (req, res) => {
  const branding = resellerSystem.getBranding(req.reseller.id);
  if (!branding) return res.status(404).json({ error: 'Reseller not found' });
  res.json(branding);
});

// ─── NEW RESELLER-AUTHENTICATED ROUTES ───────────────────────────────────────

// GET /portal — white-labeled portal HTML (validate via ?key= query param)
app.get('/portal', (req, res) => {
  const key = req.query.key || req.headers['x-reseller-key'];
  if (!key) {
    return res.status(401).send('<html><body style="background:#0f1117;color:#e2e4ef;font-family:monospace;padding:40px"><h1>401 Unauthorized</h1><p>Add <code>?key=YOUR_RESELLER_KEY</code> to the URL.</p></body></html>');
  }
  const reseller = resellerSystem.getReseller(key);
  if (!reseller) {
    return res.status(403).send('<html><body style="background:#0f1117;color:#e2e4ef;font-family:monospace;padding:40px"><h1>403 Forbidden</h1><p>Invalid reseller key.</p></body></html>');
  }
  if (reseller.active === 0) {
    return res.status(403).send('<html><body style="background:#0f1117;color:#e2e4ef;font-family:monospace;padding:40px"><h1>403 Forbidden</h1><p>Reseller account is inactive.</p></body></html>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildResellerPortalHtml(reseller));
});

// GET /api/reseller/me — reseller info + stats
app.get('/api/reseller/me', requireReseller, (req, res) => {
  try {
    const stats = resellerSystem.getResellerStats(req.reseller.id, churches);
    const { api_key, ...safe } = req.reseller;
    res.json({ ...safe, ...stats });
  } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
});

// PUT /api/reseller/me — update branding
app.put('/api/reseller/me', requireReseller, (req, res) => {
  try {
    const { name, brand_name, support_email, logo_url, primary_color, custom_domain } = req.body;
    const patch = {};
    if (name          !== undefined) patch.name          = name;
    if (brand_name    !== undefined) patch.brand_name    = brand_name;
    if (support_email !== undefined) patch.support_email = support_email;
    if (logo_url      !== undefined) patch.logo_url      = logo_url;
    if (primary_color !== undefined) patch.primary_color = primary_color;
    if (custom_domain !== undefined) patch.custom_domain = custom_domain;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields provided' });
    const updated = resellerSystem.updateReseller(req.reseller.id, patch);
    const { api_key, ...safe } = updated;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
});

// POST /api/reseller/churches/token — generate church + registration code
app.post('/api/reseller/churches/token', requireReseller, (req, res) => {
  try {
    const { churchName, contactEmail, portalEmail, password } = req.body || {};
    if (!churchName) return res.status(400).json({ error: 'churchName required' });
    if (password && !portalEmail) return res.status(400).json({ error: 'portalEmail is required when password is provided' });
    if (portalEmail && !password) return res.status(400).json({ error: 'password is required when portalEmail is provided' });
    if (password && String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const cleanContactEmail = String(contactEmail || '').trim();
    const cleanPortalEmail = String(portalEmail || '').trim().toLowerCase();

    if (cleanPortalEmail) {
      const existingEmail = db.prepare('SELECT churchId FROM churches WHERE portal_email = ?').get(cleanPortalEmail);
      if (existingEmail) return res.status(409).json({ error: 'portalEmail already exists' });
    }

    const createChurch = db.transaction(() => {
      const result = resellerSystem.generateChurchToken(req.reseller.id, churchName);
      if (cleanContactEmail) {
        db.prepare('UPDATE churches SET email = ? WHERE churchId = ?').run(cleanContactEmail, result.churchId);
      }
      if (cleanPortalEmail) {
        db.prepare('UPDATE churches SET portal_email = ?, portal_password_hash = ? WHERE churchId = ?')
          .run(cleanPortalEmail, hashPassword(password), result.churchId);
      }
      return result;
    });
    const result = createChurch();

    // Add to in-memory map so the church is immediately visible
    churches.set(result.churchId, {
      churchId:         result.churchId,
      name:             result.churchName,
      email:            cleanContactEmail,
      token:            result.token,
      ws:               null,
      status:           { connected: false, atem: null, obs: null },
      lastSeen:         null,
      lastHeartbeat:    null,
      registeredAt:     new Date().toISOString(),
      disconnectedAt:   null,
      _offlineAlertSent: false,
      church_type:      'recurring',
      event_expires_at: null,
      event_label:      null,
      reseller_id:      req.reseller.id,
    });

    log(`Reseller "${req.reseller.name}" created church token: ${result.churchName} (${result.churchId})`);
    res.json({
      churchId:         result.churchId,
      churchName:       result.churchName,
      registrationCode: result.registrationCode,
      portalEmail:      cleanPortalEmail || null,
      appLoginCreated:  !!cleanPortalEmail,
      reseller:         req.reseller.brand_name || req.reseller.name,
    });
  } catch (e) {
    const msg = String(e.message || '');
    const status =
      msg.includes('limit') ? 403 :
      (msg.includes('already exists') || msg.includes('UNIQUE constraint failed')) ? 409 :
      (msg.includes('required') || msg.includes('at least 8')) ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

// GET /api/reseller/stats — church count, online count, alert count
app.get('/api/reseller/stats', requireReseller, (req, res) => {
  try {
    const stats = resellerSystem.getResellerStats(req.reseller.id, churches);
    res.json(stats);
  } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function resolveAdminKey(req) {
  return req.headers['x-api-key'] || req.cookies[ADMIN_SESSION_COOKIE];
}

function setAdminSession(res, key) {
  res.cookie(ADMIN_SESSION_COOKIE, key, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_SESSION_TTL_MS,
  });
}

app.get('/dashboard', (req, res) => {
  const queryKey = req.query.key || req.query.apikey;

  if (queryKey) {
    if (!safeCompareKey(queryKey, ADMIN_API_KEY)) {
      return res.status(401).send('<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;padding:40px"><h1>401 Unauthorized</h1><p>Invalid admin key.</p></body></html>');
    }
    setAdminSession(res, queryKey);
    // Redirect to clean URL so the key is not left in browser history/bookmarks.
    return res.redirect(302, '/dashboard');
  }

  const key = resolveAdminKey(req);
  if (!safeCompareKey(key, ADMIN_API_KEY)) {
    return res.status(401).send('<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;padding:40px"><h1>401 Unauthorized</h1><p>Missing admin authentication. Set your admin key via header or add <code>?key=YOUR_ADMIN_KEY</code> one-time to establish a session.</p></body></html>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildDashboardHtml());
});

// ─── SSE Dashboard Stream ─────────────────────────────────────────────────────

app.get('/api/dashboard/stream', (req, res) => {
  const key         = resolveAdminKey(req);
  const resellerKey = req.query.resellerKey || req.headers['x-reseller-key'];

  let filterResellerId = null;

  if (resellerKey) {
    // Reseller portal access — validate reseller key and filter to their churches
    const reseller = resellerSystem.getReseller(resellerKey);
    if (!reseller) return res.status(403).json({ error: 'Invalid reseller key' });
    filterResellerId = reseller.id;
  } else if (!safeCompareKey(key, ADMIN_API_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if behind proxy
  res.flushHeaders();

  // Attach reseller filter to the response for broadcast filtering
  if (filterResellerId) res._resellerFilter = filterResellerId;

  // Send initial state (filtered if reseller)
  const allChurches = Array.from(churches.values());
  const filtered = filterResellerId
    ? allChurches.filter(c => c.reseller_id === filterResellerId)
    : allChurches;

  const initialState = filtered.map(c => ({
    churchId:         c.churchId,
    name:             c.name,
    connected:        c.ws?.readyState === WebSocket.OPEN,
    status:           c.status,
    lastSeen:         c.lastSeen,
    lastHeartbeat:    c.lastHeartbeat,
    church_type:      c.church_type      || 'recurring',
    event_expires_at: c.event_expires_at || null,
    event_label:      c.event_label      || null,
    reseller_id:      c.reseller_id      || null,
  }));
  res.write(`data: ${JSON.stringify({ type: 'initial', churches: initialState })}\n\n`);

  // Keep-alive ping every 15s to prevent proxy/LB timeouts
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);

  sseClients.add(res);
  log(`Dashboard SSE client connected (total: ${sseClients.size})`);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    log(`Dashboard SSE client disconnected (total: ${sseClients.size})`);
  });
});

// Periodic snapshot broadcast every 60s — keeps all dashboards in sync
_intervals.push(setInterval(() => {
  if (sseClients.size === 0) return;
  const states = [...churches.values()].map(c => ({
    churchId:         c.churchId,
    name:             c.name,
    connected:        c.connected,
    status:           c.status,
    lastSeen:         c.lastSeen,
    activeAlerts:     c.activeAlerts || 0,
    encoderActive:    c.encoderActive || false,
    syncStatus:       c.syncStatus || null,
    church_type:      c.church_type || 'recurring',
    reseller_id:      c.reseller_id || null,
  }));
  broadcastToSSE({ type: 'snapshot', churches: states });
}, 60_000));

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

app.get('/api/churches/:churchId/oncall', requireAdmin, requireFeature('oncall_rotation'), (req, res) => {
  const onCall = onCallRotation.getOnCallTD(req.params.churchId);
  const all = db.prepare('SELECT * FROM td_oncall WHERE churchId = ? ORDER BY isPrimary DESC, id ASC').all(req.params.churchId);
  res.json({ onCall, all });
});

app.post('/api/churches/:churchId/oncall', requireAdmin, requireFeature('oncall_rotation'), (req, res) => {
  const { tdName } = req.body;
  if (!tdName) return res.status(400).json({ error: 'tdName required' });
  const result = onCallRotation.setOnCall(req.params.churchId, tdName);
  res.json(result);
});

app.post('/api/churches/:churchId/tds/add', requireAdmin, requireFeature('oncall_rotation'), (req, res) => {
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

// Telegram bot API (extracted)
require('./src/routes/telegram')(app, {
  db, churches, tallyBot, requireAdmin, safeErrorMessage, log,
  TALLY_BOT_WEBHOOK_URL, TALLY_BOT_WEBHOOK_SECRET,
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

  const access = checkChurchPaidAccess(church.churchId);
  if (!access.allowed) {
    log(`Blocked church connection for "${church.name}" (${church.churchId}): ${access.message}`);
    return ws.close(1008, `billing_${access.status}`);
  }

  // Close any existing connection from this church
  if (church.ws?.readyState === WebSocket.OPEN) {
    church.ws.close(1000, 'replaced by new connection');
  }

  church.ws = ws;
  church.lastSeen = new Date().toISOString();
  church.disconnectedAt = null;
  log(`Church "${church.name}" connected from ${clientIp}`);

  // ─── Onboarding milestone: first app connection ───────────────────────
  try {
    const dbRow = db.prepare('SELECT onboarding_app_connected_at, portal_email, registration_code FROM churches WHERE churchId = ?').get(church.churchId);
    if (dbRow && !dbRow.onboarding_app_connected_at) {
      const now = new Date().toISOString();
      db.prepare('UPDATE churches SET onboarding_app_connected_at = ? WHERE churchId = ?').run(now, church.churchId);
      log(`[onboarding] First app connection for "${church.name}"`);

      // Send "You're live!" email (non-blocking)
      if (dbRow.portal_email) {
        const portalUrl = `${APP_URL}/portal`;
        sendOnboardingEmail({
          to: dbRow.portal_email,
          subject: `Tally is live at ${church.name}!`,
          html: buildConnectionEmailHtml({ churchName: church.name, registrationCode: dbRow.registration_code || '', portalUrl }),
          text: buildConnectionEmailText({ churchName: church.name, registrationCode: dbRow.registration_code || '', portalUrl }),
          tag: 'connection-success',
        }).catch((e) => log(`[onboarding] Connection email failed: ${e.message}`));
      }
    }
  } catch (e) {
    log(`[onboarding] Milestone tracking error: ${e.message}`);
  }

  // Drain any queued messages
  drainQueue(church.churchId, ws);

  // Send branding message if this church belongs to a reseller
  try {
    const dbChurchRow = stmtGet.get(church.churchId);
    if (dbChurchRow && dbChurchRow.reseller_id) {
      const branding = resellerSystem.getBranding(dbChurchRow.reseller_id);
      if (branding && branding.brandName) {
        ws.send(JSON.stringify({ type: 'branding', ...branding }));
        log(`Branding sent to "${church.name}" via reseller "${branding.brandName}"`);
      }
    }
  } catch (e) {
    console.error('[branding] lookup error:', e.message);
  }

  // Notify controllers and SSE dashboard
  const connectedEvent = {
    type:             'church_connected',
    churchId:         church.churchId,
    name:             church.name,
    timestamp:        church.lastSeen,
    connected:        true,
    status:           church.status,
    church_type:      church.church_type      || 'recurring',
    event_expires_at: church.event_expires_at || null,
    event_label:      church.event_label      || null,
    reseller_id:      church.reseller_id      || null,
  };
  broadcastToControllers(connectedEvent);
  broadcastToSSE(connectedEvent);

  // WebSocket-level ping every 25s to keep the connection alive through reverse proxies
  const wsPingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);

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
    clearInterval(wsPingInterval);
    church.lastSeen = new Date().toISOString();
    church.disconnectedAt = Date.now();
    // Reset device status so dashboard doesn't show stale connected states
    church.status = { connected: false, atem: null, obs: null };
    log(`Church "${church.name}" disconnected`);
    const disconnectEvent = {
      type: 'church_disconnected',
      churchId: church.churchId,
      name: church.name,
      connected: false,
      status: church.status,
    };
    broadcastToControllers(disconnectEvent);
    broadcastToSSE(disconnectEvent);
  });

  ws.on('error', (err) => {
    console.error(`WS error from church "${church.name}":`, err.message);
  });

  ws.send(JSON.stringify({ type: 'connected', churchId: church.churchId, name: church.name }));
}

function handleControllerConnection(ws, url) {
  const apiKey = url.searchParams.get('apikey');
  if (!safeCompareKey(apiKey, ADMIN_API_KEY)) return ws.close(1008, 'invalid api key');

  controllers.add(ws);
  log(`Controller connected (total: ${controllers.size})`);

  const churchList = Array.from(churches.values()).map(c => ({
    churchId: c.churchId,
    name: c.name,
    connected: c.ws?.readyState === WebSocket.OPEN,
    status: c.status,
  }));
  ws.send(JSON.stringify({ type: 'church_list', churches: churchList }));

  // WebSocket-level ping every 25s to keep the connection alive through reverse proxies
  const wsPingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      await handleControllerMessage(ws, msg);
    } catch (e) {
      console.error('Invalid message from controller:', e.message);
    }
  });

  ws.on('close', () => {
    clearInterval(wsPingInterval);
    controllers.delete(ws);
    log(`Controller disconnected (total: ${controllers.size})`);
  });

  ws.on('error', (err) => {
    console.error('WS error from controller:', err.message);
  });
}

function handleChurchMessage(church, msg) {
  church.lastSeen = new Date().toISOString();

  switch (msg.type) {
    case 'status_update':
      church.status = { ...church.status, ...msg.status };
      church.lastHeartbeat = Date.now(); // track specifically for offline detection
      church._offlineAlertSent = false; // reset offline alert flag on reconnect

      // ─── Onboarding milestone: first ATEM connection ─────────────────
      if (msg.status?.atem?.connected && !church._onboardingAtemTracked) {
        try {
          const row = db.prepare('SELECT onboarding_atem_connected_at FROM churches WHERE churchId = ?').get(church.churchId);
          if (row && !row.onboarding_atem_connected_at) {
            db.prepare('UPDATE churches SET onboarding_atem_connected_at = ? WHERE churchId = ?').run(new Date().toISOString(), church.churchId);
            log(`[onboarding] First ATEM connection for "${church.name}"`);
          }
          church._onboardingAtemTracked = true; // avoid repeat DB checks
        } catch (e) {
          log(`[onboarding] ATEM milestone error: ${e.message}`);
        }
      }

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
      // Feed session recap with live stream/recording state
      if (msg.status) {
        if (hasStreamSignal(msg.status)) {
          sessionRecap.recordStreamStatus(church.churchId, isStreamActive(msg.status));
        }
        if (msg.status.obs?.viewers !== undefined) {
          sessionRecap.recordPeakViewers(church.churchId, msg.status.obs.viewers);
        }
        if (isRecordingActive(msg.status)) {
          sessionRecap.recordRecordingConfirmed(church.churchId);
        }
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
        // Audio silence — record separately for session recap
        if (msg.alertType === 'audio_silence') {
          sessionRecap.recordAudioSilence(church.churchId);
        }

        (async () => {
          try {
            // Get active session ID for timeline linking
            const activeSessionId = sessionRecap.getActiveSessionId(church.churchId);
            // Log event (with session ID)
            const eventId = weeklyDigest.addEvent(church.churchId, msg.alertType, msg.message, activeSessionId);
            // Try auto-recovery first
            const recovery = await autoRecovery.attempt(church, msg.alertType, church.status);
            if (recovery.attempted && recovery.success) {
              weeklyDigest.resolveEvent(eventId, true);
              // Record as auto-recovered in session
              sessionRecap.recordAlert(church.churchId, msg.alertType, true, false);
              log(`[AutoRecovery] ✅ ${recovery.event} for ${church.name}`);
            } else {
              // Send alert through escalation ladder (with session ID + recovery result)
              const dbChurch = stmtGet.get(church.churchId);
              const recoveryInfo = recovery.attempted ? recovery : null;
              const alertResult = await alertEngine.sendAlert({ ...church, ...dbChurch }, msg.alertType, { message: msg.message, status: church.status }, activeSessionId, recoveryInfo);
              // Record in session — escalated if EMERGENCY severity
              const escalated = alertResult && alertResult.severity === 'EMERGENCY';
              sessionRecap.recordAlert(church.churchId, msg.alertType, false, escalated);
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

    case 'propresenter_slide_change': {
      // Forward slide change to autopilot for trigger evaluation
      autoPilot.onSlideChange(church.churchId, {
        presentationName: msg.presentationName || '',
        slideIndex: msg.slideIndex ?? 0,
        slideCount: msg.slideCount ?? 0,
      }).catch(e => console.error(`[AutoPilot] Slide change error:`, e.message));
      break;
    }

    case 'chat': {
      if (!msg.message || !msg.message.trim()) break;
      const saved = chatEngine.saveMessage({
        churchId: church.churchId,
        senderName: msg.senderName || church.tdName || 'TD',
        senderRole: msg.senderRole || 'td',
        source: 'app',
        message: msg.message.trim(),
      });
      chatEngine.broadcastChat(saved);
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

async function handleControllerMessage(ws, msg) {
  if (msg.type === 'command' && msg.churchId) {
    const rateLimit = await checkCommandRateLimit(msg.churchId);
    if (!rateLimit.ok) {
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

  // Chat from controller (admin dashboard WebSocket)
  if (msg.type === 'chat' && msg.churchId && msg.message) {
    const saved = chatEngine.saveMessage({
      churchId: msg.churchId,
      senderName: msg.senderName || 'Admin',
      senderRole: 'admin',
      source: 'dashboard',
      message: msg.message.trim(),
    });
    chatEngine.broadcastChat(saved);
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
    try {
      // If this SSE client has a reseller filter, only send events for their churches
      if (res._resellerFilter) {
        const churchId = data.churchId;
        if (churchId) {
          const church = churches.get(churchId);
          if (!church || church.reseller_id !== res._resellerFilter) continue;
        } else {
          continue; // skip non-church events for reseller streams
        }
      }
      res.write(payload);
    } catch { sseClients.delete(res); }
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

const ADMIN_ROLES = ['super_admin', 'admin', 'engineer', 'sales'];

const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  admin:       ['churches:read', 'churches:write', 'churches:delete',
                'billing:read', 'billing:write',
                'resellers:read', 'resellers:write', 'resellers:delete',
                'commands:send', 'settings:read', 'settings:write'],
  engineer:    ['churches:read', 'commands:send',
                'sessions:read', 'alerts:read', 'alerts:ack',
                'settings:read'],
  sales:       ['churches:read',
                'billing:read',
                'resellers:read', 'resellers:write'],
};

function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

/**
 * JWT-based admin auth middleware.
 * Accepts: Authorization: Bearer <jwt>, x-admin-jwt header, or legacy x-api-key.
 * @param {...string} allowedRoles - If provided, only these roles are allowed. Empty = any admin role.
 */
function requireAdminJwt(...allowedRoles) {
  return (req, res, next) => {
    // 1. Try JWT from Authorization: Bearer header
    let token = null;
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
    // 2. Try x-admin-jwt header (from landing site proxy)
    if (!token) token = req.headers['x-admin-jwt'];

    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.type !== 'admin') throw new Error('wrong token type');

        // Verify user still exists and is active (catches revocations)
        const user = db.prepare('SELECT id, email, name, role, active FROM admin_users WHERE id = ?').get(payload.userId);
        if (!user || !user.active) {
          return res.status(401).json({ error: 'Account deactivated or not found' });
        }

        // Check role permission
        if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }

        req.adminUser = { id: user.id, email: user.email, name: user.name, role: user.role };
        return next();
      } catch (e) {
        if (e.name === 'TokenExpiredError') {
          return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(401).json({ error: 'Invalid admin token' });
      }
    }

    // 3. Legacy fallback: x-api-key or admin cookie → treat as super_admin
    const key = resolveAdminKey(req);
    if (safeCompareKey(key, ADMIN_API_KEY)) {
      req.adminUser = { id: '_legacy_api_key', email: '', name: 'API Key', role: 'super_admin' };
      if (allowedRoles.length > 0 && !allowedRoles.includes('super_admin')) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      return next();
    }

    return res.status(401).json({ error: 'unauthorized' });
  };
}

function requireAdmin(req, res, next) {
  // Backward-compatible: accepts JWT or legacy API key
  return requireAdminJwt()(req, res, next);
}

function requireReseller(req, res, next) {
  const key = req.headers['x-reseller-key'];
  if (!key) return res.status(401).json({ error: 'Reseller API key required' });
  const reseller = db.prepare('SELECT * FROM resellers WHERE api_key = ?').get(key);
  if (!reseller) return res.status(403).json({ error: 'Invalid reseller key' });
  req.reseller = reseller;
  next();
}

function requireChurchOrAdmin(req, res, next) {
  const key = resolveAdminKey(req);
  if (safeCompareKey(key, ADMIN_API_KEY)) return next();

  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      // Church JWT can only access its own data
      if (req.params.churchId && payload.churchId !== req.params.churchId) {
        return res.status(403).json({ error: 'forbidden' });
      }
      req.churchPayload = payload;
      return next();
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }
  }

  return res.status(401).json({ error: 'unauthorized' });
}

// ─── PRESET LIBRARY API ───────────────────────────────────────────────────────

// Helper: create a sendCommand function for a church WebSocket
function makeCommandSender(church) {
  return (command, params) => new Promise((resolve, reject) => {
    const { WebSocket: WS } = require('ws');
    if (!church.ws || church.ws.readyState !== WS.OPEN) {
      return reject(new Error('Church client not connected'));
    }
    const { v4: uuid } = require('uuid');
    const id = uuid();
    const timeout = setTimeout(() => {
      church.ws.removeListener('message', handler);
      reject(new Error('Command timeout (15s)'));
    }, 15000);

    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'command_result' && msg.id === id) {
          clearTimeout(timeout);
          church.ws.removeListener('message', handler);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch { /* ignore */ }
    };
    church.ws.on('message', handler);
    church.ws.send(JSON.stringify({ type: 'command', command, params, id }));
  });
}

// List presets for a church
app.get('/api/churches/:churchId/presets', requireChurchOrAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  res.json(presetLibrary.list(req.params.churchId));
});

// Save a preset
app.post('/api/churches/:churchId/presets', requireChurchOrAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const { name, type, data } = req.body;
  if (!name || !type || !data) return res.status(400).json({ error: 'name, type, and data required' });
  try {
    const id = presetLibrary.save(req.params.churchId, name, type, data);
    res.json({ id, name, type, saved: true });
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// Get a specific preset
app.get('/api/churches/:churchId/presets/:name', requireChurchOrAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const preset = presetLibrary.get(req.params.churchId, req.params.name);
  if (!preset) return res.status(404).json({ error: 'Preset not found' });
  res.json(preset);
});

// Delete a preset
app.delete('/api/churches/:churchId/presets/:name', requireChurchOrAdmin, (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const deleted = presetLibrary.delete(req.params.churchId, req.params.name);
  if (!deleted) return res.status(404).json({ error: 'Preset not found' });
  res.json({ deleted: true });
});

// Recall a preset (send appropriate device command to church client)
app.post('/api/churches/:churchId/presets/:name/recall', requireChurchOrAdmin, async (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  if (!church.ws || church.ws.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'Church client not connected' });
  }
  try {
    const sendCommand = makeCommandSender(church);
    const preset = await presetLibrary.recall(req.params.churchId, req.params.name, sendCommand);
    log(`PRESET recall → ${church.name}: "${preset.name}" (${preset.type})`);
    res.json({ recalled: true, preset: { name: preset.name, type: preset.type } });
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

// ─── AUTOPILOT API ────────────────────────────────────────────────────────────

// List rules + paused state
app.get('/api/churches/:churchId/automation', requireAdmin, requireFeature('autopilot'), (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });
  const rules = autoPilot.getRules(req.params.churchId);
  res.json({
    paused: autoPilot.isPaused(req.params.churchId),
    rules,
  });
});

// Create rule
app.post('/api/churches/:churchId/automation', requireAdmin, requireFeature('autopilot'), (req, res) => {
  const church = churches.get(req.params.churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  try {
    const rule = autoPilot.createRule(req.params.churchId, {
      name: req.body.name,
      triggerType: req.body.triggerType,
      triggerConfig: req.body.triggerConfig || {},
      actions: req.body.actions || [],
    });
    res.json(rule);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update rule
app.put('/api/churches/:churchId/automation/:ruleId', requireAdmin, requireFeature('autopilot'), (req, res) => {
  try {
    const rule = autoPilot.updateRule(req.params.ruleId, req.body);
    res.json(rule);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete rule
app.delete('/api/churches/:churchId/automation/:ruleId', requireAdmin, requireFeature('autopilot'), (req, res) => {
  const deleted = autoPilot.deleteRule(req.params.ruleId);
  if (!deleted) return res.status(404).json({ error: 'Rule not found' });
  res.json({ deleted: true });
});

// Pause autopilot for a church
app.post('/api/churches/:churchId/automation/pause', requireAdmin, requireFeature('autopilot'), (req, res) => {
  autoPilot.pause(req.params.churchId);
  res.json({ paused: true });
});

// Resume autopilot for a church
app.post('/api/churches/:churchId/automation/resume', requireAdmin, requireFeature('autopilot'), (req, res) => {
  autoPilot.resume(req.params.churchId);
  res.json({ paused: false });
});

// Command log
app.get('/api/churches/:churchId/command-log', requireAdmin, requireFeature('autopilot'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const log = autoPilot.getCommandLog(req.params.churchId, limit, offset);
  res.json(log);
});

// ─── CHAT API ────────────────────────────────────────────────────────────────

// Chat endpoints (extracted)
require('./src/routes/chat')(app, {
  db, chatEngine, requireAdmin, requireChurchAppAuth, handleChatCommandMessage, log,
});

// Slack integration API (extracted)
require('./src/routes/slack')(app, {
  db, churches, requireAdmin, alertEngine, stmtGet, safeErrorMessage, log,
});

// Offline between-service detection (extracted)
const offlineDetection = require('./src/crons/offlineDetection')({
  db, churches, scheduleEngine, alertEngine, eventMode, tallyBot, log, _intervals,
});
offlineDetection.start();

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// Must be registered AFTER all routes. Catches unhandled synchronous errors from
// Express route handlers and middleware, preventing stack traces from leaking to
// clients in production.

app.use((err, _req, res, _next) => {
  const status = typeof err.status === 'number' ? err.status : 500;
  const isProd = process.env.NODE_ENV === 'production';
  console.error(`[Express] Unhandled error (${status}):`, err);
  res.status(status).json({
    error: isProd && status >= 500 ? 'Internal server error' : (err.message || 'Internal server error'),
  });
});

// ─── START ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  log(`Tally Relay running on port ${PORT}`);
  log(`Admin API key: configured (${ADMIN_API_KEY.length} chars)`);
  runStatusChecks().catch((e) => {
    console.error('[StatusChecks] initial run failed:', e.message);
  });
});

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  log(`${signal} received — shutting down gracefully...`);

  // Clear all tracked intervals to prevent timer leaks / post-close errors
  for (const id of _intervals) clearInterval(id);
  _intervals.length = 0;

  // Close WebSocket server (stops accepting new connections)
  wss.close(() => {
    log('WebSocket server closed');
  });

  // Close all church WebSocket connections
  for (const church of churches.values()) {
    if (church.ws?.readyState === WebSocket.OPEN) {
      church.ws.close(1001, 'server shutting down');
    }
  }

  // Close all controller connections
  for (const ws of controllers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1001, 'server shutting down');
    }
  }

  // Close HTTP server
  server.close(() => {
    log('HTTP server closed');
    // Close database
    try { db.close(); } catch {}
    process.exit(0);
  });

  // Force exit after 10s if graceful close hangs
  setTimeout(() => {
    console.error('Forced exit after 10s timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  log(`[FATAL] Unhandled rejection: ${reason?.message || reason}`);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  log(`[FATAL] Uncaught exception: ${err.message}`);
  // Give log a moment to flush, then exit — continuing after uncaught exception is unsafe
  setTimeout(() => process.exit(1), 1000).unref();
});

// Export for testing
module.exports = { app, server, wss, churches, controllers };
