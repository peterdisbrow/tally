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
const { VersionConfig } = require('./src/versionConfig');
const { AutoRecovery } = require('./src/autoRecovery');
const { WeeklyDigest } = require('./src/weeklyDigest');
const { TallyBot, parseCommand } = require('./src/telegramBot');
const { aiParseCommand, setAiUsageLogger: setParserLogger } = require('./src/ai-parser');
const { smartParse } = require('./src/smart-parser');
const { detectSetupIntent, detectIntentWithAttachment, parsePatchList, generateMixerSetup, parseCameraPlot, buildCameraCommands, setAiUsageLogger: setSetupLogger } = require('./src/ai-setup-assistant');
const { isOnTopic, OFF_TOPIC_RESPONSE, containsSensitiveData, SENSITIVE_RESPONSE } = require('./src/chat-guard');
const { checkStreamSafety, checkWorkflowSafety, hasForceBypass } = require('./src/stream-guard');
const { ChurchMemory } = require('./src/churchMemory');
const { ChurchDocuments } = require('./src/churchDocuments');
const { PreServiceCheck } = require('./src/preServiceCheck');
const { MonthlyReport } = require('./src/monthlyReport');
const { OnCallRotation } = require('./src/onCallRotation');
const { GuestTdMode } = require('./src/guestTdMode');
const { SessionRecap } = require('./src/sessionRecap');
const { PlanningCenter } = require('./src/planningCenter');
const { StreamPlatformOAuth } = require('./src/streamPlatformOAuth');
const { PresetLibrary } = require('./src/presetLibrary');
const { EventMode } = require('./src/eventMode');
const { ResellerSystem } = require('./src/reseller');
const { AutoPilot } = require('./src/autoPilot');
const { ChatEngine } = require('./src/chatEngine');
const { ENGINEER_SYSTEM_PROMPT } = require('./src/engineer-knowledge');
const { LifecycleEmails } = require('./src/lifecycleEmails');

const { BillingSystem, BILLING_INTERVALS, TRIAL_PERIOD_DAYS } = require('./src/billing');
const { buildResellerPortalHtml } = require('./src/dashboard');
const { setupSyncMonitor } = require('./src/syncMonitor');
const { setupChurchPortal } = require('./src/churchPortal');
const { setupResellerPortal } = require('./src/resellerPortal');
const { setupStatusPage } = require('./src/statusPage');
const { setupDocsPortal } = require('./src/docsPortal');
const { setupHowToPortal } = require('./src/howToPortal');
const { hasStreamSignal, isStreamActive, isRecordingActive } = require('./src/status-utils');
const { createBackupSnapshot } = require('./src/dbBackup');
const { createRateLimit, consumeRateLimit, logRateLimitStatus } = require('./src/rateLimit');
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
const ADMIN_UI_URL = (process.env.ADMIN_UI_URL || `${APP_URL.replace(/\/$/, '')}/admin`).trim();

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
  // Tally Engineer profile (JSON object with setup context for AI)
  "ALTER TABLE churches ADD COLUMN engineer_profile TEXT DEFAULT '{}'",
  // Email verification
  "ALTER TABLE churches ADD COLUMN email_verified INTEGER DEFAULT 0",
  "ALTER TABLE churches ADD COLUMN email_verify_token TEXT",
  "ALTER TABLE churches ADD COLUMN email_verify_sent_at TEXT",
  // Church memory system (pre-compiled AI context)
  "ALTER TABLE churches ADD COLUMN memory_summary TEXT DEFAULT ''",
  // Audio routing flag — set when church routes audio directly into ATEM (no external mixer)
  "ALTER TABLE churches ADD COLUMN audio_via_atem INTEGER DEFAULT 0",
  // IANA timezone reported by the booth computer (e.g. 'America/New_York')
  "ALTER TABLE churches ADD COLUMN timezone TEXT DEFAULT ''",
  // Self-service password reset
  "ALTER TABLE churches ADD COLUMN password_reset_token TEXT",
  "ALTER TABLE churches ADD COLUMN password_reset_expires TEXT",
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
// Support constants (supportCategories, supportSeverities, supportTicketStates) moved to src/routes/supportTickets.js
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
    // Audio routing flag
    audio_via_atem:   row.audio_via_atem   || 0,
    // IANA timezone from booth computer (e.g. 'America/New_York')
    timezone:         row.timezone         || '',
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

// ─── AI Usage tracking table ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    church_id TEXT,
    feature TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    cached INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_church ON ai_usage_log(church_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage_log(created_at)');

/** Log an AI API call to the usage table. Fire-and-forget — never throws. */
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001':  { input: 1.00,  output: 5.00  },  // $/M tokens
  'claude-3-haiku-20240307':    { input: 0.25,  output: 1.25  },
  'claude-sonnet-4-20250514':   { input: 3.00,  output: 15.00 },
};
function logAiUsage({ churchId, feature, model, inputTokens, outputTokens, cached }) {
  const m = model || 'claude-haiku-4-5-20251001';
  const pricing = MODEL_PRICING[m] || MODEL_PRICING['claude-haiku-4-5-20251001'];
  const cost = ((inputTokens || 0) * pricing.input / 1_000_000) + ((outputTokens || 0) * pricing.output / 1_000_000);
  try {
    db.prepare(
      'INSERT INTO ai_usage_log (church_id, feature, model, input_tokens, output_tokens, cost_usd, cached, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(churchId || null, feature, m, inputTokens || 0, outputTokens || 0, cost, cached ? 1 : 0, new Date().toISOString());
  } catch (err) {
    console.error('[AI Usage] Failed to log:', err.message);
  }
}

// Wire logAiUsage into AI modules
setParserLogger(logAiUsage);
setSetupLogger(logAiUsage);

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
const versionConfig = new VersionConfig(db);
const autoRecovery = new AutoRecovery(churches, alertEngine, db);
const weeklyDigest = new WeeklyDigest(db);
weeklyDigest.setNotificationConfig(process.env.ALERT_BOT_TOKEN);
weeklyDigest.churchMemory = null; // set after churchMemory is created below
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

const churchMemory = new ChurchMemory(db);
weeklyDigest.churchMemory = churchMemory;
const churchDocuments = new ChurchDocuments(db);
churchDocuments.setAiUsageLogger((opts) => logAiUsage({ churchId: opts.churchId || null, ...opts }));
const sessionRecap = new SessionRecap(db);
sessionRecap.churchMemory = churchMemory;
sessionRecap.setNotificationConfig(
  process.env.ALERT_BOT_TOKEN,
  process.env.ANDREW_TELEGRAM_CHAT_ID
);
sessionRecap.recoverActiveSessions(); // Re-hydrate sessions that survived a restart

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

// ─── STREAM PLATFORM OAUTH ──────────────────────────────────────────────────

const streamOAuth = new StreamPlatformOAuth(db);
streamOAuth.start();

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
sessionRecap.setLifecycleEmails(lifecycleEmails);
alertEngine.setLifecycleEmails(lifecycleEmails);

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

const _isProduction = process.env.NODE_ENV === 'production';
const _defaultBackupMinutes = _isProduction ? 15 : 0; // 15-min default in production, off in dev
const DB_BACKUP_INTERVAL_MINUTES = Number(process.env.DB_BACKUP_INTERVAL_MINUTES || _defaultBackupMinutes);
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
} else if (_isProduction) {
  console.warn('[Backup] ⚠️  PRODUCTION: No backup schedule configured (DB_BACKUP_INTERVAL_MINUTES=0). Set this env var for automatic DB snapshots.');
} else {
  log('[Backup] Backups disabled (dev mode — set DB_BACKUP_INTERVAL_MINUTES to enable)');
}

// Wire chat engine broadcast functions (uses hoisted broadcastToControllers)
chatEngine.setBroadcasters({
  broadcastToChurch: (churchId, msg) => {
    const church = churches.get(churchId);
    if (church?.ws?.readyState === WebSocket.OPEN) {
      safeSend(church.ws, msg);
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
setupAdminPanel(app, db, churches, resellerSystem, { jwt, JWT_SECRET, lifecycleEmails });

// Pre-service check — created before portal so portal can trigger manual checks
preServiceCheck = new PreServiceCheck({
  db,
  scheduleEngine,
  churches,
  defaultBotToken: process.env.ALERT_BOT_TOKEN,
  andrewChatId: ANDREW_TELEGRAM_CHAT_ID,
  sessionRecap,
  versionConfig,
});
preServiceCheck.start();

// ─── PRE-SERVICE BRIEFING (posted when service window opens) ────────────────
// Registered after preServiceCheck so getLatestResult() is available
scheduleEngine.addWindowOpenCallback((churchId) => {
  try {
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return;
    const onCallTd = onCallRotation.getOnCallTD(churchId);
    const briefing = churchMemory.getPreServiceBriefing(churchId);
    const lastSession = db.prepare(
      'SELECT * FROM service_sessions WHERE church_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1'
    ).get(churchId);
    const preCheck = preServiceCheck ? preServiceCheck.getLatestResult(churchId) : null;

    const lines = [`📋 Pre-Service Briefing — ${church.name}`];
    if (onCallTd?.name) lines.push(`TD on call: ${onCallTd.name}`);
    if (lastSession?.grade) lines.push(`Last service: ${lastSession.grade}`);
    if (briefing.reliabilityTrend) lines.push(briefing.reliabilityTrend.summary);

    // Recurring issues + equipment quirks
    const warnings = [...briefing.recurringIssues, ...briefing.equipmentQuirks];
    if (warnings.length) {
      lines.push('');
      lines.push('Watch for:');
      for (const w of warnings) lines.push(`  ⚠ ${w.summary}`);
    }

    // User notes (TD reminders)
    if (briefing.userNotes.length) {
      lines.push('');
      lines.push('Reminders:');
      for (const n of briefing.userNotes) lines.push(`  📌 ${n.summary}`);
    }

    // Failed pre-service checks
    if (preCheck && !preCheck.pass) {
      const failed = (preCheck.checks || []).filter(c => !c.pass);
      if (failed.length) {
        lines.push('');
        lines.push('Pre-check issues:');
        for (const c of failed) lines.push(`  ❌ ${c.name}${c.detail ? ': ' + c.detail : ''}`);
      }
    }

    // Only post if there's meaningful content beyond the header
    if (lines.length > 2) {
      postSystemChatMessage(churchId, lines.join('\n'));
    }
  } catch (e) {
    console.error(`[Briefing] Error for ${churchId}:`, e.message);
  }
});

// ─── PATTERN WARNINGS (proactive alerts during live service) ────────────────
const patternWarningState = new Map(); // churchId → { timer, firedWarnings: Set }

scheduleEngine.addWindowOpenCallback((churchId) => {
  try {
    const warningTimer = setInterval(() => {
      try {
        if (!sessionRecap.activeSessions.has(churchId)) {
          clearInterval(warningTimer);
          patternWarningState.delete(churchId);
          return;
        }
        const now = new Date();
        const currentMinute = now.getHours() * 60 + now.getMinutes();
        const warnings = churchMemory.getTimedWarnings(churchId);
        const state = patternWarningState.get(churchId);
        if (!state) return;

        for (const w of warnings) {
          const warningKey = `${String(w.eventType || '').toLowerCase()}|${String(w.summary || '').toLowerCase()}|${w.windowMinuteOfDay}`;
          const minutesUntil = w.windowMinuteOfDay - currentMinute;
          if (minutesUntil >= 5 && minutesUntil <= 10 && !state.firedWarnings.has(warningKey)) {
            state.firedWarnings.add(warningKey);
            const h = Math.floor(w.windowMinuteOfDay / 60);
            const m = w.windowMinuteOfDay % 60;
            const ampm = h < 12 ? 'AM' : 'PM';
            const h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
            const timeStr = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
            postSystemChatMessage(churchId,
              `⚠️ Heads up — ${w.summary}. Watching closely around ${timeStr}.`
            );
          }
        }
      } catch (e) {
        console.error(`[PatternWarning] Tick error for ${churchId}:`, e.message);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes

    patternWarningState.set(churchId, { timer: warningTimer, firedWarnings: new Set() });
  } catch (e) {
    console.error(`[PatternWarning] Setup error for ${churchId}:`, e.message);
  }
});

scheduleEngine.addWindowCloseCallback(async (churchId) => {
  const warningState = patternWarningState.get(churchId);
  if (warningState?.timer) {
    clearInterval(warningState.timer);
    patternWarningState.delete(churchId);
  }
});

// Church Portal — self-service login for individual churches
setupChurchPortal(app, db, churches, JWT_SECRET, requireAdmin, { billing, lifecycleEmails, preServiceCheck, sessionRecap, weeklyDigest });
console.log('[Server] ✓ Church Portal routes registered');

// Reseller Portal — self-service login for integrators/resellers
setupResellerPortal(app, db, churches, resellerSystem, JWT_SECRET, requireAdmin);
console.log('[Server] ✓ Reseller Portal routes registered');

// Public status page
setupStatusPage(app);
console.log('[Server] ✓ Status page route registered');

// Public docs portal
setupDocsPortal(app);
console.log('[Server] ✓ Docs portal route registered');

// Public how-to guides portal
setupHowToPortal(app);

logRateLimitStatus();

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
      safeSend(ws, item.msg);
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

// Support helpers (normalizeSupportCategory, normalizeSupportSeverity, etc.)
// moved to src/routes/supportTickets.js — wired below.

/* Support helper functions (buildSupportDiagnostics, computeTriageResult,
   requireSupportAccess, resolveSupportChurchId) removed — now in
   src/routes/supportTickets.js, wired via setupSupportTicketRoutes() below. */

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

          // 404 = path not exposed on this target — degraded, not outage.
          // 401/403 = auth issue — also degraded (server is reachable).
          // 5xx or other = actual outage.
          const is404 = resp.status === 404;
          const isAuthIssue = resp.status === 401 || resp.status === 403;
          lastFailure = {
            state: (is404 || isAuthIssue) ? 'degraded' : 'outage',
            latencyMs: resp.latencyMs,
            detail: `HTTP ${resp.status} via ${target}`,
          };

          if (is404) continue; // try next candidate
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

// Church onboard route → src/routes/churchAuth.js
// Lead capture route → src/routes/churchAuth.js

// Email verification (extracted)
require('./src/routes/emailVerification')(app, { db, APP_URL, sendOnboardingEmail, lifecycleEmails, rateLimit, log });

// Church app login route → src/routes/churchAuth.js

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

// GET/POST /api/church/app/me + /api/pf/report routes → src/routes/churchAuth.js

// PUT /api/church/app/me + reset-password routes → src/routes/churchAuth.js

// ─── SUPPORT TRIAGE + TICKETS (extracted to module) ──────────────────────────
require('./src/routes/supportTickets')(app, {
  db, churches, requireAdminJwt, stmtGet, scheduleEngine,
  JWT_SECRET, RELAY_VERSION, SUPPORT_TRIAGE_WINDOW_HOURS, rateLimit,
});
console.log('[Server] ✓ Support ticket routes registered');

// Status components & incidents (extracted)
require('./src/routes/statusComponents')(app, {
  db, requireAdmin, runStatusChecks,
  lastStatusCheckAt: () => lastStatusCheckAt,
});

// ─── EXTRACTED ROUTE MODULES ───────────────────────────────────────────────
const routeCtx = {
  db, churches, requireAdmin, requireAdminJwt, requireChurchAppAuth,
  requireChurchOrAdmin, requireReseller, requireFeature, rateLimit,
  billing, hashPassword, verifyPassword, normalizeBillingInterval,
  issueChurchAppToken, checkChurchPaidAccess, generateRegistrationCode,
  checkCommandRateLimit, checkBillingAccessForCommand,
  sendOnboardingEmail, lifecycleEmails, broadcastToSSE,
  safeErrorMessage, safeSend, queueMessage, messageQueues,
  stmtGet, stmtInsert, stmtDelete, stmtFindByName, stmtUpdateRegistrationCode,
  resellerSystem, planningCenter, streamOAuth, eventMode,
  scheduleEngine, alertEngine, weeklyDigest, sessionRecap,
  monthlyReport, autoPilot, presetLibrary, onCallRotation,
  guestTdMode, chatEngine, buildResellerPortalHtml,
  logAiUsage, isOnTopic, OFF_TOPIC_RESPONSE, runManualDbSnapshot,
  jwt, JWT_SECRET, ADMIN_ROLES, ADMIN_API_KEY, uuidv4,
  CHURCH_APP_TOKEN_TTL, REQUIRE_ACTIVE_BILLING, TRIAL_PERIOD_DAYS,
  BILLING_TIERS, BILLING_STATUSES, QUEUE_TTL_MS, totalMessagesRelayed,
  log,
};
require('./src/routes/churchAuth')(app, routeCtx);
require('./src/routes/adminAuth')(app, routeCtx);
require('./src/routes/billing')(app, routeCtx);
require('./src/routes/adminChurches')(app, routeCtx);
require('./src/routes/sessions')(app, routeCtx);
require('./src/routes/planningCenter')(app, routeCtx);
require('./src/routes/streamPlatforms')(app, routeCtx);
require('./src/routes/reseller')(app, routeCtx);
require('./src/routes/automation')(app, routeCtx);
require('./src/routes/churchOps')(app, routeCtx);
console.log('[Server] ✓ Route modules registered');

app.post('/api/internal/backups/snapshot', requireAdmin, (req, res) => {
  try {
    const label = String(req.body?.label || 'manual').trim().slice(0, 40) || 'manual';
    const snapshot = runManualDbSnapshot(label);
    res.status(201).json({ ok: true, snapshot });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin auth, users, AI usage routes → src/routes/adminAuth.js

// GET /api/events route → src/routes/churchOps.js

// Billing routes → src/routes/billing.js

// Churches list, billing update, delete routes → src/routes/adminChurches.js

// Map command prefixes to device types for tier-based gating
// Connect tier: atem, obs, vmix only. Plus+: everything.
const COMMAND_DEVICE_MAP = {
  atem: 'atem', hyperdeck: 'atem', ptz: 'atem', camera: 'atem',
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

// ─── ENGINEER AI (question answering) ─────────────────────────────────────

const QUESTION_STARTERS = /^(how|what|why|where|when|which|who|explain|tell me|can (you|i|we|tally)|could (you|i|we)|would (you|it)|does|do|is there|is it|is the|is my|help me|i need help|i'm having|im having|any idea|do you know|what's|whats|where's|where is|walk me through|show me how|describe|should (i|we)|i don't understand|i dont understand|i'm confused|im confused|troubleshoot|diagnose)/i;
const COMMAND_STARTERS = /^(cut|switch|take|go|start|stop|mute|unmute|fade|set|recall|save|run|press|play|record|route|clear|toggle|upload|snap|check|scan|test|turn|apply|load)\b/i;

function isEngineerQuestion(message) {
  if (!message || typeof message !== 'string') return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  // Short messages (1-2 words) are likely commands, not questions
  if (trimmed.split(/\s+/).length <= 2 && !trimmed.includes('?')) return false;
  // Messages starting with command verbs are commands, not questions
  if (COMMAND_STARTERS.test(trimmed)) return false;
  // Messages starting with question words or containing ? are questions
  if (QUESTION_STARTERS.test(trimmed)) return true;
  if (trimmed.includes('?')) return true;
  return false;
}

async function callEngineerAI(churchId, question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 'AI is not configured (ANTHROPIC_API_KEY missing).';

  const church = churches.get(churchId);
  const churchRow = stmtGet.get(churchId);
  let engineerProfile = {};
  try { engineerProfile = JSON.parse(churchRow?.engineer_profile || '{}'); } catch {}

  const statusContext = church?.status ? JSON.stringify(church.status) : '{}';
  const profileContext = Object.keys(engineerProfile).length > 0
    ? '\n\nEngineer profile: ' + JSON.stringify(engineerProfile)
    : '';

  const conversationHistory = chatEngine.getRecentConversation(churchId);

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        system: ENGINEER_SYSTEM_PROMPT
          + '\n\nCurrent church status: ' + statusContext
          + profileContext,
        messages: [
          ...(Array.isArray(conversationHistory) ? conversationHistory : []),
          { role: 'user', content: question },
        ],
        temperature: 0.4,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error(`[EngineerAI] Anthropic error: ${aiRes.status} ${errBody.slice(0, 200)}`);
      return 'Sorry, I couldn\'t process that question right now. Try again in a moment.';
    }

    const data = await aiRes.json();
    const reply = data?.content?.[0]?.text || 'No response.';

    if (data?.usage) {
      logAiUsage({
        churchId,
        feature: 'engineer_chat',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
      });
    }

    return reply;
  } catch (err) {
    console.error(`[EngineerAI] Error: ${err.message}`);
    return 'Sorry, I couldn\'t process that question right now. Try again in a moment.';
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

function parseChatCommandIntent(rawMessage, status) {
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

  // "confirm: ..." prefix — force-confirmed re-send (stream guard bypass)
  if (lower.startsWith('confirm:') || lower.startsWith('confirm ')) {
    const commandText = text.replace(/^confirm[:\s]+/i, '').trim();
    if (!commandText) return null;
    const parsed = parseCommand(commandText);
    if (parsed) return { type: 'command', parsed, forceConfirmed: true };
    const smartResult = smartParse(commandText, status || {});
    if (smartResult) {
      if (smartResult.type === 'command') return { type: 'command', parsed: { command: smartResult.command, params: smartResult.params }, forceConfirmed: true };
      if (smartResult.type === 'commands') return { type: 'commands', steps: smartResult.steps, forceConfirmed: true };
    }
    return { type: 'ai', prompt: commandText, forceConfirmed: true };
  }

  if (lower.startsWith('/ai')) {
    const prompt = text.slice(3).trim();
    if (!prompt) return { type: 'invalid', reason: 'Usage: /ai move to the pastor shot and start stream' };
    return { type: 'ai', prompt };
  }

  // All other messages: try pattern parsing first, then smart parser, then AI.
  const parsed = parseCommand(text);
  if (parsed) return { type: 'command', parsed };

  // Smart parser: device-aware routing without AI
  const smartResult = smartParse(text, status || {});
  if (smartResult) {
    if (smartResult.type === 'chat') return { type: 'chat_reply', text: smartResult.text };
    if (smartResult.type === 'command') return { type: 'command', parsed: { command: smartResult.command, params: smartResult.params } };
    if (smartResult.type === 'commands') return { type: 'commands', steps: smartResult.steps };
  }

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
        mimeType || 'image/jpeg',
        { churchId }
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
        mimeType || 'image/jpeg',
        { churchId }
      );
      if (!patchList.channels || patchList.channels.length === 0) {
        postSystemChatMessage(churchId, '⚠️ Could not identify any channels from the input.');
        return;
      }
      postSystemChatMessage(churchId, `🎛️ Found ${patchList.channels.length} channels. Generating channel strip settings...`);

      const mixerType = church?.status?.mixer?.type || 'behringer';
      const setup = await generateMixerSetup(patchList, mixerType, { churchId });
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

    // ─── Document upload → knowledge base ──────────────────────────────────
    if (intentType === 'document') {
      if (!attachment?.data) {
        postSystemChatMessage(churchId, '⚠️ Please attach a file (PDF, TXT, or CSV) to upload to the knowledge base.');
        return;
      }
      postSystemChatMessage(churchId, `📄 Processing "${attachment.fileName}"...`);
      try {
        const result = await churchDocuments.uploadDocument(
          churchId, attachment.data, attachment.fileName || 'document', mimeType
        );
        postSystemChatMessage(churchId, `✅ Saved "${attachment.fileName}" (${result.chunkCount} sections). Summary: ${result.summary}\n\nI'll reference this document when answering questions. Say "list documents" to see all uploads.`);
      } catch (docErr) {
        postSystemChatMessage(churchId, `❌ Could not process document: ${docErr.message}`);
      }
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

  const lowerMsg = (rawMessage || '').toLowerCase().trim();

  // ─── Sensitive data guard (stream keys, passwords, etc.) ─────────────────
  if (containsSensitiveData(rawMessage)) {
    postSystemChatMessage(churchId, SENSITIVE_RESPONSE);
    return;
  }

  // ─── "Remember this" handler ─────────────────────────────────────────────
  if (/^(remember|note|save note|don't forget|tally remember)\b/i.test(lowerMsg)) {
    const noteText = rawMessage.replace(/^(remember|note|save note|don't forget|tally remember)\s*/i, '').trim();
    if (noteText.length < 5) {
      postSystemChatMessage(churchId, 'What should I remember? Example: "Remember the pastor likes a tight shot during prayer"');
      return;
    }
    churchMemory.saveUserNote(churchId, noteText);
    postSystemChatMessage(churchId, "Got it — I'll remember that.");
    return;
  }

  // ─── "What do you remember?" handler ─────────────────────────────────────
  if (/^(what do you remember|what do you know|show notes|list notes|my notes)/i.test(lowerMsg)) {
    const notes = churchMemory.getUserNotes(churchId);
    if (!notes.length) {
      postSystemChatMessage(churchId, 'I don\'t have any saved notes yet. Say "remember [something]" to teach me.');
      return;
    }
    const lines = notes.map((n, i) => `${i + 1}. ${n.summary}`);
    postSystemChatMessage(churchId, `Here's what I remember:\n${lines.join('\n')}`);
    return;
  }

  // ─── "Forget N" handler ──────────────────────────────────────────────────
  if (/^(forget|delete note|remove note)\s+(\d+)/i.test(lowerMsg)) {
    const match = lowerMsg.match(/(\d+)/);
    const idx = parseInt(match[1]) - 1;
    const notes = churchMemory.getUserNotes(churchId);
    if (idx >= 0 && idx < notes.length) {
      db.prepare('UPDATE church_memory SET active = 0 WHERE id = ?').run(notes[idx].id);
      churchMemory._rebuildSummary(churchId);
      postSystemChatMessage(churchId, `Forgot: "${notes[idx].summary}"`);
    } else {
      postSystemChatMessage(churchId, 'Note number not found. Say "what do you remember" to see the list.');
    }
    return;
  }

  // ─── "What happened last week?" handler ──────────────────────────────────
  if (/^(what happened|last (week|service|sunday)|previous (session|service)|recap|how did (last|this) week go|session history)/i.test(lowerMsg)) {
    const sessions = db.prepare(
      `SELECT * FROM service_sessions WHERE church_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 4`
    ).all(churchId);

    if (!sessions.length) {
      postSystemChatMessage(churchId, 'No recent service sessions on record yet.');
      return;
    }

    const churchRow = db.prepare('SELECT name FROM churches WHERE churchId = ?').get(churchId);
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const lines = [`Recent sessions for ${churchRow?.name || 'your church'}:`];

    for (const s of sessions) {
      const d = new Date(s.started_at);
      const dayStr = `${DAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
      const dur = s.duration_minutes ? `${s.duration_minutes}m` : '?';
      const stream = s.stream_runtime_minutes > 0 ? `streamed ${s.stream_runtime_minutes}m` : 'no stream';
      const alerts = s.alert_count || 0;
      const auto = s.auto_recovered_count || 0;
      const viewers = s.peak_viewers != null ? `, ${s.peak_viewers} peak viewers` : '';
      lines.push(`${dayStr} — ${s.grade || 'N/A'} (${dur}, ${stream}, ${alerts} alert${alerts !== 1 ? 's' : ''}${auto ? `, ${auto} auto-fixed` : ''}${viewers})`);

      // Show event timeline for the most recent session only
      if (s === sessions[0]) {
        try {
          const events = db.prepare(
            'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT 5'
          ).all(s.id);
          for (const e of events) {
            const t = new Date(e.timestamp);
            const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            const type = (e.event_type || '').replace(/_/g, ' ');
            const status = e.auto_resolved ? 'auto-fixed' : e.resolved ? 'resolved' : 'unresolved';
            lines.push(`  ${time} ${type} (${status})`);
          }
        } catch { /* service_events table might not exist yet */ }
      }
    }

    postSystemChatMessage(churchId, lines.join('\n'));
    return;
  }

  // ─── "List documents" handler ────────────────────────────────────────────
  if (/^(list doc|my doc|what doc|show doc)/i.test(lowerMsg)) {
    if (typeof churchDocuments !== 'undefined' && churchDocuments) {
      const docs = churchDocuments.listDocuments(churchId);
      if (!docs.length) {
        postSystemChatMessage(churchId, 'No documents uploaded yet. Attach a PDF, TXT, or CSV in chat to upload.');
        return;
      }
      const lines = docs.map((d, i) => `${i + 1}. ${d.filename} — ${d.summary.slice(0, 60)}...`);
      postSystemChatMessage(churchId, `Your documents:\n${lines.join('\n')}`);
    } else {
      postSystemChatMessage(churchId, 'Document storage is not enabled.');
    }
    return;
  }

  // ─── Engineer AI: answer questions before trying command parsing ──────────
  if (isEngineerQuestion(rawMessage)) {
    const reply = await callEngineerAI(churchId, rawMessage);
    postSystemChatMessage(churchId, reply);
    return;
  }

  const church = churches.get(churchId);
  const intent = parseChatCommandIntent(rawMessage, church?.status);
  if (!intent) return;

  if (intent.type === 'invalid') {
    postSystemChatMessage(churchId, `⚠️ ${intent.reason}`);
    return;
  }

  if (intent.type === 'chat_reply') {
    postSystemChatMessage(churchId, intent.text);
    return;
  }

  // ─── Stream guard: skip if force-confirmed or has force bypass ──────────
  const streamGuardBypassed = intent.forceConfirmed || hasForceBypass(rawMessage);

  if (intent.type === 'commands' && Array.isArray(intent.steps) && intent.steps.length > 0) {
    if (!streamGuardBypassed) {
      const wfSafety = checkWorkflowSafety(intent.steps, church?.status || {});
      if (wfSafety) {
        postSystemChatMessage(churchId, `${wfSafety.warning}\n\nTo confirm, resend: confirm: ${rawMessage}`);
        return;
      }
    }
    for (const step of intent.steps) {
      if (!step?.command) continue;
      if (step.command === 'system.wait') {
        const seconds = Math.min(Math.max(Number(step.params?.seconds) || 1, 0.5), 30);
        postSystemChatMessage(churchId, `⏳ Waiting ${seconds}s...`);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        continue;
      }
      const executed = await executeChurchCommandWithResult(churchId, step.command, step.params || {});
      if (!executed.ok) {
        postSystemChatMessage(churchId, `❌ ${friendlyError(step.command, executed.error)}`);
        return;
      }
      postSystemChatMessage(churchId, `✅ ${step.command} ${formatResultForChat(executed.result)}`);
    }
    return;
  }

  if (intent.type === 'command') {
    const { command, params } = intent.parsed;
    if (!streamGuardBypassed) {
      const safety = checkStreamSafety(command, params, church?.status || {});
      if (safety) {
        postSystemChatMessage(churchId, `${safety.warning}\n\nTo confirm, resend: confirm: ${rawMessage}`);
        return;
      }
    }
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

  const conversationHistory = chatEngine.getRecentConversation(churchId);
  const churchRow = stmtGet.get(churchId);
  let engineerProfile = {};
  try { engineerProfile = JSON.parse(churchRow?.engineer_profile || '{}'); } catch {}
  // Inject document context if knowledge base is active
  const docContext = (typeof churchDocuments !== 'undefined' && churchDocuments)
    ? churchDocuments.getDocumentContext(churchId, intent.prompt)
    : '';
  const aiResult = await aiParseCommand(intent.prompt, {
    churchId,
    churchName: church?.name || '',
    status: church?.status || {},
    tier: churchRow?.billing_tier || 'connect',
    engineerProfile,
    memorySummary: churchRow?.memory_summary || '',
    documentContext: docContext,
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

  // Stream guard for AI-parsed commands
  if (!streamGuardBypassed) {
    const wfSafety = checkWorkflowSafety(steps, church?.status || {});
    if (wfSafety) {
      postSystemChatMessage(churchId, `${wfSafety.warning}\n\nTo confirm, resend: confirm: ${rawMessage}`);
      return;
    }
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
    churchMemory.recordCommandOutcome(churchId, step.command, executed.ok, 'user_request');
    if (!executed.ok) {
      postSystemChatMessage(churchId, `❌ ${friendlyError(step.command, executed.error)}`);
      return;
    }
    postSystemChatMessage(churchId, `✅ ${step.command} ${formatResultForChat(executed.result)}`);
  }
}

/** Make device errors volunteer-friendly. */
function friendlyError(command, error) {
  const msg = String(error || 'Command failed');
  const device = command?.split('.')[0] || '';
  // Device not connected
  if (/not connected/i.test(msg)) {
    const deviceNames = { atem: 'video switcher (ATEM)', obs: 'OBS', mixer: 'audio console', encoder: 'encoder', vmix: 'vMix', companion: 'Companion', propresenter: 'ProPresenter', ptz: 'PTZ camera', hyperdeck: 'HyperDeck' };
    const friendly = deviceNames[device] || device;
    return `The ${friendly} isn't responding. Check that it's powered on and connected to the network — or ask your tech director for help.`;
  }
  if (/not configured/i.test(msg)) {
    return `${device || 'That device'} isn't set up yet. Ask your tech director to configure it in the Tally settings.`;
  }
  if (/timed out/i.test(msg)) {
    return `The command took too long to respond. The device might be busy — try again in a few seconds.`;
  }
  if (/doesn't exist|not found/i.test(msg) && /camera|input/i.test(msg)) {
    return msg; // Already friendly from validateAtemInput
  }
  return `${command} failed: ${msg}`;
}

// Command dispatch, broadcast, church status, schedule, td-contact routes → src/routes/churchOps.js

// Alerts, digest, AI chat routes → src/routes/churchOps.js

// Monthly report, session recap, timeline, debrief routes → src/routes/sessions.js

// Planning center, stream platforms, event create routes → src/routes/planningCenter.js, streamPlatforms.js, churchOps.js

// Reseller routes (admin CRUD + reseller API + portal/stats) → src/routes/reseller.js

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

app.get(['/dashboard', '/dashboard/*'], (req, res) => {
  // Consolidated: canonical admin UI lives on Vercel.
  res.redirect(302, ADMIN_UI_URL);
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
    audio_via_atem:   c.audio_via_atem   || 0,
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
    audio_via_atem:   c.audio_via_atem || 0,
  }));
  broadcastToSSE({ type: 'snapshot', churches: states });
}, 60_000));

// Maintenance, on-call, guest token routes → src/routes/churchOps.js

// Telegram bot API (extracted)
require('./src/routes/telegram')(app, {
  db, churches, tallyBot, requireAdmin, safeErrorMessage, log,
  TALLY_BOT_WEBHOOK_URL, TALLY_BOT_WEBHOOK_SECRET,
});

// Church detail route → src/routes/adminChurches.js

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
        safeSend(ws, { type: 'branding', ...branding });
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
    audio_via_atem:   church.audio_via_atem   || 0,
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
    church._versionCheckedDevices = null; // allow re-check on next connect
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

  safeSend(ws, { type: 'connected', churchId: church.churchId, name: church.name });
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
  safeSend(ws, { type: 'church_list', churches: churchList });

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

// ── Device version check helper (fires once per device per WS session) ───────
function _checkDeviceVersions(church, status) {
  if (!status) return;
  if (!church._versionCheckedDevices) church._versionCheckedDevices = new Set();

  const encType = status.encoder?.type || 'unknown';
  const mixerType = status.mixer?.type || 'unknown';
  const checks = [
    { key: 'obs',          version: status.obs?.version,            type: 'obs',                    label: 'OBS Studio' },
    { key: 'proPresenter', version: status.proPresenter?.version,   type: 'proPresenter',           label: 'ProPresenter' },
    { key: 'vmix',         version: status.vmix?.version,           type: 'vmix',                   label: 'vMix' },
    { key: 'atem',         version: status.atem?.protocolVersion,   type: 'atem_protocol',          label: 'ATEM Firmware' },
    { key: 'encoder',      version: status.encoder?.firmwareVersion,type: `encoder_${encType}`,     label: `${encType} Encoder` },
    { key: 'mixer',        version: status.mixer?.firmware,         type: `mixer_${mixerType}`,     label: `${mixerType} Mixer` },
  ];

  for (const c of checks) {
    if (!c.version) continue;
    const dedupKey = `${c.key}:${c.version}`;
    if (church._versionCheckedDevices.has(dedupKey)) continue;
    church._versionCheckedDevices.add(dedupKey);

    const result = versionConfig.checkVersion(c.type, c.version);
    if (result.checked && result.outdated) {
      alertEngine.sendAlert(
        church, 'firmware_outdated',
        { device: c.label, currentVersion: result.current, minimumVersion: result.minimum },
        sessionRecap?.getActiveSessionId?.(church.churchId) || null,
      ).catch(() => {});
    }
  }
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

      // ── Auto-sync audio_via_atem from client-side detection ──────────
      if (msg.status?.audioViaAtemSource === 'auto' && !church._audioViaAtemManualOverride) {
        const newVal = msg.status.audioViaAtem ? 1 : 0;
        if (church.audio_via_atem !== newVal) {
          church.audio_via_atem = newVal;
          try { db.prepare('UPDATE churches SET audio_via_atem = ? WHERE churchId = ?').run(newVal, church.churchId); }
          catch (e) { log(`[audio_via_atem] auto-sync DB error: ${e.message}`); }
        }
      }

      // ── Sync booth computer timezone (for offline detection nighttime check) ──
      if (msg.status?.system?.timezone && church.timezone !== msg.status.system.timezone) {
        church.timezone = msg.status.system.timezone;
        try { db.prepare('UPDATE churches SET timezone = ? WHERE churchId = ?').run(church.timezone, church.churchId); }
        catch (e) { log(`[timezone] sync DB error: ${e.message}`); }
      }

      // ── Check device firmware / software versions (once per device per WS session) ──
      _checkDeviceVersions(church, msg.status);

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
              if (recovery.command) churchMemory.recordCommandOutcome(church.churchId, recovery.command, true, msg.alertType);
              log(`[AutoRecovery] ✅ ${recovery.event} for ${church.name}`);
            } else {
              if (recovery.attempted && recovery.command) churchMemory.recordCommandOutcome(church.churchId, recovery.command, false, msg.alertType);
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
      safeSend(church.ws, { type: 'pong', ts: msg.ts });
      break;

    default:
      broadcastToControllers({ ...msg, churchId: church.churchId, churchName: church.name });
  }
}

async function handleControllerMessage(ws, msg) {
  if (msg.type === 'command' && msg.churchId) {
    const rateLimit = await checkCommandRateLimit(msg.churchId);
    if (!rateLimit.ok) {
      safeSend(ws, { type: 'error', error: 'Rate limit exceeded', churchId: msg.churchId });
      return;
    }
    const church = churches.get(msg.churchId);
    if (church?.ws?.readyState === WebSocket.OPEN) {
      safeSend(church.ws, msg);
      totalMessagesRelayed++;
    } else {
      safeSend(ws, { type: 'error', error: 'Church not connected', churchId: msg.churchId });
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

/** Safely send JSON to a WebSocket — catches errors from mid-close sockets */
function safeSend(ws, payload) {
  try {
    if (ws?.readyState === WebSocket.OPEN) ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  } catch (e) {
    log(`[WS] safeSend error: ${e.message}`);
  }
}

function broadcastToControllers(msg) {
  const data = JSON.stringify(msg);
  for (const ws of controllers) {
    safeSend(ws, data);
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
      console.warn(`[DEPRECATED] Legacy API key auth used for ${req.method} ${req.path} — migrate to JWT`);
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

// ─── PRESET LIBRARY & COMMAND HELPERS ─────────────────────────────────────────

// Helper: create a sendCommand function for a church WebSocket
// (kept in server.js — used by autoPilot executor and executeChurchCommandWithResult)
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
    safeSend(church.ws, { type: 'command', command, params, id });
  });
}

// Preset + autopilot routes → src/routes/automation.js

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

// ─── LANDING PAGE CHAT PROXY (Anthropic → SSE) ───────────────────────────────

app.post('/api/chat/stream', async (req, res) => {
  // Shared secret prevents public abuse — only the Next.js app should call this
  const secret = req.headers['x-chat-secret'];
  const expected = process.env.CHAT_PROXY_SECRET || '';
  if (!secret || secret !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AI not configured' });
  }

  const { system, messages, max_tokens = 300, temperature = 0.7 } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // Non-streaming call (proven reliable in this codebase), then emit as SSE
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        system: system || '',
        messages,
        max_tokens: Math.min(max_tokens, 250),
        temperature,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error('[ChatProxy] Anthropic error:', aiRes.status, errBody.slice(0, 300));
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'AI service error.' })}\n\n`);
      return res.end();
    }

    const data = await aiRes.json();
    const text = data?.content?.[0]?.text || '';

    // Track usage in the AI usage log
    if (data?.usage) {
      logAiUsage({
        churchId: null,
        feature: 'landing_chat',
        model: 'claude-3-haiku-20240307',
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
      });
    }

    if (!text) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'No response from AI.' })}\n\n`);
      return res.end();
    }

    // Emit the response as chunked SSE deltas with staggered timing for a
    // natural typing feel.  Chunks are small (2–5 chars) with a randomised
    // delay so it doesn't feel robotic or perfectly uniform.
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    let pos = 0;
    while (pos < text.length) {
      const chunkLen = 2 + Math.floor(Math.random() * 4);          // 2-5 chars
      const piece = text.slice(pos, pos + chunkLen);
      res.write(`data: ${JSON.stringify({ type: 'delta', text: piece })}\n\n`);
      pos += chunkLen;
      await delay(20 + Math.floor(Math.random() * 30));            // 20-50 ms
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[ChatProxy] Error:', err.message);
    try { res.write(`data: ${JSON.stringify({ type: 'error', message: 'Something went wrong.' })}\n\n`); } catch {}
    try { res.end(); } catch {}
  }
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
