import { beforeEach, describe, expect, it, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const { hashPassword, verifyPassword } = require('../src/auth');
const { SqliteQueryClient } = require('../src/db/queryClient');
const setupChurchAuthRoutes = require('../src/routes/churchAuth');
const setupRoomEquipmentRoutes = require('../src/routes/roomEquipment');
const setupMobileRoutes = require('../src/routes/mobile');
const setupSessionRoutes = require('../src/routes/sessions');
const setupAdminChurchRoutes = require('../src/routes/adminChurches');
const setupSupportTicketRoutes = require('../src/routes/supportTickets');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'route-query-client-secret';
const CHURCH_APP_TOKEN_TTL = '7d';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT NOT NULL,
      portal_email TEXT,
      portal_password_hash TEXT,
      billing_status TEXT DEFAULT 'active',
      billing_tier TEXT DEFAULT 'connect',
      billing_interval TEXT DEFAULT 'monthly',
      billing_trial_ends TEXT,
      room_id TEXT,
      room_name TEXT,
      notifications TEXT DEFAULT '{}',
      timezone TEXT,
      phone TEXT,
      location TEXT,
      notes TEXT,
      telegram_chat_id TEXT,
      td_telegram_chat_id TEXT,
      td_name TEXT,
      alert_bot_token TEXT,
      engineer_profile TEXT,
      audio_via_atem INTEGER DEFAULT 0,
      locale TEXT,
      referral_code TEXT
    );
    CREATE TABLE church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      name TEXT,
      registered_at TEXT,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      campus_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      deleted_at TEXT
    );
    CREATE TABLE room_equipment (
      room_id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      equipment TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT,
      severity TEXT,
      context TEXT,
      created_at TEXT,
      acknowledged_at TEXT,
      resolved INTEGER DEFAULT 0,
      room_id TEXT,
      session_id TEXT
    );
    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      grade TEXT,
      td_name TEXT,
      duration_minutes INTEGER,
      alert_count INTEGER DEFAULT 0,
      auto_recovered_count INTEGER DEFAULT 0,
      escalated_count INTEGER DEFAULT 0,
      audio_silence_count INTEGER DEFAULT 0,
      stream_ran INTEGER DEFAULT 0,
      stream_runtime_minutes INTEGER,
      recording_confirmed INTEGER DEFAULT 0,
      peak_viewers INTEGER DEFAULT 0
    );
    CREATE TABLE service_events (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      event_type TEXT,
      details TEXT,
      resolved INTEGER DEFAULT 0,
      resolved_at TEXT,
      auto_resolved INTEGER DEFAULT 0,
      instance_name TEXT,
      room_id TEXT
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      sender_name TEXT,
      sender_role TEXT,
      source TEXT,
      message TEXT
    );
    CREATE TABLE billing_customers (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      tier TEXT,
      billing_interval TEXT,
      status TEXT,
      email TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_session_id TEXT,
      grace_ends_at TEXT,
      trial_ends_at TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER DEFAULT 0
    );
    CREATE TABLE support_triage_runs (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      issue_category TEXT,
      severity TEXT,
      summary TEXT,
      triage_result TEXT,
      diagnostics_json TEXT,
      autofix_attempts_json TEXT,
      timezone TEXT,
      app_version TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      triage_id TEXT,
      issue_category TEXT,
      severity TEXT,
      title TEXT,
      description TEXT,
      status TEXT DEFAULT 'open',
      forced_bypass INTEGER DEFAULT 0,
      diagnostics_json TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE support_ticket_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      message TEXT,
      actor_type TEXT,
      actor_id TEXT,
      created_at TEXT
    );
    CREATE TABLE diagnostic_bundles (
      id TEXT PRIMARY KEY,
      churchId TEXT NOT NULL,
      bundle TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE health_score_cache (
      church_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      computed_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeProxyDb(db) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return () => {
          throw new Error('db.prepare should not be used when queryClient is available');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function seedChurch(db, opts = {}) {
  const churchId = opts.churchId || uuidv4();
  db.prepare(`
    INSERT INTO churches (
      churchId, name, email, token, registeredAt, portal_email, portal_password_hash,
      billing_status, billing_tier, billing_interval, billing_trial_ends, room_id, room_name,
      notifications, timezone, referral_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    churchId,
    opts.name || 'Test Church',
    opts.email || 'test@church.com',
    'tok',
    new Date().toISOString(),
    opts.portal_email || null,
    opts.password ? hashPassword(opts.password) : null,
    opts.billing_status || 'active',
    opts.billing_tier || 'connect',
    opts.billing_interval || 'monthly',
    opts.billing_trial_ends || null,
    opts.room_id || null,
    opts.room_name || null,
    JSON.stringify(opts.notifications || {}),
    opts.timezone || 'America/New_York',
    opts.referral_code || 'ABC123',
  );
  return churchId;
}

function seedRoom(db, opts = {}) {
  const roomId = opts.roomId || uuidv4();
  db.prepare('INSERT INTO rooms (id, campus_id, name, description, deleted_at) VALUES (?, ?, ?, ?, NULL)')
    .run(roomId, opts.churchId, opts.name || 'Main Room', opts.description || 'Main sanctuary');
  return roomId;
}

function seedTd(db, churchId, opts = {}) {
  db.prepare('INSERT INTO church_tds (church_id, name, registered_at, active) VALUES (?, ?, ?, 1)')
    .run(churchId, opts.name || 'Taylor', opts.registeredAt || new Date().toISOString());
}

function seedAlert(db, opts = {}) {
  db.prepare(`
    INSERT INTO alerts (id, church_id, alert_type, severity, context, created_at, acknowledged_at, room_id, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id || uuidv4(),
    opts.churchId,
    opts.alertType || 'offline',
    opts.severity || 'warning',
    JSON.stringify(opts.context || {}),
    opts.createdAt || new Date().toISOString(),
    opts.acknowledgedAt || null,
    opts.roomId || null,
    opts.sessionId || null,
  );
}

function seedSession(db, opts = {}) {
  db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, grade) VALUES (?, ?, ?, ?, ?)')
    .run(opts.id || uuidv4(), opts.churchId, opts.startedAt || new Date().toISOString(), opts.endedAt || null, opts.grade || 'A');
}

function seedHealthScore(db, churchId, score) {
  db.prepare('INSERT INTO health_score_cache (church_id, score, computed_at) VALUES (?, ?, ?)')
    .run(churchId, score, new Date().toISOString());
}

function seedServiceEvent(db, opts = {}) {
  db.prepare(`
    INSERT INTO service_events (id, church_id, session_id, timestamp, event_type, details, resolved, resolved_at, auto_resolved, instance_name, room_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id || uuidv4(),
    opts.churchId,
    opts.sessionId || null,
    opts.timestamp || new Date().toISOString(),
    opts.eventType || 'stream_drop',
    opts.details || 'Video lost',
    opts.resolved ? 1 : 0,
    opts.resolvedAt || null,
    opts.autoResolved ? 1 : 0,
    opts.instanceName || null,
    opts.roomId || null,
  );
}

function seedChatMessage(db, opts = {}) {
  db.prepare(`
    INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id || uuidv4(),
    opts.churchId,
    opts.sessionId || null,
    opts.timestamp || new Date().toISOString(),
    opts.senderName || 'Alice',
    opts.senderRole || 'host',
    opts.source || 'church',
    opts.message || 'Welcome',
  );
}

function seedBillingCustomer(db, churchId, opts = {}) {
  db.prepare(`
    INSERT INTO billing_customers (id, church_id, tier, billing_interval, status, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id || `billing_${churchId}`,
    churchId,
    opts.tier || 'connect',
    opts.billingInterval || 'monthly',
    opts.status || 'inactive',
    opts.email || 'billing@church.com',
    opts.createdAt || new Date().toISOString(),
    opts.updatedAt || new Date().toISOString(),
  );
}

function buildQueryApp(db, routeModule, extraCtx = {}) {
  const app = express();
  app.use(express.json());

  const actualDb = db;
  const queryClient = new SqliteQueryClient(actualDb);
  const proxyDb = makeProxyDb(actualDb);
  const churches = new Map();

  const requireChurchAppAuth = async (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
    }
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      if (payload.type !== 'church_app') throw new Error('wrong token type');
      const church = await queryClient.queryOne('SELECT * FROM churches WHERE churchId = ?', [payload.churchId]);
      if (!church) return res.status(404).json({ error: 'Church not found' });
      req.church = church;
      req.churchReadonly = !!payload.readonly;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };

  const requireAdmin = (req, res, next) => {
    req.adminUser = { id: 'admin-1', email: 'admin@test.com', role: 'super_admin' };
    next();
  };

  const ctx = {
    db: proxyDb,
    queryClient,
    churches,
    requireAdmin,
    requireChurchAppAuth,
    requireChurchWriteAccess: (req, res, next) => (req.churchReadonly ? res.status(403).json({ error: 'This token is read-only.' }) : next()),
    rateLimit: () => (req, res, next) => next(),
    billing: {
      isEnabled: () => false,
      createCheckout: vi.fn(),
    },
    hashPassword,
    verifyPassword,
    normalizeBillingInterval: (v, tier, fallback) => {
      if (v === undefined || v === null || v === '') return fallback || 'monthly';
      const normalized = String(v).trim().toLowerCase();
      if (['monthly', 'annual', 'one_time'].includes(normalized)) return normalized;
      return null;
    },
    issueChurchAppToken: (churchId, name, opts = {}) => jwt.sign(
      { type: 'church_app', churchId, name, ...(opts.readonly ? { readonly: true } : {}) },
      JWT_SECRET,
      { expiresIn: CHURCH_APP_TOKEN_TTL },
    ),
    checkChurchPaidAccess: (churchId) => {
      const church = actualDb.prepare(
        'SELECT billing_status, billing_tier, billing_interval FROM churches WHERE churchId = ?',
      ).get(churchId);
      if (!church) return { allowed: false, status: 'inactive', message: 'Church not found' };
      const status = church.billing_status || 'inactive';
      return {
        allowed: ['active', 'trialing', 'grace'].includes(status),
        status,
        tier: church.billing_tier,
        billingInterval: church.billing_interval,
      };
    },
    generateRegistrationCode: () => 'ABC123',
    sendOnboardingEmail: vi.fn().mockResolvedValue(undefined),
    lifecycleEmails: {
      captureLead: vi.fn(),
      sendLeadWelcome: vi.fn().mockResolvedValue(undefined),
      sendRegistrationConfirmation: vi.fn().mockResolvedValue(undefined),
      sendPasswordReset: vi.fn().mockResolvedValue(undefined),
    },
    broadcastToSSE: vi.fn(),
    stmtInsert: null,
    stmtFindByName: null,
    stmtUpdateRegistrationCode: null,
    jwt,
    JWT_SECRET,
    CHURCH_APP_TOKEN_TTL,
    REQUIRE_ACTIVE_BILLING: false,
    TRIAL_PERIOD_DAYS: 14,
    uuidv4,
    safeErrorMessage: (e) => e.message,
    log: vi.fn(),
    pushNotifications: {
      registerDevice: vi.fn().mockResolvedValue({ created: true, deviceId: 'device-1' }),
      unregisterDevice: vi.fn().mockResolvedValue({ ok: true }),
      getPrefs: vi.fn().mockResolvedValue({}),
      updatePrefs: vi.fn().mockResolvedValue({}),
      getStats: vi.fn().mockResolvedValue({ deviceCount: 2 }),
    },
    scheduleEngine: {
      getSchedule: vi.fn(() => ({ id: 'sched-1' })),
      getNextServiceWindow: vi.fn(() => ({ name: 'Sunday Service', start: '2026-04-05T10:00:00Z' })),
      isServiceWindow: vi.fn(() => false),
    },
    rundownEngine: {},
    requireFeature: () => (req, res, next) => next(),
    alertEngine: {
      acknowledgeAlert: vi.fn().mockResolvedValue({ ok: true }),
    },
    weeklyDigest: {
      getLatestDigest: vi.fn(() => null),
      saveDigest: vi.fn().mockResolvedValue({ filePath: '/tmp/digest.txt' }),
    },
    sessionRecap: {
      getActiveSession: vi.fn(() => null),
    },
    signalFailover: {
      refreshChurchConfig: vi.fn().mockResolvedValue(undefined),
    },
    monthlyReport: {
      generateReport: vi.fn().mockResolvedValue({ month: '2026-04' }),
      formatReport: vi.fn(() => 'formatted report'),
    },
    logAiUsage: vi.fn(),
    isOnTopic: vi.fn(() => true),
    OFF_TOPIC_RESPONSE: 'off-topic',
    ...extraCtx,
  };

  routeModule(app, ctx);
  return { app, db: actualDb, queryClient, churches };
}

function makeToken(churchId, readonly = false) {
  return jwt.sign({ type: 'church_app', churchId, ...(readonly ? { readonly: true } : {}) }, JWT_SECRET, { expiresIn: '1h' });
}

describe('church routes queryClient path', () => {
  let db;
  let client;

  afterEach(async () => {
    if (client) await client.close();
    if (db) db.close();
    client = null;
    db = null;
  });

  describe('churchAuth', () => {
    beforeEach(() => {
      db = createDb();
      const churchId = seedChurch(db, { churchId: 'church-1', name: 'Grace Church', portal_email: 'grace@church.com', password: 'Grace1234!' });
      seedTd(db, churchId, { name: 'Taylor' });
      seedRoom(db, { churchId, roomId: 'room-1', name: 'Main', description: 'Main room' });
      client = createClient(buildQueryApp(db, setupChurchAuthRoutes).app);
    });

    it('logs in and loads profile data through queryClient', async () => {
      const { status, body } = await client.post('/api/church/app/login', {
        body: { email: 'grace@church.com', password: 'Grace1234!' },
      });
      expect(status).toBe(200);
      expect(body.token).toBeTruthy();

      const token = makeToken('church-1');
      const me = await client.get('/api/church/app/me', { token });
      expect(me.status).toBe(200);
      expect(me.body.churchId).toBe('church-1');
      expect(me.body.tds).toHaveLength(1);
    });

    it('lists and assigns rooms through queryClient', async () => {
      const token = makeToken('church-1');
      const rooms = await client.get('/api/church/app/rooms', { token });
      expect(rooms.status).toBe(200);
      expect(rooms.body.rooms).toHaveLength(1);

      const assign = await client.post('/api/church/app/room-assign', {
        token,
        body: { roomId: 'room-1' },
      });
      expect(assign.status).toBe(200);
      expect(assign.body.roomName).toBe('Main');
      const row = db.prepare('SELECT room_id, room_name FROM churches WHERE churchId = ?').get('church-1');
      expect(row.room_id).toBe('room-1');
      expect(row.room_name).toBe('Main');
    });
  });

  describe('roomEquipment', () => {
    beforeEach(() => {
      db = createDb();
      seedChurch(db, { churchId: 'church-1', name: 'Grace Church', portal_email: 'grace@church.com', password: 'Grace1234!' });
      seedRoom(db, { churchId: 'church-1', roomId: 'room-1', name: 'Main', description: 'Main room' });
      client = createClient(buildQueryApp(db, setupRoomEquipmentRoutes).app);
    });

    it('reads and updates room equipment through queryClient', async () => {
      const token = makeToken('church-1');
      const empty = await client.get('/api/church/app/rooms/room-1/equipment', { token });
      expect(empty.status).toBe(200);
      expect(empty.body.equipment).toEqual({});

      const update = await client.put('/api/church/app/rooms/room-1/equipment', {
        token,
        body: { equipment: { mixer: { configured: true } } },
      });
      expect(update.status).toBe(200);

      const readback = db.prepare('SELECT equipment FROM room_equipment WHERE room_id = ?').get('room-1');
      expect(JSON.parse(readback.equipment)).toMatchObject({ mixer: { configured: true } });
    });
  });

  describe('mobile', () => {
    beforeEach(() => {
      db = createDb();
      const churchId = seedChurch(db, { churchId: 'church-1', name: 'Grace Church', portal_email: 'grace@church.com', password: 'Grace1234!' });
      seedRoom(db, { churchId, roomId: 'room-1', name: 'Main', description: 'Main room' });
      seedAlert(db, { churchId, roomId: 'room-1', sessionId: 'session-1' });
      seedSession(db, { churchId, id: 'session-1', startedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString() });
      seedHealthScore(db, churchId, 87);
      client = createClient(buildQueryApp(db, setupMobileRoutes).app);
    });

    it('logs in and loads dashboard summary through queryClient', async () => {
      const login = await client.post('/api/church/mobile/login', {
        body: { email: 'grace@church.com', password: 'Grace1234!' },
      });
      expect(login.status).toBe(200);
      expect(login.body.rooms).toHaveLength(1);

      const token = makeToken('church-1');
      const summary = await client.get('/api/church/mobile/summary', { token });
      expect(summary.status).toBe(200);
      expect(summary.body.rooms).toHaveLength(1);
      expect(summary.body.recentAlerts).toHaveLength(1);
      expect(summary.body.healthScore).toBe(87);
      expect(summary.body.pushDevices).toBe(2);
    });
  });

  describe('sessions', () => {
    beforeEach(() => {
      db = createDb();
      const churchId = seedChurch(db, { churchId: 'church-1', name: 'Grace Church' });
      seedSession(db, {
        churchId,
        id: 'session-1',
        startedAt: '2026-04-05T10:00:00.000Z',
        endedAt: '2026-04-05T11:30:00.000Z',
        grade: 'Clean',
      });
      seedServiceEvent(db, {
        churchId,
        sessionId: 'session-1',
        timestamp: '2026-04-05T10:15:00.000Z',
        eventType: 'stream_drop',
        details: 'Primary stream dropped',
        resolved: true,
        autoResolved: true,
      });
      seedChatMessage(db, {
        churchId,
        sessionId: 'session-1',
        timestamp: '2026-04-05T10:16:00.000Z',
        senderName: 'Taylor',
        message: 'We are back online',
      });

      const appInfo = buildQueryApp(db, setupSessionRoutes);
      appInfo.churches.set('church-1', { churchId: 'church-1', name: 'Grace Church' });
      client = createClient(appInfo.app);
    });

    it('updates td contact and reads sessions through queryClient', async () => {
      const update = await client.put('/api/churches/church-1/td-contact', {
        body: { tdChatId: 'chat-1', tdName: 'Taylor', alertBotToken: 'bot-1' },
      });
      expect(update.status).toBe(200);

      const tdRow = db.prepare('SELECT td_telegram_chat_id, td_name, alert_bot_token FROM churches WHERE churchId = ?').get('church-1');
      expect(tdRow.td_telegram_chat_id).toBe('chat-1');
      expect(tdRow.td_name).toBe('Taylor');
      expect(tdRow.alert_bot_token).toBe('bot-1');

      const sessions = await client.get('/api/churches/church-1/sessions');
      expect(sessions.status).toBe(200);
      expect(sessions.body.sessions).toHaveLength(1);

      const timeline = await client.get('/api/churches/church-1/sessions/session-1/timeline');
      expect(timeline.status).toBe(200);
      expect(timeline.body.timeline.some((item) => item._type === 'event')).toBe(true);
      expect(timeline.body.timeline.some((item) => item._type === 'chat')).toBe(true);

      const debrief = await client.get('/api/churches/church-1/sessions/session-1/debrief');
      expect(debrief.status).toBe(200);
      expect(debrief.body.debrief).toContain('SERVICE DEBRIEF');
    });
  });

  describe('adminChurches', () => {
    beforeEach(() => {
      db = createDb();
      seedChurch(db, { churchId: 'church-1', name: 'Grace Church', portal_email: 'grace@church.com' });
      seedBillingCustomer(db, 'church-1', { tier: 'connect', status: 'inactive', billingInterval: 'monthly' });
      const appInfo = buildQueryApp(db, setupAdminChurchRoutes, {
        messageQueues: new Map(),
        BILLING_TIERS: new Set(['connect', 'plus', 'pro', 'managed', 'event']),
        BILLING_STATUSES: new Set(['active', 'inactive', 'trialing', 'canceled', 'past_due']),
        logAudit: vi.fn(),
      });
      appInfo.churches.set('church-1', { churchId: 'church-1', name: 'Grace Church', sockets: new Map(), status: 'ok', lastSeen: null });
      client = createClient(appInfo.app);
    });

    it('lists churches, updates billing, and deletes through queryClient', async () => {
      const list = await client.get('/api/churches');
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].churchId).toBe('church-1');

      const billing = await client.put('/api/churches/church-1/billing', {
        body: { tier: 'plus', status: 'active', billingInterval: 'annual' },
      });
      expect(billing.status).toBe(200);
      expect(billing.body.billing.tier).toBe('plus');

      const billingRow = db.prepare('SELECT tier, status, billing_interval FROM billing_customers WHERE church_id = ?').get('church-1');
      expect(billingRow.tier).toBe('plus');
      expect(billingRow.status).toBe('active');
      expect(billingRow.billing_interval).toBe('annual');

      const del = await client.delete('/api/churches/church-1');
      expect(del.status).toBe(200);
      expect(del.body.deleted).toBe(true);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM churches WHERE churchId = ?').get('church-1').cnt).toBe(0);
    });
  });

  describe('supportTickets', () => {
    beforeEach(() => {
      db = createDb();
      const churchId = seedChurch(db, { churchId: 'church-1', name: 'Grace Church' });
      seedAlert(db, { churchId, sessionId: 'session-1', roomId: 'room-1', alertType: 'stream_down', severity: 'P2' });
      const appInfo = buildQueryApp(db, setupSupportTicketRoutes, {
        requireAdminJwt: () => (req, res, next) => {
          req.adminUser = { id: 'admin-1', email: 'admin@test.com', role: 'super_admin' };
          next();
        },
        scheduleEngine: {
          isServiceWindow: vi.fn(() => false),
        },
        RELAY_VERSION: '1.0.0-test',
        SUPPORT_TRIAGE_WINDOW_HOURS: 4,
        broadcastToSSE: vi.fn(),
        lifecycleEmails: {
          captureLead: vi.fn(),
          sendLeadWelcome: vi.fn(),
          sendRegistrationConfirmation: vi.fn(),
          sendPasswordReset: vi.fn(),
        },
      });
      appInfo.churches.set('church-1', { churchId: 'church-1', name: 'Grace Church', sockets: new Map(), status: { atem: { connected: false } } });
      client = createClient(appInfo.app);
    });

    it('looks up a church through queryClient for diagnostic bundle requests', async () => {
      const token = makeToken('church-1');
      const bundle = await client.post('/api/church/church-1/diagnostic-bundle', { token, body: {} });
      expect(bundle.status).toBe(503);
      expect(bundle.body.error).toMatch(/not connected/i);
    });

    it('triages, creates, lists, reads, and updates tickets through queryClient', async () => {
      const triage = await client.post('/api/support/triage', {
        body: { churchId: 'church-1', issueCategory: 'stream_down', severity: 'P2', summary: 'Stream dropped' },
      });
      expect(triage.status).toBe(201);
      expect(triage.body.triageId).toBeTruthy();
      expect(triage.body.diagnostics.recentAlerts).toHaveLength(1);

      const triageRow = db.prepare('SELECT * FROM support_triage_runs WHERE id = ?').get(triage.body.triageId);
      expect(triageRow.church_id).toBe('church-1');

      const createTicket = await client.post('/api/support/tickets', {
        body: { churchId: 'church-1', triageId: triage.body.triageId, title: 'Stream issue', description: 'Need help' },
      });
      expect(createTicket.status).toBe(201);
      expect(createTicket.body.ticketId).toBeTruthy();

      const list = await client.get('/api/support/tickets', {});
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);

      const ticket = await client.get(`/api/support/tickets/${createTicket.body.ticketId}`, {});
      expect(ticket.status).toBe(200);
      expect(ticket.body.updates).toHaveLength(1);

      const update = await client.post(`/api/support/tickets/${createTicket.body.ticketId}/updates`, {
        body: { message: 'We are checking it', status: 'waiting_customer' },
      });
      expect(update.status).toBe(200);
      expect(update.body.status).toBe('waiting_customer');

      const patch = await client.put(`/api/support/tickets/${createTicket.body.ticketId}`, {
        body: { status: 'closed', title: 'Resolved' },
      });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe('closed');
      expect(patch.body.title).toBe('Resolved');
    });
  });
});
