/**
 * Tally Relay Server
 * Bridges OpenClaw/Telegram (controller) ↔ Church Client App (on-site)
 *
 * Deploy to Railway: https://railway.app
 *
 * ENV VARS:
 *   PORT            (default 3000)
 *   ADMIN_API_KEY   Secret key for the internal admin skill
 *   JWT_SECRET      Secret for signing church tokens
 *   DATABASE_DRIVER sqlite (default) or postgres
 *   DATABASE_PATH   Path to SQLite DB (default ./data/churches.db)
 *   DATABASE_URL    Postgres / Neon connection string (requires DATABASE_DRIVER=postgres)
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

const cookieParser = require('cookie-parser');
const Sentry = require('@sentry/node');
const { createAppDatabase } = require('./src/db');
const { ensureCanonicalTenantColumns, ensureTenantGuardrails } = require('./src/db/tenantGuardrails');

// ─── ERROR TRACKING ─────────────────────────────────────────────────────────
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Scrub sensitive headers
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });
}

const app = express();
app.set('trust proxy', 1); // Railway runs behind a single reverse proxy

// ─── SECURITY HEADERS ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // tools pages use inline scripts
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'https://worldtimeapi.org'],
      mediaSrc: ["'self'", "blob:", "https://*.facebook.com", "https://*.fbcdn.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      frameSrc: ["https://www.facebook.com", "https://web.facebook.com"],
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
app.use('/portal', express.static(require('path').join(__dirname, 'public/portal')));
app.use('/admin', express.static(require('path').join(__dirname, 'public/admin')));
app.use('/tools', express.static(require('path').join(__dirname, 'public/tools')));

// Public rundown view — no auth required
app.get('/rundown/view/:token', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'public/rundown-view.html'));
});

// Serve the standalone rundown timer page at /rundown/timer/:token
app.get('/rundown/timer/:token', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public/rundown-timer.html'));
});

// Serve the standalone show mode page at /rundown/show/:token
app.get('/rundown/show/:token', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'public/rundown-show.html'));
});

const { csrfMiddleware } = require('./src/csrf');
app.use(csrfMiddleware);

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  maxPayload: 256 * 1024, // 256 KB max message
  handleProtocols: (protocols, req) => {
    // For mobile clients that send auth via Sec-WebSocket-Protocol, echo it back.
    // The WebSocket spec requires the server to acknowledge the chosen subprotocol.
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.replace(/^\//, '') === 'mobile') {
      return _mobileWsHandler.getMobileSubprotocol(protocols);
    }
    return false;
  },
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
    threshold: 128,
    concurrencyLimit: 10,
    serverNoContextTakeover: true,
  },
}); // WebSocket compression via permessage-deflate

// ─── GLOBAL HEARTBEAT ─────────────────────────────────────────────────────────
// Ping every connected client every 30s. Any client that fails to pong within
// 10s is considered a zombie and terminated. This prevents stale connections
// from silently blocking alerts and status updates.
const HEARTBEAT_PING_INTERVAL_MS = 30_000;
const HEARTBEAT_PONG_TIMEOUT_MS  = 10_000;

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    // Clear any previous timeout before setting a new one — guards against the
    // edge case where a pong arrives just before the next ping cycle and the old
    // timeout ID is overwritten, leaving a stale timer that would falsely terminate
    // an otherwise healthy connection.
    if (ws._pongTimeout) { clearTimeout(ws._pongTimeout); ws._pongTimeout = null; }
    // Set a 10-second timeout; cleared when pong arrives
    ws._pongTimeout = setTimeout(() => {
      const label = ws._churchName ? `church "${ws._churchName}"` : 'controller';
      log(`[heartbeat] Zombie connection terminated — ${label} did not pong in ${HEARTBEAT_PONG_TIMEOUT_MS / 1000}s`, {
        event: 'zombie_disconnect',
        churchName: ws._churchName || null,
      });
      ws.terminate();
    }, HEARTBEAT_PONG_TIMEOUT_MS);
    ws.ping();
  }
}, HEARTBEAT_PING_INTERVAL_MS);

const { ScheduleEngine } = require('./src/scheduleEngine');
const { AlertEngine } = require('./src/alertEngine');
const { VersionConfig } = require('./src/versionConfig');
const { AutoRecovery } = require('./src/autoRecovery');
const { AITriageEngine } = require('./src/aiTriage');
const { SignalFailover } = require('./src/signalFailover');
const { IncidentSummarizer } = require('./src/incidentSummarizer');
const { AiRateLimiter } = require('./src/aiRateLimiter');
const { WeeklyDigest } = require('./src/weeklyDigest');
const { TallyBot, parseCommand } = require('./src/telegramBot');
const { aiParseCommand, setAiUsageLogger: setParserLogger, setIncidentBypassCheck, getConfiguredDeviceTypes, buildCommandConfirmation } = require('./src/ai-parser');
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
const { ensureTable: ensureOnboardingTable } = require('./src/onboardingChat');
const { ENGINEER_SYSTEM_PROMPT } = require('./src/engineer-knowledge'); // kept for backward compat — will deprecate
const { classifyIntent } = require('./src/intent-classifier');
const { buildDiagnosticContext } = require('./src/diagnostic-context'); // kept for backward compat — tally-context.js wraps this
const { buildDiagnosticPrompt, buildAdminPrompt } = require('./src/tally-engineer');
const { buildContext } = require('./src/tally-context');
const { LifecycleEmails } = require('./src/lifecycleEmails');
const PostServiceReport = require('./src/postServiceReport');

const { BillingSystem, BILLING_INTERVALS, TRIAL_PERIOD_DAYS, TIER_LIMITS } = require('./src/billing');
const { setupSyncMonitor } = require('./src/syncMonitor');
const { setupBroadcastMonitor } = require('./src/broadcastMonitor');
const { setupChurchPortal } = require('./src/churchPortal');
const { RundownEngine } = require('./src/rundownEngine');
const { LiveRundownManager } = require('./src/liveRundown');
const { ManualRundownStore } = require('./src/manualRundown');
const { buildManualPlanTimerState, buildPublicRundownPayload } = require('./src/rundownPublic');
const { RundownScheduler } = require('./src/scheduler');
const { PushNotificationService } = require('./src/pushNotifications');
const { createMobileWebSocketHandler } = require('./src/mobileWebSocket');
const { PreServiceRundown } = require('./src/preServiceRundown');
const { ViewerBaseline } = require('./src/viewerBaseline');
const { setupResellerPortal } = require('./src/resellerPortal');
const { setupStatusPage } = require('./src/statusPage');
const { setupDocsPortal } = require('./src/docsPortal');
const { setupHowToPortal } = require('./src/howToPortal');
const { hasStreamSignal, isStreamActive, isRecordingActive } = require('./src/status-utils');
const { escapeHtml } = require('./src/escapeHtml');
const { createBackupSnapshot } = require('./src/dbBackup');
const { createRateLimit, consumeRateLimit, logRateLimitStatus, closeRedisRateLimitClient } = require('./src/rateLimit');
const { createWebSocketHandlers } = require('./src/websocketRouter');
const { createDeltaTracker } = require('./src/deltaUpdates');
const { createStatusBatcher } = require('./src/statusBatcher');
const { createRuntimeCoordinator } = require('./src/runtimeCoordination');
const { createRuntimeMetrics } = require('./src/runtimeMetrics');
const { createRuntimeMirror } = require('./src/runtimeMirror');
const { createSharedRuntimeState } = require('./src/sharedRuntimeState');
const createAuthMiddleware = require('./src/routes/authMiddleware');
const relayPackage = require('./package.json');
const { initRtmpIngest, shutdownRtmpIngest, getActiveStreams, getStreamMeta, getStreamInfo, isStreamActive: isIngestActive, disconnectStream, getHlsDir, generateStreamKey } = require('./src/rtmpIngest');

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key-change-me';
const JWT_SECRET    = process.env.JWT_SECRET;
const ADMIN_SESSION_COOKIE = 'tally_admin_key';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const CHURCH_APP_TOKEN_TTL = process.env.TALLY_CHURCH_APP_TOKEN_TTL || '30d';
const REQUIRE_ACTIVE_BILLING = (process.env.TALLY_REQUIRE_ACTIVE_BILLING || (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';
const RELAY_VERSION = process.env.RELAY_VERSION || relayPackage.version;
const RELAY_BUILD = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null;
const SUPPORT_TRIAGE_WINDOW_HOURS = Number(process.env.SUPPORT_TRIAGE_WINDOW_HOURS || 24);
const PORT = Number(process.env.PORT || 3000);
const ADMIN_ROLES = ['super_admin', 'admin', 'engineer', 'sales'];

// Onboarding email configuration
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Tally <noreply@tallyconnect.app>';
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://tallyconnect.app';
const ADMIN_UI_URL = (process.env.ADMIN_UI_URL || `${APP_URL.replace(/\/$/, '')}/admin`).trim();

// ─── STARTUP SECRET VALIDATION ───────────────────────────────────────────────
// Fail loudly in any non-development, non-test environment if secrets are
// missing or still set to insecure defaults. This prevents accidental staging
// deploys with dev credentials — a leak of those secrets is an account takeover.
const _isDevEnv = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' || !!process.env.VITEST;
if (!_isDevEnv) {
  if (!process.env.ADMIN_API_KEY) {
    throw new Error(
      `[STARTUP] ADMIN_API_KEY is required in ${process.env.NODE_ENV || 'non-development'} environments.\n` +
      '  Generate a secure value with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (ADMIN_API_KEY === 'dev-admin-key-change-me') {
    throw new Error(
      '[STARTUP] Default development admin credential detected in a non-development environment! ' +
      'Set ADMIN_API_KEY to a unique, cryptographically random value.'
    );
  }
  if (!process.env.SESSION_SECRET) {
    throw new Error(
      `[STARTUP] SESSION_SECRET is required in ${process.env.NODE_ENV || 'non-development'} environments.\n` +
      '  Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  // Stripe: if secret key is set, webhook secret MUST also be set to prevent spoofed webhooks
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error(
      '[STARTUP] STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set. ' +
      'Get it from Stripe Dashboard → Webhooks. Without it, spoofed webhook requests could manipulate billing state.'
    );
  }
  // Email: warn (not fatal) — app works without it but users can't reset passwords
  if (!process.env.RESEND_API_KEY) {
    console.warn('\n⚠️  RESEND_API_KEY not set — transactional emails (welcome, password reset, billing) will only log to console.');
    console.warn('   Users will NOT receive emails. Get a key from https://resend.com\n');
  }
}
if (_isDevEnv && ADMIN_API_KEY === 'dev-admin-key-change-me') {
  console.warn('\n⚠️  WARNING: Using default dev admin key! Set ADMIN_API_KEY before deploying.\n');
}

// ─── CONNECTION LIMITS ───────────────────────────────────────────────────────
const wsConnectionsByIp = new Map(); // IP -> count
const MAX_WS_CONNECTIONS_PER_IP = 5;
const MAX_CONTROLLERS = 20;
const MAX_SSE_CLIENTS = 50;
const PREVIEW_FRAME_CACHE_TTL_MS = Math.max(5_000, Number(process.env.PREVIEW_FRAME_CACHE_TTL_MS || 30_000));

// ─── TIMER COORDINATION ─────────────────────────────────────────────────────
// Track all setInterval IDs so graceful shutdown can clear them, preventing
// timer leaks and post-close errors.
const _intervals = [];

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const isAdminRoute = (req.path.startsWith('/api/') && !req.path.startsWith('/api/public/') && !req.path.startsWith('/api/church/app/')) || req.path.startsWith('/dashboard');

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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-reseller-key, x-csrf-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── LOGGING ──────────────────────────────────────────────────────────────────

const LOG_JSON = process.env.LOG_FORMAT === 'json';

function log(msg, meta) {
  if (LOG_JSON) {
    const entry = { ts: new Date().toISOString(), level: 'info', msg };
    if (meta) Object.assign(entry, meta);
    console.log(JSON.stringify(entry));
  } else {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${ts}] ${msg}`);
  }
}

function logError(msg, meta) {
  if (LOG_JSON) {
    const entry = { ts: new Date().toISOString(), level: 'error', msg };
    if (meta) Object.assign(entry, meta);
    console.error(JSON.stringify(entry));
  } else {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.error(`[${ts}] ERROR: ${msg}`);
  }
}

function logWarn(msg, meta) {
  if (LOG_JSON) {
    const entry = { ts: new Date().toISOString(), level: 'warn', msg };
    if (meta) Object.assign(entry, meta);
    console.warn(JSON.stringify(entry));
  } else {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.warn(`[${ts}] WARN: ${msg}`);
  }
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

// ─── SLACK WEBHOOK URL VALIDATION ────────────────────────────────────────────
// Prevents SSRF by ensuring webhook URLs point to legitimate Slack endpoints.

function isValidSlackWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
           (parsed.hostname === 'hooks.slack.com' || parsed.hostname.endsWith('.slack.com'));
  } catch { return false; }
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

      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Tally is live at ${escapeHtml(churchName)}!</h1>
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
        Tally Connect &mdash; <a href="https://tallyconnect.app" style="color: #999;">tallyconnect.app</a>
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

Tally Connect — tallyconnect.app`;
}

// ─── DATABASE PERSISTENCE ────────────────────────────────────────────────────

const { db, config: dbConfig, queryClient } = createAppDatabase({ env: process.env, onInfo: log });
const runtimeCoordinator = createRuntimeCoordinator({ env: process.env, logger: console });
const sharedRuntimeState = createSharedRuntimeState({ env: process.env, logger: console });
const runtimeMetrics = createRuntimeMetrics();
const DB_PATH = dbConfig?.sqlitePath || null;
const SQL_AUTOINCREMENT_PRIMARY_KEY = queryClient.driver === 'postgres'
  ? 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'
  : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const SQL_CURRENT_TIMESTAMP_DEFAULT = queryClient.driver === 'postgres'
  ? 'CURRENT_TIMESTAMP'
  : "(datetime('now'))";
const CHURCH_ROW_SELECT = `
  SELECT *,
         churchId AS "churchId",
         registeredAt AS "registeredAt"
  FROM churches
`;
db.exec(`
  CREATE TABLE IF NOT EXISTS churches (
    churchId TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    email TEXT DEFAULT '',
    token TEXT NOT NULL,
    registeredAt TEXT NOT NULL
  )
`);

const resellerSystem = new ResellerSystem(queryClient);
const authMiddleware = createAuthMiddleware({
  db,
  queryClient,
  JWT_SECRET,
  ADMIN_API_KEY,
  safeCompareKey,
  resolveAdminKey,
});
const {
  requireAdminJwt,
  requireAdmin,
  requireReseller,
  requireChurchAppAuth,
  requireChurchOrAdmin,
} = authMiddleware;

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
  // AI routing tracking columns
  "ALTER TABLE ai_usage_log ADD COLUMN latency_ms INTEGER",
  "ALTER TABLE ai_usage_log ADD COLUMN intent TEXT",
  // Signal failover settings
  "ALTER TABLE churches ADD COLUMN failover_enabled INTEGER DEFAULT 0",
  "ALTER TABLE churches ADD COLUMN failover_black_threshold_s INTEGER DEFAULT 5",
  "ALTER TABLE churches ADD COLUMN failover_ack_timeout_s INTEGER DEFAULT 30",
  "ALTER TABLE churches ADD COLUMN failover_action TEXT",
  "ALTER TABLE churches ADD COLUMN failover_auto_recover INTEGER DEFAULT 0",
  "ALTER TABLE churches ADD COLUMN failover_audio_trigger INTEGER DEFAULT 0",
  "ALTER TABLE churches ADD COLUMN recovery_outside_service_hours INTEGER DEFAULT 1",
  // Onboarding checklist steps 3 & 4 (steps 1-2 use existing app/telegram columns)
  "ALTER TABLE churches ADD COLUMN onboarding_failover_tested_at TEXT",
  "ALTER TABLE churches ADD COLUMN onboarding_team_invited_at TEXT",
  // Legacy campus columns — kept for migration compatibility but no longer used by campus linking
  // campus_id: was used for satellite→main campus linking (deprecated)
  // campus_link_code: was used for campus join flow (deprecated)
  "ALTER TABLE churches ADD COLUMN campus_id TEXT",
  "ALTER TABLE churches ADD COLUMN campus_link_code TEXT",
  // Room assignment — which room this desktop/agent monitors
  "ALTER TABLE churches ADD COLUMN room_id TEXT",
  "ALTER TABLE churches ADD COLUMN room_name TEXT",
  // RTMP ingest stream key (for test stream preview in admin portal)
  "ALTER TABLE churches ADD COLUMN ingest_stream_key TEXT",
  // ── Multi-room Phase 1: room_id / instance_name on church-scoped tables ──
  "ALTER TABLE alerts ADD COLUMN room_id TEXT",
  "ALTER TABLE service_sessions ADD COLUMN room_id TEXT",
  "ALTER TABLE service_sessions ADD COLUMN instance_name TEXT",
  "ALTER TABLE post_service_reports ADD COLUMN room_id TEXT",
  "ALTER TABLE post_service_reports ADD COLUMN instance_name TEXT",
  "ALTER TABLE preservice_check_results ADD COLUMN room_id TEXT",
  "ALTER TABLE automation_rules ADD COLUMN room_id TEXT",
  "ALTER TABLE automation_rules ADD COLUMN instance_name TEXT",
  "ALTER TABLE active_rundowns ADD COLUMN room_id TEXT",
  "ALTER TABLE active_rundowns ADD COLUMN instance_name TEXT",
  "ALTER TABLE service_events ADD COLUMN room_id TEXT",
  "ALTER TABLE viewer_snapshots ADD COLUMN room_id TEXT",
  "ALTER TABLE viewer_snapshots ADD COLUMN instance_name TEXT",
  "ALTER TABLE command_log ADD COLUMN room_id TEXT",
  "ALTER TABLE command_log ADD COLUMN instance_name TEXT",
  "ALTER TABLE incident_summaries ADD COLUMN room_id TEXT",
  "ALTER TABLE incident_summaries ADD COLUMN instance_name TEXT",
  "ALTER TABLE problem_finder_reports ADD COLUMN room_id TEXT",
  // Pre-service rundown escalation config on churches table
  "ALTER TABLE churches ADD COLUMN escalation_enabled INTEGER DEFAULT 0",
  "ALTER TABLE churches ADD COLUMN escalation_timing_json TEXT",
];
for (const m of _schemaMigrations) {
  try { db.exec(m); } catch { /* column already exists */ }
}
// Disable auto-recover globally — TD should manually switch back after failover
// (auto-recover caused bounce loops when the source was still intermittent)
try { db.exec("UPDATE churches SET failover_auto_recover = 0 WHERE failover_auto_recover = 1"); } catch { /* ok */ }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_churches_portal_email ON churches(portal_email)');

// Performance indexes for commonly queried columns
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_church_tds_church_id ON church_tds(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_church_id ON alerts(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_events_church_id ON service_events(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_sessions_church_id ON service_sessions(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_guest_tokens_church_id ON guest_tokens(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_churches_reseller_id ON churches(reseller_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_churches_campus_id ON churches(campus_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_churches_campus_link_code ON churches(campus_link_code)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_billing_customers_church_id ON billing_customers(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_rooms_church_id ON rooms(church_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_rooms_campus_id ON rooms(campus_id)');
} catch { /* tables may not exist yet — indexes will be created when they are */ }

// ─── ROOMS TABLE ─────────────────────────────────────────────────────────────
// Rooms are physical spaces within a church (e.g. Main Sanctuary, Youth Room).
// Each room belongs to a church (campus_id column stores the owning churchId).
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    campus_id   TEXT NOT NULL,
    church_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at  TEXT NOT NULL
  )
`);

// ─── ROOM EQUIPMENT TABLE ───────────────────────────────────────────────────
// Stores per-room equipment config (JSON blob) so any machine can pull it on sign-in.
db.exec(`
  CREATE TABLE IF NOT EXISTS room_equipment (
    room_id     TEXT PRIMARY KEY,
    church_id   TEXT NOT NULL,
    equipment   TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL,
    updated_by  TEXT DEFAULT ''
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_room_equipment_church ON room_equipment(church_id)`);

// ─── ROOMS SCHEMA HARDENING (M1, M3, M5) ───────────────────────────────────

// M3: Enable foreign key enforcement
if (queryClient.driver === 'sqlite') {
  db.exec('PRAGMA foreign_keys = ON');
}

// M5: Soft-delete for rooms — add deleted_at column (must come before unique index)
try { db.exec('ALTER TABLE rooms ADD COLUMN deleted_at TEXT'); } catch { /* already exists */ }

// M6: Per-room stream keys — each room gets its own RTMP ingest key
try { db.exec('ALTER TABLE rooms ADD COLUMN stream_key TEXT'); } catch { /* already exists */ }

// Canonical tenant key for rooms while keeping campus_id for legacy callers
try { db.exec('ALTER TABLE rooms ADD COLUMN church_id TEXT'); } catch { /* already exists */ }
try { db.exec('UPDATE rooms SET church_id = campus_id WHERE church_id IS NULL'); } catch { /* already exists */ }

// Add index on rooms.stream_key for RTMP lookup
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_stream_key ON rooms(stream_key)'); } catch { /* already exists */ }

// M3: FK constraint — room_equipment.room_id references rooms.id
// SQLite cannot add FK constraints to existing tables via ALTER TABLE, but we
// can create an index to enforce referential integrity at the application layer.
// The FK is enforced in the room delete endpoint (cascade cleanup).

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

// ─── COMPANION AUTOMATION TABLE ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS rundown_companion_actions (
    id         TEXT PRIMARY KEY,
    church_id  TEXT NOT NULL,
    plan_id    TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rundown_companion_actions_item ON rundown_companion_actions(church_id, plan_id, item_id)'); } catch { /* already exists */ }

// ─── IN-MEMORY RUNTIME STATE ─────────────────────────────────────────────────

// churchId → { churchId, name, email, token, ws, status, lastSeen, lastHeartbeat, registeredAt, disconnectedAt }
const churches = new Map();
const runtimeMirror = createRuntimeMirror({
  churches,
  runtimeCoordinator,
  wsOpen: WebSocket.OPEN,
  logger: console,
});
const controllers = new Set();
// SSE clients for the admin dashboard (all churches)
const sseClients = new Set();
// SSE clients for church portal live status (churchId → Set of res objects)
const portalSseClients = new Map();
// WebSocket clients for church portal live status (churchId → Set of ws)
const portalWsClients = new Map();
// WebSocket clients for public rundown timer displays (planId → Set of ws)
const timerWsClients = new Map();
const roomRegistry = new Map();
const previewFrameCache = new Map();

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

const churchRuntimeReady = (async () => {
  await db.whenReady?.();
  const rows = await queryClient.query(`${CHURCH_ROW_SELECT} ORDER BY registeredAt ASC`);
  const latestBillingByChurch = new Map();
  try {
    const billingRows = await queryClient.query(`
      SELECT church_id, tier, status, trial_ends_at, grace_ends_at, billing_interval
      FROM billing_customers
      ORDER BY updated_at DESC
    `);
    for (const billingRow of billingRows) {
      if (!billingRow?.church_id || latestBillingByChurch.has(billingRow.church_id)) continue;
      latestBillingByChurch.set(billingRow.church_id, billingRow);
    }
  } catch {
    // billing_customers may not exist yet during very early bootstrap flows
  }

  for (const row of rows) {
    let registrationCode = row.registration_code || null;
    if (!registrationCode) {
      registrationCode = await generateRegistrationCode();
      await queryClient.run('UPDATE churches SET registration_code = ? WHERE churchId = ?', [registrationCode, row.churchId]);
    }

    const billingRow = latestBillingByChurch.get(row.churchId) || null;

    churches.set(row.churchId, {
      churchId: row.churchId,
      name: row.name,
      email: row.email,
      token: row.token,
      ws: null,
      sockets: new Map(),  // Map<instanceName, ws> — multi-instance support
      status: {},
      instanceStatus: {},   // { instanceName → status object } — per-room status
      roomInstanceMap: {},  // { roomId → instanceName }
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
      // Billing/access context kept on the runtime object for fast gating checks
      billing_tier:        row.billing_tier || billingRow?.tier || null,
      billing_status:      row.billing_status || billingRow?.status || 'inactive',
      billing_interval:    row.billing_interval || billingRow?.billing_interval || null,
      billing_trial_ends:  row.billing_trial_ends || billingRow?.trial_ends_at || null,
      billing_grace_ends_at: billingRow?.grace_ends_at || null,
      registrationCode,
    });
  }
  log(`Loaded ${churches.size} churches from database`);
})();

const startupBootstrap = (async () => {
  await db.whenReady?.();
  try {
    roomRegistry.clear();
    const roomRows = await queryClient.query(
      'SELECT campus_id, id FROM rooms WHERE deleted_at IS NULL',
    );
    for (const roomRow of roomRows) {
      if (!roomRegistry.has(roomRow.campus_id)) roomRegistry.set(roomRow.campus_id, new Set());
      roomRegistry.get(roomRow.campus_id).add(roomRow.id);
    }
  } catch (e) {
    console.log(`[migration] room registry preload: ${e.message}`);
  }

  try {
    const dupes = await queryClient.query(`
      SELECT campus_id, name, COUNT(*) AS cnt
      FROM rooms
      WHERE deleted_at IS NULL
      GROUP BY campus_id, name
      HAVING COUNT(*) > 1
    `);
    if (dupes.length > 0) {
      for (const dupe of dupes) {
        const rows = await queryClient.query(
          'SELECT id FROM rooms WHERE campus_id = ? AND name = ? ORDER BY created_at ASC',
          [dupe.campus_id, dupe.name],
        );
        for (let i = 1; i < rows.length; i++) {
          await queryClient.run('UPDATE rooms SET name = ? WHERE id = ?', [`${dupe.name} (${i + 1})`, rows[i].id]);
        }
      }
      console.log(`[migration] Fixed ${dupes.length} duplicate room name(s)`);
    }
    await queryClient.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_unique_name ON rooms(campus_id, name) WHERE deleted_at IS NULL');
  } catch (e) {
    console.log(`[migration] rooms unique index: ${e.message}`);
  }

  try {
    const roomsWithoutKeys = await queryClient.query(
      'SELECT id FROM rooms WHERE stream_key IS NULL AND deleted_at IS NULL',
    );
    for (const room of roomsWithoutKeys) {
      await queryClient.run('UPDATE rooms SET stream_key = ? WHERE id = ?', [crypto.randomBytes(16).toString('hex'), room.id]);
    }
    if (roomsWithoutKeys.length > 0) {
      console.log(`[migration] Generated stream keys for ${roomsWithoutKeys.length} existing room(s)`);
    }
  } catch (e) {
    console.log(`[migration] stream key backfill: ${e.message}`);
  }

  try {
    await queryClient.queryOne('SELECT instance_name FROM problem_finder_reports LIMIT 1');
  } catch {
    try {
      await queryClient.exec('ALTER TABLE problem_finder_reports ADD COLUMN instance_name TEXT');
    } catch {
      /* already exists */
    }
  }

  const adminCount = Number(await queryClient.queryValue('SELECT COUNT(*) AS cnt FROM admin_users')) || 0;
  if (adminCount === 0 && process.env.ADMIN_SEED_EMAIL && process.env.ADMIN_SEED_PASSWORD) {
    const seedSalt = crypto.randomBytes(16).toString('hex');
    const seedHash = crypto.scryptSync(process.env.ADMIN_SEED_PASSWORD, seedSalt, 64).toString('hex');
    await queryClient.run(
      'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), process.env.ADMIN_SEED_EMAIL.trim().toLowerCase(), `${seedSalt}:${seedHash}`, 'Admin', 'super_admin', 1, new Date().toISOString()],
    );
    console.log(`[AdminUsers] Seeded initial super_admin: ${process.env.ADMIN_SEED_EMAIL}`);
  } else if (adminCount === 0) {
    console.log('[AdminUsers] No admin users exist. Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD to create the first super_admin.');
  }
})().catch((e) => {
  console.error('[StartupBootstrap] Error:', e.message);
});

// ─── EXTRA SQLITE TABLES (new features) ──────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS maintenance_windows (
    id ${SQL_AUTOINCREMENT_PRIMARY_KEY},
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
    id ${SQL_AUTOINCREMENT_PRIMARY_KEY},
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
    id ${SQL_AUTOINCREMENT_PRIMARY_KEY},
    component_id TEXT NOT NULL,
    previous_state TEXT NOT NULL,
    new_state TEXT NOT NULL,
    message TEXT DEFAULT '',
    started_at TEXT NOT NULL,
    resolved_at TEXT
  )
`);

// ─── Diagnostic Bundles table ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS diagnostic_bundles (
    id TEXT PRIMARY KEY,
    church_id TEXT,
    churchId TEXT NOT NULL,
    bundle TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);
try { db.exec('ALTER TABLE diagnostic_bundles ADD COLUMN church_id TEXT'); } catch { /* already exists */ }
try { db.exec('UPDATE diagnostic_bundles SET church_id = churchId WHERE church_id IS NULL AND churchId IS NOT NULL'); } catch { /* ignore */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_diagnostic_bundles_church ON diagnostic_bundles(church_id, created_at DESC)');

db.exec('CREATE INDEX IF NOT EXISTS idx_support_triage_church ON support_triage_runs(church_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_support_ticket_church ON support_tickets(church_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_support_ticket_status ON support_tickets(status, updated_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_support_ticket_updates_ticket ON support_ticket_updates(ticket_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_status_incidents_component ON status_incidents(component_id, started_at DESC)');

// ─── Network Topology table ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS network_topology (
    church_id   TEXT NOT NULL,
    room_id     TEXT,
    devices     TEXT NOT NULL DEFAULT '[]',
    scan_time   TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (church_id, room_id)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_network_topology_church ON network_topology(church_id)');

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
    id ${SQL_AUTOINCREMENT_PRIMARY_KEY},
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

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_chat_log (
    id ${SQL_AUTOINCREMENT_PRIMARY_KEY},
    timestamp TEXT NOT NULL,
    church_id TEXT,
    room_id TEXT,
    source TEXT NOT NULL,
    user_message TEXT NOT NULL,
    ai_response TEXT,
    intent TEXT,
    model TEXT,
    latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT ${SQL_CURRENT_TIMESTAMP_DEFAULT}
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_ai_chat_log_church ON ai_chat_log(church_id, timestamp DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ai_chat_log_source ON ai_chat_log(source, timestamp DESC)');

function logAiChatInteraction({ churchId, roomId, source, userMessage, aiResponse, intent, model, latencyMs }) {
  queryClient.run(
    'INSERT INTO ai_chat_log (timestamp, church_id, room_id, source, user_message, ai_response, intent, model, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [new Date().toISOString(), churchId || null, roomId || null, source || 'unknown', userMessage || '', aiResponse || null, intent || null, model || null, latencyMs || null],
  ).catch((err) => {
    console.error('[AI Chat Log] Failed to log:', err.message);
  });
}

// ─── AUDIT LOG TABLE ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id            ${SQL_AUTOINCREMENT_PRIMARY_KEY},
    admin_user_id TEXT,
    admin_email   TEXT NOT NULL,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    details       TEXT DEFAULT '{}',
    ip_address    TEXT,
    created_at    TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at DESC)');

// ─── VIEWER SNAPSHOTS TABLE ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS viewer_snapshots (
    id ${SQL_AUTOINCREMENT_PRIMARY_KEY},
    church_id TEXT NOT NULL,
    session_id TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    youtube INTEGER,
    facebook INTEGER,
    vimeo INTEGER,
    captured_at TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_viewer_snaps_church ON viewer_snapshots(church_id, captured_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_viewer_snaps_session ON viewer_snapshots(session_id, captured_at DESC)');

// ─── CLOCK LAYOUTS TABLE ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clock_layouts (
    id TEXT PRIMARY KEY,
    church_id TEXT NOT NULL,
    name TEXT NOT NULL,
    layout_mode TEXT NOT NULL,
    cells TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_clock_layouts_church ON clock_layouts(church_id)');

/** Log an admin action to the audit table. Fire-and-forget — never throws. */
function logAudit({ adminUserId, adminEmail, action, targetType, targetId, details, ip }) {
  queryClient.run(
    'INSERT INTO audit_log (admin_user_id, admin_email, action, target_type, target_id, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      adminUserId || null,
      adminEmail || 'unknown',
      action,
      targetType || null,
      targetId || null,
      typeof details === 'object' ? JSON.stringify(details) : (details || '{}'),
      ip || null,
      new Date().toISOString(),
    ],
  ).catch((err) => {
    console.error('[AuditLog] Failed to log:', err.message);
  });
}

/** Log an AI API call to the usage table. Fire-and-forget — never throws. */
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001':  { input: 1.00,  output: 5.00  },  // $/M tokens
  'claude-sonnet-4-20250514':   { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-6':           { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':            { input: 15.00, output: 75.00 },
};
function logAiUsage({ churchId, feature, model, inputTokens, outputTokens, cached, latencyMs, intent }) {
  const m = model || 'claude-haiku-4-5-20251001';
  const pricing = MODEL_PRICING[m] || MODEL_PRICING['claude-haiku-4-5-20251001'];
  const cost = ((inputTokens || 0) * pricing.input / 1_000_000) + ((outputTokens || 0) * pricing.output / 1_000_000);
  queryClient.run(
    'INSERT INTO ai_usage_log (church_id, feature, model, input_tokens, output_tokens, cost_usd, cached, created_at, latency_ms, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [churchId || null, feature, m, inputTokens || 0, outputTokens || 0, cost, cached ? 1 : 0, new Date().toISOString(), latencyMs || null, intent || null],
  ).catch((err) => {
    console.error('[AI Usage] Failed to log:', err.message);
  });
}

// Wire logAiUsage into AI modules
setParserLogger(logAiUsage);
setSetupLogger(logAiUsage);

// ─── INCIDENT CHAIN TRACKING ─────────────────────────────────────────────────
// Track sequences of alerts that occur within 5 minutes of each other.
// These chains help the AI understand causal relationships.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS incident_chains (
      id ${SQL_AUTOINCREMENT_PRIMARY_KEY},
      church_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      occurrence_count INTEGER DEFAULT 1,
      last_seen TEXT NOT NULL,
      first_seen TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_incident_chains_church ON incident_chains(church_id)');
} catch {}

const _recentAlertsByChurch = new Map(); // churchId → [{ type, timestamp }]
const CHAIN_WINDOW_MS = 5 * 60_000; // 5 minutes

function recordAlertForChaining(churchId, alertType) {
  if (!_recentAlertsByChurch.has(churchId)) _recentAlertsByChurch.set(churchId, []);
  const recent = _recentAlertsByChurch.get(churchId);
  const now = Date.now();
  // Prune old alerts outside window
  while (recent.length > 0 && now - recent[0].timestamp > CHAIN_WINDOW_MS) recent.shift();
  recent.push({ type: alertType, timestamp: now });
  // If we have 2+ alerts in the window, record the chain
  if (recent.length >= 2) {
    const chain = recent.map(a => a.type).join(' → ');
    const nowIso = new Date().toISOString();
    queryClient.queryOne(
      'SELECT id, occurrence_count AS "occurrence_count" FROM incident_chains WHERE church_id = ? AND chain = ?',
      [churchId, chain],
    ).then((existing) => {
      if (existing) {
        return queryClient.run(
          'UPDATE incident_chains SET occurrence_count = occurrence_count + 1, last_seen = ? WHERE id = ?',
          [nowIso, existing.id],
        );
      } else {
        return queryClient.run(
          'INSERT INTO incident_chains (church_id, chain, first_seen, last_seen) VALUES (?, ?, ?, ?)',
          [churchId, chain, nowIso, nowIso],
        );
      }
    }).catch(() => {});
  }
}

async function _getIncidentChains(churchId) {
  try {
    const chains = await queryClient.query(`
      SELECT chain,
             occurrence_count AS "occurrence_count",
             last_seen AS "last_seen"
      FROM incident_chains
      WHERE church_id = ? AND occurrence_count >= 2
      ORDER BY occurrence_count DESC
      LIMIT 10
    `, [churchId]);
    if (!chains.length) return 'No known incident chains yet.';
    return chains.map(c =>
      `"${c.chain}" — seen ${c.occurrence_count} times (last: ${c.last_seen})`
    ).join('\n');
  } catch {
    return 'No known incident chains yet.';
  }
}

// Slack integration columns (safe to run multiple times)
for (const col of ['slack_webhook_url', 'slack_channel']) {
  try { db.exec(`ALTER TABLE churches ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
}

// Preset library table
const presetLibrary = new PresetLibrary(queryClient);

// ─── AUTOMATION ENGINES ──────────────────────────────────────────────────────

const scheduleEngine = new ScheduleEngine(queryClient);
const billing = new BillingSystem(queryClient);
billing.setChurchRuntimeStore(churches);
const onCallRotation = new OnCallRotation(queryClient);
const alertEngine = new AlertEngine(queryClient, scheduleEngine, { onCallRotation });

// ─── PUSH NOTIFICATIONS (mobile) ──────────────────────────────────────────────
let firebaseApp = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require('firebase-admin');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[Server] ✓ Firebase Admin initialized for push notifications');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const admin = require('firebase-admin');
    const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[Server] ✓ Firebase Admin initialized from file');
  } else {
    console.log('[Server] ℹ FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
  }
} catch (e) {
  console.warn('[Server] Firebase Admin init failed (push notifications disabled):', e.message);
}
const pushNotifications = new PushNotificationService({ db: queryClient, firebaseApp, log: console.log });
alertEngine.setPushNotifications(pushNotifications);

const versionConfig = new VersionConfig(queryClient);
const autoRecovery = new AutoRecovery(churches, alertEngine, queryClient);
const aiTriageEngine = new AITriageEngine(queryClient, scheduleEngine, {
  churches,
  autoRecovery,
  broadcastToSSE: (data) => broadcastToSSE(data),
  createTicket: async ({ churchId, title, description, severity, issueCategory, aiTriageEventId }) => {
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    try {
      await queryClient.run(`
        INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, description, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
      `, [ticketId, churchId, aiTriageEventId || null, issueCategory || 'other', severity || 'P3', title, description, '{}', 'ai_triage', now, now]);
      await queryClient.run(
        `INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at) VALUES (?, ?, 'system', 'ai_triage', ?)`,
        [ticketId, description || 'AI Triage recommendation', now],
      );
    } catch (e) { console.error('[AITriage] Ticket creation failed:', e.message); }
    return ticketId;
  },
});
const signalFailover = new SignalFailover(churches, alertEngine, autoRecovery, queryClient);
autoRecovery.signalFailover = signalFailover; // allow autoRecovery to defer to failover
const weeklyDigest = new WeeklyDigest(queryClient);
weeklyDigest.setNotificationConfig(process.env.ALERT_BOT_TOKEN);
const rundownEngine = new RundownEngine(queryClient);

// Live Rundown — show-calling with PCO or manual service plans.
// Broadcast functions are deferred because the WebSocket handlers aren't created yet.
let _liveRundownBroadcastMobile = () => {};
let _liveRundownBroadcastPortal = () => {};
let _liveRundownBroadcastControllers = () => {};
let _liveRundownBroadcastChurch = () => {};
const liveRundown = new LiveRundownManager({
  broadcastToMobile: (churchId, msg) => _liveRundownBroadcastMobile(churchId, msg),
  broadcastToPortal: (churchId, msg) => _liveRundownBroadcastPortal(churchId, msg),
  broadcastToControllers: (churchId, msg) => _liveRundownBroadcastControllers(churchId, msg),
  broadcastToChurch: (churchId, msg) => _liveRundownBroadcastChurch(churchId, msg),
  log,
  queryClient,
});
const manualRundown = new ManualRundownStore({ queryClient, log });

weeklyDigest.churchMemory = null; // set after churchMemory is created below

const guestTdMode = new GuestTdMode(queryClient, {
  adminName: process.env.ADMIN_NAME || 'the administrator',
});

const monthlyReport = new MonthlyReport({
  db: queryClient,
  defaultBotToken: process.env.ALERT_BOT_TOKEN,
  adminChatId: process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.ANDREW_TELEGRAM_CHAT_ID,
});

// ─── SESSION RECAP ────────────────────────────────────────────────────────────

const churchMemory = new ChurchMemory(queryClient);
weeklyDigest.churchMemory = churchMemory;
const churchDocuments = new ChurchDocuments(queryClient);
churchDocuments.setAiUsageLogger((opts) => logAiUsage({ churchId: opts.churchId || null, ...opts }));
const sessionRecap = new SessionRecap(queryClient);
sessionRecap.setRoomResolver((churchId, instanceName) => {
  if (!instanceName) return null;
  const runtime = churches.get(churchId);
  const roomInstanceMap = runtime?.roomInstanceMap || null;
  if (!roomInstanceMap) return null;
  for (const [roomId, mappedInstance] of Object.entries(roomInstanceMap)) {
    if (mappedInstance === instanceName) return roomId;
  }
  return null;
});
sessionRecap.churchMemory = churchMemory;
sessionRecap.setNotificationConfig(
  process.env.ALERT_BOT_TOKEN,
  process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.ANDREW_TELEGRAM_CHAT_ID
);
aiTriageEngine.setSessionRecap(sessionRecap); // Let triage detect active streaming sessions

// ─── PRE-SERVICE PUSH REMINDER (T-30 minutes) ────────────────────────────────
scheduleEngine.addPreServiceCallback(async (churchId, nextService) => {
  try {
    const church = churches.get(churchId);
    const churchName = church?.name || 'Church';
    let rundownSummary = null;
    try {
      const activeRundown = rundownEngine.getActive(churchId);
      if (activeRundown?.items?.length) {
        rundownSummary = `${activeRundown.items.length} items in rundown`;
      }
    } catch { /* no rundown */ }
    await pushNotifications.sendServiceReminder(churchId, {
      name: `${churchName} Service`,
      startsAt: nextService.startTime,
      rundownSummary,
    });
  } catch (e) {
    console.error(`[Push] Pre-service reminder error for ${churchId}:`, e.message);
  }
});

// Hook schedule engine window transitions → session lifecycle
function getConnectedSessionInstances(churchId) {
  const church = churches.get(churchId);
  if (!church?.sockets?.size) return [null];
  return Array.from(church.sockets.keys());
}

scheduleEngine.addWindowOpenCallback(async (churchId) => {
  try {
    const onCallTd = await onCallRotation.getOnCallTD(churchId);
    for (const instanceName of getConnectedSessionInstances(churchId)) {
      await sessionRecap.startSession(churchId, onCallTd?.name || null, instanceName, { scheduled: true });
    }
  } catch (e) {
    console.error(`[SessionRecap] onWindowOpen error for ${churchId}:`, e.message);
  }
});

scheduleEngine.addWindowCloseCallback(async (churchId) => {
  try {
    // Clear auto-recovery attempt counts for the ended session
    autoRecovery.clearAllAttempts(churchId);
    const sessions = await sessionRecap.endSessionsForChurch(churchId);
    for (const sessionData of sessions) {
      // Fire-and-forget post-service narrative (never blocks session end)
      incidentSummarizer.generatePostServiceNarrative(churchId, sessionData).then(narrative => {
        if (narrative) postSystemChatMessage(churchId, `📋 Post-Service Summary\n${narrative}`, sessionData.roomId || null);
      }).catch(e => console.error(`[IncidentSummarizer] Narrative error for ${churchId}:`, e.message));

      // Write production notes back to Planning Center
      planningCenter.writeServiceNotes(churchId, sessionData).catch(e =>
        console.warn(`[PlanningCenter] Write-back error for ${churchId}:`, e.message)
      );
    }
  } catch (e) {
    console.error(`[SessionRecap] onWindowClose error for ${churchId}:`, e.message);
  }
});


// ─── AUTOPILOT ───────────────────────────────────────────────────────────────

const autoPilot = new AutoPilot(queryClient, { scheduleEngine, sessionRecap, billing });

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

// ─── RUNDOWN SCHEDULER ───────────────────────────────────────────────────────

const scheduler = new RundownScheduler(queryClient, {
  rundownEngine, scheduleEngine, billing, presetLibrary, autoPilot,
});

// Command executor (same pattern as AutoPilot)
scheduler.setCommandExecutor(async (churchId, command, params, source) => {
  const church = churches.get(churchId);
  if (!church) throw new Error('Church not found');
  const sender = makeCommandSender(church);
  return await sender(command, params);
});

// Hook service window transitions for auto-activate / deactivate
scheduleEngine.addWindowOpenCallback((churchId) => {
  Promise.resolve(scheduler.onServiceWindowOpen(churchId)).catch(() => {});
});
scheduleEngine.addWindowCloseCallback((churchId) => {
  try { scheduler.onServiceWindowClose(churchId); } catch {}
});

// ─── CHAT ENGINE ─────────────────────────────────────────────────────────────

const chatEngine = new ChatEngine(queryClient, { sessionRecap });
ensureOnboardingTable(db);

// ─── INCIDENT SUMMARIZER ─────────────────────────────────────────────────────

const incidentSummarizer = new IncidentSummarizer({
  db: queryClient, churches, chatEngine, alertEngine, weeklyDigest, sessionRecap, signalFailover,
});
incidentSummarizer.setAiUsageLogger(logAiUsage);

// Fire-and-forget transition handler — summaries never block the state machine
signalFailover.onTransition((churchId, from, to, trigger, snapshot) => {
  incidentSummarizer.handleTransition(churchId, from, to, trigger, snapshot);

  // Send failover state to the specific instance that triggered it, or all if unknown
  const church = churches.get(churchId);
  if (church?.sockets?.size) {
    const payload = JSON.stringify({ type: 'failover_state', ...snapshot });
    const targetInstance = snapshot?.instanceName;
    if (targetInstance && church.sockets.has(targetInstance)) {
      const sock = church.sockets.get(targetInstance);
      try { if (sock.readyState === 1) sock.send(payload); } catch { /* best effort */ }
    } else {
      // Backward compat: broadcast to all instances if no specific instance
      for (const sock of church.sockets.values()) {
        try { if (sock.readyState === 1) sock.send(payload); } catch { /* best effort */ }
      }
    }
  }
});
console.log('[Server] ✓ Incident Summarizer initialized');

// ─── AI RATE LIMITER ─────────────────────────────────────────────────────────

const aiRateLimiter = new AiRateLimiter({ db: queryClient, signalFailover });
aiRateLimiter.setAiUsageLogger(logAiUsage);

// Hook incident bypass into ai-parser's per-hour rate limiter
setIncidentBypassCheck((churchId) => aiRateLimiter.isActiveIncident(churchId));

// Wire template fallback logging into incident summarizer
incidentSummarizer._aiRateLimiter = aiRateLimiter;

console.log('[Server] ✓ AI Rate Limiter initialized');

// ─── PLANNING CENTER ──────────────────────────────────────────────────────────

const planningCenter = new PlanningCenter(queryClient);
planningCenter.setScheduleEngine(scheduleEngine);

// ─── STREAM PLATFORM OAUTH ──────────────────────────────────────────────────

const streamOAuth = new StreamPlatformOAuth(queryClient);

// ─── TRIAL EXPIRATION CRON ────────────────────────────────────────────────────
// Every hour, check for expired trials and deactivate them.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function checkExpiredTrials() {
  try {
    const now = new Date().toISOString();
    const expired = await queryClient.query(`
      SELECT churchId AS "churchId", name, billing_trial_ends
      FROM churches
      WHERE billing_status = 'trialing'
        AND billing_trial_ends IS NOT NULL
        AND billing_trial_ends < ?
    `, [now]);

    for (const church of expired) {
      await queryClient.run(
        'UPDATE churches SET billing_status = ? WHERE churchId = ?',
        ['trial_expired', church.churchId],
      );
      // Also update billing_customers if a record exists
      await queryClient.run(
        `UPDATE billing_customers SET status = 'trial_expired', updated_at = ? WHERE church_id = ?`,
        [now, church.churchId],
      );
      const runtime = churches.get(church.churchId);
      if (runtime) {
        runtime.billing_status = 'trial_expired';
        runtime.billing_trial_ends = church.billing_trial_ends || runtime.billing_trial_ends || null;
        runtime.billing_grace_ends_at = null;
      }

      log(`[TrialExpiry] Trial expired for "${church.name}" (${church.churchId}) — trial ended ${church.billing_trial_ends}`);

      // Send trial-expired email (non-blocking)
      if (lifecycleEmails) {
        const fullChurch = await queryClient.queryOne(
          'SELECT churchId AS "churchId", name, portal_email FROM churches WHERE churchId = ?',
          [church.churchId],
        );
        if (fullChurch) lifecycleEmails.sendTrialExpired(fullChurch).catch(e => logError('[TrialExpiry] Failed to send trial-expired email to ' + fullChurch.portal_email + ': ' + e.message));
      }

      // Disconnect the church if it's currently connected
      if (runtime?.sockets?.size) {
        for (const sock of runtime.sockets.values()) {
          if (sock.readyState === 1) sock.close(1008, 'billing_trial_expired');
        }
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
async function enforceGracePeriods() {
  try {
    const now = new Date().toISOString();
    const expired = await queryClient.query(`
      SELECT bc.church_id, bc.grace_ends_at, c.name
      FROM billing_customers bc
      LEFT JOIN churches c ON c.churchId = bc.church_id
      WHERE bc.status = 'past_due'
        AND bc.grace_ends_at IS NOT NULL
        AND bc.grace_ends_at < ?
    `, [now]);

    for (const row of expired) {
      await queryClient.run(
        "UPDATE billing_customers SET status = 'inactive', updated_at = ? WHERE church_id = ?",
        [now, row.church_id],
      );
      await queryClient.run(
        "UPDATE churches SET billing_status = 'inactive' WHERE churchId = ?",
        [row.church_id],
      );
      const runtime = churches.get(row.church_id);
      if (runtime) {
        runtime.billing_status = 'inactive';
        runtime.billing_grace_ends_at = null;
      }

      // Disconnect client
      if (runtime?.sockets?.size) {
        for (const sock of runtime.sockets.values()) {
          if (sock.readyState === 1) sock.close(1008, 'billing_grace_expired');
        }
      }

      log(`[GracePeriod] ⏰ Grace period expired for "${row.name}" (${row.church_id}) — deactivated`);

      // Send grace-expired email
      if (lifecycleEmails) {
        const church = await queryClient.queryOne(
          'SELECT churchId AS "churchId", name, portal_email FROM churches WHERE churchId = ?',
          [row.church_id],
        );
        if (church) lifecycleEmails.sendGraceExpired(church).catch(e => logError('[GracePeriod] Failed to send grace-expired email to ' + church.portal_email + ': ' + e.message));
      }
    }

    if (expired.length > 0) {
      log(`[GracePeriod] Deactivated ${expired.length} church(es) with expired grace periods`);
    }
  } catch (e) {
    console.error('[GracePeriod] Error:', e.message);
  }
}

// ─── LIFECYCLE EMAILS ────────────────────────────────────────────────────────
// Automated email sequences: setup nudge, first-sunday prep, check-in,
// trial warnings, trial expired, payment failed, weekly digest.

const lifecycleEmails = new LifecycleEmails(queryClient, {
  resendApiKey: RESEND_API_KEY,
  fromEmail: FROM_EMAIL,
  appUrl: APP_URL,
});

app.get('/api/notifications/unsubscribe', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).type('html').send('<!doctype html><html><body><h1>Invalid unsubscribe link</h1><p>This link is missing a token.</p></body></html>');
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) || {};
    const churchId = String(payload.churchId || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const type = payload.type === 'digest' || payload.type === 'report' ? payload.type : '';
    if (!churchId || !email || !type) throw new Error('Invalid token payload');

    const church = await queryClient.queryOne(
      'SELECT churchId FROM churches WHERE churchId = ?',
      [churchId],
    );
    if (!church) {
      return res.status(404).type('html').send('<!doctype html><html><body><h1>Church not found</h1><p>This unsubscribe link is no longer valid.</p></body></html>');
    }

    const category = type === 'digest' ? 'weekly-digest' : 'monthly-reports';
    lifecycleEmails.unsubscribeRecipient(churchId, email, category);

    const label = type === 'digest' ? 'weekly digest emails' : 'monthly report emails';
    return res.type('html').send(
      `<!doctype html><html><body><h1>Unsubscribed</h1><p>${escapeHtml(email)} will no longer receive ${escapeHtml(label)}.</p></body></html>`,
    );
  } catch {
    return res.status(400).type('html').send('<!doctype html><html><body><h1>Invalid unsubscribe link</h1><p>This link is invalid or has expired.</p></body></html>');
  }
});

// ─── CHAT LOG PRUNING (nightly, 30-day retention) ────────────────────────────
chatEngine.pruneOldMessages(30).catch((e) => {
  console.error('[ChatEngine] Initial prune failed:', e.message);
});
_intervals.push(setInterval(() => {
  chatEngine.pruneOldMessages(30).catch((e) => {
    console.error('[ChatEngine] Scheduled prune failed:', e.message);
  });
}, 24 * 60 * 60 * 1000));

// ─── VIEWER SNAPSHOTS PRUNING (daily, 90-day retention) ──────────────────────
async function pruneRowsOlderThan({ table, col, cutoffIso, label }) {
  try {
    const pruned = await queryClient.run(
      `DELETE FROM ${table} WHERE ${col} < ?`,
      [cutoffIso],
    );
    if (pruned.changes > 0) log(`[${label}] Pruned ${pruned.changes} rows older than ${cutoffIso}`);
    return pruned.changes || 0;
  } catch { /* ignore */ }
  return 0;
}

async function pruneViewerSnapshots() {
  return pruneRowsOlderThan({
    table: 'viewer_snapshots',
    col: 'captured_at',
    cutoffIso: new Date(Date.now() - 90 * MS_PER_DAY).toISOString(),
    label: 'ViewerSnapshots',
  });
}

async function pruneAuditLog() {
  return pruneRowsOlderThan({
    table: 'audit_log',
    col: 'created_at',
    cutoffIso: new Date(Date.now() - 90 * MS_PER_DAY).toISOString(),
    label: 'AuditLog',
  });
}

async function pruneAiChatLog() {
  return pruneRowsOlderThan({
    table: 'ai_chat_log',
    col: 'timestamp',
    cutoffIso: new Date(Date.now() - 90 * MS_PER_DAY).toISOString(),
    label: 'AiChatLog',
  });
}

// ─── DATA RETENTION PRUNING (daily, multiple tables) ─────────────────────────
// These tables were previously growing unbounded and are the likely cause of
// volume exhaustion on Railway.
const _retentionRules = [
  // High-volume event/log tables — 90 days
  { table: 'alerts',                  col: 'created_at',  days: 180, label: 'Alerts' },
  { table: 'health_alerts',           col: 'created_at',  days: 180, label: 'HealthAlerts' },
  { table: 'service_events',          col: 'timestamp',   days: 180, label: 'ServiceEvents' },
  { table: 'command_log',             col: 'timestamp',   days: 90,  label: 'CommandLog' },
  { table: 'ai_usage_log',            col: 'created_at',  days: 90,  label: 'AIUsageLog' },
  { table: 'ai_rate_limit_events',    col: 'created_at',  days: 90,  label: 'AIRateLimitEvents' },
  { table: 'autopilot_session_fires', col: 'fired_at',    days: 90,  label: 'AutopilotFires' },
  { table: 'processed_webhook_events',col: 'processed_at',days: 90,  label: 'WebhookEvents' },
  // Reports & diagnostics — 90 days (contain large JSON blobs)
  { table: 'diagnostic_bundles',      col: 'created_at',  days: 90,  label: 'DiagnosticBundles' },
  { table: 'problem_finder_reports',  col: 'created_at',  days: 90,  label: 'ProblemFinderReports' },
  { table: 'preservice_check_results',col: 'created_at',  days: 90,  label: 'PreserviceChecks' },
  { table: 'support_triage_runs',     col: 'created_at',  days: 180, label: 'SupportTriageRuns' },
  // Session & summary data — 365 days (lower volume, useful for trends)
  { table: 'service_sessions',        col: 'started_at',  days: 365, label: 'ServiceSessions' },
  { table: 'post_service_reports',    col: 'created_at',  days: 365, label: 'PostServiceReports' },
  { table: 'incident_summaries',      col: 'created_at',  days: 180, label: 'IncidentSummaries' },
  { table: 'incident_chains',         col: 'last_seen',   days: 180, label: 'IncidentChains' },
  { table: 'email_sends',             col: 'sent_at',     days: 180, label: 'EmailSends' },
  // Monthly aggregates — 12 months
  { table: 'ai_diagnostic_usage',     col: 'month',       days: 365, label: 'AIDiagUsage', monthCol: true },
];

async function runDataRetention() {
  let totalPruned = 0;
  for (const rule of _retentionRules) {
    try {
      let result;
      if (rule.monthCol) {
        // month column stores 'YYYY-MM' strings
        const cutoff = new Date(Date.now() - rule.days * MS_PER_DAY);
        const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
        result = await queryClient.run(
          `DELETE FROM ${rule.table} WHERE ${rule.col} < ?`,
          [cutoffMonth],
        );
      } else {
        const cutoffIso = new Date(Date.now() - rule.days * MS_PER_DAY).toISOString();
        result = await queryClient.run(
          `DELETE FROM ${rule.table} WHERE ${rule.col} < ?`,
          [cutoffIso],
        );
      }
      if (result.changes > 0) {
        log(`[DataRetention] ${rule.label}: pruned ${result.changes} rows older than ${rule.days} days`);
        totalPruned += result.changes;
      }
    } catch { /* table may not exist yet */ }
  }
  // After large prunes, checkpoint WAL and reclaim disk space
  if (totalPruned > 0 && queryClient.driver === 'sqlite') {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      log(`[DataRetention] WAL checkpoint complete`);
    } catch { /* ignore */ }
  }
  return totalPruned;
}

async function runDailyMaintenance() {
  await pruneViewerSnapshots();
  await pruneAuditLog();
  await pruneAiChatLog();
  try {
    await Promise.resolve(aiTriageEngine.cleanup(90));
  } catch { /* ignore */ }
}

async function runStartupMaintenance() {
  await db.whenReady?.();
  await startupBootstrap;
  await churchRuntimeReady;
  await checkExpiredTrials();
  await enforceGracePeriods();
  await runDailyMaintenance();
  const startupPruned = await runDataRetention();
  if (startupPruned > 100 && queryClient.driver === 'sqlite') {
    // Only VACUUM after significant prunes to avoid blocking on small cleanups
    try {
      db.exec('VACUUM');
      log(`[DataRetention] VACUUM complete after pruning ${startupPruned} rows`);
    } catch (e) { log(`[DataRetention] VACUUM skipped: ${e.message}`); }
  }
}

// Run on schedule after startup
_intervals.push(setInterval(() => {
  checkExpiredTrials().catch((e) => {
    console.error('[TrialExpiry] Scheduled check failed:', e.message);
  });
}, 60 * 60 * 1000));
_intervals.push(setInterval(() => {
  enforceGracePeriods().catch((e) => {
    console.error('[GracePeriod] Scheduled enforcement failed:', e.message);
  });
}, 60 * 60 * 1000));
_intervals.push(setInterval(() => {
  runDailyMaintenance().catch((e) => {
    console.error('[DailyMaintenance] Scheduled run failed:', e.message);
  });
}, 24 * 60 * 60 * 1000));
_intervals.push(setInterval(() => {
  runDataRetention().catch((e) => {
    console.error('[DataRetention] Scheduled run failed:', e.message);
  });
}, 24 * 60 * 60 * 1000));

// Weekly WAL checkpoint (even without prunes, keeps WAL file from growing)
if (queryClient.driver === 'sqlite') {
  _intervals.push(setInterval(() => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
  }, 7 * 24 * 60 * 60 * 1000));
}

billing.setLifecycleEmails(lifecycleEmails);
sessionRecap.setLifecycleEmails(lifecycleEmails);
weeklyDigest.setLifecycleEmails(lifecycleEmails);
alertEngine.setLifecycleEmails(lifecycleEmails);
const postServiceReport = new PostServiceReport(queryClient, {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  lifecycleEmails,
});
sessionRecap.setPostServiceReport(postServiceReport);

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
if (TALLY_BOT_TOKEN) guestTdMode.botToken = TALLY_BOT_TOKEN;
const TALLY_BOT_WEBHOOK_URL = process.env.TALLY_BOT_WEBHOOK_URL;
const TALLY_BOT_WEBHOOK_SECRET = process.env.TALLY_BOT_WEBHOOK_SECRET || '';
const ADMIN_TELEGRAM_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.ANDREW_TELEGRAM_CHAT_ID;

let tallyBot = null;
let preServiceCheck = null;

if (TALLY_BOT_TOKEN) {
  tallyBot = new TallyBot({
    botToken: TALLY_BOT_TOKEN,
    adminChatId: ADMIN_TELEGRAM_CHAT_ID,
    db,
    queryClient,
    relay: { churches, callDiagnosticAI, makeCommandSender, logAiChatInteraction },
    onCallRotation,
    guestTdMode,
    presetLibrary,
    planningCenter,
    resellerSystem,
    autoPilot,
    chatEngine,
    scheduler,
    signalFailover,
  });
  log('Telegram bot initialized');

  // Wire scheduler TD notifications through the Telegram bot
  scheduler.setTDNotifier((churchId, message) => {
    queryClient.query(
      'SELECT telegram_chat_id AS "telegram_chat_id" FROM church_tds WHERE church_id = ? AND active = 1',
      [churchId],
    ).then((tds) => {
      for (const td of tds) {
        tallyBot.sendMessage(String(td.telegram_chat_id), message, { parse_mode: 'Markdown' }).catch(e => log('[Scheduler] Telegram notify failed for TD ' + td.telegram_chat_id + ': ' + e.message));
      }
    }).catch(() => {});
  });

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
const _defaultBackupMinutes = 0; // Backups are opt-in so fresh deployments do not silently exhaust volumes
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
    if (church?.sockets?.size) {
      for (const sock of church.sockets.values()) safeSend(sock, msg);
    }
  },
  broadcastToControllers: (msg) => broadcastToControllers(msg),
  broadcastToMobile: (churchId, msg) => _mobileWsHandler.broadcastToMobile(churchId, msg),
  notifyTelegram: (churchId, savedMsg) => {
    if (!tallyBot) return;
    const sourceIcon = { app: '💻', dashboard: '🌐', telegram: '📱' }[savedMsg.source] || '💬';
    const text = `${sourceIcon} *${savedMsg.sender_name}*:\n${savedMsg.message}`;
    // Notify TD(s) for this church
    queryClient.query(
      'SELECT telegram_chat_id AS "telegram_chat_id" FROM church_tds WHERE church_id = ? AND active = 1',
      [churchId],
    ).then((tds) => {
      for (const td of tds) {
        if (td.telegram_chat_id && savedMsg.source !== 'telegram') {
          tallyBot.sendMessage(td.telegram_chat_id, text).catch(e => log('[Chat] Telegram notify failed for TD ' + td.telegram_chat_id + ': ' + e.message));
        }
      }
    }).catch(() => {});
    // Notify admin if message is from a TD
    if (savedMsg.sender_role === 'td' && tallyBot.adminChatId) {
      queryClient.queryOne('SELECT name FROM churches WHERE churchId = ?', [churchId])
        .then((churchRow) => {
          const adminText = `${sourceIcon} *${savedMsg.sender_name}* (${churchRow?.name || churchId}):\n${savedMsg.message}`;
          return tallyBot.sendMessage(tallyBot.adminChatId, adminText);
        })
        .catch(e => log('[Chat] Admin Telegram notify failed: ' + e.message));
    }
  },
});

// ─── A/V SYNC MONITOR ────────────────────────────────────────────────────────

setupSyncMonitor(db, { churches }, tallyBot, (churchId) => {
  broadcastToSSE({ type: 'sync_update', churchId });
});

// ─── BROADCAST PLATFORM MONITOR ──────────────────────────────────────────────

setupBroadcastMonitor(queryClient, { churches }, alertEngine, (churchId) => {
  broadcastToSSE({ type: 'broadcast_update', churchId });
});

// ─── EVENT MODE & RESELLER SYSTEM ────────────────────────────────────────────

const eventMode = new EventMode(queryClient);

// Wire resellerSystem into alertEngine for white-label brand names
alertEngine.resellerSystem = resellerSystem;

// ─── ADMIN + RESELLER PORTALS ─────────────────────────────────────────────────
const { setupAdminPanel } = require('./src/adminPanel');
setupAdminPanel(app, db, churches, resellerSystem, {
  jwt,
  JWT_SECRET,
  lifecycleEmails,
  logAudit,
  queryClient,
  getObservedChurch,
  listObservedChurches,
  dispatchRemoteCommand: (payload, meta) => dispatchCommandAcrossRuntime(payload, meta),
});

// Pre-service check — created before portal so portal can trigger manual checks
preServiceCheck = new PreServiceCheck({
  db: queryClient,
  scheduleEngine,
  churches,
  defaultBotToken: process.env.ALERT_BOT_TOKEN,
  adminChatId: ADMIN_TELEGRAM_CHAT_ID,
  sessionRecap,
  versionConfig,
});

// ─── PRE-SERVICE RUNDOWN ORCHESTRATOR ─────────────────────────────────────────
const viewerBaseline = new ViewerBaseline(queryClient);
const preServiceRundown = new PreServiceRundown({
  queryClient,
  scheduleEngine,
  preServiceCheck,
  churchMemory,
  viewerBaseline,
  rundownEngine,
  churches,
  broadcastToPortal,
  postSystemChatMessage,
  makeCommandSender,
  alertBotToken: process.env.ALERT_BOT_TOKEN,
});

// Hook service window transitions for pre-service rundown lifecycle
scheduleEngine.addWindowOpenCallback((churchId) => {
  preServiceRundown.onServiceWindowOpen(churchId).catch(e =>
    console.error(`[PreServiceRundown] onWindowOpen error for ${churchId}:`, e.message)
  );
});
scheduleEngine.addWindowCloseCallback((churchId) => {
  preServiceRundown.onServiceWindowClose(churchId);
});

// Recompute viewer baselines weekly (Sunday at 2 AM)
_intervals.push(setInterval(() => {
  const now = new Date();
  if (now.getDay() === 0 && now.getHours() === 2 && now.getMinutes() === 0) {
    Promise.resolve(viewerBaseline.recomputeAll()).catch((e) => {
      console.error('[ViewerBaseline] Weekly recompute failed:', e.message);
    });
  }
}, 60 * 1000));
console.log('[Server] ✓ Pre-Service Rundown orchestrator initialized');

// ─── PRE-SERVICE BRIEFING (posted when service window opens) ────────────────
// Registered after preServiceCheck so getLatestResult() is available
scheduleEngine.addWindowOpenCallback(async (churchId) => {
  try {
    const church = await queryClient.queryOne(`${CHURCH_ROW_SELECT} WHERE churchId = ?`, [churchId]);
    if (!church) return;
    const onCallTd = await onCallRotation.getOnCallTD(churchId);
    const briefing = await churchMemory.getPreServiceBriefing(churchId);
    const lastSession = await queryClient.queryOne(
      'SELECT * FROM service_sessions WHERE church_id = ? AND ended_at IS NOT NULL AND (session_type IS NULL OR session_type != \'test\') ORDER BY ended_at DESC LIMIT 1',
      [churchId],
    );
    const preCheck = preServiceCheck ? await preServiceCheck.getLatestResult(churchId) : null;

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
    const warningTimer = setInterval(async () => {
      try {
        if (!sessionRecap.activeSessions.has(churchId)) {
          clearInterval(warningTimer);
          patternWarningState.delete(churchId);
          return;
        }
        const now = new Date();
        const currentMinute = now.getHours() * 60 + now.getMinutes();
        const warnings = await churchMemory.getTimedWarnings(churchId);
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
setupChurchPortal(app, db, churches, JWT_SECRET, requireAdmin, {
  billing,
  lifecycleEmails,
  preServiceCheck,
  sessionRecap,
  weeklyDigest,
  rundownEngine,
  scheduler,
  aiRateLimiter,
  guestTdMode,
  signalFailover,
  broadcastToPortal,
  aiTriageEngine,
  preServiceRundown,
  viewerBaseline,
  streamOAuth,
  planningCenter,
  queryClient,
  onRoomCreated(churchId, roomId) {
    if (!roomRegistry.has(churchId)) roomRegistry.set(churchId, new Set());
    roomRegistry.get(churchId).add(roomId);
  },
  onRoomDeleted(churchId, roomId) {
    const rooms = roomRegistry.get(churchId);
    if (!rooms) return;
    rooms.delete(roomId);
    if (rooms.size === 0) roomRegistry.delete(churchId);
  },
  onRoomRestored(churchId, roomId) {
    if (!roomRegistry.has(churchId)) roomRegistry.set(churchId, new Set());
    roomRegistry.get(churchId).add(roomId);
  },
});
console.log('[Server] ✓ Church Portal routes registered');

// ─── Church Portal Live Status SSE ───────────────────────────────────────────
// Authenticated churches can subscribe to real-time status pushes so the portal
// dashboard updates live without requiring a manual refresh.
app.get('/api/church/stream', (req, res) => {
  // Authenticate via cookie (same mechanism as the portal)
  const token = req.cookies?.tally_church_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let churchId;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'church_portal') throw new Error('wrong type');
    churchId = payload.churchId;
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately
  const church = getObservedChurch(churchId);
  const initialPayload = buildPortalStatusSnapshot(church);
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  // Register as a portal SSE client for this church
  if (!portalSseClients.has(churchId)) portalSseClients.set(churchId, new Set());
  portalSseClients.get(churchId).add(res);

  // Keep-alive ping every 20s
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const clients = portalSseClients.get(churchId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) portalSseClients.delete(churchId);
    }
  });
});

function _sendToPortalClients(churchId, data) {
  const clients = portalSseClients.get(churchId);
  if (clients && clients.size > 0) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch {}
    }
  }

  const wsClients = portalWsClients.get(churchId);
  if (wsClients && wsClients.size > 0) {
    const payload = JSON.stringify(data);
    for (const ws of wsClients) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      } catch {}
    }
  }
}

const _portalBatcher = createStatusBatcher(
  (churchId, event) => _sendToPortalClients(churchId, event),
  { windowMs: 100 }
);

// Helper: push an event to all portal clients for a given church
function broadcastToPortal(churchId, data) {
  if (data?.type === 'status_update') {
    _portalBatcher.enqueue(churchId, data);
  } else {
    _sendToPortalClients(churchId, data);
  }
}
console.log('[Server] ✓ Church Portal SSE stream registered');

// ─── CHURCH APP STATUS SSE (Bearer token auth for Electron desktop app) ──────
app.get('/api/church/app/status/stream', requireChurchAppAuth, (req, res) => {
  const churchId = req.church.churchId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current snapshot immediately
  const church = getObservedChurch(churchId);
  const snapshot = buildPortalStatusSnapshot(church);
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

  // Reuse portal SSE client set so broadcastToPortal() pushes updates here too
  if (!portalSseClients.has(churchId)) portalSseClients.set(churchId, new Set());
  portalSseClients.get(churchId).add(res);

  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const clients = portalSseClients.get(churchId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) portalSseClients.delete(churchId);
    }
  });
});
console.log('[Server] ✓ Church App Status SSE stream registered');

// Reseller Portal — self-service login for integrators/resellers
setupResellerPortal(app, queryClient, churches, resellerSystem, JWT_SECRET, requireAdmin);
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
runtimeCoordinator.logStatus();

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
  const item = { msg, queuedAt: Date.now() };
  queue.push(item);
  Promise.resolve(sharedRuntimeState.enqueueMessage(churchId, item, {
    maxQueueSize: MAX_QUEUE_SIZE,
    ttlMs: QUEUE_TTL_MS,
  })).catch((error) => {
    logWarn(`[queue] shared enqueue failed for ${churchId}: ${error.message}`);
  });
}

function drainQueue(churchId, ws) {
  const localQueue = messageQueues.get(churchId) || [];
  messageQueues.delete(churchId);

  const deliverQueuedItems = (items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const now = Date.now();
    let delivered = 0;
    const seen = new Set();
    for (const item of items) {
      const dedupKey = item?.msg?.id || item?.msg?.messageId || JSON.stringify(item?.msg || item);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      if (now - Number(item?.queuedAt || 0) >= QUEUE_TTL_MS) continue;
      safeSend(ws, item.msg);
      delivered++;
    }
    if (delivered > 0) log(`Delivered ${delivered} queued messages to church ${churchId}`);
  };

  if (!sharedRuntimeState.enabled) {
    deliverQueuedItems(localQueue);
    return;
  }

  Promise.resolve(sharedRuntimeState.drainQueuedMessages(churchId))
    .then((sharedQueue) => {
      deliverQueuedItems([...localQueue, ...sharedQueue]);
    })
    .catch((error) => {
      logWarn(`[queue] shared drain failed for ${churchId}: ${error.message}`);
      deliverQueuedItems(localQueue);
    });
}

// ─── HTTP API ────────────────────────────────────────────────────────────────

// Time endpoint (NTP-like sync for broadcast clock)
require('./src/routes/time')(app);

// Streaming config tool – email lead capture (public, no auth)
require('./src/routes/streamingConfigLeads')(app, { rateLimit });

// Health / root endpoints (extracted)
require('./src/routes/health')(app, {
  churches, controllers, RELAY_VERSION, RELAY_BUILD, WebSocket,
  get totalMessagesRelayed() { return totalMessagesRelayed; },
  db,
  queryClient,
  runtimeMetrics,
  runtimeCoordinator,
  runtimeMirror,
  getObservedChurch,
  listObservedChurches,
  getPreviewCacheSummary,
  messageQueues,
});

// Shared auth utilities (single source of truth — also used by churchPortal.js)
const { hashPassword, verifyPassword, generateRegistrationCode: _genRegCode } = require('./src/auth');
async function generateRegistrationCode() {
  return _genRegCode(queryClient || db);
}

function issueChurchAppToken(churchId, name, { readonly = false } = {}) {
  const payload = { type: 'church_app', churchId, name };
  if (readonly) payload.readonly = true;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: CHURCH_APP_TOKEN_TTL });
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
  const church = churches.get(churchId);
  if (!church) {
    return { exists: false, tier: null, status: 'not_found' };
  }

  const resolvedTier = church.billing_tier || null;
  const resolvedInterval =
    normalizeBillingInterval(church.billing_interval, resolvedTier, resolvedTier === 'event' ? 'one_time' : 'monthly') ||
    (resolvedTier === 'event' ? 'one_time' : 'monthly');

  return {
    exists: true,
    tier: resolvedTier,
    billingInterval: resolvedInterval,
    status: String(church.billing_status || 'inactive').toLowerCase(),
    trialEndsAt: church.billing_trial_ends || null,
    graceEndsAt: church.billing_grace_ends_at || null,
  };
}

function checkChurchPaidAccess(churchId) {
  const snapshot = getChurchBillingSnapshot(churchId);
  if (!snapshot.exists) {
    return { allowed: false, status: 'not_found', message: 'Church account not found.' };
  }
  // Attach room limit so the WebSocket router can enforce multi-instance caps
  const tierLimits = TIER_LIMITS[snapshot.tier] || TIER_LIMITS.connect;
  snapshot.maxRooms = tierLimits.rooms;

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

async function upsertStatusComponent({ componentId, name, state, latencyMs = null, detail = '' }) {
  if (!STATUS_STATES.includes(state)) state = 'degraded';
  const nowIso = new Date().toISOString();
  const previous = await queryClient.queryOne(
    'SELECT state, last_changed_at FROM status_components WHERE component_id = ?',
    [componentId],
  );

  if (!previous) {
    await queryClient.run(`
      INSERT INTO status_components (component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [componentId, name, state, latencyMs, detail, nowIso, nowIso]);
    if (state !== 'operational') {
      await queryClient.run(`
        INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at)
        VALUES (?, ?, ?, ?, ?)
      `, [componentId, 'unknown', state, detail, nowIso]);
    }
    return;
  }

  const changed = previous.state !== state;
  await queryClient.run(`
    UPDATE status_components
    SET name = ?, state = ?, latency_ms = ?, detail = ?, last_checked_at = ?, last_changed_at = ?
    WHERE component_id = ?
  `, [name, state, latencyMs, detail, nowIso, changed ? nowIso : previous.last_changed_at, componentId]);

  if (!changed) return;

  await queryClient.run(`
    UPDATE status_incidents
    SET resolved_at = ?
    WHERE id = (
      SELECT id FROM status_incidents
      WHERE component_id = ? AND resolved_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    )
  `, [nowIso, componentId]);

  if (state !== 'operational') {
    await queryClient.run(`
      INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at)
      VALUES (?, ?, ?, ?, ?)
    `, [componentId, previous.state, state, detail, nowIso]);
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
      await upsertStatusComponent({
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
  if (!DB_PATH || queryClient.driver !== 'sqlite') {
    throw new Error('Manual DB snapshots are only available for the SQLite runtime.');
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  const backupDir = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
  return createBackupSnapshot({
    dbPath: DB_PATH,
    backupDir,
    encryptionKey: process.env.BACKUP_ENCRYPTION_KEY || '',
    retainCount: Number(process.env.BACKUP_RETAIN_COUNT || 10),
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

    const church = churches.get(churchId);
    if (!church) return next(); // let route's own 404 handle it

    const access = billing.checkAccess(church, featureName);
    if (!access.allowed) {
      return res.status(403).json({ error: access.reason, feature: featureName });
    }
    next();
  };
}

// Register a new church and get a connection token
app.post('/api/churches/register', requireAdmin, rateLimit(10, 60_000), async (req, res) => {
  const { name, email, portalEmail, password, tier, billingStatus } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (password && !portalEmail) return res.status(400).json({ error: 'portalEmail is required when password is provided' });
  if (portalEmail && !password) return res.status(400).json({ error: 'password is required when portalEmail is provided' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  // Check uniqueness
  const existing = await queryClient.queryOne(
    'SELECT churchId AS "churchId" FROM churches WHERE name = ?',
    [name],
  );
  if (existing) return res.status(409).json({ error: `A church named "${name}" already exists` });

  const cleanPortalEmail = String(portalEmail || '').trim().toLowerCase();
  if (cleanPortalEmail) {
    const existingEmail = await queryClient.queryOne(
      'SELECT churchId AS "churchId" FROM churches WHERE portal_email = ?',
      [cleanPortalEmail],
    );
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
  const registrationCode = await generateRegistrationCode();

  // Compute trial end date if status is trialing
  const finalStatus = normalizedStatus || 'active';
  const trialEndsAt = finalStatus === 'trialing'
    ? new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await queryClient.run(
    'INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)',
    [churchId, name, email || '', token, registeredAt],
  );
  await queryClient.run('UPDATE churches SET registration_code = ? WHERE churchId = ?', [registrationCode, churchId]);
  await queryClient.run(`
    UPDATE churches
    SET portal_email = ?, portal_password_hash = ?, billing_tier = ?, billing_status = ?, billing_trial_ends = ?, billing_interval = ?
    WHERE churchId = ?
  `, [
    cleanPortalEmail || null,
    password ? hashPassword(password) : null,
    resolvedTier,
    finalStatus,
    trialEndsAt,
    normalizedInterval,
    churchId,
  ]);

  churches.set(churchId, {
    churchId, name, email: email || '',
    token, ws: null, sockets: new Map(),
    status: {},
    lastSeen: null, registeredAt, disconnectedAt: null,
    billing_tier: resolvedTier,
    billing_status: finalStatus,
    billing_interval: normalizedInterval,
    billing_trial_ends: trialEndsAt,
    billing_grace_ends_at: null,
    registrationCode,
  });

  const admin = req.adminUser || {};
  logAudit({ adminUserId: admin.id, adminEmail: admin.email || 'api', action: 'church_created', targetType: 'church', targetId: churchId, details: { name, tier: resolvedTier }, ip: req.ip });
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

// Accepts EITHER a church_app Bearer token (Electron app) OR a portal session
// cookie (church portal web UI). Used by endpoints shared between both clients.
async function requireChurchAppOrPortalAuth(req, res, next) {
  // 1. Try Bearer token (Electron app / mobile)
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      if (payload.type !== 'church_app') throw new Error('wrong token type');
      const church = await loadChurchById(payload.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });
      req.church = church;
      req.churchReadonly = !!payload.readonly;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }
  // 2. Fall back to portal session cookie (church portal web UI)
  const token = req.cookies?.tally_church_session;
  if (!token) {
    return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type === 'church_portal') {
      const church = await loadChurchById(payload.churchId);
      if (!church) throw new Error('church not found');
      req.church = church;
      return next();
    }
    if (payload.type === 'td_portal') {
      const td = await loadTdPortalUser(payload.tdId, payload.churchId);
      if (!td || !td.portal_enabled) throw new Error('td not found or disabled');
      const church = await loadChurchById(payload.churchId);
      if (!church) throw new Error('church not found');
      req.church = church;
      req.td = td;
      req.tdAccessLevel = td.access_level || 'operator';
      if (payload.roomId) req.tdRoomId = payload.roomId;
      return next();
    }
    throw new Error('wrong type');
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

// Rejects requests from readonly church_app tokens (staff view-only access).
function requireChurchWriteAccess(req, res, next) {
  if (req.churchReadonly) {
    return res.status(403).json({ error: 'This token is read-only. Log in with full credentials to make changes.' });
  }
  next();
}

// GET/POST /api/church/app/me + /api/pf/report routes → src/routes/churchAuth.js

// PUT /api/church/app/me + reset-password routes → src/routes/churchAuth.js

// ─── SUPPORT TRIAGE + TICKETS (extracted to module) ──────────────────────────
require('./src/routes/supportTickets')(app, {
  db, queryClient, churches, requireAdminJwt, scheduleEngine,
  JWT_SECRET, RELAY_VERSION, SUPPORT_TRIAGE_WINDOW_HOURS, rateLimit,
  broadcastToSSE, lifecycleEmails,
});
console.log('[Server] ✓ Support ticket routes registered');

// Status components & incidents (extracted)
require('./src/routes/statusComponents')(app, {
  db, queryClient, requireAdmin, runStatusChecks,
  lastStatusCheckAt: () => lastStatusCheckAt,
});

// ─── EXTRACTED ROUTE MODULES ───────────────────────────────────────────────
// ─── Rundown presence tracking (planId → [{ sessionId, churchId, userName, joinedAt, lastSeenAt, status }]) ─
const rundownPresence = new Map();
const RUNDOWN_PRESENCE_STALE_AFTER_MS = 5 * 60 * 1000;

// Periodic cleanup: mark stale presence entries offline when they stop heartbeating.
setInterval(() => {
  const staleThreshold = Date.now() - RUNDOWN_PRESENCE_STALE_AFTER_MS;
  if (manualRundown?.cleanupStaleCollaborators) {
    manualRundown.cleanupStaleCollaborators(staleThreshold).catch((error) => {
      log(`[rundown] stale collaborator cleanup failed: ${error.message}`, {
        event: 'rundown_stale_collaborator_cleanup_failed',
        error: error.message,
      });
    });
  }
  for (const [planId, editors] of rundownPresence) {
    const fresh = editors.map((editor) => {
      if ((editor.lastSeenAt || editor.joinedAt || 0) < staleThreshold && editor.status === 'active') {
        return {
          ...editor,
          status: 'offline',
          leftAt: editor.leftAt || Date.now(),
        };
      }
      return editor;
    }).filter((editor) => editor.status !== 'active' || (editor.lastSeenAt || editor.joinedAt || 0) >= staleThreshold);
    if (fresh.length === 0) rundownPresence.delete(planId);
    else rundownPresence.set(planId, fresh);
  }
}, 60_000);

const routeCtx = {
  db, queryClient, churches, requireAdmin, requireAdminJwt, requireChurchAppAuth, requireChurchWriteAccess,
  requireChurchOrAdmin, requireReseller, requireFeature, rateLimit,
  getObservedChurch, listObservedChurches, runtimeMirror,
  billing, hashPassword, verifyPassword, normalizeBillingInterval,
  issueChurchAppToken, checkChurchPaidAccess, generateRegistrationCode,
  checkCommandRateLimit, checkBillingAccessForCommand,
  dispatchRemoteCommand: (payload, meta) => dispatchCommandAcrossRuntime(payload, meta),
  sendOnboardingEmail, lifecycleEmails, broadcastToSSE,
  safeErrorMessage, safeSend, queueMessage, messageQueues,
  resellerSystem, planningCenter, streamOAuth, eventMode,
  scheduleEngine, alertEngine, weeklyDigest, sessionRecap, aiTriageEngine,
  monthlyReport, autoPilot, presetLibrary, onCallRotation, rundownEngine, scheduler, signalFailover,
  guestTdMode, chatEngine, pushNotifications, liveRundown, manualRundown,
  logAiUsage, logAudit, isOnTopic, OFF_TOPIC_RESPONSE, runManualDbSnapshot,
  jwt, JWT_SECRET, ADMIN_ROLES, ADMIN_API_KEY, uuidv4,
  CHURCH_APP_TOKEN_TTL, REQUIRE_ACTIVE_BILLING, TRIAL_PERIOD_DAYS,
  BILLING_TIERS, BILLING_STATUSES, QUEUE_TTL_MS, totalMessagesRelayed,
  broadcastToPortal,
  broadcastPublicRundownTimer: (planId, message) => {
    const clients = timerWsClients.get(planId);
    if (!clients?.size) return;
    for (const ws of clients) safeSend(ws, message);
  },
  rundownPresence,
  log,
};
require('./src/routes/churchAuth')(app, routeCtx);
require('./src/routes/adminAuth')(app, routeCtx);
require('./src/routes/billing')(app, routeCtx);
require('./src/routes/adminChurches')(app, routeCtx);
require('./src/routes/sessions')(app, routeCtx);
require('./src/routes/planningCenter')(app, routeCtx);
require('./src/routes/liveRundown')(app, routeCtx);

async function resolvePublicRundownAccess(token) {
  return manualRundown.resolvePublicAccess(token);
}

async function buildPublicTimerStateForPlan(plan) {
  if (!plan) return null;
  const found = liveRundown.findSessionByPlanId(plan.id);
  if (found) {
    return liveRundown.getTimerState(found.churchId, plan.id) || {
      is_live: false,
      plan_id: plan.id,
      plan_title: plan.title,
    };
  }
  const liveState = await manualRundown.getLiveState(plan.id);
  return buildManualPlanTimerState(plan, liveState);
}

// ─── Public rundown data endpoint (no auth) ──────────────────────────────────
// GET /api/public/rundown/:token — returns plan+items for a valid share token
app.get('/api/public/rundown/:token', async (req, res) => {
  try {
    const share = await manualRundown.getShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: 'Link not found or expired' });
    if (share.expiresAt < Date.now()) {
      return res.status(410).json({ error: 'This rundown link has expired' });
    }
    const plan = await manualRundown.getPlan(share.planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const [columns, values, attachments, liveState] = await Promise.all([
      manualRundown.getColumns(plan.id),
      manualRundown.getColumnValues(plan.id),
      manualRundown.getAttachmentsByPlan(plan.id),
      manualRundown.getLiveState(plan.id),
    ]);
    const requestBase = `${req.protocol}://${req.get('host')}`;
    res.json(buildPublicRundownPayload({
      plan,
      share,
      liveState,
      columns,
      values,
      attachments,
      attachmentUrlBuilder: (attachment) => (
        `${requestBase}/api/public/rundown/${encodeURIComponent(share.token)}/attachments/${encodeURIComponent(attachment.id)}`
      ),
    }));
  } catch (e) {
    console.error('[rundown-public] error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

require('./src/routes/streamPlatforms')(app, routeCtx);
require('./src/routes/reseller')(app, routeCtx);
require('./src/routes/automation')(app, routeCtx);
require('./src/routes/scheduler')(app, routeCtx);
require('./src/routes/churchOps')(app, routeCtx);
require('./src/routes/roomEquipment')(app, routeCtx);
require('./src/routes/networkTopology')(app, routeCtx);
require('./src/routes/aiTriage')(app, routeCtx);
require('./src/routes/mobile')(app, routeCtx);
require('./src/routes/clockLayouts')(app, routeCtx);
console.log('[Server] ✓ Route modules registered (including mobile)');

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

  const dbChurch = churches.get(churchId);
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
  if (typeof result !== 'object') return String(result).slice(0, 300);

  try {
    // Format device status objects as human-readable summaries
    return _formatStatusObject(result);
  } catch {
    return 'OK';
  }
}

/** Convert a status/result object into a readable multi-line summary. */
function _formatStatusObject(obj) {
  const lines = [];

  // If it's a full device status object (has atem, obs, etc.)
  if (obj.atem || obj.obs || obj.encoder || obj.mixer || obj.propresenter || obj.system) {
    if (obj.atem) {
      const a = obj.atem;
      lines.push(`ATEM: ${a.connected ? '🟢 Connected' : '🔴 Disconnected'}${a.model ? ` (${a.model})` : ''}`);
      if (a.connected) {
        if (a.ip) lines.push(`  IP: ${a.ip}`);
        if (a.programInput != null) lines.push(`  Program: Input ${a.programInput}${a.previewInput != null ? ` | Preview: Input ${a.previewInput}` : ''}`);
        if (a.streaming != null) lines.push(`  Streaming: ${a.streaming ? 'Yes' : 'No'}${a.recording != null ? ` | Recording: ${a.recording ? 'Yes' : 'No'}` : ''}`);
      }
    }
    if (obj.obs) {
      const o = obj.obs;
      lines.push(`OBS: ${o.connected ? '🟢 Connected' : '🔴 Disconnected'}`);
      if (o.connected) {
        if (o.currentScene) lines.push(`  Scene: ${o.currentScene}`);
        if (o.streaming != null) lines.push(`  Streaming: ${o.streaming ? 'Yes' : 'No'}${o.recording != null ? ` | Recording: ${o.recording ? 'Yes' : 'No'}` : ''}`);
        if (o.fps) lines.push(`  FPS: ${o.fps}${o.bitrate ? ` | Bitrate: ${o.bitrate} kbps` : ''}`);
      }
    }
    if (obj.encoder) {
      const e = obj.encoder;
      lines.push(`Encoder: ${e.connected ? '🟢 Connected' : '🔴 Disconnected'}${e.type ? ` (${e.type})` : ''}`);
      if (e.connected && e.streaming != null) lines.push(`  Streaming: ${e.streaming ? 'Yes' : 'No'}${e.bitrateKbps ? ` | ${e.bitrateKbps} kbps` : ''}`);
    }
    if (obj.mixer) {
      const m = obj.mixer;
      lines.push(`Mixer: ${m.connected ? '🟢 Connected' : '🔴 Disconnected'}${m.model ? ` (${m.model})` : ''}`);
    }
    if (obj.propresenter) {
      const p = obj.propresenter;
      lines.push(`ProPresenter: ${p.connected ? '🟢 Connected' : '🔴 Disconnected'}`);
      if (p.connected && p.currentSlide) lines.push(`  Slide: ${p.currentSlide}`);
    }
    if (obj.hyperdeck) {
      const h = obj.hyperdeck;
      lines.push(`HyperDeck: ${h.connected ? '🟢 Connected' : '🔴 Disconnected'}${h.recording ? ' (Recording)' : ''}`);
    }
    if (obj.system) {
      const s = obj.system;
      const cpu = typeof s.cpu === 'object' ? s.cpu?.usage : s.cpu;
      const mem = typeof s.memory === 'object' ? s.memory?.usage : s.memory;
      const disk = typeof s.disk === 'object' ? s.disk?.usage : s.disk;
      if (cpu != null || mem != null) {
        lines.push(`System: CPU ${cpu != null ? cpu + '%' : '--'} | RAM ${mem != null ? mem + '%' : '--'} | Disk ${disk != null ? disk + '%' : '--'}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : 'OK';
  }

  // For pre-service check results
  if (obj.checks && Array.isArray(obj.checks)) {
    const checkLines = obj.checks.map(c => `${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail || ''}`);
    const summary = obj.pass ? '🟢 All systems go!' : '⚠️ Issues detected';
    return `${summary}\n${checkLines.join('\n')}`;
  }

  // Generic: flatten key-value pairs
  const kvLines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      kvLines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      kvLines.push(`${key}: ${value}`);
    }
  }
  return kvLines.length > 0 ? kvLines.join('\n').slice(0, 500) : 'OK';
}

// ─── DIAGNOSTIC AI (Sonnet) — deep troubleshooting + question answering ──────
// Commands stay on Haiku (lean context). Diagnostics go to Sonnet (full context).

const DIAGNOSTIC_MODEL = 'claude-sonnet-4-6';
const DIAGNOSTIC_TIMEOUT = 25000; // Sonnet is slower — 25s acceptable for diagnostics

async function callDiagnosticAI(churchId, question, roomCtx = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 'AI is not configured (ANTHROPIC_API_KEY missing).';

  // Build Tier 2 (diagnostic) context via tally-context.js
  const church = churches.get(churchId);
  const diagnosticContextBlock = buildContext(church?.status || {}, 'diagnostic', {
    churchId,
    churchName: roomCtx.churchName || church?.name || '',
    roomId: roomCtx.roomId || '',
    roomName: roomCtx.roomName || '',
    db,
    churches,
    signalFailover,
    planningCenter,
  });

  const conversationHistory = await chatEngine.getRecentConversation(churchId);

  // Use unified diagnostic prompt from tally-engineer.js + full diagnostic context
  const systemPrompt = buildDiagnosticPrompt()
    + '\n\n── DIAGNOSTIC CONTEXT ──\n' + diagnosticContextBlock;

  const userContent = diagnosticContextBlock
    ? question
    : question; // context is in system prompt, not user message

  const startMs = Date.now();

  try {
    console.log(`[DiagnosticAI] Calling Sonnet for ${churchId} (church="${roomCtx.churchName}" room="${roomCtx.roomName || roomCtx.roomId || 'none'}"): "${question.slice(0, 60)}"`);
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: DIAGNOSTIC_MODEL,
        system: systemPrompt,
        messages: [
          ...(Array.isArray(conversationHistory) ? conversationHistory : []),
          { role: 'user', content: userContent },
        ],
        temperature: 0.4,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT),
    });

    const latencyMs = Date.now() - startMs;

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error(`[DiagnosticAI] Anthropic error: ${aiRes.status} ${errBody.slice(0, 200)}`);
      // Fallback to Haiku if Sonnet fails
      console.log('[DiagnosticAI] Falling back to Haiku...');
      return _callHaikuDiagnosticFallback(churchId, question, conversationHistory);
    }

    const data = await aiRes.json();
    const reply = data?.content?.[0]?.text || 'No response.';

    if (data?.usage) {
      logAiUsage({
        churchId,
        feature: 'diagnostic_chat',
        model: DIAGNOSTIC_MODEL,
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
        latencyMs,
        intent: 'diagnostic',
      });
    }

    console.log(`[DiagnosticAI] Sonnet responded in ${latencyMs}ms (${(data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0)} tokens)`);
    logAiChatInteraction({ churchId, roomId: roomCtx.roomId, source: 'diagnostic', userMessage: question, aiResponse: reply, intent: 'diagnostic', model: DIAGNOSTIC_MODEL, latencyMs });
    return reply;
  } catch (err) {
    console.error(`[DiagnosticAI] Error: ${err.message}`);
    // Fallback to Haiku on timeout or other errors
    console.log('[DiagnosticAI] Falling back to Haiku...');
    return _callHaikuDiagnosticFallback(churchId, question, conversationHistory);
  }
}

/** Haiku fallback when Sonnet is unavailable — best-effort diagnostic with lean context */
async function _callHaikuDiagnosticFallback(churchId, question, conversationHistory) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 'AI is not configured.';

  const church = churches.get(churchId);
  const statusContext = church?.status ? JSON.stringify(church.status) : '{}';

  const startMs = Date.now();
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
        system: ENGINEER_SYSTEM_PROMPT + '\n\nCurrent church status: ' + statusContext,
        messages: [
          ...(Array.isArray(conversationHistory) ? conversationHistory : []),
          { role: 'user', content: question },
        ],
        temperature: 0.4,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const latencyMs = Date.now() - startMs;

    if (!aiRes.ok) return 'Sorry, I could not process that question right now. Try again in a moment.';

    const data = await aiRes.json();
    const reply = data?.content?.[0]?.text || 'No response.';

    if (data?.usage) {
      logAiUsage({
        churchId,
        feature: 'diagnostic_chat_fallback',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
        latencyMs,
        intent: 'diagnostic',
      });
    }

    return reply;
  } catch (err) {
    console.error(`[DiagnosticAI/Fallback] Error: ${err.message}`);
    return 'Sorry, I could not process that question right now. Try again in a moment.';
  }
}

function postSystemChatMessage(churchId, message, roomId) {
  chatEngine.saveMessage({
    churchId,
    senderName: 'Tally',
    senderRole: 'system',
    source: 'system',
    message,
    roomId: roomId || null,
  }).then((saved) => {
    chatEngine.broadcastChat(saved);
  }).catch((e) => {
    console.error('[ChatEngine] System message save failed:', e.message);
  });
}

async function executeChurchCommandWithResult(churchId, command, params = {}, roomId) {
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
    const sendCommand = makeCommandSender(church, roomId);
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

async function handleChatCommandMessage(churchId, rawMessage, attachment, roomId, source) {
  // If there's an attachment or a setup intent, route through the setup assistant
  if (attachment?.data || detectSetupIntent(rawMessage)) {
    return handleSetupRequest(churchId, rawMessage, attachment);
  }

  const lowerMsg = (rawMessage || '').toLowerCase().trim();

  // ─── Sensitive data guard (stream keys, passwords, etc.) ─────────────────
  if (containsSensitiveData(rawMessage)) {
    postSystemChatMessage(churchId, SENSITIVE_RESPONSE, roomId);
    return;
  }

  // ─── "Remember this" handler ─────────────────────────────────────────────
  if (/^(remember|note|save note|don't forget|tally remember)\b/i.test(lowerMsg)) {
    const noteText = rawMessage.replace(/^(remember|note|save note|don't forget|tally remember)\s*/i, '').trim();
    if (noteText.length < 5) {
      postSystemChatMessage(churchId, 'What should I remember? Example: "Remember the pastor likes a tight shot during prayer"');
      return;
    }
    await churchMemory.saveUserNote(churchId, noteText);
    postSystemChatMessage(churchId, "Got it — I'll remember that.");
    return;
  }

  // ─── "What do you remember?" handler ─────────────────────────────────────
  if (/^(what do you remember|what do you know|show notes|list notes|my notes)/i.test(lowerMsg)) {
    const notes = await churchMemory.getUserNotes(churchId);
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
    const notes = await churchMemory.getUserNotes(churchId);
    if (idx >= 0 && idx < notes.length) {
      const archived = await churchMemory.archiveMemory(churchId, notes[idx].id);
      if (archived) {
        postSystemChatMessage(churchId, `Forgot: "${notes[idx].summary}"`);
      } else {
        postSystemChatMessage(churchId, 'I could not forget that note right now. Please try again.');
      }
    } else {
      postSystemChatMessage(churchId, 'Note number not found. Say "what do you remember" to see the list.');
    }
    return;
  }

  // ─── "What happened last week?" handler ──────────────────────────────────
  if (/^(what happened|last (week|service|sunday)|previous (session|service)|recap|how did (last|this) week go|session history)/i.test(lowerMsg)) {
    const sessions = await queryClient.query(
      'SELECT * FROM service_sessions WHERE church_id = ? AND ended_at IS NOT NULL AND (session_type IS NULL OR session_type != \'test\') ORDER BY started_at DESC LIMIT 4',
      [churchId],
    );

    if (!sessions.length) {
      postSystemChatMessage(churchId, 'No recent service sessions on record yet.');
      return;
    }

    const churchRow = await queryClient.queryOne('SELECT name FROM churches WHERE churchId = ?', [churchId]);
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
          const events = await queryClient.query(
            'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT 5',
            [s.id],
          );
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
      const docs = await churchDocuments.listDocuments(churchId);
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

  // ─── Resolve church + roomId early so both diagnostic and command paths have context ──
  const church = churches.get(churchId);
  // Auto-detect roomId if not in request: check roomInstanceMap, then DB single-room
  if (!roomId && church?.roomInstanceMap) {
    const roomEntries = Object.entries(church.roomInstanceMap);
    if (roomEntries.length === 1) roomId = roomEntries[0][0];
  }
  if (!roomId) {
    try {
      const singleRoom = await queryClient.query(
        'SELECT id FROM rooms WHERE campus_id = ? AND deleted_at IS NULL LIMIT 2',
        [churchId],
      );
      if (singleRoom.length === 1) roomId = singleRoom[0].id;
    } catch { /* non-fatal */ }
  }
  let resolvedRoomName = '';
  if (roomId) {
    try {
      const roomRow = await queryClient.queryOne(
        'SELECT name FROM rooms WHERE id = ? AND campus_id = ? AND deleted_at IS NULL',
        [roomId, churchId],
      );
      resolvedRoomName = roomRow?.name || '';
    } catch { /* non-fatal */ }
  }

  const churchRow = await loadChurchById(churchId);

  // ─── Intent classification: route diagnostics to Sonnet, commands to Haiku ──
  const classification = classifyIntent(rawMessage);
  console.log(`[Router] "${rawMessage.slice(0, 50)}" → ${classification.intent} (${classification.confidence}, ${classification.reason})`);

  if (classification.intent === 'diagnostic') {
    // Category 2: Monthly Sonnet diagnostic limit
    const tier_d = churchRow?.billing_tier || 'connect';
    const limitCheck = await aiRateLimiter.checkDiagnosticLimit(churchId, tier_d);

    if (!limitCheck.allowed) {
      const resetStr = limitCheck.resetDate || '1st of next month';
      postSystemChatMessage(churchId, `You've used ${limitCheck.usage}/${limitCheck.limit} AI diagnostic messages this month. Resets ${resetStr}.\n\nDirect commands like "cam 2" and "status" are always available.`, roomId);
      return;
    }

    if (limitCheck.warning80) {
      postSystemChatMessage(churchId, `📊 AI Usage: ${limitCheck.usage}/${limitCheck.limit} diagnostic messages used this month. Upgrade for more → Settings > Billing`, roomId);
    }

    const reply = await callDiagnosticAI(churchId, rawMessage, { churchName: church?.name || '', roomId: roomId || '', roomName: resolvedRoomName });
    postSystemChatMessage(churchId, reply, roomId);
    return;
  }

  // ── Ambiguous intent: route directly to Sonnet (skip Haiku→fail→Sonnet double-hop) ──
  if (classification.intent === 'ambiguous') {
    const tier_a = churchRow?.billing_tier || 'connect';
    const limitCheck_a = await aiRateLimiter.checkDiagnosticLimit(churchId, tier_a);

    if (limitCheck_a.allowed) {
      console.log(`[Router] Ambiguous → direct Sonnet for: "${rawMessage.slice(0, 50)}"`);
      const reply = await callDiagnosticAI(churchId, rawMessage, { churchName: church?.name || '', roomId: roomId || '', roomName: resolvedRoomName });
      postSystemChatMessage(churchId, reply, roomId);

      if (limitCheck_a.warning80) {
        postSystemChatMessage(churchId, `📊 AI Usage: ${limitCheck_a.usage}/${limitCheck_a.limit} this month. Upgrade for more → Settings > Billing`, roomId);
      }
      return;
    }
    // Over diagnostic limit — fall through to Haiku command parser as best effort
    console.log(`[Router] Ambiguous but over diagnostic limit — falling through to Haiku for: "${rawMessage.slice(0, 50)}"`);
  }

  // Resolve room-specific status: if roomId is provided and we have per-room status, use it
  const roomStatus = (roomId && church?.instanceStatus)
    ? (church.instanceStatus[church.roomInstanceMap?.[roomId]] || church?.status)
    : church?.status;
  const intent = parseChatCommandIntent(rawMessage, roomStatus);
  if (!intent) return;

  if (intent.type === 'invalid') {
    postSystemChatMessage(churchId, `⚠️ ${intent.reason}`, roomId);
    return;
  }

  if (intent.type === 'chat_reply') {
    postSystemChatMessage(churchId, intent.text, roomId);
    return;
  }

  // ─── Stream guard: skip if force-confirmed or has force bypass ──────────
  const streamGuardBypassed = intent.forceConfirmed || hasForceBypass(rawMessage);

  if (intent.type === 'commands' && Array.isArray(intent.steps) && intent.steps.length > 0) {
    if (!streamGuardBypassed) {
      const wfSafety = checkWorkflowSafety(intent.steps, roomStatus || {});
      if (wfSafety) {
        postSystemChatMessage(churchId, `${wfSafety.warning}\n\nTo confirm, resend: confirm: ${rawMessage}`, roomId);
        return;
      }
    }
    for (const step of intent.steps) {
      if (!step?.command) continue;
      if (step.command === 'system.wait') {
        const seconds = Math.min(Math.max(Number(step.params?.seconds) || 1, 0.5), 30);
        postSystemChatMessage(churchId, `⏳ Waiting ${seconds}s...`, roomId);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        continue;
      }
      const executed = await executeChurchCommandWithResult(churchId, step.command, step.params || {}, roomId);
      if (!executed.ok) {
        postSystemChatMessage(churchId, `❌ ${friendlyError(step.command, executed.error)}`, roomId);
        return;
      }
      postSystemChatMessage(churchId, `✅ ${step.command} ${formatResultForChat(executed.result)}`, roomId);
    }
    return;
  }

  if (intent.type === 'command') {
    const { command, params } = intent.parsed;
    if (!streamGuardBypassed) {
      const safety = checkStreamSafety(command, params, roomStatus || {});
      if (safety) {
        postSystemChatMessage(churchId, `${safety.warning}\n\nTo confirm, resend: confirm: ${rawMessage}`, roomId);
        return;
      }
    }
    const executed = await executeChurchCommandWithResult(churchId, command, params || {}, roomId);
    if (!executed.ok) {
      postSystemChatMessage(churchId, `❌ ${command} failed: ${executed.error}`, roomId);
      return;
    }
    postSystemChatMessage(churchId, `✅ ${command} ${formatResultForChat(executed.result)}`, roomId);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    postSystemChatMessage(churchId, '❌ AI command parsing is not configured (ANTHROPIC_API_KEY missing).', roomId);
    return;
  }

  const conversationHistory = await chatEngine.getRecentConversation(churchId, { roomId });
  let engineerProfile = {};
  try { engineerProfile = JSON.parse(churchRow?.engineer_profile || '{}'); } catch {}
  // Inject document context if knowledge base is active
  const docContext = (typeof churchDocuments !== 'undefined' && churchDocuments)
    ? await churchDocuments.getDocumentContext(churchId, intent.prompt)
    : '';
  // Build diagnostic context for Sonnet (only used if question is diagnostic)
  let diagnosticCtx = '';
  let incidentChainCtx = '';
  try {
    diagnosticCtx = await require('./src/diagnostic-context').buildDiagnosticContext(churchId, db, churches, signalFailover);
    incidentChainCtx = await _getIncidentChains(churchId);
  } catch {}

  // Look up configured devices for this room so AI only reports on real equipment
  let configuredDevices = [];
  try {
    // Try room-specific equipment first, then fall back to any room for this church
    const eqRow = roomId
      ? await queryClient.queryOne('SELECT equipment FROM room_equipment WHERE room_id = ?', [roomId])
      : await queryClient.queryOne('SELECT equipment FROM room_equipment WHERE church_id = ? LIMIT 1', [churchId]);
    if (eqRow?.equipment) {
      const equipment = JSON.parse(eqRow.equipment);
      configuredDevices = getConfiguredDeviceTypes(equipment);
    }
  } catch { /* non-fatal — AI will work without it */ }

  // Fetch recent alerts so AI can see active/recent issues
  let recentAlerts = [];
  try {
    recentAlerts = await queryClient.query(
      `SELECT alert_type, severity, acknowledged_at, resolved
       FROM alerts WHERE church_id = ? ORDER BY created_at DESC LIMIT 5`
      , [churchId]);
  } catch { /* alerts table may not exist */ }

  // Compute health score for situational awareness
  let healthScore = null;
  try {
    const { computeHealthScore } = require('./src/healthScore');
    if (db && typeof db.prepare === 'function') {
      const hs = computeHealthScore(db, churchId, 7);
      healthScore = hs?.score ?? null;
    }
  } catch { /* non-fatal */ }

  // Get signal failover state
  let failoverState = null;
  try {
    if (signalFailover) {
      const state = signalFailover.getState(churchId);
      if (state?.state) failoverState = state.state;
    }
  } catch { /* non-fatal */ }

  const aiResult = await aiParseCommand(intent.prompt, {
    churchId,
    churchName: church?.name || '',
    roomId: roomId || '',
    roomName: resolvedRoomName,
    status: roomStatus || {},
    tier: churchRow?.billing_tier || 'connect',
    engineerProfile,
    memorySummary: churchRow?.memory_summary || '',
    documentContext: docContext,
    diagnosticContext: diagnosticCtx,
    incidentChains: incidentChainCtx,
    configuredDevices,
    recentAlerts,
    healthScore,
    failoverState,
    planningCenter,
  }, conversationHistory);

  {
    const aiResponseText = aiResult.type === 'chat' ? aiResult.text
      : aiResult.type === 'command' ? `[command] ${aiResult.command} ${JSON.stringify(aiResult.params || {})}`
      : aiResult.type === 'commands' ? `[commands] ${(aiResult.steps || []).map((s) => s.command).join(', ')}`
      : aiResult.type === 'error' ? `[error] ${aiResult.message || ''}`
      : aiResult.type === 'rate_limited' ? '[rate_limited]'
      : '[unknown]';
    logAiChatInteraction({
      churchId,
      roomId,
      source: source || 'portal',
      userMessage: rawMessage,
      aiResponse: aiResponseText,
      intent: classification.intent,
      model: 'claude-haiku-4-5-20251001',
    });
  }

  if (aiResult.type === 'error' || aiResult.type === 'rate_limited') {
    // Before giving up, try the regex + smart parsers one more time on the raw message
    // (they may not have matched earlier due to intent classification routing)
    const retryParsed = parseCommand(rawMessage);
    if (retryParsed) {
      const executed = await executeChurchCommandWithResult(churchId, retryParsed.command, retryParsed.params || {}, roomId);
      if (executed.ok) {
        postSystemChatMessage(churchId, `✅ ${retryParsed.command} ${formatResultForChat(executed.result)}`, roomId);
      } else {
        postSystemChatMessage(churchId, `❌ ${friendlyError(retryParsed.command, executed.error)}`, roomId);
      }
      return;
    }
    const retrySmartResult = smartParse(rawMessage, roomStatus || {});
    if (retrySmartResult && retrySmartResult.type !== 'chat') {
      const retrySteps = retrySmartResult.type === 'commands' ? retrySmartResult.steps : [{ command: retrySmartResult.command, params: retrySmartResult.params }];
      for (const step of retrySteps) {
        if (!step?.command) continue;
        const executed = await executeChurchCommandWithResult(churchId, step.command, step.params || {}, roomId);
        if (!executed.ok) {
          postSystemChatMessage(churchId, `❌ ${friendlyError(step.command, executed.error)}`, roomId);
          return;
        }
        postSystemChatMessage(churchId, `✅ ${step.command} ${formatResultForChat(executed.result)}`, roomId);
      }
      return;
    }

    // Genuinely could not parse — give a helpful message
    const isRateLimit = aiResult.type === 'rate_limited';
    const msg = isRateLimit
      ? (aiResult.text || 'AI is at capacity right now. I understood your message but couldn\'t process it — try again in a moment, or use a direct command like "cam 2" or "status".')
      : 'I\'m having trouble connecting to the AI right now. Try again in a moment, or I can handle direct commands like "cam 2", "status", or "start stream".';
    postSystemChatMessage(churchId, msg, roomId);
    aiRateLimiter.logEvent(churchId, 'command', isRateLimit ? 'limit_hit' : 'api_failure_fallback', aiResult.message || '');
    return;
  }

  if (aiResult.type === 'chat') {
    // Ambiguous intent is now handled upstream (direct Sonnet routing).
    // If we reach here, it's Haiku's chat response for non-ambiguous intent, or
    // ambiguous that fell through due to diagnostic rate limit.
    postSystemChatMessage(churchId, aiResult.text || 'I could not map that to a command.', roomId);
    return;
  }

  const steps = aiResult.type === 'commands'
    ? (Array.isArray(aiResult.steps) ? aiResult.steps : [])
    : [{ command: aiResult.command, params: aiResult.params || {} }];

  if (!steps.length) {
    postSystemChatMessage(churchId, '⚠️ AI parser returned no executable command.', roomId);
    return;
  }

  // Stream guard for AI-parsed commands
  if (!streamGuardBypassed) {
    const wfSafety = checkWorkflowSafety(steps, roomStatus || {});
    if (wfSafety) {
      postSystemChatMessage(churchId, `${wfSafety.warning}\n\nTo confirm, resend: confirm: ${rawMessage}`, roomId);
      return;
    }
  }

  for (const step of steps) {
    if (!step?.command) continue;

    // Handle system.wait pseudo-command (delay between steps)
    if (step.command === 'system.wait') {
      const seconds = Math.min(Math.max(Number(step.params?.seconds) || 1, 0.5), 30);
      postSystemChatMessage(churchId, `⏳ Waiting ${seconds}s...`, roomId);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      continue;
    }

    const executed = await executeChurchCommandWithResult(churchId, step.command, step.params || {}, roomId);
    await churchMemory.recordCommandOutcome(churchId, step.command, executed.ok, 'user_request');
    if (!executed.ok) {
      postSystemChatMessage(churchId, `❌ ${friendlyError(step.command, executed.error)}`, roomId);
      return;
    }
    // Contextual confirmation: template-based, zero LLM cost
    const contextual = buildCommandConfirmation(step.command, step.params || {}, executed.result, roomStatus || {});
    postSystemChatMessage(churchId, contextual ? `✅ ${contextual}` : `✅ ${step.command} ${formatResultForChat(executed.result)}`, roomId);
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
    sameSite: 'Strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_SESSION_TTL_MS,
  });
}

app.get(['/dashboard', '/dashboard/*'], (req, res) => {
  res.redirect(302, '/admin');
});

// SPA fallback: serve index.html for any /admin/* route that isn't a static file
app.get('/admin/*', (req, res) => {
  const indexPath = require('path').join(__dirname, 'public/admin/index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Admin UI not built. Run: cd admin && npm run build');
  }
});

// ─── SSE Dashboard Stream ─────────────────────────────────────────────────────

app.get('/api/dashboard/stream', async (req, res) => {
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ error: 'Maximum SSE connections reached' });
  }

  const key         = resolveAdminKey(req);
  const resellerKey = req.query.resellerKey || req.headers['x-reseller-key'];
  const jwtToken    = req.query.token || '';

  let filterResellerId = null;

  if (resellerKey) {
    // Reseller portal access — validate reseller key and filter to their churches
    const reseller = resellerSystem.getReseller(resellerKey);
    if (!reseller) return res.status(403).json({ error: 'Invalid reseller key' });
    filterResellerId = reseller.id;
  } else if (safeCompareKey(key, ADMIN_API_KEY)) {
    // Admin API key — full access
  } else if (jwtToken) {
    // JWT token auth (admin SPA sends token as query param since EventSource can't set headers)
    try {
      const payload = jwt.verify(jwtToken, JWT_SECRET);
      if (payload.type !== 'admin') return res.status(401).json({ error: 'Invalid token type' });
      const user = await queryClient.queryOne(
        'SELECT id, active FROM admin_users WHERE id = ?',
        [payload.userId],
      );
      if (!user || !user.active) return res.status(401).json({ error: 'Account deactivated' });
    } catch (e) {
      return res.status(401).json({ error: e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' });
    }
  } else {
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
  const allChurches = listObservedChurches();
  const filtered = filterResellerId
    ? allChurches.filter(c => c.reseller_id === filterResellerId)
    : allChurches;

  const initialState = filtered.map(buildDashboardChurchState);
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
  const states = listObservedChurches().map(buildDashboardChurchState);
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

// Build the WebSocket routing handlers from the factory so the logic is
// importable and testable independently of the full server bootstrap.
const _deltaTracker = createDeltaTracker();
const _wsHandlers = createWebSocketHandlers({
  churches,
  controllers,
  jwt,
  jwtSecret: JWT_SECRET,
  wsOpen: WebSocket.OPEN,
  deltaTracker: _deltaTracker,
  // Inject the hoisted function declarations — they must stay as hoisted
  // `function` declarations because they're referenced at line ~2176 before
  // this factory call runs.
  safeSend,
  broadcastToControllers,
  checkPaidAccess: checkChurchPaidAccess,
  safeCompareKey,
  adminApiKey: ADMIN_API_KEY,
  wsConnectionsByIp,
  maxConnectionsPerIp: MAX_WS_CONNECTIONS_PER_IP,
  maxControllers: MAX_CONTROLLERS,
  drainQueue,
  checkCommandRateLimit,
  broadcastToSSE,
  broadcastToPortal,
  streamOAuth,
  getChurchList: buildControllerChurchList,
  sendRemoteCommand: (msg, meta) => publishRemoteCommand(msg, meta),
  validateRoomId: (roomId, churchId) => {
    const rooms = roomRegistry.get(churchId);
    return !!(rooms && rooms.has(roomId));
  },
  onChurchConnected(church, ws, connectedEvent) {
    runtimeMetrics.record('church.connect');
    // Onboarding milestone: first app connection
    if (!church._onboardingAppTracked && !church._onboardingAppTracking) {
      church._onboardingAppTracking = true;
      (async () => {
        try {
          const dbRow = await queryClient.queryOne(
            'SELECT onboarding_app_connected_at, portal_email, registration_code FROM churches WHERE churchId = ?',
            [church.churchId],
          );
          if (dbRow && !dbRow.onboarding_app_connected_at) {
            const now = new Date().toISOString();
            await queryClient.run(
              'UPDATE churches SET onboarding_app_connected_at = ? WHERE churchId = ?',
              [now, church.churchId],
            );
            log(`[onboarding] First app connection for "${church.name}"`);
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
          if (dbRow) church._onboardingAppTracked = true;
        } catch (e) {
          log(`[onboarding] Milestone tracking error: ${e.message}`);
        } finally {
          church._onboardingAppTracking = false;
        }
      })();
    }
    // Branding for reseller churches
    loadChurchById(church.churchId).then((dbChurchRow) => {
      if (dbChurchRow && dbChurchRow.reseller_id) {
        const branding = resellerSystem.getBranding(dbChurchRow.reseller_id);
        if (branding && branding.brandName) {
          safeSend(ws, { type: 'branding', ...branding });
          log(`Branding sent to "${church.name}" via reseller "${branding.brandName}"`);
        }
      }
    }).catch((e) => {
      console.error('[branding] lookup error:', e.message);
    });
    broadcastToPortal(church.churchId, { type: 'connected', status: church.status, lastSeen: church.lastSeen, instanceStatus: church.instanceStatus, roomInstanceMap: church.roomInstanceMap });
    _mobileWsHandler.sendConnectionChange(church, null, true);
    aiTriageEngine.recordReconnection(church.churchId);
    Promise.resolve(runtimeCoordinator.recordChurchPresence(church, {
      instance: ws?._churchInstance || 'primary',
      connected: true,
      statusMode: 'full',
    })).catch((e) => {
      console.warn(`[runtimeCoordination] church connect presence error: ${e.message}`);
    });
    Promise.resolve(runtimeCoordinator.publishEvent('church_connected', {
      churchId: church.churchId,
      name: church.name,
      instance: ws?._churchInstance || 'primary',
      church: serializeRuntimeChurchSnapshot(church),
      event: connectedEvent,
    })).catch(() => {});
    log(`Church "${church.name}" connected`, { event: 'church_connect', churchId: church.churchId, church: church.name });
    // (WS-level ping interval is managed by the factory via wsPingIntervalMs)
  },
  onChurchDisconnected(church, disconnectEvent) {
    runtimeMetrics.record('church.disconnect');
    _mobileWsHandler.sendConnectionChange(church, null, false);
    Promise.resolve(runtimeCoordinator.clearChurchPresence(
      church.churchId,
      disconnectEvent?.instance || 'primary',
    )).catch(() => {});
    Promise.resolve(runtimeCoordinator.publishEvent('church_disconnected', {
      churchId: church.churchId,
      name: church.name,
      church: serializeRuntimeChurchSnapshot(church),
      event: disconnectEvent,
    })).catch(() => {});
    log(`Church "${church.name}" disconnected`, { event: 'church_disconnect', churchId: church.churchId, church: church.name });
  },
  onInstanceDisconnected(church, instanceDisconnectEvent) {
    Promise.resolve(runtimeCoordinator.clearChurchPresence(
      church.churchId,
      instanceDisconnectEvent?.instance || 'primary',
    )).catch(() => {});
    Promise.resolve(runtimeCoordinator.publishEvent('instance_disconnected', {
      churchId: church.churchId,
      name: church.name,
      church: serializeRuntimeChurchSnapshot(church),
      event: instanceDisconnectEvent,
    })).catch(() => {});
  },
  onStatusUpdate(church, msg, statusEvent) {
    runtimeMetrics.record('church.status_update.in');
    runtimeMetrics.record(`church.status_update.mode.${msg.statusMode || 'full'}`);
    if (msg.statusMode === 'delta') {
      runtimeMetrics.recordBytes('church.status_update.delta', Buffer.byteLength(JSON.stringify(msg.statusDelta || {})));
    } else {
      runtimeMetrics.recordBytes('church.status_update.full', Buffer.byteLength(JSON.stringify(msg.status || {})));
    }
    // Onboarding milestone: first ATEM connection
    if (msg.status?.atem?.connected && !church._onboardingAtemTracked && !church._onboardingAtemTracking) {
      church._onboardingAtemTracking = true;
      (async () => {
        try {
          const row = await queryClient.queryOne(
            'SELECT onboarding_atem_connected_at FROM churches WHERE churchId = ?',
            [church.churchId],
          );
          if (row && !row.onboarding_atem_connected_at) {
            await queryClient.run(
              'UPDATE churches SET onboarding_atem_connected_at = ? WHERE churchId = ?',
              [new Date().toISOString(), church.churchId],
            );
            log(`[onboarding] First ATEM connection for "${church.name}"`);
          }
          if (row) church._onboardingAtemTracked = true;
        } catch (e) {
          log(`[onboarding] ATEM milestone error: ${e.message}`);
        } finally {
          church._onboardingAtemTracking = false;
        }
      })();
    }
    // Auto-sync audio_via_atem from client-side detection
    if (msg.status?.audioViaAtemSource === 'auto' && !church._audioViaAtemManualOverride) {
      const newVal = msg.status.audioViaAtem ? 1 : 0;
      if (church.audio_via_atem !== newVal) {
        church.audio_via_atem = newVal;
        queryClient.run('UPDATE churches SET audio_via_atem = ? WHERE churchId = ?', [newVal, church.churchId])
          .catch((e) => { log(`[audio_via_atem] auto-sync DB error: ${e.message}`); });
      }
    }
    // Sync booth computer timezone
    if (msg.status?.system?.timezone && church.timezone !== msg.status.system.timezone) {
      church.timezone = msg.status.system.timezone;
      queryClient.run('UPDATE churches SET timezone = ? WHERE churchId = ?', [church.timezone, church.churchId])
        .catch((e) => { log(`[timezone] sync DB error: ${e.message}`); });
    }
    // Room assignment is managed exclusively via the /api/church/app/room-assign
    // endpoint.  Status-driven sync was removed to prevent flip-flopping when
    // multiple instances report different roomIds (C2/I2 architecture fix).
    _checkDeviceVersions(church, msg.status);
    scheduler.onEquipmentStateChange(church.churchId, church.status)
      .catch(e => console.error('[Scheduler] Equipment state change error:', e.message));
    // Feed session recap with live stream/recording state
    if (msg.status) {
      if (hasStreamSignal(msg.status)) {
        Promise.resolve(sessionRecap.recordStreamStatus(church.churchId, isStreamActive(msg.status)))
          .catch(e => console.error('[SessionRecap] Stream status error:', e.message));
      }
      if (msg.status.obs?.viewers !== undefined) {
        Promise.resolve(sessionRecap.recordPeakViewers(church.churchId, msg.status.obs.viewers))
          .catch(e => console.error('[SessionRecap] Peak viewers error:', e.message));
      }
      if (isRecordingActive(msg.status)) {
        Promise.resolve(sessionRecap.recordRecordingConfirmed(church.churchId))
          .catch(e => console.error('[SessionRecap] Recording confirm error:', e.message));
      }
    }
    signalFailover.onStatusUpdate(church.churchId, church.status, statusEvent?.instance || null);
    // Send delta updates to mobile WebSocket clients
    _mobileWsHandler.sendStatusUpdate(church);
    Promise.resolve(runtimeCoordinator.recordChurchPresence(church, {
      instance: statusEvent?.instance || 'primary',
      connected: true,
      statusMode: msg.statusMode || 'full',
    })).catch(() => {});
    Promise.resolve(runtimeCoordinator.publishEvent('church_status', {
      churchId: church.churchId,
      instance: statusEvent?.instance || null,
      statusMode: msg.statusMode || 'full',
      church: serializeRuntimeChurchSnapshot(church),
      event: statusEvent,
    })).catch(() => {});
    totalMessagesRelayed++;
  },
  onStatusNoop(_church, msg) {
    runtimeMetrics.record('church.status_update.noop');
    runtimeMetrics.record(`church.status_update.noop.${msg.statusMode || 'full'}`);
  },
  onAlert(church, msg, alertEvent) {
    runtimeMetrics.record('church.alert.in');
    if (msg.alertType) {
      // Extract instance/room context from the resolved alertEvent
      const alertInstanceName = alertEvent?.instance || null;
      const alertRoomId = alertEvent?.roomId || null;

      if (msg.alertType === 'audio_silence') {
        Promise.resolve(sessionRecap.recordAudioSilence(church.churchId))
          .catch(e => console.error('[SessionRecap] Audio silence error:', e.message));
      }
      // Forward alert to mobile WebSocket clients
      _mobileWsHandler.sendAlertToMobile(church.churchId, {
        alertType: msg.alertType,
        severity: alertEngine.classifyAlert(msg.alertType),
        context: { message: msg.message, _instanceName: alertInstanceName, _roomId: alertRoomId },
        diagnosis: alertEngine.getDiagnosis(msg.alertType),
        timestamp: Date.now(),
      });
      // Forward encoder disconnect to SignalFailover so it can evaluate failover
      // (watchdog alerts bypass signal_event path — bridge the gap here)
      if (msg.alertType === 'encoder_disconnected') {
        signalFailover.onSignalEvent(church.churchId, 'encoder_disconnected', { church, instanceName: alertInstanceName, roomId: alertRoomId });
      }
      Promise.resolve(runtimeCoordinator.publishEvent('church_alert', {
        churchId: church.churchId,
        name: church.name,
        church: serializeRuntimeChurchSnapshot(church),
        event: {
          ...alertEvent,
          alertType: msg.alertType,
          alertId: alertEvent?.alertId || null,
        },
      })).catch(() => {});
      recordAlertForChaining(church.churchId, msg.alertType);
      (async () => {
        try {
          const activeSessionId = sessionRecap.getActiveSessionId(church.churchId);
          const eventId = await weeklyDigest.addEvent(church.churchId, msg.alertType, msg.message, activeSessionId);
          const recovery = await autoRecovery.attempt(church, msg.alertType, church.status);
          if (recovery.attempted && recovery.success) {
            await weeklyDigest.resolveEvent(eventId, true);
            await sessionRecap.recordAlert(church.churchId, msg.alertType, true, false);
            if (recovery.command) await churchMemory.recordCommandOutcome(church.churchId, recovery.command, true, msg.alertType);
            log(`[AutoRecovery] ✅ ${recovery.event} for ${church.name}`);
          } else {
            if (recovery.attempted && recovery.command) await churchMemory.recordCommandOutcome(church.churchId, recovery.command, false, msg.alertType);
            const dbChurch = await loadChurchById(church.churchId);
            const recoveryInfo = recovery.attempted ? recovery : null;
            const alertResult = await alertEngine.sendAlert({ ...church, ...dbChurch }, msg.alertType, { message: msg.message, status: church.status, _instanceName: alertInstanceName, _roomId: alertRoomId }, activeSessionId, recoveryInfo);
            const escalated = alertResult && alertResult.severity === 'EMERGENCY';
            await sessionRecap.recordAlert(church.churchId, msg.alertType, false, escalated);
          }
          // ── AI Triage: score and process every alert ──
          aiTriageEngine.processAlert(
            church.churchId, msg.alertType,
            alertEngine.classifyAlert(msg.alertType),
            { message: msg.message, status: church.status, roomId: alertRoomId || church.room_id },
          ).catch(e => console.error('[AITriage] Process error:', e.message));
          // ── AutoPilot: evaluate alert-based rules ──
          if (autoPilot) {
            autoPilot.onAlert(church.churchId, {
              alertType: msg.alertType,
              severity: msg.severity || 'warning',
              message: msg.message,
            }).catch(() => {});
          }
        } catch (e) {
          console.error(`Alert processing error for ${church.name}:`, e.message);
        }
      })();
    }
  },
  onCommandResult(church, cmdResultMsg) {
    if (tallyBot) tallyBot.onCommandResult(cmdResultMsg);
    if (preServiceCheck) preServiceCheck.onCommandResult(cmdResultMsg);
    Promise.resolve(runtimeCoordinator.publishEvent('command_result', {
      churchId: church.churchId,
      church: serializeRuntimeChurchSnapshot(church),
      event: cmdResultMsg,
    })).catch(() => {});
    // church-client sends { id, result, error } — use id first, fall back to
    // messageId in case future payloads use the other field name.
    _mobileWsHandler.broadcastToMobile(church.churchId, {
      type: 'command_result',
      messageId: cmdResultMsg.id || cmdResultMsg.messageId,
      result: cmdResultMsg.result,
      error: cmdResultMsg.error,
    });
    totalMessagesRelayed++;
  },
  onChurchMessage(church, msg) {
    switch (msg.type) {
      case 'signal_event':
        runtimeMetrics.record('church.signal_event.in');
        signalFailover.onSignalEvent(church.churchId, msg.signal, {
          bitrateKbps: msg.bitrateKbps,
          baselineKbps: msg.baselineKbps,
          church,
          instanceName: msg._instance || null,
          roomId: msg._roomId || null,
        });
        break;
      case 'viewer_snapshot': {
        runtimeMetrics.record('church.viewer_snapshot.in');
        const total = typeof msg.total === 'number' ? msg.total : 0;
        const breakdown = msg.breakdown || {};
        const activeSession = sessionRecap.activeSessions?.get(church.churchId);
        const sessionId = activeSession?.sessionId || null;
        queryClient.run(`
            INSERT INTO viewer_snapshots (church_id, session_id, total, youtube, facebook, vimeo, captured_at, room_id, instance_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [church.churchId, sessionId, total, breakdown.youtube ?? null, breakdown.facebook ?? null, breakdown.vimeo ?? null, msg.timestamp || new Date().toISOString(), msg._roomId || null, msg._instance || null])
          .catch((e) => {
            console.error('[ViewerSnapshot] Insert failed:', e.message);
          });
        if (total > 0) {
          Promise.resolve(sessionRecap.recordPeakViewers(church.churchId, total))
            .catch(e => console.error('[SessionRecap] Peak viewers error:', e.message));
        }
        broadcastToControllers({ type: 'viewer_update', churchId: church.churchId, name: church.name, total, breakdown, timestamp: msg.timestamp });
        broadcastToPortal(church.churchId, { type: 'viewer_update', total, breakdown, timestamp: msg.timestamp });
        break;
      }
      case 'propresenter_slide_change': {
        runtimeMetrics.record('church.propresenter_slide_change.in');
        const slideData = { presentationName: msg.presentationName || '', slideIndex: msg.slideIndex ?? 0, slideCount: msg.slideCount ?? 0 };
        autoPilot.onSlideChange(church.churchId, slideData).catch(e => console.error('[AutoPilot] Slide change error:', e.message));
        scheduler.onSlideChange(church.churchId, slideData).catch(e => console.error('[Scheduler] Slide change error:', e.message));
        // Auto-advance live rundown if presentation name changed and auto-advance is on
        if (slideData.presentationName) {
          liveRundown.onPresentationChange(church.churchId, slideData.presentationName);
        }
        break;
      }
      case 'chat': {
        runtimeMetrics.record('church.chat.in');
        if (!msg.message || !msg.message.trim()) break;
        if (msg.message.length > 2000) msg.message = msg.message.slice(0, 2000);
        chatEngine.saveMessage({
          churchId: church.churchId,
          senderName: msg.senderName || church.td_name || 'TD',
          senderRole: msg.senderRole || 'td',
          source: 'app',
          message: msg.message.trim(),
        }).then((saved) => {
          chatEngine.broadcastChat(saved);
        }).catch((e) => {
          console.error('[ChatEngine] Church chat save failed:', e.message);
        });
        break;
      }
      case 'preview_frame': {
        runtimeMetrics.record('church.preview_frame.in');
        runtimeMetrics.recordBytes('church.preview_frame.in', msg.data ? Buffer.byteLength(msg.data) : 0);
        if (msg.data && msg.data.length > 150_000) break;
        church.status.previewActive = true;
        const frameMsg = { type: 'preview_frame', churchId: church.churchId, churchName: church.name, timestamp: msg.timestamp, width: msg.width, height: msg.height, format: msg.format, data: msg.data };
        const cachedFrame = cachePreviewFrame(frameMsg);
        const availability = buildPreviewAvailability(cachedFrame);
        broadcastPreviewAvailability(availability);
        Promise.resolve(sharedRuntimeState.setPreviewFrame(
          church.churchId,
          cachedFrame,
          PREVIEW_FRAME_CACHE_TTL_MS,
        )).catch(() => {});
        Promise.resolve(runtimeCoordinator.publishEvent('preview_available', {
          churchId: church.churchId,
          event: availability,
        })).catch(() => {});
        if (tallyBot) tallyBot.onPreviewFrame(frameMsg);
        totalMessagesRelayed++;
        break;
      }
    }
  },
  onControllerMessage(ws, msg) {
    runtimeMetrics.record('controller.message.in');
    if (msg.type === 'preview_subscribe' && msg.churchId) {
      runtimeMetrics.record('controller.preview_subscribe.in');
      subscribeControllerToPreview(ws, msg.churchId);
      safeSend(ws, { type: 'preview_subscription', churchId: msg.churchId, subscribed: true });
      const cachedFrame = getCachedPreviewFrame(msg.churchId);
      if (cachedFrame) {
        safeSend(ws, buildPreviewAvailability(cachedFrame));
      } else if (sharedRuntimeState.enabled) {
        Promise.resolve(sharedRuntimeState.getPreviewFrame(msg.churchId)).then((sharedFrame) => {
          if (sharedFrame) safeSend(ws, buildPreviewAvailability(sharedFrame));
        }).catch(() => {});
      }
      return;
    }

    if (msg.type === 'preview_unsubscribe') {
      runtimeMetrics.record('controller.preview_unsubscribe.in');
      unsubscribeControllerFromPreview(ws, msg.churchId);
      safeSend(ws, { type: 'preview_subscription', churchId: msg.churchId || null, subscribed: false });
      return;
    }

    if (msg.type === 'command' && msg.churchId) {
      runtimeMetrics.record('controller.command.in');
      if (msg.command === 'preview.start') {
        subscribeControllerToPreview(ws, msg.churchId);
      } else if (msg.command === 'preview.stop') {
        unsubscribeControllerFromPreview(ws, msg.churchId);
      }
    }

    // Rundown commands from controller (Companion module / admin dashboard)
    if (msg.type?.startsWith('rundown_') && msg.churchId) {
      runtimeMetrics.record('controller.rundown.in');
      _handleRundownWsMessage(msg.churchId, msg, ws);
      return;
    }

    // Chat from controller (admin dashboard WebSocket)
    if (msg.type === 'chat' && msg.churchId && msg.message) {
      runtimeMetrics.record('controller.chat.in');
      chatEngine.saveMessage({ churchId: msg.churchId, senderName: msg.senderName || 'Admin', senderRole: 'admin', source: 'dashboard', message: msg.message.trim() })
        .then((saved) => {
          chatEngine.broadcastChat(saved);
        })
        .catch((e) => {
          console.error('[ChatEngine] Controller chat save failed:', e.message);
        });
    }
  },
  onControllerConnected(ws) {
    ws._previewSubscriptions = new Set();
    runtimeMetrics.record('controller.connect');
    ws._controllerPresenceId = ws._controllerPresenceId || crypto.randomUUID();
    Promise.resolve(runtimeCoordinator.recordControllerPresence(ws._controllerPresenceId, {
      ip: ws._socket?.remoteAddress || null,
    })).catch(() => {});
    log(`Controller connected (total: ${controllers.size})`);
  },
  onControllerDisconnected(ws) {
    runtimeMetrics.record('controller.disconnect');
    unsubscribeControllerFromPreview(ws);
    Promise.resolve(runtimeCoordinator.clearControllerPresence(ws?._controllerPresenceId)).catch(() => {});
    log(`Controller disconnected (total: ${controllers.size})`);
  },
});

// ─── LIVE RUNDOWN WEBSOCKET MESSAGE HANDLER ────────────────────────────────────
// Handles rundown_start/advance/back/goto/end/get_state from mobile & portal WS.
function _handleRundownWsMessage(churchId, msg, ws) {
  const _send = (data) => {
    if (ws?.readyState === 1) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  };

  switch (msg.type) {
    case 'rundown_start': {
      if (!msg.planId) {
        _send({ type: 'rundown_error', error: 'planId is required', messageId: msg.messageId });
        break;
      }
      const plan = planningCenter.getCachedPlan(msg.planId);
      if (!plan || plan.churchId !== churchId) {
        _send({ type: 'rundown_error', error: 'Plan not found', messageId: msg.messageId });
        break;
      }
      const state = liveRundown.startSession(churchId, plan, msg.callerName || 'TD');
      _send({ type: 'rundown_state', messageId: msg.messageId, ...state });
      break;
    }
    case 'rundown_advance': {
      const state = liveRundown.advance(churchId);
      if (!state) _send({ type: 'rundown_error', error: 'Cannot advance', messageId: msg.messageId });
      break;
    }
    case 'rundown_back': {
      const state = liveRundown.back(churchId);
      if (!state) _send({ type: 'rundown_error', error: 'Cannot go back', messageId: msg.messageId });
      break;
    }
    case 'rundown_goto': {
      const state = liveRundown.goTo(churchId, msg.index);
      if (!state) _send({ type: 'rundown_error', error: 'Invalid index', messageId: msg.messageId });
      break;
    }
    case 'rundown_end': {
      const summary = liveRundown.endSession(churchId);
      if (!summary) _send({ type: 'rundown_error', error: 'No active session', messageId: msg.messageId });
      break;
    }
    case 'rundown_get_state': {
      const state = liveRundown.getState(churchId);
      _send({ type: 'rundown_state', messageId: msg.messageId, active: !!state, ...(state || {}) });
      break;
    }
    case 'rundown_auto_advance': {
      const state = liveRundown.setAutoAdvance(churchId, msg.enabled);
      if (!state) _send({ type: 'rundown_error', error: 'No active session', messageId: msg.messageId });
      break;
    }
  }
}

// ─── MOBILE WEBSOCKET HANDLER ─────────────────────────────────────────────────
const _mobileWsHandler = createMobileWebSocketHandler({
  churches,
  db,
  queryClient,
  jwtSecret: JWT_SECRET,
  pushNotifications,
  log,
  checkCommandRateLimit,
  onRundownMessage: _handleRundownWsMessage,
  dispatchRemoteCommand: (payload, meta) => dispatchCommandAcrossRuntime(payload, meta),
});

// Wire up deferred broadcast functions for LiveRundownManager
_liveRundownBroadcastMobile = (churchId, msg) => _mobileWsHandler.broadcastToMobile(churchId, msg);
_liveRundownBroadcastPortal = (churchId, msg) => {
  broadcastToPortal(churchId, msg);
  // Also forward rundown_timer messages to public timer WS clients
  if (msg?.type === 'rundown_timer' || msg?.type === 'rundown_ended') {
    const planId = msg.plan_id || msg.planId;
    if (planId) {
      const clients = timerWsClients.get(planId);
      if (clients?.size) {
        const payload = JSON.stringify(msg);
        for (const ws of clients) {
          try { if (ws.readyState === WebSocket.OPEN) ws.send(payload); } catch {}
        }
      }
    }
  }
};
_liveRundownBroadcastControllers = (churchId, msg) => broadcastToControllers({ ...msg, churchId });
// Send companion_actions directly to the church-client (desktop app) WebSocket
_liveRundownBroadcastChurch = (churchId, msg) => {
  const church = churches.get(churchId);
  if (!church) return;
  // Send to all connected instances (handles multi-room; companion is per-room but
  // the action should fire on whichever instance handles A/V)
  if (church.sockets?.size) {
    for (const ws of church.sockets.values()) {
      safeSend(ws, msg);
    }
  } else if (church.ws) {
    safeSend(church.ws, msg);
  }
};

wss.on('connection', (ws, req) => {
  // Clear pong-timeout when client responds to a heartbeat ping
  ws.on('pong', () => {
    if (ws._pongTimeout) {
      clearTimeout(ws._pongTimeout);
      ws._pongTimeout = null;
    }
  });

  const url = new URL(req.url, 'http://localhost');
  const role = url.pathname.replace(/^\//, '');
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (role === 'church') {
    handleChurchConnection(ws, url, clientIp);
  } else if (role === 'controller') {
    handleControllerConnection(ws, url, req);
  } else if (role === 'portal') {
    handlePortalWsConnection(ws, url);
  } else if (role === 'mobile') {
    _mobileWsHandler.handleMobileConnection(ws, url, req);
  } else if (role === 'rundown-timer') {
    handleTimerWsConnection(ws, url);
  } else {
    ws.close(1008, 'Unknown role');
  }
});

function handleChurchConnection(ws, url, clientIp) {
  return _wsHandlers.handleChurchConnection(ws, url, clientIp);
}

function handleControllerConnection(ws, url, req) {
  return _wsHandlers.handleControllerConnection(ws, url, req);
}

function handlePortalWsConnection(ws, url) {
  const token = url.searchParams.get('token');
  if (!token) return ws.close(1008, 'token required');

  let churchId;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'church_portal' && payload.type !== 'church_td' && payload.type !== 'church_app') {
      throw new Error('wrong token type');
    }
    churchId = payload.churchId;
  } catch {
    return ws.close(1008, 'invalid or expired token');
  }

  const church = churches.get(churchId);
  safeSend(ws, {
    type: 'status_snapshot',
    connected: church ? !!(church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN)) : false,
    status: church ? church.status : {},
    instanceStatus: church?.instanceStatus || {},
    roomInstanceMap: church?.roomInstanceMap || {},
    lastSeen: church ? church.lastSeen : null,
  });

  // Send active rundown state if a session is in progress
  if (liveRundown.hasSession(churchId)) {
    const rundownState = liveRundown.getState(churchId);
    if (rundownState) safeSend(ws, { type: 'rundown_state', active: true, ...rundownState });
  }

  if (!portalWsClients.has(churchId)) portalWsClients.set(churchId, new Set());
  portalWsClients.get(churchId).add(ws);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'stream_protection_command') {
        dispatchCommandAcrossRuntime(
          { type: 'stream_protection_command', action: msg.action, churchId },
          { churchId, source: 'portal' },
        ).catch(() => {});
      } else if (msg.type === 'command') {
        dispatchCommandAcrossRuntime(
          { type: 'command', churchId, command: msg.command, params: msg.params || {}, id: msg.messageId, messageId: msg.messageId, roomId: msg.roomId || null },
          { churchId, roomId: msg.roomId || null, source: 'portal' },
        ).catch(() => {});
      } else if (msg.type?.startsWith('rundown_')) {
        // Route live rundown messages from portal
        _handleRundownWsMessage(churchId, msg, ws);
      }
    } catch { /* Malformed JSON */ }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    const clients = portalWsClients.get(churchId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) portalWsClients.delete(churchId);
    }
  });

  ws.on('error', () => {});
}

// ─── RUNDOWN TIMER WEBSOCKET (public, share-token auth) ───────────────────────
function handleTimerWsConnection(ws, url) {
  const token = url.searchParams.get('token');
  if (!token) return ws.close(1008, 'token required');

  let planId = null;

  // Resolve share token to plan asynchronously
  resolvePublicRundownAccess(token).then(async (access) => {
    if (!access?.plan) return ws.close(1008, 'invalid share token');
    const plan = access.plan;
    planId = plan.id;

    // Register in timer clients map (keyed by planId for targeted broadcasts)
    if (!timerWsClients.has(planId)) timerWsClients.set(planId, new Set());
    timerWsClients.get(planId).add(ws);

    // Send initial state
    const timer = await buildPublicTimerStateForPlan(plan);
    if (timer) {
      safeSend(ws, { type: 'timer_state', ...timer });
    } else {
      safeSend(ws, { type: 'timer_state', is_live: false, plan_title: plan.title });
    }
  }).catch(() => ws.close(1011, 'internal error'));

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') safeSend(ws, { type: 'pong' });
    } catch { /* ignore */ }
  });

  ws.on('close', () => {
    if (planId) {
      const clients = timerWsClients.get(planId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) timerWsClients.delete(planId);
      }
    }
  });

  ws.on('error', () => {});
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
      ).catch(e => logError('[VersionCheck] Failed to send firmware-outdated alert: ' + e.message));
    }
  }
}

function handleChurchMessage(church, msg) {
  return _wsHandlers.handleChurchMessage(church, msg);
}

async function handleControllerMessage(ws, msg) {
  return _wsHandlers.handleControllerMessage(ws, msg);
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
  let recipients = 0;
  for (const ws of controllers) {
    if (ws?.readyState !== WebSocket.OPEN) continue;
    safeSend(ws, data);
    recipients++;
  }
  runtimeMetrics.record('controller.broadcast.out', recipients);
  runtimeMetrics.recordBytes('controller.broadcast.out', Buffer.byteLength(data) * recipients);
}

function ensurePreviewSubscriptions(ws) {
  if (!(ws?._previewSubscriptions instanceof Set)) {
    ws._previewSubscriptions = new Set();
  }
  return ws._previewSubscriptions;
}

function subscribeControllerToPreview(ws, churchId) {
  if (!ws || !churchId) return false;
  ensurePreviewSubscriptions(ws).add(churchId);
  return true;
}

function unsubscribeControllerFromPreview(ws, churchId = null) {
  if (!(ws?._previewSubscriptions instanceof Set)) return false;
  if (churchId) return ws._previewSubscriptions.delete(churchId);
  ws._previewSubscriptions.clear();
  return true;
}

function prunePreviewFrameCache(now = Date.now()) {
  for (const [churchId, frame] of previewFrameCache.entries()) {
    if (!frame?.storedAt || (now - frame.storedAt) > PREVIEW_FRAME_CACHE_TTL_MS) {
      previewFrameCache.delete(churchId);
    }
  }
}

function cachePreviewFrame(msg) {
  prunePreviewFrameCache();
  const bytes = msg.data ? Buffer.byteLength(msg.data) : 0;
  const cached = {
    frameId: crypto.randomUUID(),
    churchId: msg.churchId,
    churchName: msg.churchName,
    timestamp: msg.timestamp || new Date().toISOString(),
    width: msg.width || null,
    height: msg.height || null,
    format: msg.format || 'jpeg',
    data: msg.data || '',
    bytes,
    storedAt: Date.now(),
  };
  previewFrameCache.set(cached.churchId, cached);
  runtimeMetrics.record('preview_frame.cache.store');
  runtimeMetrics.recordBytes('preview_frame.cache.store', bytes);
  return cached;
}

function getCachedPreviewFrame(churchId) {
  prunePreviewFrameCache();
  const cached = previewFrameCache.get(churchId);
  if (!cached) {
    runtimeMetrics.record('preview_frame.cache.miss');
    return null;
  }
  runtimeMetrics.record('preview_frame.cache.hit');
  return cached;
}

async function getPreviewFrameForRequest(churchId) {
  const local = getCachedPreviewFrame(churchId);
  if (local) return local;
  if (!sharedRuntimeState.enabled) return null;
  const shared = await sharedRuntimeState.getPreviewFrame(churchId);
  if (shared) {
    previewFrameCache.set(churchId, { ...shared, storedAt: Date.now() });
  }
  return shared;
}

function buildPreviewAvailability(cached) {
  return {
    type: 'preview_available',
    churchId: cached.churchId,
    churchName: cached.churchName,
    timestamp: cached.timestamp,
    width: cached.width,
    height: cached.height,
    format: cached.format,
    frameId: cached.frameId,
  };
}

function getPreviewCacheSummary() {
  prunePreviewFrameCache();
  const now = Date.now();
  const ages = Array.from(previewFrameCache.values())
    .map((frame) => Math.max(0, now - frame.storedAt))
    .sort((a, b) => a - b);
  return {
    cachedChurches: previewFrameCache.size,
    newestAgeMs: ages[0] || 0,
    oldestAgeMs: ages[ages.length - 1] || 0,
  };
}

function broadcastPreviewAvailability(msg) {
  const data = JSON.stringify(msg);
  const payloadBytes = Buffer.byteLength(data);
  let recipients = 0;
  for (const ws of controllers) {
    if (ws?.readyState !== WebSocket.OPEN) continue;
    const subscriptions = ws?._previewSubscriptions;
    if (!(subscriptions instanceof Set) || !subscriptions.has(msg.churchId)) continue;
    safeSend(ws, data);
    recipients++;
  }
  runtimeMetrics.record('preview_available.out', recipients);
  runtimeMetrics.recordBytes('preview_available.out', payloadBytes * recipients);
  if (recipients === 0) runtimeMetrics.record('preview_available.drop.no_subscriber');
}

function getObservedChurch(churchId) {
  return runtimeMirror.getObservedChurch(churchId) || churches.get(churchId) || null;
}

function listObservedChurches() {
  return runtimeMirror.listObservedChurches();
}

function serializeRuntimeChurchSnapshot(church) {
  const observed = church?.churchId ? getObservedChurch(church.churchId) || church : church;
  return observed ? {
    churchId: observed.churchId,
    name: observed.name,
    connected: !!observed.connected,
    status: observed.status || {},
    lastSeen: observed.lastSeen || null,
    lastHeartbeat: observed.lastHeartbeat || null,
    disconnectedAt: observed.disconnectedAt || null,
    instanceStatus: observed.instanceStatus || {},
    roomInstanceMap: observed.roomInstanceMap || {},
    instances: Array.isArray(observed.instances) ? observed.instances : [],
    activeAlerts: observed.activeAlerts || 0,
    encoderActive: !!observed.encoderActive,
    syncStatus: observed.syncStatus || null,
    church_type: observed.church_type || 'recurring',
    event_expires_at: observed.event_expires_at || null,
    event_label: observed.event_label || null,
    reseller_id: observed.reseller_id || null,
    audio_via_atem: observed.audio_via_atem || 0,
    updatedAt: new Date().toISOString(),
  } : null;
}

function buildControllerChurchList() {
  return listObservedChurches().map((church) => ({
    churchId: church.churchId,
    name: church.name,
    connected: !!church.connected,
    status: church.status || {},
    instances: Array.isArray(church.instances) ? church.instances : [],
  }));
}

function buildDashboardChurchState(church) {
  return {
    churchId: church.churchId,
    name: church.name,
    connected: !!church.connected,
    status: church.status || {},
    lastSeen: church.lastSeen || null,
    lastHeartbeat: church.lastHeartbeat || null,
    activeAlerts: church.activeAlerts || 0,
    encoderActive: !!church.encoderActive,
    syncStatus: church.syncStatus || null,
    church_type: church.church_type || 'recurring',
    event_expires_at: church.event_expires_at || null,
    event_label: church.event_label || null,
    reseller_id: church.reseller_id || null,
    audio_via_atem: church.audio_via_atem || 0,
    instances: Array.isArray(church.instances) ? church.instances : [],
  };
}

function buildPortalStatusSnapshot(church) {
  return {
    type: 'status_snapshot',
    connected: !!church?.connected,
    status: church?.status || {},
    instanceStatus: church?.instanceStatus || {},
    roomInstanceMap: church?.roomInstanceMap || {},
    lastSeen: church?.lastSeen || null,
  };
}

function rebroadcastMirroredRuntimeEvent({ churchId, eventType, mirroredChurch, rebroadcastEvent }) {
  if (!churchId) return;

  if (rebroadcastEvent) {
    broadcastToControllers(rebroadcastEvent);
    broadcastToSSE(rebroadcastEvent);
  }

  switch (eventType) {
    case 'church_connected':
      broadcastToPortal(churchId, {
        type: 'connected',
        status: mirroredChurch?.status || {},
        lastSeen: mirroredChurch?.lastSeen || null,
        instanceStatus: mirroredChurch?.instanceStatus || {},
        roomInstanceMap: mirroredChurch?.roomInstanceMap || {},
      });
      _mobileWsHandler.sendConnectionChange(mirroredChurch || { churchId, name: rebroadcastEvent?.name || churchId }, null, true);
      break;
    case 'church_disconnected':
      broadcastToPortal(churchId, {
        type: 'disconnected',
        status: mirroredChurch?.status || {},
      });
      _mobileWsHandler.sendConnectionChange(mirroredChurch || { churchId, name: rebroadcastEvent?.name || churchId, status: rebroadcastEvent?.status || {} }, null, false);
      break;
    case 'instance_disconnected':
      broadcastToPortal(churchId, {
        type: 'instance_disconnected',
        instance: rebroadcastEvent?.instance || null,
        roomIds: rebroadcastEvent?.roomIds || [],
        instanceStatus: mirroredChurch?.instanceStatus || {},
        roomInstanceMap: mirroredChurch?.roomInstanceMap || {},
      });
      _mobileWsHandler.broadcastToMobile(churchId, {
        type: 'status_update',
        churchId,
        name: mirroredChurch?.name || rebroadcastEvent?.name || churchId,
        instanceStatus: mirroredChurch?.instanceStatus || {},
        roomInstanceMap: mirroredChurch?.roomInstanceMap || {},
        timestamp: rebroadcastEvent?.timestamp || new Date().toISOString(),
      });
      break;
    case 'church_status':
      broadcastToPortal(churchId, {
        type: 'status_update',
        churchId,
        name: mirroredChurch?.name || rebroadcastEvent?.name || churchId,
        status: mirroredChurch?.status || {},
        instance: rebroadcastEvent?.instance || null,
        instanceStatus: mirroredChurch?.instanceStatus || {},
        roomInstanceMap: mirroredChurch?.roomInstanceMap || {},
        lastSeen: mirroredChurch?.lastSeen || null,
        statusDelta: rebroadcastEvent?.statusDelta || null,
        statusMode: rebroadcastEvent?.statusMode || 'full',
      });
      _mobileWsHandler.broadcastToMobile(churchId, {
        type: 'status_update',
        churchId,
        name: mirroredChurch?.name || rebroadcastEvent?.name || churchId,
        instanceStatus: mirroredChurch?.instanceStatus || {},
        roomInstanceMap: mirroredChurch?.roomInstanceMap || {},
        timestamp: rebroadcastEvent?.timestamp || new Date().toISOString(),
      });
      break;
    case 'church_alert':
      if (rebroadcastEvent) {
        _mobileWsHandler.sendAlertToMobile(churchId, {
          alertId: rebroadcastEvent.alertId || rebroadcastEvent.id || null,
          alertType: rebroadcastEvent.alertType || rebroadcastEvent.type || null,
          severity: rebroadcastEvent.severity || 'warning',
          context: {
            _roomId: rebroadcastEvent.roomId || null,
            _instanceName: rebroadcastEvent.instance || null,
          },
          diagnosis: {},
          timestamp: rebroadcastEvent.timestamp || Date.now(),
        });
      }
      break;
    default:
      break;
  }
}

function sendCommandToLocalChurch(churchId, payload, { instance = null, roomId = null } = {}) {
  const church = churches.get(churchId);
  if (!church?.sockets?.size) return 0;

  let sent = 0;
  if (instance && church.sockets.get(instance)?.readyState === WebSocket.OPEN) {
    safeSend(church.sockets.get(instance), payload);
    return 1;
  }

  if (roomId && church.roomInstanceMap?.[roomId]) {
    const roomInstance = church.roomInstanceMap[roomId];
    const roomSocket = church.sockets.get(roomInstance);
    if (roomSocket?.readyState === WebSocket.OPEN) {
      safeSend(roomSocket, payload);
      return 1;
    }
  }

  for (const sock of church.sockets.values()) {
    if (sock?.readyState !== WebSocket.OPEN) continue;
    safeSend(sock, payload);
    sent++;
  }
  return sent;
}

function hasObservedConnectionForCommand(churchId, { instance = null, roomId = null } = {}) {
  const observed = getObservedChurch(churchId);
  if (!observed?.connected) return false;

  if (instance) {
    return Array.isArray(observed.instances) ? observed.instances.includes(instance) : true;
  }

  if (roomId) {
    return !!observed.roomInstanceMap?.[roomId];
  }

  return true;
}

async function publishRemoteCommand(payload, meta = {}) {
  if (!runtimeCoordinator.enabled || !payload?.churchId) {
    runtimeMetrics.record('command.remote.publish.skipped');
    return false;
  }
  const shouldPublish = !!meta.hasLocalDelivery || hasObservedConnectionForCommand(payload.churchId, {
    instance: meta.instance || payload.instance || null,
    roomId: meta.roomId || payload.roomId || null,
  });
  if (!shouldPublish) {
    runtimeMetrics.record('command.remote.publish.skipped.no_target');
    return false;
  }
  runtimeMetrics.record('command.remote.publish.attempt');
  await runtimeCoordinator.publishEvent('controller_command', {
    churchId: payload.churchId,
    roomId: meta.roomId || payload.roomId || null,
    instance: meta.instance || payload.instance || null,
    event: payload,
    source: meta.source || 'controller',
    hasLocalDelivery: !!meta.hasLocalDelivery,
  });
  runtimeMetrics.record('command.remote.publish.success');
  return true;
}

async function dispatchCommandAcrossRuntime(payload, meta = {}) {
  if (!payload?.churchId) return { localRecipients: 0, remotePublished: false, delivered: false };
  const localRecipients = sendCommandToLocalChurch(payload.churchId, payload, {
    instance: meta.instance || payload.instance || null,
    roomId: meta.roomId || payload.roomId || null,
  });
  const remoteLikelyConnected = hasObservedConnectionForCommand(payload.churchId, {
    instance: meta.instance || payload.instance || null,
    roomId: meta.roomId || payload.roomId || null,
  });
  let remotePublished = false;
  try {
    remotePublished = await publishRemoteCommand(payload, {
      ...meta,
      hasLocalDelivery: localRecipients > 0,
    });
  } catch {
    runtimeMetrics.record('command.remote.publish.error');
    remotePublished = false;
  }
  return {
    localRecipients,
    remotePublished,
    remoteLikelyConnected,
    delivered: localRecipients > 0 || remoteLikelyConnected,
  };
}

function handleRuntimeCoordinationEvent(event) {
  if (!event || event.instanceId === runtimeCoordinator.instanceId) return;
  runtimeMetrics.record('coordination.event.in');
  runtimeMetrics.record(`coordination.event.${event.type || 'unknown'}.in`);
  const payload = event.payload || {};

  if (event.type === 'controller_command') {
    const forwarded = payload.event;
    if (!forwarded?.churchId) return;
    const localRecipients = sendCommandToLocalChurch(forwarded.churchId, forwarded, {
      instance: payload.instance || forwarded.instance || null,
      roomId: payload.roomId || forwarded.roomId || null,
    });
    runtimeMetrics.record('command.remote.receive');
    runtimeMetrics.record('command.remote.receive.local_recipients', localRecipients);
    if (localRecipients === 0) runtimeMetrics.record('command.remote.receive.miss');
    return;
  }

  if (event.type === 'command_result') {
    const cmdResultMsg = payload.event;
    if (!cmdResultMsg?.churchId) return;
    runtimeMetrics.record('command_result.remote.receive');
    broadcastToControllers(cmdResultMsg);
    _mobileWsHandler.broadcastToMobile(cmdResultMsg.churchId, {
      type: 'command_result',
      messageId: cmdResultMsg.id || cmdResultMsg.messageId,
      result: cmdResultMsg.result,
      error: cmdResultMsg.error,
    });
  }

  if (event.type === 'preview_available') {
    const previewMsg = payload.event;
    if (!previewMsg?.churchId) return;
    runtimeMetrics.record('preview_available.remote.receive');
    broadcastPreviewAvailability(previewMsg);
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
          const church = getObservedChurch(churchId);
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

async function loadChurchById(churchId) {
  return queryClient.queryOne(`${CHURCH_ROW_SELECT} WHERE churchId = ?`, [churchId]);
}

async function loadTdPortalUser(tdId, churchId) {
  return queryClient.queryOne(
    'SELECT * FROM church_tds WHERE id = ? AND church_id = ?',
    [tdId, churchId],
  );
}

// ─── PRESET LIBRARY & COMMAND HELPERS ─────────────────────────────────────────

// Helper: create a sendCommand function for a church WebSocket
// (kept in server.js — used by autoPilot executor and executeChurchCommandWithResult)
function makeCommandSender(church, roomId) {
  return (command, params) => new Promise((resolve, reject) => {
    const { WebSocket: WS } = require('ws');
    // Gather open sockets — if roomId is specified, target only that room's instance
    const openSockets = [];
    if (roomId && church.roomInstanceMap?.[roomId]) {
      const instanceName = church.roomInstanceMap[roomId];
      const sock = church.sockets?.get(instanceName);
      if (sock?.readyState === WS.OPEN) openSockets.push(sock);
    } else if (church.sockets?.size) {
      for (const sock of church.sockets.values()) {
        if (sock.readyState === WS.OPEN) openSockets.push(sock);
      }
    }
    if (openSockets.length === 0) {
      return reject(new Error(roomId ? 'Room client not connected' : 'Church client not connected'));
    }
    const { v4: uuid } = require('uuid');
    const id = uuid();

    const cleanup = () => {
      for (const sock of openSockets) {
        try { sock.removeListener('message', handler); } catch { /* ignore */ }
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Command timeout (15s)'));
    }, 15000);

    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'command_result' && msg.id === id) {
          clearTimeout(timeout);
          cleanup();
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch { /* ignore */ }
    };

    // Listen for response on ALL open sockets and send command to ALL
    for (const sock of openSockets) {
      sock.on('message', handler);
      safeSend(sock, { type: 'command', command, params, id });
    }
  });
}

// Preset + autopilot routes → src/routes/automation.js

// ─── CHAT API ────────────────────────────────────────────────────────────────

// Chat endpoints (extracted)
require('./src/routes/chat')(app, {
  db, queryClient, chatEngine, requireAdmin, requireChurchAppAuth: requireChurchAppOrPortalAuth, handleChatCommandMessage, rateLimit, log,
  churches, scheduleEngine,
});

// Slack integration API (extracted)
require('./src/routes/slack')(app, {
  db, queryClient, churches, requireAdmin, alertEngine, safeErrorMessage, log, isValidSlackWebhookUrl,
});

// Offline between-service detection (extracted)
const offlineDetection = require('./src/crons/offlineDetection')({
  db, queryClient, churches, scheduleEngine, alertEngine, eventMode, tallyBot, log, _intervals,
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

// ─── ADMIN GENERATE (Outreach AI message generation) ─────────────────────────

const OUTREACH_SYSTEM_PROMPT = `You are a ghostwriter for TallyConnect — a church production monitoring and remote control platform. You write outreach messages to church technical directors, worship leaders, and production volunteers on behalf of the Tally team.

RULES:
- Never sound salesy, pitch-like, or corporate. Write like a fellow church tech person talking to a peer.
- Lead with genuine help related to THEIR specific problem or situation.
- Keep it conversational, warm, and practical.
- Be concise. DMs should be 3-5 sentences. Emails should be 1-2 short paragraphs.
- Only mention Tally casually and briefly — "we built something called Tally that handles this" or similar. Never hard-sell.
- When relevant, mention our free tools naturally:
  - Health Check: "we built a free 2-minute production audit" (https://tallyconnect.app/tools/healthcheck/)
  - Checklist Generator: "we made a free pre-service checklist tool" (https://tallyconnect.app/tools/checklist/)
- Use first person ("I" not "we" for DMs, "we" is fine for emails).
- Match the tone of church tech communities — helpful, humble, practical.
- Never use emojis excessively. One is fine if natural.
- Never use exclamation marks more than once.
- Don't over-explain what Tally does. Keep it mysterious enough to spark curiosity.
- Always provide value in the message itself, even if they never click a link.

ABOUT TALLY:
TallyConnect.app monitors church production systems (ATEM switchers, OBS, ProPresenter, audio consoles, encoders) from one dashboard. It auto-recovers stream failures, runs pre-service health checks, sends instant alerts via Slack/Telegram, and provides full remote control. Pricing starts at $49/mo with a 30-day free trial.`;

const OUTREACH_TYPE_PROMPTS = {
  'cold-dm': 'Write a short, friendly cold DM (3-5 sentences). The goal is to start a conversation, not close a sale. Offer something genuinely helpful — the free health check tool or checklist. Don\'t mention pricing or trials unless asked.',
  'healthcheck-followup': 'Write a personalized follow-up message based on their health check results. Reference their specific score and top risks. Frame Tally as the solution to their specific weak areas. Keep it warm and helpful, not "gotcha, you need us."',
  'group-reply': 'Write a helpful reply to their post/question in a community group. Lead with actually answering their question or solving their problem. Only mention Tally briefly at the end as "something that might help with this long-term." The reply should be valuable even if they ignore the Tally mention.',
  'email': 'Write a short professional email (1-2 paragraphs + brief sign-off). Slightly more formal than a DM but still conversational. Include a clear but soft CTA — either try the free health check or book a quick call. Sign off as "The Tally Team".',
};

const OUTREACH_SOURCE_CONTEXT = {
  facebook: 'Found in a Facebook group for church tech/production.',
  youtube: 'Found on YouTube (comment, channel, or video about church production).',
  reddit: 'Found on Reddit (r/churchtechnology, r/churchav, or similar).',
  direct: 'Direct outreach — reaching out proactively.',
  healthcheck: 'They completed our Church Production Health Check.',
};

app.post('/api/admin/generate', requireAdminJwt(), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

  const { messageType, prospectName, churchName, source, context } = req.body;
  if (!messageType || !OUTREACH_TYPE_PROMPTS[messageType]) {
    return res.status(400).json({ error: 'Invalid messageType' });
  }

  let userMsg = '';
  if (prospectName) userMsg += `Name: ${prospectName}\n`;
  if (churchName) userMsg += `Church: ${churchName}\n`;
  if (source && OUTREACH_SOURCE_CONTEXT[source]) userMsg += `Source: ${OUTREACH_SOURCE_CONTEXT[source]}\n`;
  userMsg += `\nMessage type: ${messageType.replace(/-/g, ' ')}\n`;
  if (context && context.trim()) userMsg += `\nContext about this person:\n${context.trim()}\n`;
  userMsg += `\nInstructions: ${OUTREACH_TYPE_PROMPTS[messageType]}`;
  userMsg += '\n\nWrite the message now. Output ONLY the message text — no subject lines, no labels, no explanation.';

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
        system: OUTREACH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
        max_tokens: 1024,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error('[Generate] Anthropic error:', aiRes.status, errBody.slice(0, 300));
      return res.status(500).json({ error: 'Failed to generate message' });
    }

    const data = await aiRes.json();
    const message = data?.content?.[0]?.text || '';

    if (data?.usage) {
      logAiUsage({
        churchId: null,
        feature: 'outreach_generate',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
      });
    }

    res.json({ message });
  } catch (err) {
    console.error('[Generate] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate message' });
  }
});

// ─── ADMIN CHAT (AI chat for admin dashboard) ────────────────────────────────

app.post('/api/admin/chat', requireAdminJwt(), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

  const { message, history, churchStates } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  // Unified admin prompt from tally-engineer.js
  const systemPrompt = buildAdminPrompt();

  // Build context from church states
  let contextStr = '';
  if (churchStates && typeof churchStates === 'object') {
    const entries = Object.values(churchStates);
    if (entries.length > 0) {
      contextStr = `\n\nCurrent church states (${entries.length} churches):\n${JSON.stringify(entries.slice(0, 50), null, 0)}`;
    }
  }

  const messages = [];
  if (Array.isArray(history)) {
    for (const m of history.slice(-18)) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }
  if (messages.length === 0 || messages[messages.length - 1]?.content !== message) {
    messages.push({ role: 'user', content: message + contextStr });
  }

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
        system: systemPrompt,
        messages,
        max_tokens: 1200,
        temperature: 0.5,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error('[AdminChat] Anthropic error:', aiRes.status, errBody.slice(0, 300));
      return res.status(500).json({ error: 'AI service error' });
    }

    const data = await aiRes.json();
    const reply = data?.content?.[0]?.text || 'No response.';

    if (data?.usage) {
      logAiUsage({
        churchId: null,
        feature: 'dashboard_chat',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
      });
    }

    logAiChatInteraction({ churchId: null, roomId: null, source: 'admin', userMessage: message, aiResponse: reply, intent: 'admin_chat', model: 'claude-haiku-4-5-20251001' });
    res.json({ reply });
  } catch (err) {
    console.error('[AdminChat] Error:', err.message);
    res.status(500).json({ error: 'Failed to get AI response' });
  }
});

// ─── LANDING PAGE CHAT PROXY (Anthropic → SSE) ───────────────────────────────

app.post('/api/chat/stream', async (req, res) => {
  // Shared secret prevents public abuse — only the Next.js app should call this
  const secret = req.headers['x-chat-secret'];
  const expected = process.env.CHAT_PROXY_SECRET || '';
  if (!secret || !expected || !safeCompareKey(secret, expected)) {
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
        model: 'claude-haiku-4-5-20251001',
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
        model: 'claude-haiku-4-5-20251001',
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

// ─── OPENAPI SPEC ─────────────────────────────────────────────────────────────

app.get('/api/docs', (_req, res) => {
  const specPath = path.join(__dirname, 'docs', 'openapi.yaml');
  try {
    const yaml = fs.readFileSync(specPath, 'utf8');
    // Parse YAML → JSON using a minimal hand-off (Node has no built-in YAML parser,
    // so we serve the raw YAML text with the correct content-type and also provide
    // a JSON-compatible wrapper for clients that prefer JSON).
    // To get proper JSON, clients can use any YAML parser (e.g. js-yaml).
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(yaml);
  } catch (e) {
    res.status(404).json({ error: 'OpenAPI spec not found' });
  }
});

// ─── ADMIN STREAM PREVIEW ROUTES ─────────────────────────────────────────────

const _fs = require('fs');
const _path = require('path');

// List active RTMP ingest streams
app.get('/api/admin/streams', requireAdmin, (req, res) => {
  res.json({ streams: getActiveStreams() });
});

app.get('/api/admin/churches/:churchId/preview/latest', requireAdmin, async (req, res) => {
  const churchId = String(req.params.churchId || '').trim();
  if (!churchId) return res.status(400).json({ error: 'churchId required' });

  const church = getObservedChurch(churchId);
  if (!church) return res.status(404).json({ error: 'Church not found' });

  const cached = await getPreviewFrameForRequest(churchId);
  if (!cached) return res.status(404).json({ error: 'Preview not available' });

  const knownFrameId = String(req.query.frameId || req.headers['if-none-match'] || '').trim();
  if (knownFrameId && knownFrameId === cached.frameId) {
    runtimeMetrics.record('preview_frame.http.not_modified');
    return res.status(304).end();
  }

  runtimeMetrics.record('preview_frame.http.out');
  runtimeMetrics.recordBytes('preview_frame.http.out', cached.bytes || 0);
  res.set('Cache-Control', 'no-store');
  res.set('ETag', cached.frameId);
  return res.json({
    frameId: cached.frameId,
    churchId: cached.churchId,
    churchName: cached.churchName,
    timestamp: cached.timestamp,
    width: cached.width,
    height: cached.height,
    format: cached.format,
    data: cached.data,
  });
});

// Get stream key for a church (legacy church-level key)
app.get('/api/admin/stream/:churchId/key', requireAdmin, async (req, res) => {
  const church = await queryClient.queryOne(
    'SELECT churchId AS "churchId", name, ingest_stream_key FROM churches WHERE churchId = ?',
    [req.params.churchId],
  );
  if (!church) return res.status(404).json({ error: 'Church not found' });

  let key = church.ingest_stream_key;
  if (!key) {
    key = generateStreamKey();
    await queryClient.run('UPDATE churches SET ingest_stream_key = ? WHERE churchId = ?', [key, church.churchId]);
  }

  // Include per-room stream keys
  const rooms = await queryClient.query(
    'SELECT id, name, stream_key FROM rooms WHERE campus_id = ? AND deleted_at IS NULL ORDER BY name ASC',
    [church.churchId],
  );

  const rtmpHost = process.env.RTMP_PUBLIC_URL || `rtmp://${req.hostname}:${Number(process.env.RTMP_PORT || 1935)}`;
  const rtmpUrl = `${rtmpHost}/live/${key}`;
  const active = isIngestActive(church.churchId);
  const info = active ? getStreamInfo(church.churchId) : null;
  const hlsToken = createHlsToken(church.churchId);
  const relayBase = process.env.RELAY_PUBLIC_URL || `https://${req.hostname}`;
  const hlsUrl = `${relayBase}/api/admin/stream/${church.churchId}/live.m3u8?token=${encodeURIComponent(hlsToken)}`;

  const roomStreams = rooms.map(r => {
    const roomActive = isIngestActive(r.id);
    const roomInfo = roomActive ? getStreamInfo(r.id) : null;
    const roomHlsToken = createHlsToken(r.id);
    return {
      roomId: r.id,
      roomName: r.name,
      streamKey: r.stream_key,
      rtmpUrl: `${rtmpHost}/live/${r.stream_key}`,
      active: roomActive,
      meta: roomInfo?.meta || null,
      startedAt: roomInfo?.startedAt || null,
      hlsUrl: `${relayBase}/api/admin/stream/${r.id}/live.m3u8?token=${encodeURIComponent(roomHlsToken)}`,
    };
  });

  res.json({
    churchId: church.churchId,
    churchName: church.name,
    streamKey: key,
    rtmpUrl,
    active,
    meta: info?.meta || null,
    startedAt: info?.startedAt || null,
    hlsUrl,
    rooms: roomStreams,
  });
});

// Regenerate stream key — supports both church-level and per-room keys
app.post('/api/admin/stream/:churchId/key/regenerate', requireAdmin, async (req, res) => {
  const church = await queryClient.queryOne(
    'SELECT churchId AS "churchId", name FROM churches WHERE churchId = ?',
    [req.params.churchId],
  );
  if (!church) return res.status(404).json({ error: 'Church not found' });

  // Disconnect active stream if any
  disconnectStream(church.churchId);

  const key = generateStreamKey();
  await queryClient.run('UPDATE churches SET ingest_stream_key = ? WHERE churchId = ?', [key, church.churchId]);

  const rtmpHost = process.env.RTMP_PUBLIC_URL || `rtmp://${req.hostname}:${Number(process.env.RTMP_PORT || 1935)}`;
  const rtmpUrl = `${rtmpHost}/live/${key}`;
  res.json({ churchId: church.churchId, streamKey: key, rtmpUrl });
});

// Regenerate stream key for a specific room (admin)
app.post('/api/admin/stream/:churchId/room/:roomId/key/regenerate', requireAdmin, async (req, res) => {
  const { churchId, roomId } = req.params;
  const room = await queryClient.queryOne(
    'SELECT id FROM rooms WHERE id = ? AND campus_id = ? AND deleted_at IS NULL',
    [roomId, churchId],
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });

  disconnectStream(roomId);

  const key = generateStreamKey();
  await queryClient.run('UPDATE rooms SET stream_key = ? WHERE id = ?', [key, roomId]);

  const rtmpHost = process.env.RTMP_PUBLIC_URL || `rtmp://${req.hostname}:${Number(process.env.RTMP_PORT || 1935)}`;
  res.json({ roomId, streamKey: key, rtmpUrl: `${rtmpHost}/live/${key}` });
});

// ─── HLS Token Auth ──────────────────────────────────────────────────────────
// Short-lived HMAC token for direct HLS access (bypasses Vercel proxy).
// Admin gets a token via the key endpoint, browser fetches HLS directly from Railway.
const HLS_TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function createHlsToken(churchId) {
  const expires = Date.now() + HLS_TOKEN_TTL_MS;
  const payload = `${churchId}:${expires}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex').slice(0, 16);
  return `${payload}:${sig}`;
}

function verifyHlsToken(token, churchId) {
  if (!token) return false;
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const [tokenChurch, expiresStr, sig] = parts;
  if (tokenChurch !== churchId) return false;
  if (Date.now() > parseInt(expiresStr)) return false;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${tokenChurch}:${expiresStr}`).digest('hex').slice(0, 16);
  return sig === expectedSig;
}

// CORS helper for HLS endpoints
function hlsCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ['https://tallyconnect.app', 'https://www.tallyconnect.app', 'http://localhost:3000', 'http://localhost:3001'];
  if (allowed.some(a => origin.startsWith(a)) || origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Serve HLS playlist (direct access with token — no Vercel proxy needed)
app.get('/api/admin/stream/:churchId/live.m3u8', (req, res) => {
  const { churchId } = req.params;
  const token = req.query.token;

  // Allow either admin session auth or HLS token
  if (!verifyHlsToken(token, churchId)) {
    // Fall back to admin auth
    return requireAdmin(req, res, () => serveM3u8(req, res));
  }
  hlsCors(req, res);
  serveM3u8(req, res);
});

function serveM3u8(req, res) {
  const { churchId } = req.params;
  const hlsDir = getHlsDir(churchId);
  const m3u8Path = _path.join(hlsDir, 'live.m3u8');

  if (!_fs.existsSync(m3u8Path)) {
    return res.status(404).json({ error: 'Stream not active' });
  }

  // Rewrite segment URLs to include the token for direct access
  let content = _fs.readFileSync(m3u8Path, 'utf8');
  const token = req.query.token;
  if (token) {
    content = content.replace(/^(seg\d+\.ts)$/gm, (match) => {
      return `/api/admin/stream/${churchId}/${match}?token=${encodeURIComponent(token)}`;
    });
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(content);
}

// Serve HLS segments (direct access with token)
app.get('/api/admin/stream/:churchId/:filename', (req, res) => {
  const { churchId, filename } = req.params;
  if (!filename.endsWith('.ts')) {
    return res.status(400).json({ error: 'Invalid segment file' });
  }

  const token = req.query.token;
  if (!verifyHlsToken(token, churchId)) {
    return requireAdmin(req, res, () => serveSegment(req, res));
  }
  hlsCors(req, res);
  serveSegment(req, res);
});

function serveSegment(req, res) {
  const { churchId, filename } = req.params;
  const hlsDir = getHlsDir(churchId);
  const segPath = _path.join(hlsDir, filename);

  if (!_fs.existsSync(segPath)) {
    return res.status(404).json({ error: 'Segment not found' });
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.sendFile(segPath);
}

// CORS preflight for HLS endpoints
app.options('/api/admin/stream/:churchId/*', (req, res) => {
  hlsCors(req, res);
  res.sendStatus(204);
});

// ─── SENTRY ERROR HANDLER (must be after all routes) ─────────────────────────
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ─── START ────────────────────────────────────────────────────────────────────

async function startServer() {
  log('Startup phase: waiting for bootstrap queue', { event: 'startup_phase', phase: 'bootstrap_queue' });
  await db.whenReady?.();
  log('Startup phase complete: bootstrap queue', { event: 'startup_phase_complete', phase: 'bootstrap_queue' });
  log('Startup phase: startup bootstrap', { event: 'startup_phase', phase: 'startup_bootstrap' });
  await startupBootstrap;
  log('Startup phase complete: startup bootstrap', { event: 'startup_phase_complete', phase: 'startup_bootstrap' });
  log('Startup phase: church runtime hydration', { event: 'startup_phase', phase: 'church_runtime' });
  await churchRuntimeReady;
  log('Startup phase complete: church runtime hydration', { event: 'startup_phase_complete', phase: 'church_runtime' });
  await runtimeMirror.start({
    onMirroredEvent: rebroadcastMirroredRuntimeEvent,
    onRawEvent: handleRuntimeCoordinationEvent,
  });
  log('Startup phase: service readiness', { event: 'startup_phase', phase: 'service_ready' });
  await Promise.all([
    resellerSystem.ready,
    versionConfig.ready,
    presetLibrary.ready,
    eventMode.ready,
    guestTdMode.ready,
    onCallRotation.ready,
    scheduleEngine.ready,
    billing.ready,
    churchMemory.ready,
    churchDocuments.ready,
    weeklyDigest.ready,
    postServiceReport.ready,
    sessionRecap.ready,
    monthlyReport.ready,
    rundownEngine.ready,
    liveRundown.ready,
    manualRundown.ready,
    autoPilot.ready,
    scheduler.ready,
    chatEngine.ready,
    aiTriageEngine.ready,
    aiRateLimiter.ready,
    incidentSummarizer.ready,
    planningCenter.ready,
    lifecycleEmails.ready,
    preServiceCheck.ready,
    viewerBaseline.ready,
    streamOAuth.ready,
    pushNotifications.ready,
    alertEngine.ready,
    signalFailover.ready,
    tallyBot?.ready ?? Promise.resolve(),
  ]);
  log('Startup phase complete: service readiness', { event: 'startup_phase_complete', phase: 'service_ready' });
  try {
    await ensureCanonicalTenantColumns(queryClient, { logger: console });
    await ensureTenantGuardrails(queryClient, { logger: console });
  } catch (e) {
    console.warn(`[tenantGuardrails] startup audit failed: ${e.message}`);
  }
  weeklyDigest.startWeeklyTimer();
  guestTdMode.startCleanupTimer();
  monthlyReport.start();
  scheduleEngine.startPolling();
  streamOAuth.start();
  eventMode.start(tallyBot, churches);
  log('Startup phase: startup maintenance', { event: 'startup_phase', phase: 'startup_maintenance' });
  try {
    await runStartupMaintenance();
  } catch (e) {
    console.error('[StartupMaintenance] Error:', e.message);
    throw e;
  }
  log('Startup phase complete: startup maintenance', { event: 'startup_phase_complete', phase: 'startup_maintenance' });
  log('Startup phase: session recovery', { event: 'startup_phase', phase: 'session_recovery' });
  await sessionRecap.recoverActiveSessions();
  log('Startup phase complete: session recovery', { event: 'startup_phase_complete', phase: 'session_recovery' });
  scheduler.start();
  console.log('[Server] ✓ Rundown Scheduler initialized');
  planningCenter.start();
  console.log('[Server] ✓ Planning Center initialized');
  preServiceCheck.start();

  // Start RTMP ingest server if enabled
  const RTMP_ENABLED = (process.env.RTMP_ENABLED || 'false') === 'true';
  if (RTMP_ENABLED) {
    try {
      initRtmpIngest(db, broadcastToSSE);
    } catch (e) {
      console.error(`[RTMP] Failed to start RTMP ingest server: ${e.message}`);
    }
  } else {
    console.log('[RTMP] Ingest server disabled (set RTMP_ENABLED=true to enable)');
  }

  server.listen(PORT, () => {
    log(`Tally Relay running on port ${PORT}`);
    log(`Admin API key: configured (${ADMIN_API_KEY.length} chars)`);
    runStatusChecks().catch((e) => {
      console.error('[StatusChecks] initial run failed:', e.message);
    });
  });
}

startServer().catch((error) => {
  logError('Startup failed', {
    event: 'startup_failed',
    error: error?.message,
    stack: error?.stack,
  });
  process.exit(1);
});

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────

let _shuttingDown = false;

function gracefulShutdown(signal, exitCode = 0) {
  if (_shuttingDown) return; // prevent re-entrant shutdown (e.g. second signal)
  _shuttingDown = true;

  log(`${signal} received — shutting down gracefully`, { signal, event: 'shutdown_start' });

  // Force exit after 10s if graceful close hangs
  const forceTimer = setTimeout(() => {
    logError('Graceful shutdown timed out after 10s — forcing exit', { event: 'shutdown_timeout' });
    process.exit(1);
  }, 10_000);
  forceTimer.unref(); // don't keep the event loop alive just for this timer

  // Clear all tracked intervals to prevent timer leaks / post-close errors
  for (const id of _intervals) clearInterval(id);
  _intervals.length = 0;
  log('Cleared tracked intervals', { event: 'shutdown_intervals_cleared' });

  // Stop heartbeat interval
  clearInterval(heartbeatInterval);

  // Clean up subsystem timers (failover back/ack timers, Telegram bot polling)
  try { preServiceRundown.shutdown(); } catch (e) {
    logWarn('preServiceRundown.shutdown() threw during shutdown', { error: e?.message });
  }
  try { signalFailover.cleanup(); } catch (e) {
    logWarn('signalFailover.cleanup() threw during shutdown', { error: e?.message });
  }
  try { tallyBot?.stop?.(); } catch (e) {
    logWarn('tallyBot.stop() threw during shutdown', { error: e?.message });
  }
  try { monthlyReport.stop(); } catch (e) {
    logWarn('monthlyReport.stop() threw during shutdown', { error: e?.message });
  }
  try { planningCenter.stop(); } catch (e) {
    logWarn('planningCenter.stop() threw during shutdown', { error: e?.message });
  }
  try { shutdownRtmpIngest(); } catch (e) {
    logWarn('shutdownRtmpIngest() threw during shutdown', { error: e?.message });
  }

  // Send close frames to all church WebSocket connections so clients know to reconnect
  let churchWsClosed = 0;
  for (const church of churches.values()) {
    if (church.sockets?.size) {
      for (const sock of church.sockets.values()) {
        if (sock.readyState === WebSocket.OPEN) {
          sock.close(1001, 'server shutting down');
          churchWsClosed++;
        }
      }
    } else if (church.ws?.readyState === WebSocket.OPEN) {
      church.ws.close(1001, 'server shutting down');
      churchWsClosed++;
    }
  }
  log(`Closed ${churchWsClosed} church WebSocket connection(s)`, { event: 'shutdown_church_ws_closed', count: churchWsClosed });

  // Send close frames to all controller connections
  let controllerWsClosed = 0;
  for (const ws of controllers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1001, 'server shutting down');
      controllerWsClosed++;
    }
  }
  log(`Closed ${controllerWsClosed} controller WebSocket connection(s)`, { event: 'shutdown_controller_ws_closed', count: controllerWsClosed });

  // Explicitly end long-lived SSE responses so server.close() can complete.
  let sseClosed = 0;
  for (const res of sseClients) {
    try {
      res.end();
      sseClosed++;
    } catch {}
  }
  sseClients.clear();

  let portalSseClosed = 0;
  for (const clients of portalSseClients.values()) {
    for (const res of clients) {
      try {
        res.end();
        portalSseClosed++;
      } catch {}
    }
    clients.clear();
  }
  portalSseClients.clear();
  log('Closed SSE clients', {
    event: 'shutdown_sse_closed',
    dashboardCount: sseClosed,
    portalCount: portalSseClosed,
  });

  // Stop accepting new WebSocket connections
  wss.close(() => {
    log('WebSocket server closed', { event: 'shutdown_wss_closed' });
  });

  // Stop accepting new HTTP connections; wait for in-flight requests to finish
  server.close(() => {
    log('HTTP server closed', { event: 'shutdown_http_closed' });
    Promise.allSettled([
      runtimeMirror.close(),
      runtimeCoordinator.close(),
      sharedRuntimeState.close(),
      closeRedisRateLimitClient(),
      Promise.resolve(runtimeMetrics.close()),
    ]).finally(() => {
      // Close database (flushes WAL and pending writes)
      try {
        db.close();
        log('Database closed', { event: 'shutdown_db_closed' });
      } catch (e) {
        logWarn('db.close() threw during shutdown', { error: e?.message });
      }
      clearTimeout(forceTimer);
      log('Shutdown complete', { event: 'shutdown_complete', exitCode });
      process.exit(exitCode);
    });
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ─── SAFETY NET: UNHANDLED REJECTIONS & UNCAUGHT EXCEPTIONS ───────────────────

// Log and continue — an unhandled rejection means a single async operation
// failed without a catch, but Node is still in a defined state.
process.on('unhandledRejection', (reason, _promise) => {
  logError('Unhandled promise rejection', {
    event: 'unhandled_rejection',
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Do NOT exit — the server can continue serving other requests.
});

// Log, attempt graceful shutdown, then exit.
// Node docs: after uncaughtException the process is in an undefined state;
// continuing to serve requests is unsafe.
process.on('uncaughtException', (err, origin) => {
  logError('Uncaught exception — initiating graceful shutdown', {
    event: 'uncaught_exception',
    origin,
    error: err?.message,
    stack: err?.stack,
  });
  gracefulShutdown('uncaughtException', 1);
});

// Export for testing
module.exports = { app, server, wss, churches, controllers };
