import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const { ResellerSystem } = require('../src/reseller');

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE resellers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      brand_name TEXT,
      support_email TEXT,
      logo_url TEXT,
      webhook_url TEXT,
      church_limit INTEGER DEFAULT NULL,
      commission_rate REAL,
      created_at TEXT NOT NULL,
      slug TEXT UNIQUE,
      primary_color TEXT DEFAULT '#22c55e',
      custom_domain TEXT,
      active INTEGER DEFAULT 1,
      portal_email TEXT,
      portal_password_hash TEXT,
      portal_password TEXT
    );
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT NOT NULL,
      reseller_id TEXT,
      registration_code TEXT,
      portal_email TEXT,
      portal_password_hash TEXT,
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'inactive'
    );
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function createPostgresLikeClient(db) {
  const translateAlertWindow = (sql) => String(sql)
    .replace(
      /datetime\(a\.created_at\) > datetime\('now', '-24 hours'\)/g,
      "a.created_at::timestamptz > NOW() - INTERVAL '24 hours'"
    )
    .replace(
      /datetime\(a\.created_at\) > datetime\('now', '-(\d+) hours'\)/g,
      "a.created_at::timestamptz > NOW() - INTERVAL '$1 hours'"
    )
    .replace(
      /a\.created_at::timestamptz > NOW\(\) - INTERVAL '(\d+) hours'/g,
      (_, hours) => `datetime(a.created_at) > datetime('now', '-${hours} hours')`
    );

  return {
    driver: 'postgres',
    async exec(sql) {
      db.exec(sql);
    },
    async query(sql, params = []) {
      return db.prepare(translateAlertWindow(sql)).all(...params);
    },
    async queryOne(sql, params = []) {
      return db.prepare(translateAlertWindow(sql)).get(...params) || null;
    },
    async run(sql, params = []) {
      const info = db.prepare(translateAlertWindow(sql)).run(...params);
      return {
        changes: Number(info?.changes || 0),
        lastInsertRowid: info?.lastInsertRowid ?? null,
        rows: [],
      };
    },
    async close() {},
  };
}

describe('ResellerSystem', () => {
  let db;
  let queryClient;
  let resellerSystem;

  describe('SQLite compatibility', () => {
    beforeEach(() => {
      db = createDb();
    });

    afterEach(() => {
      db?.close();
      db = null;
    });

    it('preserves synchronous reseller operations with a raw sqlite database', () => {
      const resellerSystem = new ResellerSystem(db);
      const created = resellerSystem.createReseller({ name: 'Alpha Resale', churchLimit: 2 });

      expect(created.name).toBe('Alpha Resale');
      expect(created.slug).toBe('alpha-resale');

      const bySlug = resellerSystem.getResellerBySlug('alpha-resale');
      expect(bySlug).toMatchObject({ name: 'Alpha Resale', active: 1 });

      const churches = resellerSystem.getResellerChurches(created.resellerId);
      expect(churches).toEqual([]);

      const detail = resellerSystem.getResellerDetail(created.resellerId);
      expect(detail?.reseller).toMatchObject({ name: 'Alpha Resale' });
      expect(detail?.churches).toEqual([]);

      expect(resellerSystem.canAddChurch(created.resellerId)).toBe(true);
    });
  });

  describe('query client mode', () => {
    beforeEach(async () => {
      db = createDb();
      queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    });

    afterEach(async () => {
      if (resellerSystem && typeof resellerSystem.flushWrites === 'function') {
        await resellerSystem.flushWrites().catch(() => {});
      }
      resellerSystem = null;
      await queryClient?.close();
      queryClient = null;
      db?.close();
      db = null;
    });

    it('hydrates existing rows into a sync-shaped cache', async () => {
      const seededResellerId = 'seed-reseller-1';
      const seededChurchId = 'seed-church-1';
      db.prepare(`
        INSERT INTO resellers
          (id, name, api_key, brand_name, support_email, logo_url, webhook_url, church_limit, commission_rate, created_at, slug, primary_color, custom_domain, active, portal_email, portal_password_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        seededResellerId,
        'Seeded Resale',
        'rsl_seed_key',
        'Seeded Brand',
        'support@seed.example',
        null,
        null,
        3,
        null,
        new Date().toISOString(),
        'seeded-resale',
        '#22c55e',
        null,
        1,
        'owner@seed.example',
        'salt:hash'
      );
      db.prepare(`
        INSERT INTO churches
          (churchId, name, email, token, registeredAt, reseller_id, registration_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        seededChurchId,
        'Seed Church',
        'seed@church.example',
        'token-seed',
        new Date().toISOString(),
        seededResellerId,
        'ABC123'
      );
      db.prepare(`
        INSERT INTO alerts (id, church_id, severity, created_at)
        VALUES (?, ?, ?, ?)
      `).run('alert-seed', seededChurchId, 'CRITICAL', new Date().toISOString());

      resellerSystem = new ResellerSystem(queryClient);
      await resellerSystem.ready;

      expect(() => db.prepare('SELECT reseller_id FROM churches LIMIT 1').get()).not.toThrow();
      expect(() => db.prepare('SELECT registration_code FROM churches LIMIT 1').get()).not.toThrow();

      const byId = resellerSystem.getResellerById(seededResellerId);
      expect(byId).toMatchObject({
        id: seededResellerId,
        name: 'Seeded Resale',
        active: 1,
      });

      const bySlug = resellerSystem.getResellerBySlug('seeded-resale');
      expect(bySlug).toMatchObject({ id: seededResellerId, name: 'Seeded Resale' });

      const churches = resellerSystem.getResellerChurches(seededResellerId);
      expect(Array.isArray(churches)).toBe(true);
      expect(churches).toHaveLength(1);
      expect(churches[0]).toMatchObject({ churchId: seededChurchId, reseller_id: seededResellerId });

      const stats = resellerSystem.getResellerStats(seededResellerId);
      expect(stats).toMatchObject({
        churchCount: 1,
        onlineCount: 0,
        alertCount: 1,
        church_limit: 3,
      });

      const deleted = resellerSystem.deleteChurch(seededChurchId);
      expect(deleted).toMatchObject({ churchId: seededChurchId });
      await resellerSystem.flushWrites();

      expect(resellerSystem.getChurchById(seededChurchId)).toBeNull();
      expect(resellerSystem.getResellerStats(seededResellerId)).toMatchObject({
        churchCount: 0,
        alertCount: 0,
      });

      const list = resellerSystem.listResellers();
      expect(Array.isArray(list)).toBe(true);
      expect(list[0]).not.toHaveProperty('api_key');
      expect(list[0]).toMatchObject({ id: seededResellerId, churchCount: 0 });
    });

    it('keeps alert counting working when the client reports postgres', async () => {
      const pgClient = createPostgresLikeClient(db);
      db.prepare(`
        INSERT INTO resellers
          (id, name, api_key, created_at, slug, active)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run('pg-reseller-1', 'PG Resale', 'rsl_pg_key', new Date().toISOString(), 'pg-resale');
      db.prepare(`
        INSERT INTO churches
          (churchId, name, email, token, registeredAt, reseller_id, registration_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('pg-church-1', 'PG Church', 'pg@church.example', 'token-pg', new Date().toISOString(), 'pg-reseller-1', 'PG123');
      db.prepare(`
        INSERT INTO alerts (id, church_id, severity, created_at)
        VALUES (?, ?, ?, ?)
      `).run('pg-alert-1', 'pg-church-1', 'WARNING', new Date().toISOString());

      resellerSystem = new ResellerSystem(pgClient);
      await resellerSystem.ready;

      expect(resellerSystem.getResellerStats('pg-reseller-1')).toMatchObject({
        churchCount: 1,
        alertCount: 1,
      });
    });

    it('updates the cache immediately and flushes queued writes later', async () => {
      resellerSystem = new ResellerSystem(queryClient);
      await resellerSystem.ready;

      const created = await resellerSystem.createReseller({
        name: 'Beta Resale',
        brandName: 'Beta Brand',
        supportEmail: 'support@beta.example',
        churchLimit: 1,
      });

      expect(typeof created?.then).toBe('undefined');
      expect(resellerSystem.getResellerBySlug(created.slug)).toMatchObject({
        id: created.resellerId,
        name: 'Beta Resale',
        brand_name: 'Beta Brand',
      });
      expect(resellerSystem.getResellerById(created.resellerId)).toMatchObject({
        id: created.resellerId,
        name: 'Beta Resale',
      });

      expect(db.prepare('SELECT id FROM resellers WHERE id = ?').get(created.resellerId)).toBeUndefined();

      await resellerSystem.flushWrites();

      const persistedReseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(created.resellerId);
      expect(persistedReseller).toMatchObject({
        id: created.resellerId,
        name: 'Beta Resale',
        slug: created.slug,
      });

      const loaded = resellerSystem.getResellerBySlug(created.slug);
      expect(loaded).toMatchObject({
        id: created.resellerId,
        name: 'Beta Resale',
        brand_name: 'Beta Brand',
      });

      expect(resellerSystem.canAddChurch(created.resellerId)).toBe(true);

      const tokenResult = resellerSystem.generateChurchToken(created.resellerId, 'Beta Church');
      expect(tokenResult).toMatchObject({
        churchName: 'Beta Church',
        registrationCode: expect.any(String),
        token: expect.any(String),
      });

      expect(resellerSystem.canAddChurch(created.resellerId)).toBe(false);
      expect(resellerSystem.getResellerChurches(created.resellerId)).toHaveLength(1);

      expect(() => resellerSystem.generateChurchToken(created.resellerId, 'Second Church')).toThrow(/Church limit reached/);

      const churches = resellerSystem.getResellerChurches(created.resellerId);
      expect(churches).toHaveLength(1);
      expect(churches[0]).toMatchObject({
        name: 'Beta Church',
        reseller_id: created.resellerId,
      });

      const branding = resellerSystem.getBranding(created.resellerId);
      expect(branding).toEqual({
        brandName: 'Beta Brand',
        supportEmail: 'support@beta.example',
        logoUrl: null,
        primaryColor: '#22c55e',
      });

      const detail = resellerSystem.getResellerDetail(created.resellerId);
      expect(detail).toMatchObject({
        reseller: expect.objectContaining({ name: 'Beta Resale' }),
      });
      expect(detail.churches).toHaveLength(1);

      const updated = resellerSystem.updateReseller(created.resellerId, { support_email: 'help@beta.example' });
      expect(updated.support_email).toBe('help@beta.example');
      expect(resellerSystem.getResellerById(created.resellerId).support_email).toBe('help@beta.example');
      resellerSystem.updateReseller(created.resellerId, {
        portal_email: 'owner@beta.example',
        portal_password_hash: 'salt:hash',
      });
      expect(resellerSystem.getResellerByPortalEmail('owner@beta.example')).toMatchObject({
        id: created.resellerId,
        portal_email: 'owner@beta.example',
      });

      const patchedChurch = resellerSystem.updateChurch(tokenResult.churchId, {
        email: 'contact@beta.example',
        portal_email: 'portal@beta.example',
        portal_password_hash: 'church:salt',
      });
      expect(patchedChurch).toMatchObject({
        churchId: tokenResult.churchId,
        email: 'contact@beta.example',
        portal_email: 'portal@beta.example',
      });
      expect(resellerSystem.getChurchById(tokenResult.churchId)).toMatchObject({
        churchId: tokenResult.churchId,
        portal_email: 'portal@beta.example',
      });
      expect(resellerSystem.getChurchByPortalEmail('portal@beta.example')).toMatchObject({
        churchId: tokenResult.churchId,
      });
      expect(resellerSystem.getChurchForReseller(created.resellerId, tokenResult.churchId)).toMatchObject({
        churchId: tokenResult.churchId,
        reseller_id: created.resellerId,
      });

      resellerSystem.deactivateReseller(created.resellerId);
      expect(resellerSystem.getResellerById(created.resellerId).active).toBe(0);

      const registered = resellerSystem.registerChurch(created.resellerId, tokenResult.churchId, 'Beta Church');
      expect(registered).toMatchObject({
        churchId: tokenResult.churchId,
        reseller_id: created.resellerId,
      });

      await resellerSystem.flushWrites();

      const persistedChurch = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(tokenResult.churchId);
      expect(persistedChurch).toMatchObject({
        churchId: tokenResult.churchId,
        reseller_id: created.resellerId,
        portal_email: 'portal@beta.example',
      });

      const list = resellerSystem.listResellers();
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty('api_key');
      expect(list[0]).toMatchObject({
        name: 'Beta Resale',
        churchCount: 1,
      });

      const deleted = resellerSystem.deleteChurch(tokenResult.churchId);
      expect(deleted).toMatchObject({ churchId: tokenResult.churchId });
      expect(resellerSystem.getChurchById(tokenResult.churchId)).toBeNull();
      await resellerSystem.flushWrites();
      expect(db.prepare('SELECT * FROM churches WHERE churchId = ?').get(tokenResult.churchId)).toBeUndefined();
    });
  });
});
