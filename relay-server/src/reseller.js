/**
 * Reseller System — White-label reseller support for Tally
 *
 * Allows other integrators to rebrand and resell Tally monitoring
 * to their own church clients under a custom brand.
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

class ResellerSystem {
  constructor(db) {
    this.db = db;
    this._ensureSchema();
  }

  _ensureSchema() {
    // Resellers table — with all columns
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resellers (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        api_key        TEXT NOT NULL UNIQUE,
        brand_name     TEXT,
        support_email  TEXT,
        logo_url       TEXT,
        webhook_url    TEXT,
        church_limit   INTEGER DEFAULT 10,
        created_at     TEXT NOT NULL,
        slug           TEXT UNIQUE,
        primary_color  TEXT DEFAULT '#22c55e',
        custom_domain  TEXT,
        active         INTEGER DEFAULT 1
      )
    `);

    // ALTER TABLE fallbacks for existing DBs
    const newColumns = [
      "ALTER TABLE resellers ADD COLUMN slug TEXT",
      "ALTER TABLE resellers ADD COLUMN primary_color TEXT DEFAULT '#22c55e'",
      "ALTER TABLE resellers ADD COLUMN custom_domain TEXT",
      "ALTER TABLE resellers ADD COLUMN active INTEGER DEFAULT 1",
    ];
    for (const col of newColumns) {
      try { this.db.exec(col); } catch { /* column already exists */ }
    }

    // reseller_id foreign key column on churches
    try {
      this.db.prepare('SELECT reseller_id FROM churches LIMIT 1').get();
    } catch {
      this.db.exec('ALTER TABLE churches ADD COLUMN reseller_id TEXT');
    }

    // registration_code column on churches (may be added by TallyBot, ensure it exists)
    try {
      this.db.exec('ALTER TABLE churches ADD COLUMN registration_code TEXT');
    } catch { /* already exists */ }
  }

  // ── Slug generation ─────────────────────────────────────────────────────────

  _slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  _uniqueSlug(base) {
    let slug = base;
    let n = 1;
    while (this.db.prepare('SELECT id FROM resellers WHERE slug = ?').get(slug)) {
      slug = `${base}-${n++}`;
    }
    return slug;
  }

  // ── Reseller management ─────────────────────────────────────────────────────

  /**
   * Create a new reseller account.
   * @param {object} opts
   * @param {string}  opts.name         - Internal company name
   * @param {string}  [opts.brandName]  - Brand shown to churches (e.g. "AV Solutions Pro")
   * @param {string}  [opts.supportEmail]
   * @param {string}  [opts.logoUrl]
   * @param {string}  [opts.webhookUrl]
   * @param {number}  [opts.churchLimit] - Max churches (default 10)
   * @param {string}  [opts.slug]        - Custom slug (auto-generated if omitted)
   * @param {string}  [opts.primaryColor] - Accent color (default #22c55e)
   * @param {string}  [opts.customDomain]
   * @returns {{ resellerId, apiKey, name, slug }}
   */
  createReseller({ name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit = 10, slug, primaryColor, customDomain }) {
    if (!name) throw new Error('name required');

    const resellerId  = uuidv4();
    const apiKey      = 'rsl_' + crypto.randomBytes(20).toString('hex');
    const createdAt   = new Date().toISOString();
    const finalSlug   = this._uniqueSlug(slug || this._slugify(name));
    const finalColor  = primaryColor || '#22c55e';

    this.db.prepare(`
      INSERT INTO resellers
        (id, name, api_key, brand_name, support_email, logo_url, webhook_url, church_limit, created_at, slug, primary_color, custom_domain, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      resellerId, name, apiKey,
      brandName || null, supportEmail || null, logoUrl || null, webhookUrl || null,
      churchLimit, createdAt, finalSlug, finalColor, customDomain || null
    );

    console.log(`[ResellerSystem] Created reseller: "${name}" (${resellerId}) slug="${finalSlug}"`);
    return { resellerId, apiKey, name, slug: finalSlug };
  }

  /**
   * Look up a reseller by API key.
   */
  getReseller(apiKey) {
    if (!apiKey) return null;
    return this.db.prepare('SELECT * FROM resellers WHERE api_key = ?').get(apiKey) || null;
  }

  /**
   * Look up a reseller by ID.
   */
  getResellerById(id) {
    if (!id) return null;
    return this.db.prepare('SELECT * FROM resellers WHERE id = ?').get(id) || null;
  }

  /**
   * Look up a reseller by URL slug.
   * @param {string} slug
   * @returns {object|null}
   */
  getResellerBySlug(slug) {
    if (!slug) return null;
    return this.db.prepare('SELECT * FROM resellers WHERE slug = ?').get(slug) || null;
  }

  /**
   * Update reseller branding/settings.
   * @param {string} resellerId
   * @param {object} patch - Fields to update (name, brand_name, support_email, logo_url, primary_color, custom_domain, webhook_url, church_limit)
   * @returns {object} Updated reseller row
   */
  updateReseller(resellerId, patch) {
    const allowed = ['name', 'brand_name', 'support_email', 'logo_url', 'primary_color', 'custom_domain', 'webhook_url', 'church_limit'];
    const fields = Object.keys(patch).filter(k => allowed.includes(k));
    if (fields.length === 0) throw new Error('No valid fields to update');

    const setClauses = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => patch[f]);
    values.push(resellerId);

    this.db.prepare(`UPDATE resellers SET ${setClauses} WHERE id = ?`).run(...values);
    return this.getResellerById(resellerId);
  }

  /**
   * Deactivate a reseller (set active = 0).
   * @param {string} resellerId
   */
  deactivateReseller(resellerId) {
    this.db.prepare('UPDATE resellers SET active = 0 WHERE id = ?').run(resellerId);
    console.log(`[ResellerSystem] Deactivated reseller ${resellerId}`);
  }

  /**
   * List all resellers with church counts. API keys are omitted from the response.
   */
  listResellers() {
    const resellers = this.db.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all();
    return resellers.map(r => {
      const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE reseller_id = ?').get(r.id);
      const { api_key, ...safe } = r;
      return { ...safe, churchCount: countRow ? countRow.cnt : 0 };
    });
  }

  /**
   * Get reseller detail with their churches. API key omitted.
   */
  getResellerDetail(resellerId) {
    const reseller = this.getResellerById(resellerId);
    if (!reseller) return null;
    const churches = this.getResellerChurches(resellerId);
    const { api_key, ...safe } = reseller;
    return { reseller: safe, churches };
  }

  // ── Church management ───────────────────────────────────────────────────────

  /**
   * Get all churches belonging to a reseller.
   */
  getResellerChurches(resellerId) {
    return this.db.prepare('SELECT * FROM churches WHERE reseller_id = ?').all(resellerId);
  }

  /**
   * Check whether a reseller is under their church limit.
   */
  canAddChurch(resellerId) {
    const reseller = this.getResellerById(resellerId);
    if (!reseller) return false;
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE reseller_id = ?').get(resellerId);
    const count = countRow ? countRow.cnt : 0;
    return count < reseller.church_limit;
  }

  /**
   * Create a church + registration code under this reseller.
   * Inserts the church record into the DB and assigns it to the reseller.
   * @param {string} resellerId
   * @param {string} churchName
   * @returns {{ churchId, churchName, registrationCode, token }}
   */
  generateChurchToken(resellerId, churchName) {
    if (!resellerId) throw new Error('resellerId required');
    if (!churchName) throw new Error('churchName required');

    if (!this.canAddChurch(resellerId)) {
      const reseller = this.getResellerById(resellerId);
      throw new Error(`Church limit reached (max ${reseller?.church_limit || 0})`);
    }

    const existing = this.db.prepare('SELECT churchId FROM churches WHERE name = ?').get(churchName);
    if (existing) throw new Error(`A church named "${churchName}" already exists`);

    const churchId    = uuidv4();
    const jwtSecret   = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
    const token       = jwt.sign({ churchId, name: churchName }, jwtSecret, { expiresIn: '365d' });
    const registeredAt = new Date().toISOString();
    const regCode     = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6-char

    // Insert church
    this.db.prepare(
      'INSERT INTO churches (churchId, name, email, token, registeredAt, reseller_id, registration_code) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(churchId, churchName, '', token, registeredAt, resellerId, regCode);

    console.log(`[ResellerSystem] generateChurchToken: created "${churchName}" (${churchId}) for reseller ${resellerId}`);
    return { churchId, churchName, registrationCode: regCode, token };
  }

  /**
   * Get stats for a reseller.
   * @param {string} resellerId
   * @param {Map|null} churchesMap - Optional in-memory churches Map for online count
   * @returns {{ churchCount, onlineCount, alertCount, church_limit }}
   */
  getResellerStats(resellerId, churchesMap = null) {
    const reseller = this.getResellerById(resellerId);
    if (!reseller) return { churchCount: 0, onlineCount: 0, alertCount: 0, church_limit: 0 };

    const churchCountRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE reseller_id = ?').get(resellerId);
    const churchCount = churchCountRow ? churchCountRow.cnt : 0;

    // Alert count: active (unacknowledged) alerts for this reseller's churches
    const alertCountRow = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM alerts a
      JOIN churches c ON a.church_id = c.churchId
      WHERE c.reseller_id = ? AND a.severity != 'INFO'
      AND datetime(a.created_at) > datetime('now', '-24 hours')
    `).get(resellerId);
    const alertCount = alertCountRow ? alertCountRow.cnt : 0;

    // Online count from in-memory map
    let onlineCount = 0;
    if (churchesMap) {
      const { WebSocket } = require('ws');
      for (const [, church] of churchesMap) {
        if (church.reseller_id === resellerId && church.ws?.readyState === WebSocket.OPEN) {
          onlineCount++;
        }
      }
    }

    return { churchCount, onlineCount, alertCount, church_limit: reseller.church_limit };
  }

  /**
   * Assign a newly-created church to this reseller.
   */
  registerChurch(resellerId, churchId, name) {
    this.db.prepare('UPDATE churches SET reseller_id = ? WHERE churchId = ?').run(resellerId, churchId);
    console.log(`[ResellerSystem] Assigned church "${name}" (${churchId}) to reseller ${resellerId}`);
    return this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
  }

  /**
   * Get branding info for a reseller.
   */
  getBranding(resellerId) {
    const r = this.getResellerById(resellerId);
    if (!r) return null;
    return {
      brandName:    r.brand_name    || null,
      supportEmail: r.support_email || null,
      logoUrl:      r.logo_url      || null,
      primaryColor: r.primary_color || '#22c55e',
    };
  }
}

module.exports = { ResellerSystem };
