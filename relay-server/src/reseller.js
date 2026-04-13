/**
 * Reseller System — White-label reseller support for Tally
 *
 * Allows other integrators to rebrand and resell Tally monitoring
 * to their own church clients under a custom brand.
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createQueryClient } = require('./db');
const { getJwtSecret } = require('./jwtSecret');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

class ResellerSystem {
  constructor(dbOrClient) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient);
    this._resellerCache = new Map();
    this._churchCache = new Map();
    this._alertCountCache = new Map();
    this._writeTail = Promise.resolve();
    this.ready = this.db ? Promise.resolve() : this._init();

    if (this.db) {
      this._ensureSchemaSync();
    }
  }

  _resolveClient(dbOrClient) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client) throw new Error('[ResellerSystem] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureSchemaAsync();
    await this._loadCache();
  }

  _slugify(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  _ensureSchemaSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resellers (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        api_key        TEXT NOT NULL UNIQUE,
        brand_name     TEXT,
        support_email  TEXT,
        logo_url       TEXT,
        webhook_url    TEXT,
        church_limit   INTEGER DEFAULT NULL,
        commission_rate REAL,
        created_at     TEXT NOT NULL,
        slug           TEXT UNIQUE,
        primary_color  TEXT DEFAULT '#22c55e',
        custom_domain  TEXT,
        active         INTEGER DEFAULT 1
      )
    `);

    const newColumns = [
      "ALTER TABLE resellers ADD COLUMN slug TEXT",
      "ALTER TABLE resellers ADD COLUMN primary_color TEXT DEFAULT '#22c55e'",
      "ALTER TABLE resellers ADD COLUMN custom_domain TEXT",
      "ALTER TABLE resellers ADD COLUMN active INTEGER DEFAULT 1",
      "ALTER TABLE resellers ADD COLUMN portal_email TEXT",
      "ALTER TABLE resellers ADD COLUMN portal_password_hash TEXT",
      "ALTER TABLE resellers ADD COLUMN portal_password TEXT",
      "ALTER TABLE resellers ADD COLUMN commission_rate REAL",
    ];
    for (const col of newColumns) {
      try { this.db.exec(col); } catch { /* column already exists */ }
    }

    try { this.db.exec("UPDATE resellers SET church_limit = NULL WHERE church_limit = 10"); } catch { /* ok */ }

    try {
      this.db.prepare('SELECT reseller_id FROM churches LIMIT 1').get();
    } catch {
      this.db.exec('ALTER TABLE churches ADD COLUMN reseller_id TEXT');
    }

    try {
      this.db.exec('ALTER TABLE churches ADD COLUMN registration_code TEXT');
    } catch { /* already exists */ }
  }

  async _ensureSchemaAsync() {
    const client = this._requireClient();
    await client.exec(`
      CREATE TABLE IF NOT EXISTS resellers (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        api_key        TEXT NOT NULL UNIQUE,
        brand_name     TEXT,
        support_email  TEXT,
        logo_url       TEXT,
        webhook_url    TEXT,
        church_limit   INTEGER DEFAULT NULL,
        commission_rate REAL,
        created_at     TEXT NOT NULL,
        slug           TEXT UNIQUE,
        primary_color  TEXT DEFAULT '#22c55e',
        custom_domain  TEXT,
        active         INTEGER DEFAULT 1
      )
    `);

    const newColumns = [
      "ALTER TABLE resellers ADD COLUMN slug TEXT",
      "ALTER TABLE resellers ADD COLUMN primary_color TEXT DEFAULT '#22c55e'",
      "ALTER TABLE resellers ADD COLUMN custom_domain TEXT",
      "ALTER TABLE resellers ADD COLUMN active INTEGER DEFAULT 1",
      "ALTER TABLE resellers ADD COLUMN portal_email TEXT",
      "ALTER TABLE resellers ADD COLUMN portal_password_hash TEXT",
      "ALTER TABLE resellers ADD COLUMN portal_password TEXT",
      "ALTER TABLE resellers ADD COLUMN commission_rate REAL",
    ];
    for (const col of newColumns) {
      try { await client.exec(col); } catch { /* column already exists */ }
    }

    try {
      await client.exec("UPDATE resellers SET church_limit = NULL WHERE church_limit = 10");
    } catch { /* ok */ }

    try {
      await client.queryOne('SELECT reseller_id FROM churches LIMIT 1');
    } catch {
      await client.exec('ALTER TABLE churches ADD COLUMN reseller_id TEXT');
    }

    try {
      await client.exec('ALTER TABLE churches ADD COLUMN registration_code TEXT');
    } catch { /* already exists */ }
  }

  async _loadCache() {
    const client = this._requireClient();
    const [resellers, churches, alertCounts] = await Promise.all([
      client.query('SELECT * FROM resellers ORDER BY created_at DESC').catch(() => []),
      client.query('SELECT * FROM churches').catch(() => []),
      client.query(`
        SELECT c.reseller_id, COUNT(*) AS cnt
        FROM alerts a
        JOIN churches c ON a.church_id = c.churchId
        WHERE a.severity != 'INFO'
          AND ${this._recentAlertPredicate('a.created_at', 24)}
        GROUP BY c.reseller_id
      `).catch(() => []),
    ]);

    this._resellerCache.clear();
    this._churchCache.clear();
    this._alertCountCache.clear();

    for (const row of resellers) this._cacheReseller(row);
    for (const row of churches) this._cacheChurch(row);
    for (const row of alertCounts) {
      if (row?.reseller_id) this._alertCountCache.set(row.reseller_id, Number(row.cnt || 0));
    }
  }

  async _one(sql, params = []) {
    return this._requireClient().queryOne(sql, params);
  }

  async _all(sql, params = []) {
    return this._requireClient().query(sql, params);
  }

  async _run(sql, params = []) {
    return this._requireClient().run(sql, params);
  }

  flushWrites() {
    return this._writeTail;
  }

  _enqueueWrite(label, work) {
    if (this.db) return Promise.resolve().then(work);

    const next = this._writeTail.then(async () => {
      await this.ready;
      return work();
    });
    this._writeTail = next.then(() => undefined, () => undefined);
    next.catch(err => {
      console.error(`[ResellerSystem] ${label} failed: ${err.message}`);
    });
    return next;
  }

  _cloneRow(row) {
    return row ? { ...row } : null;
  }

  _normalizeResellerRow(row = {}) {
    return {
      ...row,
      church_limit: row.church_limit ?? null,
      commission_rate: row.commission_rate ?? null,
      slug: row.slug ?? null,
      primary_color: row.primary_color || '#22c55e',
      custom_domain: row.custom_domain ?? null,
      active: row.active ?? 1,
      portal_email: row.portal_email ?? null,
      portal_password_hash: row.portal_password_hash ?? null,
    };
  }

  _normalizeChurchRow(row = {}) {
    return {
      ...row,
      reseller_id: row.reseller_id ?? null,
      registration_code: row.registration_code ?? null,
    };
  }

  _cacheReseller(row) {
    const normalized = this._normalizeResellerRow(row);
    if (!normalized.id) return null;
    this._resellerCache.set(normalized.id, normalized);
    return normalized;
  }

  _cacheChurch(row) {
    const normalized = this._normalizeChurchRow(row);
    if (!normalized.churchId) return null;
    this._churchCache.set(normalized.churchId, normalized);
    return normalized;
  }

  _getCachedResellerById(id) {
    return id ? this._resellerCache.get(id) || null : null;
  }

  _getCachedResellerBySlug(slug) {
    if (!slug) return null;
    for (const reseller of this._resellerCache.values()) {
      if (reseller.slug === slug) return reseller;
    }
    return null;
  }

  _getCachedResellerByPortalEmail(email) {
    if (!email) return null;
    const normalizedEmail = String(email).trim().toLowerCase();
    for (const reseller of this._resellerCache.values()) {
      if (String(reseller.portal_email || '').trim().toLowerCase() === normalizedEmail) {
        return reseller;
      }
    }
    return null;
  }

  _getCachedChurchById(churchId) {
    return churchId ? this._churchCache.get(churchId) || null : null;
  }

  _getCachedChurchByPortalEmail(email) {
    if (!email) return null;
    const normalizedEmail = String(email).trim().toLowerCase();
    for (const church of this._churchCache.values()) {
      if (String(church.portal_email || '').trim().toLowerCase() === normalizedEmail) {
        return church;
      }
    }
    return null;
  }

  _getCachedChurchesForReseller(resellerId) {
    return [...this._churchCache.values()].filter(church => church.reseller_id === resellerId);
  }

  _countCachedChurchesForReseller(resellerId) {
    return this._getCachedChurchesForReseller(resellerId).length;
  }

  _countCachedAlertsForReseller(resellerId) {
    return this._alertCountCache.get(resellerId) || 0;
  }

  _recentAlertPredicate(column = 'a.created_at', hours = 24) {
    const safeHours = Math.max(1, Math.min(168, Math.floor(Number(hours)) || 24));
    if (this.client?.driver === 'postgres') {
      return `${column}::timestamptz > NOW() - INTERVAL '${safeHours} hours'`;
    }
    return `datetime(${column}) > datetime('now', '-${safeHours} hours')`;
  }

  _uniqueSlugFromCache(base, excludeId = null) {
    let slug = base;
    let n = 1;
    const hasSlug = candidate => [...this._resellerCache.values()].some(r => r.slug === candidate && r.id !== excludeId);
    while (hasSlug(slug)) {
      slug = `${base}-${n++}`;
    }
    return slug;
  }

  _uniqueSlugSync(base) {
    let slug = base;
    let n = 1;
    while (this.db.prepare('SELECT id FROM resellers WHERE slug = ?').get(slug)) {
      slug = `${base}-${n++}`;
    }
    return slug;
  }

  async _uniqueSlugAsync(base) {
    const client = this._requireClient();
    let slug = base;
    let n = 1;
    while (await client.queryOne('SELECT id FROM resellers WHERE slug = ?', [slug])) {
      slug = `${base}-${n++}`;
    }
    return slug;
  }

  _createResellerSync({ name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit = null, slug, primaryColor, customDomain, commissionRate }) {
    if (!name) throw new Error('name required');

    const resellerId = uuidv4();
    const apiKey = 'rsl_' + crypto.randomBytes(20).toString('hex');
    const createdAt = new Date().toISOString();
    const finalSlug = this._uniqueSlugSync(slug || this._slugify(name));
    const finalColor = primaryColor || '#22c55e';

    this.db.prepare(`
      INSERT INTO resellers
        (id, name, api_key, brand_name, support_email, logo_url, webhook_url, church_limit, created_at, slug, primary_color, custom_domain, active, commission_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      resellerId, name, apiKey,
      brandName || null, supportEmail || null, logoUrl || null, webhookUrl || null,
      churchLimit, createdAt, finalSlug, finalColor, customDomain || null,
      commissionRate != null ? commissionRate : null
    );

    console.log(`[ResellerSystem] Created reseller: "${name}" (${resellerId}) slug="${finalSlug}"`);
    return { resellerId, apiKey, name, slug: finalSlug };
  }

  async _createResellerAsync({ name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit = null, slug, primaryColor, customDomain, commissionRate }) {
    if (!name) throw new Error('name required');

    const resellerId = uuidv4();
    const apiKey = 'rsl_' + crypto.randomBytes(20).toString('hex');
    const createdAt = new Date().toISOString();
    const finalSlug = await this._uniqueSlugAsync(slug || this._slugify(name));
    const finalColor = primaryColor || '#22c55e';

    await this._run(`
      INSERT INTO resellers
        (id, name, api_key, brand_name, support_email, logo_url, webhook_url, church_limit, created_at, slug, primary_color, custom_domain, active, commission_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `, [
      resellerId, name, apiKey,
      brandName || null, supportEmail || null, logoUrl || null, webhookUrl || null,
      churchLimit, createdAt, finalSlug, finalColor, customDomain || null,
      commissionRate != null ? commissionRate : null,
    ]);

    console.log(`[ResellerSystem] Created reseller: "${name}" (${resellerId}) slug="${finalSlug}"`);
    return { resellerId, apiKey, name, slug: finalSlug };
  }

  _createResellerCached({ name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit = null, slug, primaryColor, customDomain, commissionRate }) {
    if (!name) throw new Error('name required');

    const resellerId = uuidv4();
    const apiKey = 'rsl_' + crypto.randomBytes(20).toString('hex');
    const createdAt = new Date().toISOString();
    const finalSlug = this._uniqueSlugFromCache(slug || this._slugify(name));
    const finalColor = primaryColor || '#22c55e';

    this._cacheReseller({
      id: resellerId,
      name,
      api_key: apiKey,
      brand_name: brandName || null,
      support_email: supportEmail || null,
      logo_url: logoUrl || null,
      webhook_url: webhookUrl || null,
      church_limit: churchLimit,
      commission_rate: commissionRate != null ? commissionRate : null,
      created_at: createdAt,
      slug: finalSlug,
      primary_color: finalColor,
      custom_domain: customDomain || null,
      active: 1,
      portal_email: null,
      portal_password_hash: null,
    });

    this._enqueueWrite('createReseller', async () => {
      await this._run(`
        INSERT INTO resellers
          (id, name, api_key, brand_name, support_email, logo_url, webhook_url, church_limit, created_at, slug, primary_color, custom_domain, active, commission_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `, [
        resellerId, name, apiKey,
        brandName || null, supportEmail || null, logoUrl || null, webhookUrl || null,
        churchLimit, createdAt, finalSlug, finalColor, customDomain || null,
        commissionRate != null ? commissionRate : null,
      ]);
    });

    console.log(`[ResellerSystem] Created reseller: "${name}" (${resellerId}) slug="${finalSlug}"`);
    return { resellerId, apiKey, name, slug: finalSlug };
  }

  createReseller(opts) {
    if (this.db) return this._createResellerSync(opts);
    return this._createResellerCached(opts);
  }

  getReseller(apiKey) {
    if (!apiKey) return null;
    if (this.db) return this.db.prepare('SELECT * FROM resellers WHERE api_key = ?').get(apiKey) || null;
    return this._cloneRow([...this._resellerCache.values()].find(r => r.api_key === apiKey) || null);
  }

  getResellerById(id) {
    if (!id) return null;
    if (this.db) return this.db.prepare('SELECT * FROM resellers WHERE id = ?').get(id) || null;
    return this._cloneRow(this._getCachedResellerById(id));
  }

  getResellerBySlug(slug) {
    if (!slug) return null;
    if (this.db) return this.db.prepare('SELECT * FROM resellers WHERE slug = ?').get(slug) || null;
    return this._cloneRow(this._getCachedResellerBySlug(slug));
  }

  getResellerByPortalEmail(email) {
    if (!email) return null;
    const normalizedEmail = String(email).trim().toLowerCase();
    if (this.db) {
      return this.db.prepare('SELECT * FROM resellers WHERE portal_email = ?').get(normalizedEmail) || null;
    }
    return this._cloneRow(this._getCachedResellerByPortalEmail(normalizedEmail));
  }

  updateReseller(resellerId, patch) {
    const allowed = ['name', 'brand_name', 'support_email', 'logo_url', 'primary_color', 'custom_domain', 'webhook_url', 'church_limit', 'commission_rate', 'slug', 'active', 'portal_email', 'portal_password_hash'];
    const fields = Object.keys(patch).filter(k => allowed.includes(k));
    if (fields.length === 0) throw new Error('No valid fields to update');

    const setClauses = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => patch[f]);
    values.push(resellerId);

    if (this.db) {
      this.db.prepare(`UPDATE resellers SET ${setClauses} WHERE id = ?`).run(...values);
      return this.getResellerById(resellerId);
    }

    const current = this._getCachedResellerById(resellerId);
    if (!current) return null;
    const next = this._normalizeResellerRow({ ...current, ...patch, id: resellerId });
    if (patch.slug) {
      next.slug = this._uniqueSlugFromCache(String(patch.slug), resellerId);
    }
    this._cacheReseller(next);
    const writeValues = fields.map(f => (f === 'slug' ? next.slug : patch[f]));
    writeValues.push(resellerId);
    this._enqueueWrite('updateReseller', async () => {
      await this._run(`UPDATE resellers SET ${setClauses} WHERE id = ?`, writeValues);
    });
    return this._cloneRow(next);
  }

  deactivateReseller(resellerId) {
    if (this.db) {
      this.db.prepare('UPDATE resellers SET active = 0 WHERE id = ?').run(resellerId);
      console.log(`[ResellerSystem] Deactivated reseller ${resellerId}`);
      return;
    }

    const current = this._getCachedResellerById(resellerId);
    if (current) {
      this._cacheReseller({ ...current, active: 0 });
    }
    this._enqueueWrite('deactivateReseller', async () => {
      await this._run('UPDATE resellers SET active = 0 WHERE id = ?', [resellerId]);
    });
    console.log(`[ResellerSystem] Deactivated reseller ${resellerId}`);
  }

  listResellers() {
    if (this.db) {
      const resellers = this.db.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all();
      return resellers.map(r => {
        const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE reseller_id = ?').get(r.id);
        const { api_key, ...safe } = r;
        return { ...safe, churchCount: countRow ? countRow.cnt : 0 };
      });
    }

    return [...this._resellerCache.values()]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .map(r => {
        const { api_key, ...safe } = r;
        return { ...safe, churchCount: this._countCachedChurchesForReseller(r.id) };
      });
  }

  getResellerDetail(resellerId) {
    if (this.db) {
      const reseller = this.getResellerById(resellerId);
      if (!reseller) return null;
      const churches = this.getResellerChurches(resellerId);
      const { api_key, ...safe } = reseller;
      return { reseller: safe, churches };
    }

    const reseller = this.getResellerById(resellerId);
    if (!reseller) return null;
    const churches = this.getResellerChurches(resellerId);
    const { api_key, ...safe } = reseller;
    return { reseller: safe, churches };
  }

  getResellerChurches(resellerId) {
    if (this.db) return this.db.prepare('SELECT * FROM churches WHERE reseller_id = ?').all(resellerId);
    return this._getCachedChurchesForReseller(resellerId).map(row => this._cloneRow(row));
  }

  getChurchById(churchId) {
    if (!churchId) return null;
    if (this.db) return this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId) || null;
    return this._cloneRow(this._getCachedChurchById(churchId));
  }

  getChurchByPortalEmail(email) {
    if (!email) return null;
    const normalizedEmail = String(email).trim().toLowerCase();
    if (this.db) {
      return this.db.prepare('SELECT * FROM churches WHERE portal_email = ?').get(normalizedEmail) || null;
    }
    return this._cloneRow(this._getCachedChurchByPortalEmail(normalizedEmail));
  }

  getChurchForReseller(resellerId, churchId) {
    if (!resellerId || !churchId) return null;
    if (this.db) {
      return this.db.prepare('SELECT * FROM churches WHERE churchId = ? AND reseller_id = ?').get(churchId, resellerId) || null;
    }
    const church = this._getCachedChurchById(churchId);
    if (!church || church.reseller_id !== resellerId) return null;
    return this._cloneRow(church);
  }

  updateChurch(churchId, patch) {
    const allowed = ['name', 'email', 'token', 'registeredAt', 'reseller_id', 'registration_code', 'portal_email', 'portal_password_hash'];
    const fields = Object.keys(patch).filter(k => allowed.includes(k));
    if (!churchId || fields.length === 0) throw new Error('No valid fields to update');

    const setClauses = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => patch[f]);
    values.push(churchId);

    if (this.db) {
      this.db.prepare(`UPDATE churches SET ${setClauses} WHERE churchId = ?`).run(...values);
      return this.getChurchById(churchId);
    }

    const current = this._getCachedChurchById(churchId);
    if (!current) return null;
    const next = this._normalizeChurchRow({ ...current, ...patch, churchId });
    this._cacheChurch(next);
    this._enqueueWrite('updateChurch', async () => {
      await this._run(`UPDATE churches SET ${setClauses} WHERE churchId = ?`, values);
    });
    return this._cloneRow(next);
  }

  deleteChurch(churchId) {
    if (!churchId) return null;
    if (this.db) {
      const church = this.getChurchById(churchId);
      if (!church) return null;
      this.db.prepare('DELETE FROM churches WHERE churchId = ?').run(churchId);
      return church;
    }

    const church = this._getCachedChurchById(churchId);
    if (!church) return null;
    this._churchCache.delete(churchId);
    this._enqueueWrite('deleteChurch', async () => {
      await this._run('DELETE FROM churches WHERE churchId = ?', [churchId]);
      if (church.reseller_id) {
        try {
          const row = await this._one(`
            SELECT COUNT(*) AS cnt
            FROM alerts a
            JOIN churches c ON a.church_id = c.churchId
            WHERE c.reseller_id = ? AND a.severity != 'INFO'
              AND ${this._recentAlertPredicate('a.created_at', 24)}
          `, [church.reseller_id]);
          this._alertCountCache.set(church.reseller_id, Number(row?.cnt || 0));
        } catch { /* keep cache best-effort */ }
      }
    });
    return this._cloneRow(church);
  }

  canAddChurch(resellerId) {
    if (this.db) {
      const reseller = this.getResellerById(resellerId);
      if (!reseller) return false;
      if (reseller.church_limit == null) return true;
      const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE reseller_id = ?').get(resellerId);
      const count = countRow ? countRow.cnt : 0;
      return count < reseller.church_limit;
    }

    const reseller = this.getResellerById(resellerId);
    if (!reseller) return false;
    if (reseller.church_limit == null) return true;
    const count = this._countCachedChurchesForReseller(resellerId);
    return count < reseller.church_limit;
  }

  generateChurchToken(resellerId, churchName) {
    if (!resellerId) throw new Error('resellerId required');
    if (!churchName) throw new Error('churchName required');

    if (this.db) {
      const canAdd = this.canAddChurch(resellerId);
      if (!canAdd) {
        const reseller = this.getResellerById(resellerId);
        throw new Error(`Church limit reached (max ${reseller?.church_limit || 0})`);
      }

      const existing = this.db.prepare('SELECT churchId FROM churches WHERE name = ?').get(churchName);
      if (existing) throw new Error(`A church named "${churchName}" already exists`);

      const churchId = uuidv4();
      const jwtSecret = getJwtSecret();
      const token = jwt.sign({ churchId, name: churchName }, jwtSecret, { expiresIn: '365d' });
      const registeredAt = new Date().toISOString();
      const regCode = crypto.randomBytes(3).toString('hex').toUpperCase();

      this.db.prepare(
        'INSERT INTO churches (churchId, name, email, token, registeredAt, reseller_id, registration_code) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(churchId, churchName, '', token, registeredAt, resellerId, regCode);

      console.log(`[ResellerSystem] generateChurchToken: created "${churchName}" (${churchId}) for reseller ${resellerId}`);
      return { churchId, churchName, registrationCode: regCode, token };
    }

    const canAdd = this.canAddChurch(resellerId);
    if (!canAdd) {
      const reseller = this.getResellerById(resellerId);
      throw new Error(`Church limit reached (max ${reseller?.church_limit || 0})`);
    }

    const existing = [...this._churchCache.values()].find(church => church.name === churchName);
    if (existing) throw new Error(`A church named "${churchName}" already exists`);

    const churchId = uuidv4();
    const jwtSecret = getJwtSecret();
    const token = jwt.sign({ churchId, name: churchName }, jwtSecret, { expiresIn: '365d' });
    const registeredAt = new Date().toISOString();
    const regCode = crypto.randomBytes(3).toString('hex').toUpperCase();

    this._cacheChurch({
      churchId,
      name: churchName,
      email: '',
      token,
      registeredAt,
      reseller_id: resellerId,
      registration_code: regCode,
    });

    this._enqueueWrite('generateChurchToken', async () => {
      await this._run(
        'INSERT INTO churches (churchId, name, email, token, registeredAt, reseller_id, registration_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [churchId, churchName, '', token, registeredAt, resellerId, regCode]
      );
    });

    console.log(`[ResellerSystem] generateChurchToken: created "${churchName}" (${churchId}) for reseller ${resellerId}`);
    return { churchId, churchName, registrationCode: regCode, token };
  }

  getResellerStats(resellerId, churchesMap = null) {
    if (this.db) {
      const reseller = this.getResellerById(resellerId);
      if (!reseller) return { churchCount: 0, onlineCount: 0, alertCount: 0, church_limit: 0 };

      const churchCountRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE reseller_id = ?').get(resellerId);
      const churchCount = churchCountRow ? churchCountRow.cnt : 0;

      const alertCountRow = this.db.prepare(`
        SELECT COUNT(*) AS cnt FROM alerts a
        JOIN churches c ON a.church_id = c.churchId
        WHERE c.reseller_id = ? AND a.severity != 'INFO'
        AND datetime(a.created_at) > datetime('now', '-24 hours')
      `).get(resellerId);
      const alertCount = alertCountRow ? alertCountRow.cnt : 0;

      let onlineCount = 0;
      if (churchesMap) {
        const { WebSocket } = require('ws');
        for (const [, church] of churchesMap) {
          const hasOpen = church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN);
          if (church.reseller_id === resellerId && hasOpen) {
            onlineCount++;
          }
        }
      }

      return { churchCount, onlineCount, alertCount, church_limit: reseller.church_limit };
    }

    const reseller = this.getResellerById(resellerId);
    if (!reseller) return { churchCount: 0, onlineCount: 0, alertCount: 0, church_limit: 0 };

    const churchCount = this._countCachedChurchesForReseller(resellerId);
    const alertCount = this._countCachedAlertsForReseller(resellerId);

    let onlineCount = 0;
    if (churchesMap) {
      const { WebSocket } = require('ws');
      for (const [, church] of churchesMap) {
        const hasOpen = church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN);
        if (church.reseller_id === resellerId && hasOpen) {
          onlineCount++;
        }
      }
    }

    return { churchCount, onlineCount, alertCount, church_limit: reseller.church_limit };
  }

  registerChurch(resellerId, churchId, name) {
    if (this.db) {
      this.db.prepare('UPDATE churches SET reseller_id = ? WHERE churchId = ?').run(resellerId, churchId);
      console.log(`[ResellerSystem] Assigned church "${name}" (${churchId}) to reseller ${resellerId}`);
      return this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    }

    const church = this._getCachedChurchById(churchId);
    if (!church) return null;
    const updated = this._cacheChurch({ ...church, reseller_id: resellerId });
    this._enqueueWrite('registerChurch', async () => {
      await this._run('UPDATE churches SET reseller_id = ? WHERE churchId = ?', [resellerId, churchId]);
    });
    console.log(`[ResellerSystem] Assigned church "${name}" (${churchId}) to reseller ${resellerId}`);
    return this._cloneRow(updated);
  }

  getBranding(resellerId) {
    const lookup = this.getResellerById(resellerId);
    const r = lookup;
    if (!r) return null;
    return {
      brandName:    r.brand_name    || null,
      supportEmail:  r.support_email || null,
      logoUrl:       r.logo_url     || null,
      primaryColor:  r.primary_color || '#22c55e',
    };
  }
}

module.exports = { ResellerSystem };
