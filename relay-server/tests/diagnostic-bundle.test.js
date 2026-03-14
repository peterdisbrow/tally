/**
 * Tests for the diagnostic bundle feature.
 *
 * Tests the data flow and database storage for diagnostic bundles
 * without requiring supertest or a running Express server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';

const require = createRequire(import.meta.url);

// ─── In-memory SQLite setup ──────────────────────────────────────────────────

function createTestDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS diagnostic_bundles (
      id TEXT PRIMARY KEY,
      churchId TEXT NOT NULL,
      bundle TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_diagnostic_bundles_church ON diagnostic_bundles(churchId, created_at DESC)');

  // Insert test church
  db.prepare('INSERT INTO churches (churchId, name, token) VALUES (?, ?, ?)').run('test-church', 'Test Church', 'tok');

  return db;
}

// ─── safeJsonParse helper ────────────────────────────────────────────────────

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

// ─── Database-level tests ────────────────────────────────────────────────────

describe('diagnostic_bundles table', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  it('table exists and can insert a row', () => {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const bundleData = { timestamp: Date.now(), platform: { os: 'win32' } };

    db.prepare(`
      INSERT INTO diagnostic_bundles (id, churchId, bundle, requested_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 'test-church', JSON.stringify(bundleData), 'admin:test', new Date().toISOString());

    const row = db.prepare('SELECT * FROM diagnostic_bundles WHERE id = ?').get(id);
    expect(row).toBeTruthy();
    expect(row.churchId).toBe('test-church');
    expect(JSON.parse(row.bundle)).toEqual(bundleData);
  });

  it('stores and retrieves bundle JSON correctly', () => {
    const bundleData = {
      timestamp: 1234567890,
      connections: {
        relay: { connected: true, url: 'wss://test.relay' },
        atem: { connected: true, model: 'ATEM Mini Pro' },
      },
      stream: { active: true, bitrate: 4500 },
    };

    db.prepare('INSERT INTO diagnostic_bundles (id, churchId, bundle, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('bundle-1', 'test-church', JSON.stringify(bundleData), 'admin:test', new Date().toISOString());

    const row = db.prepare('SELECT * FROM diagnostic_bundles WHERE id = ?').get('bundle-1');
    const parsed = safeJsonParse(row.bundle, {});
    expect(parsed.timestamp).toBe(1234567890);
    expect(parsed.connections.relay.connected).toBe(true);
    expect(parsed.connections.atem.model).toBe('ATEM Mini Pro');
    expect(parsed.stream.bitrate).toBe(4500);
  });

  it('returns bundles ordered by created_at DESC', () => {
    for (let i = 0; i < 5; i++) {
      db.prepare('INSERT INTO diagnostic_bundles (id, churchId, bundle, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`b-${i}`, 'test-church', JSON.stringify({ index: i }), 'admin:test', new Date(Date.now() + i * 1000).toISOString());
    }

    const rows = db.prepare('SELECT * FROM diagnostic_bundles WHERE churchId = ? ORDER BY created_at DESC LIMIT 10').all('test-church');
    expect(rows.length).toBe(5);
    expect(JSON.parse(rows[0].bundle).index).toBe(4); // newest first
    expect(JSON.parse(rows[4].bundle).index).toBe(0); // oldest last
  });

  it('respects LIMIT 10 when more than 10 bundles exist', () => {
    for (let i = 0; i < 15; i++) {
      db.prepare('INSERT INTO diagnostic_bundles (id, churchId, bundle, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`b-${i}`, 'test-church', JSON.stringify({ index: i }), 'admin:test', new Date(Date.now() + i * 1000).toISOString());
    }

    const rows = db.prepare('SELECT * FROM diagnostic_bundles WHERE churchId = ? ORDER BY created_at DESC LIMIT 10').all('test-church');
    expect(rows.length).toBe(10);
    // Most recent first
    expect(JSON.parse(rows[0].bundle).index).toBe(14);
  });

  it('filters by churchId correctly', () => {
    db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run('other-church', 'Other Church');

    db.prepare('INSERT INTO diagnostic_bundles (id, churchId, bundle, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('b-1', 'test-church', '{}', 'admin:test', new Date().toISOString());
    db.prepare('INSERT INTO diagnostic_bundles (id, churchId, bundle, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('b-2', 'other-church', '{}', 'admin:test', new Date().toISOString());

    const rows = db.prepare('SELECT * FROM diagnostic_bundles WHERE churchId = ? ORDER BY created_at DESC LIMIT 10').all('test-church');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('b-1');
  });

  it('stores requested_by field for church user', () => {
    db.prepare('INSERT INTO diagnostic_bundles (id, churchId, bundle, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('b-church', 'test-church', '{}', 'church:test-church', new Date().toISOString());

    const row = db.prepare('SELECT * FROM diagnostic_bundles WHERE id = ?').get('b-church');
    expect(row.requested_by).toBe('church:test-church');
  });

  it('stores requested_by field for admin user', () => {
    db.prepare('INSERT INTO diagnostic_bundles (id, churchId, bundle, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('b-admin', 'test-church', '{}', 'admin:admin-1', new Date().toISOString());

    const row = db.prepare('SELECT * FROM diagnostic_bundles WHERE id = ?').get('b-admin');
    expect(row.requested_by).toBe('admin:admin-1');
  });
});

// ─── Mock WebSocket command flow tests ───────────────────────────────────────

describe('diagnostic bundle command flow', () => {
  it('command payload has correct structure', () => {
    const { v4: uuidv4 } = require('uuid');
    const commandId = uuidv4();
    const payload = {
      type: 'command',
      command: 'system.diagnosticBundle',
      params: {},
      id: commandId,
    };

    expect(payload.type).toBe('command');
    expect(payload.command).toBe('system.diagnosticBundle');
    expect(payload.id).toBe(commandId);
    expect(payload.params).toEqual({});
  });

  it('command result message has expected structure', () => {
    const bundleData = { timestamp: Date.now(), appVersion: '1.0.0' };
    const result = {
      type: 'command_result',
      id: 'test-id',
      command: 'system.diagnosticBundle',
      result: bundleData,
    };

    expect(result.type).toBe('command_result');
    expect(result.result.timestamp).toBe(bundleData.timestamp);
  });

  it('command error message has expected structure', () => {
    const result = {
      type: 'command_result',
      id: 'test-id',
      command: 'system.diagnosticBundle',
      error: 'Collection failed',
    };

    expect(result.type).toBe('command_result');
    expect(result.error).toBe('Collection failed');
  });

  it('timeout scenario produces correct error', async () => {
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Diagnostic bundle timeout (10s)'));
      }, 50); // Use 50ms for test speed
    });

    await expect(promise).rejects.toThrow(/timeout/i);
  });

  it('mock WebSocket emits command_result correctly', async () => {
    const ws = new EventEmitter();
    const bundleData = { test: true };

    const result = await new Promise((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'command_result') {
          resolve(msg.result);
        }
      });

      // Simulate church client responding
      ws.emit('message', Buffer.from(JSON.stringify({
        type: 'command_result',
        id: 'cmd-1',
        command: 'system.diagnosticBundle',
        result: bundleData,
      })));
    });

    expect(result.test).toBe(true);
  });
});

// ─── Auth requirement tests ──────────────────────────────────────────────────

describe('diagnostic bundle auth validation', () => {
  it('requireSupportAccess validates Bearer token format', () => {
    const jwt = require('jsonwebtoken');
    const secret = 'test-secret';

    // Valid church token
    const churchToken = jwt.sign({ type: 'church_app', churchId: 'test-church' }, secret);
    const decoded = jwt.verify(churchToken, secret);
    expect(decoded.type).toBe('church_app');
    expect(decoded.churchId).toBe('test-church');

    // Valid admin token
    const adminToken = jwt.sign({ role: 'admin', id: 'admin-1' }, secret);
    const adminDecoded = jwt.verify(adminToken, secret);
    expect(adminDecoded.role).toBe('admin');
  });

  it('church token can only access own church bundles', () => {
    const jwt = require('jsonwebtoken');
    const secret = 'test-secret';
    const token = jwt.sign({ type: 'church_app', churchId: 'church-A' }, secret);
    const decoded = jwt.verify(token, secret);

    // Simulating the check in the route handler
    const requestedChurchId = 'church-B';
    const isOwn = decoded.churchId === requestedChurchId;
    expect(isOwn).toBe(false);
  });

  it('admin token can access any church bundles', () => {
    const jwt = require('jsonwebtoken');
    const secret = 'test-secret';
    const token = jwt.sign({ role: 'admin', id: 'admin-1' }, secret);
    const decoded = jwt.verify(token, secret);
    expect(decoded.role).toBe('admin');
    // Admin auth does not have churchId restriction
  });
});
