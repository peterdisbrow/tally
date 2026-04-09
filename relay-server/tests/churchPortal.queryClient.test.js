import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { SqliteQueryClient } = require('../src/db/queryClient');
const { setupChurchPortal } = require('../src/churchPortal');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'church-portal-query-client-secret';

function issueToken(churchId) {
  return jwt.sign({ type: 'church_portal', churchId }, JWT_SECRET, { expiresIn: '7d' });
}

function issueTdToken(churchId, tdId) {
  return jwt.sign(
    { type: 'td_portal', churchId, tdId, accessLevel: 'operator' },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      registeredAt TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'active',
      billing_interval TEXT DEFAULT 'monthly',
      billing_trial_ends TEXT,
      room_id TEXT,
      room_name TEXT,
      portal_email TEXT,
      portal_password_hash TEXT,
      notifications TEXT DEFAULT '{}',
      schedule TEXT DEFAULT '{}',
      referral_code TEXT,
      failover_enabled INTEGER DEFAULT 0,
      failover_black_threshold_s INTEGER DEFAULT 5,
      failover_ack_timeout_s INTEGER DEFAULT 30,
      failover_action TEXT,
      failover_auto_recover INTEGER DEFAULT 0,
      failover_audio_trigger INTEGER DEFAULT 0,
      recovery_outside_service_hours INTEGER DEFAULT 1,
      escalation_enabled INTEGER DEFAULT 0,
      escalation_timing_json TEXT,
      onboarding_dismissed INTEGER DEFAULT 0,
      onboarding_failover_tested_at TEXT,
      onboarding_team_invited_at TEXT,
      ingest_stream_key TEXT
    );
    CREATE TABLE billing_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      billing_interval TEXT,
      tier TEXT,
      status TEXT,
      trial_ends_at TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE church_reviews (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      reviewer_name TEXT NOT NULL,
      reviewer_role TEXT DEFAULT '',
      rating INTEGER NOT NULL,
      body TEXT NOT NULL,
      church_name TEXT NOT NULL,
      approved INTEGER DEFAULT 0,
      featured INTEGER DEFAULT 0,
      submitted_at TEXT NOT NULL,
      approved_at TEXT,
      source TEXT DEFAULT 'portal'
    );
    CREATE TABLE referrals (
      id TEXT PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL,
      referred_name TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      credit_amount INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      converted_at TEXT,
      credited_at TEXT
    );
    CREATE TABLE email_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      email_type TEXT NOT NULL,
      recipient TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
    CREATE TABLE session_recaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      title TEXT
    );
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT DEFAULT 'open'
    );
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      alert_type TEXT,
      severity TEXT,
      context TEXT DEFAULT '{}',
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      escalated INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0,
      instance_name TEXT
    );
    CREATE TABLE service_events (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      instance_name TEXT,
      event_type TEXT,
      session_id TEXT
    );
    CREATE TABLE service_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      grade TEXT NOT NULL
    );
    CREATE TABLE preservice_rundowns (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      service_time TEXT,
      overall_status TEXT,
      confirmed_by TEXT,
      confirmed_at TEXT,
      escalation_level TEXT,
      ai_summary TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE problem_finder_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      instance_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE preservice_check_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      instance_name TEXT,
      room_id TEXT,
      checks_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      telegram_user_id TEXT,
      telegram_chat_id TEXT,
      name TEXT,
      registered_at TEXT,
      active INTEGER DEFAULT 1,
      role TEXT DEFAULT 'td',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      access_level TEXT DEFAULT 'operator',
      portal_enabled INTEGER DEFAULT 0,
      password_hash TEXT,
      last_portal_login TEXT
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      campus_id TEXT NOT NULL,
      church_id TEXT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      stream_key TEXT
    );
    CREATE TABLE room_equipment (
      room_id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      equipment TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE td_room_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      td_id INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      church_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE smart_plugs (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      plug_ip TEXT NOT NULL,
      plug_name TEXT NOT NULL DEFAULT '',
      room_id TEXT,
      assigned_device TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE church_macros (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeSetupDbProxy(db) {
  let allowPrepare = true;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (...args) => {
          if (!allowPrepare) {
            throw new Error('churchPortal queryClient path should not call db.prepare');
          }
          return target.prepare(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    db: proxy,
    lock() { allowPrepare = false; },
  };
}

function seedChurch(db, opts = {}) {
  db.prepare(`
    INSERT INTO churches (
      churchId, name, registeredAt, billing_tier, billing_status, billing_interval,
      billing_trial_ends, room_id, room_name, referral_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.churchId,
    opts.name || 'Test Church',
    opts.registeredAt || new Date().toISOString(),
    opts.billingTier || 'pro',
    opts.billingStatus || 'active',
    opts.billingInterval || 'monthly',
    opts.billingTrialEnds || null,
    opts.roomId || null,
    opts.roomName || null,
    opts.referralCode || 'ABC123',
  );
}

function seedRoom(db, opts = {}) {
  db.prepare('INSERT INTO rooms (id, campus_id, church_id, name, description, created_at, deleted_at, stream_key) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(opts.roomId, opts.churchId, opts.churchId, opts.name || 'Main', opts.description || '', opts.createdAt || new Date().toISOString(), opts.streamKey || 'sk-main');
}

function seedTd(db, opts = {}) {
  db.prepare('INSERT INTO church_tds (church_id, name, registered_at, active, role, email, phone, access_level, portal_enabled) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1)')
    .run(opts.churchId, opts.name || 'Taylor', opts.registeredAt || new Date().toISOString(), opts.role || 'td', opts.email || 'td@example.com', opts.phone || '', opts.accessLevel || 'operator');
}

function seedBillingCustomer(db, opts = {}) {
  db.prepare(`
    INSERT INTO billing_customers (
      church_id, stripe_customer_id, stripe_subscription_id, billing_interval,
      tier, status, trial_ends_at, current_period_end, cancel_at_period_end,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.churchId,
    opts.stripeCustomerId || 'cus_test_123',
    opts.stripeSubscriptionId || 'sub_test_123',
    opts.billingInterval || 'monthly',
    opts.tier || 'pro',
    opts.status || 'active',
    opts.trialEndsAt || null,
    opts.currentPeriodEnd || null,
    opts.cancelAtPeriodEnd ? 1 : 0,
    opts.createdAt || new Date().toISOString(),
    opts.updatedAt || new Date().toISOString(),
  );
}

function seedReview(db, opts = {}) {
  db.prepare(`
    INSERT INTO church_reviews (
      id, church_id, reviewer_name, reviewer_role, rating, body, church_name,
      approved, featured, submitted_at, approved_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id || 'review-1',
    opts.churchId,
    opts.reviewerName || 'Alex',
    opts.reviewerRole || 'Director',
    opts.rating || 5,
    opts.body || 'Excellent experience with Tally.',
    opts.churchName || 'Grace Church',
    opts.approved ? 1 : 0,
    opts.featured ? 1 : 0,
    opts.submittedAt || new Date().toISOString(),
    opts.approvedAt || null,
    opts.source || 'portal',
  );
}

function seedReferral(db, opts = {}) {
  db.prepare(`
    INSERT INTO referrals (
      id, referrer_id, referred_id, referred_name, status, credit_amount,
      created_at, converted_at, credited_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id || 'referral-1',
    opts.referrerId,
    opts.referredId || 'church-ref-2',
    opts.referredName || 'Cornerstone Church',
    opts.status || 'credited',
    opts.creditAmount || 25,
    opts.createdAt || new Date().toISOString(),
    opts.convertedAt || null,
    opts.creditedAt || null,
  );
}

function seedSessionRecap(db, opts = {}) {
  db.prepare('INSERT INTO session_recaps (church_id, started_at, ended_at, title) VALUES (?, ?, ?, ?)')
    .run(opts.churchId, opts.startedAt || new Date().toISOString(), opts.endedAt || null, opts.title || 'Sunday recap');
}

function seedEmailSend(db, opts = {}) {
  db.prepare('INSERT INTO email_sends (church_id, email_type, recipient, sent_at) VALUES (?, ?, ?, ?)')
    .run(opts.churchId, opts.emailType || 'billing_receipt', opts.recipient || 'finance@example.com', opts.sentAt || new Date().toISOString());
}

function seedServiceSession(db, opts = {}) {
  db.prepare('INSERT INTO service_sessions (church_id, started_at, grade) VALUES (?, ?, ?)')
    .run(opts.churchId, opts.startedAt || new Date().toISOString(), opts.grade || 'Clean');
}

function buildApp(db, queryClient, churches, extras = {}) {
  const app = express();
  app.use(express.json());
  app.use(require('cookie-parser')());

  const requireAdmin = (req, _res, next) => {
    req.adminUser = { id: 'admin-1', email: 'admin@example.com' };
    next();
  };

  setupChurchPortal(app, db, churches, JWT_SECRET, requireAdmin, {
    billing: null,
    lifecycleEmails: null,
    preServiceCheck: null,
    sessionRecap: extras.sessionRecap || null,
    weeklyDigest: null,
    rundownEngine: null,
    scheduler: null,
    aiRateLimiter: null,
    guestTdMode: null,
    signalFailover: extras.signalFailover || null,
    broadcastToPortal: null,
    aiTriageEngine: null,
    preServiceRundown: extras.preServiceRundown || null,
    viewerBaseline: null,
    streamOAuth: extras.streamOAuth || null,
    queryClient,
  });

  return app;
}

describe('churchPortal queryClient surface', () => {
  let db;
  let queryClient;
  let cleanup;
  let client;
  let app;
  let setupDb;
  let churches;
  let churchId;
  let token;
  let tdToken;

  function authCookie(value) {
    return { cookie: `tally_church_session=${value}` };
  }

  beforeEach(() => {
    db = createDb();
    const proxy = makeSetupDbProxy(db);
    queryClient = new SqliteQueryClient(db);
    churches = new Map();
    churchId = 'church-qc-1';
    const registeredAt = new Date(Date.now() - 45 * 86400000).toISOString();
    seedChurch(db, { churchId, name: 'Grace Church', registeredAt, referralCode: 'GRACE123', billingInterval: 'annual' });
    seedRoom(db, { churchId, roomId: 'room-1', name: 'Main Sanctuary' });
    seedTd(db, { churchId, name: 'Taylor' });
    seedBillingCustomer(db, { churchId, billingInterval: 'annual', tier: 'pro', status: 'active' });
    seedSessionRecap(db, { churchId, title: 'Easter recap' });
    seedEmailSend(db, { churchId });
    seedReview(db, { churchId, approved: true, featured: true });
    seedReferral(db, { referrerId: churchId, creditAmount: 40, status: 'credited' });
    seedServiceSession(db, { churchId, grade: 'Clean' });
    seedServiceSession(db, { churchId, grade: 'Clean' });
    seedServiceSession(db, { churchId, grade: 'Good' });
    seedServiceSession(db, { churchId, grade: 'Clean' });
    churches.set(churchId, {
      churchId,
      name: 'Grace Church',
      sockets: new Map(),
      roomInstanceMap: {},
      instanceStatus: {},
      status: {},
    });
    token = issueToken(churchId);
    tdToken = issueTdToken(churchId, 1);

    setupDb = proxy.db;
    app = buildApp(setupDb, queryClient, churches);
    proxy.lock();
    client = createClient(app);
    cleanup = async () => {
      if (client) await client.close();
      await queryClient.close();
      db.close();
    };
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    client = null;
    cleanup = null;
    queryClient = null;
    db = null;
    churches = null;
  });

  it('manages rooms without hitting db.prepare', async () => {
    const list = await client.get('/api/church/rooms', authCookie(token));
    expect(list.status).toBe(200);
    expect(list.body.rooms).toHaveLength(1);

    const created = await client.post('/api/church/rooms', {
      ...authCookie(token),
      body: { name: 'Youth Room', description: 'Downstairs' },
    });
    expect(created.status).toBe(201);

    const updated = await client.patch(`/api/church/rooms/${created.body.id}`, {
      ...authCookie(token),
      body: { name: 'Youth Center' },
    });
    expect(updated.status).toBe(200);

    const assigned = await client.post('/api/church/room-assign', {
      ...authCookie(token),
      body: { roomId: created.body.id },
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.roomName).toBe('Youth Center');

    const roomRow = db.prepare('SELECT room_id, room_name FROM churches WHERE churchId = ?').get(churchId);
    expect(roomRow.room_id).toBe(created.body.id);
    expect(roomRow.room_name).toBe('Youth Center');
  });

  it('manages smart plugs and TD room selections without db.prepare', async () => {
    const plug = await client.post('/api/church/smart-plugs', {
      ...authCookie(token),
      body: { plugIp: '10.0.0.10', plugName: 'Projector Plug' },
    });
    expect(plug.status).toBe(200);

    const patch = await client.patch(`/api/church/smart-plugs/${plug.body.id}`, {
      ...authCookie(token),
      body: { roomId: 'room-1', assignedDevice: 'Projector' },
    });
    expect(patch.status).toBe(200);

    const plugs = await client.get('/api/church/smart-plugs', authCookie(token));
    expect(plugs.status).toBe(200);
    expect(plugs.body.plugs).toHaveLength(1);
    expect(plugs.body.plugs[0].plug_ip).toBe('10.0.0.10');

    const tdRooms = await client.get('/api/church/tds', authCookie(token));
    expect(tdRooms.status).toBe(200);
    expect(tdRooms.body[0].roomAssignments).toHaveLength(0);

    const tdAssignment = await client.post('/api/church/tds/1/rooms', {
      ...authCookie(token),
      body: { roomId: 'room-1' },
    });
    expect(tdAssignment.status).toBe(200);

    const tdRoomsAfter = await client.get('/api/church/tds', authCookie(token));
    expect(tdRoomsAfter.body[0].roomAssignments).toHaveLength(1);

    const selectRoom = await client.post('/api/td/select-room', {
      cookie: `tally_church_session=${tdToken}`,
      body: { roomId: 'room-1' },
    });
    expect(selectRoom.status).toBe(200);
    expect(selectRoom.body.roomId).toBe('room-1');
  });

  it('manages TD macros without hitting db.prepare', async () => {
    const created = await client.post('/api/church/macros', {
      ...authCookie(token),
      body: { name: 'start_stream', description: 'Start the stream', steps: [{ command: 'start_stream' }] },
    });
    expect(created.status).toBe(200);

    const listed = await client.get('/api/church/macros', authCookie(token));
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);

    const fetched = await client.get(`/api/church/macros/${created.body.id}`, authCookie(token));
    expect(fetched.status).toBe(200);
    expect(fetched.body.name).toBe('start_stream');

    const updated = await client.put(`/api/church/macros/${created.body.id}`, {
      ...authCookie(token),
      body: { name: 'start_stream', description: 'Updated', steps: [{ command: 'start_stream' }, { command: 'mute' }] },
    });
    expect(updated.status).toBe(200);

    const deleted = await client.delete(`/api/church/macros/${created.body.id}`, authCookie(token));
    expect(deleted.status).toBe(200);
  });

  it('serves billing, export, reviews, and referrals from queryClient', async () => {
    const billing = await client.get('/api/church/billing', authCookie(token));
    expect(billing.status).toBe(200);
    expect(billing.body.tier).toBe('pro');
    expect(billing.body.billingInterval).toBe('annual');
    expect(billing.body.cancelAtPeriodEnd).toBe(false);

    const exported = await client.get('/api/church/data-export', authCookie(token));
    expect(exported.status).toBe(200);
    expect(exported.body.church.churchId).toBe(churchId);
    expect(exported.body.billing.tier).toBe('pro');
    expect(exported.body.sessions).toHaveLength(1);
    expect(exported.body.reviews).toHaveLength(1);
    expect(exported.body.referrals).toHaveLength(1);
    expect(exported.body.emailsSent).toHaveLength(1);

    const reviewState = await client.get('/api/church/review', authCookie(token));
    expect(reviewState.status).toBe(200);
    expect(reviewState.body.hasReview).toBe(true);
    expect(reviewState.body.review.rating).toBe(5);

    const publicReviews = await client.get('/api/public/reviews');
    expect(publicReviews.status).toBe(200);
    expect(publicReviews.body.reviews).toHaveLength(1);
    expect(publicReviews.body.reviews[0].featured).toBe(1);

    const adminReviews = await client.get('/api/admin/reviews');
    expect(adminReviews.status).toBe(200);
    expect(adminReviews.body.reviews).toHaveLength(1);

    const approve = await client.put('/api/admin/reviews/review-1/approve');
    expect(approve.status).toBe(200);

    const feature = await client.put('/api/admin/reviews/review-1/feature');
    expect(feature.status).toBe(200);
    expect(feature.body.featured).toBe(0);

    const deleteReview = await client.delete('/api/admin/reviews/review-1');
    expect(deleteReview.status).toBe(200);

    const submitted = await client.post('/api/church/review', {
      ...authCookie(token),
      body: {
        rating: 5,
        body: 'Tally made our Sunday setup much easier.',
        reviewerName: 'Alex',
        reviewerRole: 'Director',
      },
    });
    expect(submitted.status).toBe(200);

    const referrals = await client.get('/api/church/referrals', authCookie(token));
    expect(referrals.status).toBe(200);
    expect(referrals.body.referralCode).toBe('GRACE123');
    expect(referrals.body.totalCredits).toBe(40);
    expect(referrals.body.totalReferred).toBe(1);
  });

  it('serves onboarding, failover, alerts, session history, and rundown data from queryClient', async () => {
    db.prepare(`UPDATE churches SET failover_enabled = 1, failover_black_threshold_s = 9, failover_ack_timeout_s = 45, failover_audio_trigger = 1 WHERE churchId = ?`)
      .run(churchId);
    db.prepare('INSERT INTO alerts (id, church_id, alert_type, severity, context, created_at, resolved, instance_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('alert-1', churchId, 'video_drop', 'P2', JSON.stringify({ diagnosis: { likely_cause: 'OBS offline' } }), '2025-03-10T09:00:00.000Z', 0, null);
    db.prepare('INSERT INTO alerts (id, church_id, alert_type, severity, context, created_at, resolved, instance_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('alert-2', churchId, 'audio_silence', 'P1', '{}', '2025-03-11T09:00:00.000Z', 1, null);
    db.prepare('INSERT INTO room_equipment (room_id, church_id, equipment, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)')
      .run('room-1', churchId, JSON.stringify({ atemIp: '10.0.0.50' }), new Date().toISOString(), churchId);
    db.prepare('INSERT INTO preservice_check_results (church_id, instance_name, room_id, checks_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(churchId, null, 'room-1', JSON.stringify([
        { name: 'ATEM', pass: true, detail: 'connected' },
        { name: 'OBS', pass: true, detail: 'connected' },
      ]), '2025-03-11T08:00:00.000Z');
    db.prepare('INSERT INTO preservice_rundowns (id, church_id, service_time, overall_status, confirmed_by, confirmed_at, escalation_level, ai_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('rundown-1', churchId, '2025-03-11T09:30:00.000Z', 'ready', 'portal', '2025-03-11T09:15:00.000Z', 'low', 'All good', '2025-03-11T09:00:00.000Z');
    db.prepare('INSERT INTO service_events (id, church_id, timestamp, instance_name, event_type, session_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('event-1', churchId, '2025-03-11T09:05:00.000Z', 'room-1', 'signal_drop', 'session-1');

    const onboardingDismiss = await client.post('/api/church/onboarding/dismiss', authCookie(token));
    expect(onboardingDismiss.status).toBe(200);
    const onboardingUndo = await client.post('/api/church/onboarding/undismiss', authCookie(token));
    expect(onboardingUndo.status).toBe(200);

    const failover = await client.get('/api/church/failover', authCookie(token));
    expect(failover.status).toBe(200);
    expect(failover.body.enabled).toBe(true);

    const failoverUpdate = await client.put('/api/church/failover', {
      ...authCookie(token),
      body: { enabled: false, blackThresholdS: 7, ackTimeoutS: 30, autoRecover: false, audioTrigger: false, recoveryOutsideServiceHours: true },
    });
    expect(failoverUpdate.status).toBe(200);

    const alerts = await client.get('/api/church/alerts', authCookie(token));
    expect(alerts.status).toBe(200);
    expect(alerts.body).toHaveLength(2);
    expect(alerts.body[0].alert_type).toBe('audio_silence');

    const preservice = await client.get('/api/church/preservice-check?roomId=room-1', authCookie(token));
    expect(preservice.status).toBe(200);
    expect(JSON.parse(preservice.body.checks_json)).toHaveLength(1);

    const rundownHistory = await client.get('/api/church/rundown/history', authCookie(token));
    expect(rundownHistory.status).toBe(200);
    expect(rundownHistory.body).toHaveLength(1);

    const rundownSettings = await client.get('/api/church/rundown/escalation-settings', authCookie(token));
    expect(rundownSettings.status).toBe(200);
    expect(rundownSettings.body.enabled).toBe(false);

    const dashboard = await client.get('/api/church/dashboard/stats', authCookie(token));
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.thisWeek).toBeDefined();
    expect(dashboard.body.trend).toBeDefined();

    const sessionRecap = {
      getActiveSession: () => ({
        sessionId: 'session-1',
        started_at: '2025-03-11T09:00:00.000Z',
        ended_at: null,
        grade: 'Clean',
        alert_count: 1,
        auto_recovered_count: 1,
        escalated_count: 0,
        stream_runtime_minutes: 55,
      }),
    };
    const sessionApp = buildApp(setupDb, queryClient, churches, { sessionRecap });
    const sessionClient = createClient(sessionApp);
    try {
      const sessionActive = await sessionClient.get('/api/church/session/active', authCookie(token));
      expect(sessionActive.status).toBe(200);
      expect(sessionActive.body.active).toBe(true);
      expect(sessionActive.body.events).toHaveLength(1);
    } finally {
      await sessionClient.close();
    }
  });

  it('serves compact live status for overview polling', async () => {
    db.prepare('INSERT INTO room_equipment (room_id, church_id, equipment, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)')
      .run('room-1', churchId, JSON.stringify({ atemIp: '10.0.0.50', encoderType: 'obs' }), new Date().toISOString(), churchId);

    churches.set(churchId, {
      churchId,
      name: 'Grace Church',
      sockets: new Map([['instance-main', { readyState: 1 }]]),
      roomInstanceMap: { 'room-1': 'instance-main' },
      instanceStatus: {
        'instance-main': {
          atem: { connected: true, model: 'ATEM Mini' },
          encoder: { connected: true, type: 'obs' },
        },
      },
      status: {
        atem: { connected: true, model: 'ATEM Mini' },
        encoder: { connected: true, type: 'obs' },
      },
      lastSeen: '2025-03-11T09:30:00.000Z',
      broadcastHealth: { youtube: { connected: true } },
    });

    const live = await client.get('/api/church/live-status?roomId=room-1', authCookie(token));
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({
      connected: true,
      lastSeen: '2025-03-11T09:30:00.000Z',
      audio_via_atem: false,
      broadcastHealth: { youtube: { connected: true } },
    });
    expect(live.body.status.atem).toMatchObject({ connected: true, model: 'ATEM Mini' });
    expect(live.body.status.encoder).toMatchObject({ connected: true, type: 'obs' });
    expect(live.body).not.toHaveProperty('tds');
    expect(live.body).not.toHaveProperty('notifications');
  });
});
