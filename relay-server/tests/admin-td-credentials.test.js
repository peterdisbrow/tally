'use strict';

/**
 * Tests for the per-room TD credential endpoints in src/adminPanel.js:
 *   GET    /api/admin/church/:churchId/tds
 *   POST   /api/admin/church/:churchId/tds
 *   PATCH  /api/admin/church/:churchId/tds/:tdId
 *   DELETE /api/admin/church/:churchId/tds/:tdId
 *   POST   /api/admin/church/:churchId/tds/:tdId/set-password
 *   PUT    /api/admin/church/:churchId/tds/:tdId/portal-access
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const { setupAdminPanel } = await import('../src/adminPanel.js');
const { verifyPassword } = await import('../src/auth.js');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      registeredAt TEXT
    );

    CREATE TABLE church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      telegram_user_id TEXT NOT NULL,
      telegram_chat_id TEXT,
      name TEXT NOT NULL,
      role TEXT,
      email TEXT,
      phone TEXT,
      access_level TEXT DEFAULT 'operator',
      portal_enabled INTEGER DEFAULT 0,
      password_hash TEXT,
      last_portal_login TEXT,
      registered_at TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      UNIQUE(telegram_user_id)
    );

    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      church_id TEXT,
      campus_id TEXT NOT NULL,
      name TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE td_room_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      td_id INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      church_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(td_id, room_id)
    );

    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      role TEXT,
      active INTEGER DEFAULT 1
    );
  `);
  db.prepare('INSERT INTO churches (churchId, name, registeredAt) VALUES (?, ?, ?)')
    .run('church-1', 'Test Church', new Date().toISOString());
  return db;
}

function createMockApp() {
  const routes = { get: {}, post: {}, put: {}, patch: {}, delete: {} };
  const app = {
    use: () => app,
    get:    (path, ...args) => { routes.get[path]    = args; return app; },
    post:   (path, ...args) => { routes.post[path]   = args; return app; },
    put:    (path, ...args) => { routes.put[path]    = args; return app; },
    patch:  (path, ...args) => { routes.patch[path]  = args; return app; },
    delete: (path, ...args) => { routes.delete[path] = args; return app; },
  };
  app.routes = routes;
  return app;
}

function buildReq({ params = {}, body = {}, headers = {}, query = {} } = {}) {
  return {
    params, body, headers, query,
    cookies: {},
    path: '/api/admin/test',
    get: (h) => headers[h.toLowerCase()] || null,
  };
}

function buildRes() {
  const res = { _status: 200, _json: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (data) => { res._json = data; return res; };
  res.send = (data) => { res._sent = data; return res; };
  return res;
}

async function callRoute(app, method, path, req) {
  const args = app.routes[method]?.[path];
  if (!args) throw new Error(`Route not registered: ${method.toUpperCase()} ${path}`);
  const handler = args[args.length - 1];
  const res = buildRes();
  await Promise.resolve(handler(req, res));
  return res;
}

describe('Admin TD Credentials', () => {
  let db, app;

  beforeEach(() => {
    db = createTestDb();
    app = createMockApp();
    process.env.ADMIN_API_KEY = 'test-key';
    setupAdminPanel(app, db, new Map(), { getResellerById: () => null, getResellerStats: () => ({}), getResellers: () => [] }, {
      jwt: { verify: () => ({ type: 'admin', userId: 'u1', role: 'super_admin' }) },
      JWT_SECRET: 'test-secret',
      logAudit: () => {},
    });
  });

  afterEach(() => {
    db.close();
    delete process.env.ADMIN_API_KEY;
  });

  describe('POST /api/admin/church/:churchId/tds', () => {
    it('creates a portal-only TD with email', async () => {
      const req = buildReq({
        params: { churchId: 'church-1' },
        body: { name: 'Alice', email: 'alice@church.org', accessLevel: 'operator' },
      });
      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds', req);

      expect(res._status).toBe(201);
      expect(res._json.name).toBe('Alice');
      expect(res._json.email).toBe('alice@church.org');
      expect(res._json.access_level).toBe('operator');
      expect(res._json.has_password).toBe(false);
      expect(res._json.portal_enabled).toBe(false);

      const stored = db.prepare('SELECT * FROM church_tds WHERE email = ?').get('alice@church.org');
      expect(stored).toBeTruthy();
      expect(stored.telegram_user_id).toMatch(/^portal_/);
    });

    it('rejects invalid email format', async () => {
      const req = buildReq({
        params: { churchId: 'church-1' },
        body: { name: 'Bob', email: 'not-an-email' },
      });
      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds', req);
      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/invalid email/i);
    });

    it('rejects duplicate email', async () => {
      await callRoute(app, 'post', '/api/admin/church/:churchId/tds', buildReq({
        params: { churchId: 'church-1' },
        body: { name: 'Alice', email: 'alice@church.org' },
      }));
      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds', buildReq({
        params: { churchId: 'church-1' },
        body: { name: 'Alice2', email: 'ALICE@church.org' },
      }));
      expect(res._status).toBe(409);
    });

    it('coerces invalid accessLevel to operator', async () => {
      const req = buildReq({
        params: { churchId: 'church-1' },
        body: { name: 'Alice', accessLevel: 'superuser' },
      });
      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds', req);
      expect(res._status).toBe(201);
      expect(res._json.access_level).toBe('operator');
    });

    it('rejects empty name', async () => {
      const req = buildReq({
        params: { churchId: 'church-1' },
        body: { name: '   ' },
      });
      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds', req);
      expect(res._status).toBe(400);
    });
  });

  describe('GET /api/admin/church/:churchId/tds', () => {
    it('returns TDs with has_password and portal_enabled flags', async () => {
      db.prepare(
        'INSERT INTO church_tds (church_id, telegram_user_id, name, email, password_hash, portal_enabled, access_level, registered_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
      ).run('church-1', 'portal_a', 'Alice', 'alice@church.org', 'salt:hash', 'admin', new Date().toISOString());

      const res = await callRoute(app, 'get', '/api/admin/church/:churchId/tds', buildReq({
        params: { churchId: 'church-1' },
      }));

      expect(res._status).toBe(200);
      expect(Array.isArray(res._json)).toBe(true);
      expect(res._json).toHaveLength(1);
      expect(res._json[0].has_password).toBe(true);
      expect(res._json[0].portal_enabled).toBe(true);
      expect(res._json[0].access_level).toBe('admin');
      expect(res._json[0].password_hash).toBeUndefined();
    });

    it('embeds room assignments per TD', async () => {
      db.prepare('INSERT INTO rooms (id, campus_id, church_id, name) VALUES (?, ?, ?, ?)')
        .run('room-1', 'church-1', 'church-1', 'Sanctuary');
      db.prepare(
        'INSERT INTO church_tds (church_id, telegram_user_id, name, registered_at) VALUES (?, ?, ?, ?)'
      ).run('church-1', 'portal_a', 'Alice', new Date().toISOString());
      const tdId = db.prepare('SELECT id FROM church_tds WHERE telegram_user_id = ?').get('portal_a').id;
      db.prepare(
        'INSERT INTO td_room_assignments (td_id, room_id, church_id, created_at) VALUES (?, ?, ?, ?)'
      ).run(tdId, 'room-1', 'church-1', new Date().toISOString());

      const res = await callRoute(app, 'get', '/api/admin/church/:churchId/tds', buildReq({
        params: { churchId: 'church-1' },
      }));

      expect(res._json[0].roomAssignments).toHaveLength(1);
      expect(res._json[0].roomAssignments[0].room_name).toBe('Sanctuary');
    });
  });

  describe('POST /api/admin/church/:churchId/tds/:tdId/set-password', () => {
    function seedTd({ email = 'alice@church.org' } = {}) {
      db.prepare(
        'INSERT INTO church_tds (church_id, telegram_user_id, name, email, registered_at) VALUES (?, ?, ?, ?, ?)'
      ).run('church-1', 'portal_a', 'Alice', email, new Date().toISOString());
      return db.prepare('SELECT id FROM church_tds WHERE telegram_user_id = ?').get('portal_a').id;
    }

    it('hashes password and enables portal access', async () => {
      const tdId = seedTd();
      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds/:tdId/set-password', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { password: 'newpass123' },
      }));

      expect(res._status).toBe(200);
      const row = db.prepare('SELECT password_hash, portal_enabled FROM church_tds WHERE id = ?').get(tdId);
      expect(row.password_hash).toBeTruthy();
      expect(row.password_hash).toContain(':');
      expect(verifyPassword('newpass123', row.password_hash)).toBe(true);
      expect(row.portal_enabled).toBe(1);
    });

    it('rejects passwords shorter than 8 characters', async () => {
      const tdId = seedTd();
      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds/:tdId/set-password', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { password: 'short' },
      }));
      expect(res._status).toBe(400);
    });

    it('refuses to set password without an email', async () => {
      db.prepare(
        'INSERT INTO church_tds (church_id, telegram_user_id, name, email, registered_at) VALUES (?, ?, ?, ?, ?)'
      ).run('church-1', 'portal_a', 'Alice', '', new Date().toISOString());
      const tdId = db.prepare('SELECT id FROM church_tds WHERE telegram_user_id = ?').get('portal_a').id;

      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds/:tdId/set-password', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { password: 'newpass123' },
      }));
      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/email/i);
    });

    it('returns 404 for unknown TD', async () => {
      const res = await callRoute(app, 'post', '/api/admin/church/:churchId/tds/:tdId/set-password', buildReq({
        params: { churchId: 'church-1', tdId: '9999' },
        body: { password: 'newpass123' },
      }));
      expect(res._status).toBe(404);
    });
  });

  describe('PUT /api/admin/church/:churchId/tds/:tdId/portal-access', () => {
    function seedTd({ withCreds = true } = {}) {
      const passwordHash = withCreds ? 'salt:hash' : null;
      db.prepare(
        'INSERT INTO church_tds (church_id, telegram_user_id, name, email, password_hash, portal_enabled, registered_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
      ).run('church-1', 'portal_a', 'Alice', 'alice@church.org', passwordHash, new Date().toISOString());
      return db.prepare('SELECT id FROM church_tds WHERE telegram_user_id = ?').get('portal_a').id;
    }

    it('disables portal access', async () => {
      const tdId = seedTd();
      const res = await callRoute(app, 'put', '/api/admin/church/:churchId/tds/:tdId/portal-access', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { enabled: false },
      }));
      expect(res._status).toBe(200);
      expect(res._json.portal_enabled).toBe(false);
      const row = db.prepare('SELECT portal_enabled FROM church_tds WHERE id = ?').get(tdId);
      expect(row.portal_enabled).toBe(0);
    });

    it('refuses to enable when no password is set', async () => {
      const tdId = seedTd({ withCreds: false });
      const res = await callRoute(app, 'put', '/api/admin/church/:churchId/tds/:tdId/portal-access', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { enabled: true },
      }));
      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/email and password/i);
    });

    it('rejects non-boolean enabled flag', async () => {
      const tdId = seedTd();
      const res = await callRoute(app, 'put', '/api/admin/church/:churchId/tds/:tdId/portal-access', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { enabled: 'yes' },
      }));
      expect(res._status).toBe(400);
    });
  });

  describe('PATCH /api/admin/church/:churchId/tds/:tdId', () => {
    function seedTd() {
      db.prepare(
        'INSERT INTO church_tds (church_id, telegram_user_id, name, email, access_level, registered_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('church-1', 'portal_a', 'Alice', 'alice@church.org', 'operator', new Date().toISOString());
      return db.prepare('SELECT id FROM church_tds WHERE telegram_user_id = ?').get('portal_a').id;
    }

    it('updates email and access_level', async () => {
      const tdId = seedTd();
      const res = await callRoute(app, 'patch', '/api/admin/church/:churchId/tds/:tdId', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { email: 'NEW@church.org', accessLevel: 'admin' },
      }));
      expect(res._status).toBe(200);
      const row = db.prepare('SELECT email, access_level FROM church_tds WHERE id = ?').get(tdId);
      expect(row.email).toBe('new@church.org');
      expect(row.access_level).toBe('admin');
    });

    it('rejects invalid access level', async () => {
      const tdId = seedTd();
      const res = await callRoute(app, 'patch', '/api/admin/church/:churchId/tds/:tdId', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { accessLevel: 'godmode' },
      }));
      expect(res._status).toBe(400);
    });

    it('rejects email collision with another TD', async () => {
      const tdId = seedTd();
      db.prepare(
        'INSERT INTO church_tds (church_id, telegram_user_id, name, email, registered_at) VALUES (?, ?, ?, ?, ?)'
      ).run('church-1', 'portal_b', 'Bob', 'bob@church.org', new Date().toISOString());

      const res = await callRoute(app, 'patch', '/api/admin/church/:churchId/tds/:tdId', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
        body: { email: 'bob@church.org' },
      }));
      expect(res._status).toBe(409);
    });
  });

  describe('DELETE /api/admin/church/:churchId/tds/:tdId', () => {
    it('removes TD and cascades room assignments', async () => {
      db.prepare('INSERT INTO rooms (id, campus_id, church_id, name) VALUES (?, ?, ?, ?)')
        .run('room-1', 'church-1', 'church-1', 'Sanctuary');
      db.prepare(
        'INSERT INTO church_tds (church_id, telegram_user_id, name, registered_at) VALUES (?, ?, ?, ?)'
      ).run('church-1', 'portal_a', 'Alice', new Date().toISOString());
      const tdId = db.prepare('SELECT id FROM church_tds WHERE telegram_user_id = ?').get('portal_a').id;
      db.prepare(
        'INSERT INTO td_room_assignments (td_id, room_id, church_id, created_at) VALUES (?, ?, ?, ?)'
      ).run(tdId, 'room-1', 'church-1', new Date().toISOString());

      const res = await callRoute(app, 'delete', '/api/admin/church/:churchId/tds/:tdId', buildReq({
        params: { churchId: 'church-1', tdId: String(tdId) },
      }));

      expect(res._status).toBe(200);
      expect(db.prepare('SELECT COUNT(*) AS c FROM church_tds WHERE id = ?').get(tdId).c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM td_room_assignments WHERE td_id = ?').get(tdId).c).toBe(0);
    });

    it('returns 404 for unknown TD', async () => {
      const res = await callRoute(app, 'delete', '/api/admin/church/:churchId/tds/:tdId', buildReq({
        params: { churchId: 'church-1', tdId: '9999' },
      }));
      expect(res._status).toBe(404);
    });
  });
});
