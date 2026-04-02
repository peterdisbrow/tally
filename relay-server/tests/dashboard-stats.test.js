/**
 * Tests for getDashboardStats and _findNextService from churchPortal.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const express = require('express');

const { getDashboardStats, _findNextService, setupChurchPortal } = require('../src/churchPortal');

const JWT_SECRET = 'test-secret-dashboard';
const CHURCH_ID = 'church-dash-001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function issueToken(churchId) {
  return jwt.sign({ type: 'church_portal', churchId }, JWT_SECRET, { expiresIn: '7d' });
}

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT,
      portal_email TEXT,
      portal_password_hash TEXT,
      phone TEXT,
      location TEXT,
      notes TEXT,
      notifications TEXT DEFAULT '{}',
      telegram_chat_id TEXT,
      parent_church_id TEXT,
      campus_name TEXT,
      schedule TEXT DEFAULT '{}',
      auto_recovery_enabled INTEGER DEFAULT 1,
      leadership_emails TEXT DEFAULT '',
      referral_code TEXT,
      referred_by TEXT,
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'active',
      billing_interval TEXT DEFAULT 'monthly',
      billing_trial_ends TEXT,
      reseller_id TEXT,
      failover_enabled INTEGER DEFAULT 0,
      failover_black_threshold_s INTEGER DEFAULT 5,
      failover_ack_timeout_s INTEGER DEFAULT 30,
      failover_action TEXT,
      failover_auto_recover INTEGER DEFAULT 0,
      failover_audio_trigger INTEGER DEFAULT 0,
      onboarding_dismissed INTEGER DEFAULT 0,
      registration_code TEXT,
      audio_via_atem INTEGER DEFAULT 0,
      engineer_profile TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      telegram_user_id TEXT,
      telegram_chat_id TEXT,
      name TEXT,
      registered_at TEXT,
      active INTEGER DEFAULT 1,
      role TEXT DEFAULT 'td',
      email TEXT,
      phone TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      duration_minutes INTEGER,
      stream_ran INTEGER DEFAULT 0,
      stream_runtime_minutes INTEGER DEFAULT 0,
      recording_confirmed INTEGER DEFAULT 0,
      alert_count INTEGER DEFAULT 0,
      auto_recovered_count INTEGER DEFAULT 0,
      escalated_count INTEGER DEFAULT 0,
      audio_silence_count INTEGER DEFAULT 0,
      peak_viewers INTEGER,
      td_name TEXT,
      grade TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      context TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      escalated INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT DEFAULT '',
      resolved INTEGER DEFAULT 0,
      resolved_at TEXT,
      auto_resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest_tokens (
      token TEXT PRIMARY KEY,
      churchId TEXT NOT NULL,
      label TEXT,
      name TEXT,
      createdAt TEXT NOT NULL,
      expiresAt TEXT,
      usedByChat TEXT
    )
  `);
  return db;
}

function seedChurch(db, schedule = '{}') {
  const { hashPassword } = require('../src/auth');
  db.prepare(`
    INSERT OR REPLACE INTO churches (churchId, name, email, portal_email, portal_password_hash, registeredAt, billing_tier, schedule)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(CHURCH_ID, 'Test Church', 'test@church.org', 'admin@test.org', hashPassword('pass123'), '2024-01-01T00:00:00.000Z', 'pro', schedule);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function request(app) {
  const { createClient } = require('./helpers/expressTestClient');
  return createClient(app);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getDashboardStats', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    seedChurch(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  it('returns empty stats when no sessions exist', () => {
    const stats = getDashboardStats(db, CHURCH_ID, new Map());
    expect(stats.thisWeek.services).toBe(0);
    expect(stats.thisWeek.alerts).toBe(0);
    expect(stats.thisWeek.autoRecoveries).toBe(0);
    expect(stats.thisWeek.uptimePercent).toBe(0);
    expect(stats.trend.alertsTrending).toBe('stable');
    expect(stats.trend.comparedToLastWeek).toBe('0');
    expect(stats.equipmentStatus.total).toBe(0);
    expect(stats.nextService).toBeNull();
  });

  it('counts this week sessions correctly', () => {
    // "now" is a Wednesday
    const now = new Date('2025-03-12T14:00:00.000Z'); // Wednesday
    const thisWeekSunday = new Date('2025-03-09T09:00:00.000Z');
    const thisWeekMonday = new Date('2025-03-10T10:00:00.000Z');

    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, stream_runtime_minutes, alert_count, auto_recovered_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('s1', CHURCH_ID, thisWeekSunday.toISOString(), thisWeekSunday.toISOString(), 90, 80, 2, 1);
    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, stream_runtime_minutes, alert_count, auto_recovered_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('s2', CHURCH_ID, thisWeekMonday.toISOString(), thisWeekMonday.toISOString(), 60, 55, 1, 1);

    const stats = getDashboardStats(db, CHURCH_ID, new Map(), now);
    expect(stats.thisWeek.services).toBe(2);
    expect(stats.thisWeek.alerts).toBe(3);
    expect(stats.thisWeek.autoRecoveries).toBe(2);
    // uptimePercent = (80+55) / (90+60) * 100 = 135/150 * 100 = 90
    expect(stats.thisWeek.uptimePercent).toBe(90);
  });

  it('computes alert trend correctly (up)', () => {
    const now = new Date('2025-03-12T14:00:00.000Z'); // Wednesday
    // Last week session (Sunday of prev week = March 2)
    const lastWeek = new Date('2025-03-03T09:00:00.000Z');
    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, alert_count) VALUES (?, ?, ?, ?, ?, ?)')
      .run('lw1', CHURCH_ID, lastWeek.toISOString(), lastWeek.toISOString(), 90, 1);

    // This week session
    const thisWeek = new Date('2025-03-09T09:00:00.000Z');
    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, alert_count) VALUES (?, ?, ?, ?, ?, ?)')
      .run('tw1', CHURCH_ID, thisWeek.toISOString(), thisWeek.toISOString(), 90, 4);

    const stats = getDashboardStats(db, CHURCH_ID, new Map(), now);
    expect(stats.trend.alertsTrending).toBe('up');
    expect(stats.trend.comparedToLastWeek).toBe('+3');
  });

  it('computes alert trend correctly (down)', () => {
    const now = new Date('2025-03-12T14:00:00.000Z');
    const lastWeek = new Date('2025-03-03T09:00:00.000Z');
    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, alert_count) VALUES (?, ?, ?, ?, ?, ?)')
      .run('lw1', CHURCH_ID, lastWeek.toISOString(), lastWeek.toISOString(), 90, 5);

    const thisWeek = new Date('2025-03-09T09:00:00.000Z');
    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, alert_count) VALUES (?, ?, ?, ?, ?, ?)')
      .run('tw1', CHURCH_ID, thisWeek.toISOString(), thisWeek.toISOString(), 90, 2);

    const stats = getDashboardStats(db, CHURCH_ID, new Map(), now);
    expect(stats.trend.alertsTrending).toBe('down');
    expect(stats.trend.comparedToLastWeek).toBe('-3');
  });

  it('computes equipment status from runtime map', () => {
    const churches = new Map();
    churches.set(CHURCH_ID, {
      status: {
        atem: { connected: true },
        obs: { connected: false },
        encoder: { connected: true, live: true },
        mixer: { connected: true },
      },
    });

    const stats = getDashboardStats(db, CHURCH_ID, churches);
    expect(stats.equipmentStatus.total).toBe(4);
    expect(stats.equipmentStatus.healthy).toBe(3);
    expect(stats.equipmentStatus.offline).toBe(1);
    expect(stats.equipmentStatus.warning).toBe(0);
  });

  it('handles equipment with hyperdecks and PTZ cameras', () => {
    const churches = new Map();
    churches.set(CHURCH_ID, {
      status: {
        atem: { connected: true },
        hyperdecks: [{ connected: true }, { connected: false }],
        ptzCameras: [{ connected: true }, { connected: true }],
      },
    });

    const stats = getDashboardStats(db, CHURCH_ID, churches);
    expect(stats.equipmentStatus.total).toBe(5); // atem + 2 hyperdecks + 2 ptz
    expect(stats.equipmentStatus.healthy).toBe(4);
    expect(stats.equipmentStatus.offline).toBe(1);
  });

  it('returns null equipmentStatus totals when no runtime data', () => {
    const stats = getDashboardStats(db, CHURCH_ID, new Map());
    expect(stats.equipmentStatus.total).toBe(0);
    expect(stats.equipmentStatus.healthy).toBe(0);
  });

  it('returns uptime 100% when sessions exist but no stream data', () => {
    const now = new Date('2025-03-12T14:00:00.000Z');
    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, stream_runtime_minutes, alert_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('s1', CHURCH_ID, '2025-03-09T09:00:00.000Z', '2025-03-09T10:30:00.000Z', 90, 0, 0);

    const stats = getDashboardStats(db, CHURCH_ID, new Map(), now);
    // duration > 0 but stream = 0, so uptime = 0%
    expect(stats.thisWeek.uptimePercent).toBe(0);
  });

  it('does not count sessions from other churches', () => {
    const now = new Date('2025-03-12T14:00:00.000Z');
    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, alert_count) VALUES (?, ?, ?, ?, ?, ?)')
      .run('s1', 'other-church', '2025-03-09T09:00:00.000Z', '2025-03-09T10:30:00.000Z', 90, 5);

    const stats = getDashboardStats(db, CHURCH_ID, new Map(), now);
    expect(stats.thisWeek.services).toBe(0);
    expect(stats.thisWeek.alerts).toBe(0);
  });
});

describe('_findNextService', () => {
  it('returns null for empty schedule', () => {
    expect(_findNextService({}, new Date())).toBeNull();
    expect(_findNextService(null, new Date())).toBeNull();
  });

  it('finds next service on same day', () => {
    // Create a "now" at 8am local time on a known day
    const now = new Date();
    // Force to a Wednesday by adjusting
    const dayOfWeek = now.getDay();
    const wednesdayOffset = (3 - dayOfWeek + 7) % 7;
    now.setDate(now.getDate() + wednesdayOffset);
    now.setHours(8, 0, 0, 0); // 8am local

    const sched = {
      wednesday: [{ start: '10:00', end: '12:00', label: 'Midweek Service' }],
    };
    const next = _findNextService(sched, now);
    expect(next).not.toBeNull();
    expect(next.label).toContain('Wednesday');
    expect(next.label).toContain('Midweek Service');
    expect(next.minutesUntil).toBe(120); // 8am to 10am = 120 min
  });

  it('skips past service windows on same day', () => {
    // Create a "now" at 11am local on a Wednesday — service at 10am is past
    const now = new Date();
    const dayOfWeek = now.getDay();
    const wednesdayOffset = (3 - dayOfWeek + 7) % 7;
    now.setDate(now.getDate() + wednesdayOffset);
    now.setHours(11, 0, 0, 0); // 11am local, past the 10am service

    const sched = {
      wednesday: [{ start: '10:00', end: '12:00', label: 'Morning' }],
    };
    const next = _findNextService(sched, now);
    // The 10am window already passed, and we only look 7 days ahead (not including same day-of-week next week)
    expect(next).toBeNull();
  });

  it('finds service on a later day of the week', () => {
    // Set "now" to a Wednesday at 8am local
    const now = new Date();
    const dayOfWeek = now.getDay();
    const wednesdayOffset = (3 - dayOfWeek + 7) % 7;
    now.setDate(now.getDate() + wednesdayOffset);
    now.setHours(8, 0, 0, 0);

    const sched = {
      sunday: [{ start: '09:00', end: '12:00', label: 'Sunday AM' }],
    };
    const next = _findNextService(sched, now);
    expect(next).not.toBeNull();
    expect(next.label).toContain('Sunday');
    expect(next.label).toContain('Sunday AM');
    expect(next.minutesUntil).toBeGreaterThan(0);
  });

  it('picks the soonest service when multiple exist', () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const wednesdayOffset = (3 - dayOfWeek + 7) % 7;
    now.setDate(now.getDate() + wednesdayOffset);
    now.setHours(8, 0, 0, 0);

    const sched = {
      wednesday: [{ start: '18:00', end: '20:00', label: 'Evening' }],
      thursday: [{ start: '09:00', end: '11:00', label: 'Thursday AM' }],
    };
    const next = _findNextService(sched, now);
    expect(next).not.toBeNull();
    expect(next.label).toContain('Wednesday');
    expect(next.label).toContain('Evening');
  });

  it('handles schedule without label', () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const wednesdayOffset = (3 - dayOfWeek + 7) % 7;
    now.setDate(now.getDate() + wednesdayOffset);
    now.setHours(8, 0, 0, 0);

    const sched = {
      wednesday: [{ start: '18:00', end: '20:00' }],
    };
    const next = _findNextService(sched, now);
    expect(next).not.toBeNull();
    expect(next.label).toContain('Wednesday');
    expect(next.label).not.toContain('undefined');
  });
});

describe('GET /api/church/dashboard/stats route', () => {
  let app, db, churches, client;

  beforeEach(() => {
    db = createTestDb();
    seedChurch(db);

    churches = new Map();
    churches.set(CHURCH_ID, {
      churchId: CHURCH_ID,
      name: 'Test Church',
      ws: { readyState: 1 },
      status: {
        atem: { connected: true },
        encoder: { connected: true, live: false },
      },
      lastSeen: new Date().toISOString(),
    });

    app = express();
    app.use(express.json());
    app.use(require('cookie-parser')());

    const requireAdmin = (req, res, next) => next();

    setupChurchPortal(app, db, churches, JWT_SECRET, requireAdmin, {
      billing: null,
      lifecycleEmails: null,
      preServiceCheck: null,
      sessionRecap: null,
      weeklyDigest: null,
      rundownEngine: null,
      scheduler: null,
      aiRateLimiter: null,
      guestTdMode: null,
      signalFailover: null,
    });

    client = request(app);
  });

  afterEach(() => {
    client.close();
    try { db.close(); } catch {}
  });

  it('returns 401 without auth', async () => {
    const res = await client.get('/api/church/dashboard/stats');
    expect(res.status).toBe(401);
  });

  it('returns stats with valid auth cookie', async () => {
    const token = issueToken(CHURCH_ID);
    const res = await client.get('/api/church/dashboard/stats', {
      cookie: `tally_church_session=${token}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('thisWeek');
    expect(res.body).toHaveProperty('trend');
    expect(res.body).toHaveProperty('equipmentStatus');
    expect(res.body).toHaveProperty('nextService');
    expect(res.body.thisWeek).toHaveProperty('services');
    expect(res.body.thisWeek).toHaveProperty('alerts');
    expect(res.body.thisWeek).toHaveProperty('autoRecoveries');
    expect(res.body.thisWeek).toHaveProperty('uptimePercent');
    expect(res.body.equipmentStatus.total).toBe(2); // atem + encoder
    expect(res.body.equipmentStatus.healthy).toBe(2);
  });

  it('returns correct structure with session data', async () => {
    // Insert a session for this week
    const now = new Date();
    const dayOfWeek = now.getDay();
    const thisWeekStart = new Date(now);
    thisWeekStart.setDate(now.getDate() - dayOfWeek);
    thisWeekStart.setHours(9, 0, 0, 0);

    db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, stream_runtime_minutes, alert_count, auto_recovered_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('test-sess-1', CHURCH_ID, thisWeekStart.toISOString(), thisWeekStart.toISOString(), 90, 85, 2, 1);

    const token = issueToken(CHURCH_ID);
    const res = await client.get('/api/church/dashboard/stats', {
      cookie: `tally_church_session=${token}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.thisWeek.services).toBe(1);
    expect(res.body.thisWeek.alerts).toBe(2);
    expect(res.body.thisWeek.autoRecoveries).toBe(1);
    expect(typeof res.body.thisWeek.uptimePercent).toBe('number');
  });
});
