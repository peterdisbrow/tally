/**
 * Reseller System — White-label reseller support for Tally
 *
 * Allows other integrators to rebrand and resell Tally monitoring
 * to their own church clients under a custom brand.
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

class ResellerSystem {
  constructor(db) {
    this.db = db;
    this._ensureSchema();
  }

  _ensureSchema() {
    // Resellers table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resellers (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        api_key      TEXT NOT NULL UNIQUE,
        brand_name   TEXT,
        support_email TEXT,
        logo_url     TEXT,
        webhook_url  TEXT,
        church_limit INTEGER DEFAULT 10,
        created_at   TEXT NOT NULL
      )
    `);

    // reseller_id foreign key column on churches
    try {
      this.db.prepare('SELECT reseller_id FROM churches LIMIT 1').get();
    } catch {
      this.db.exec('ALTER TABLE churches ADD COLUMN reseller_id TEXT');
    }
  }

  // ── Reseller management ─────────────────────────────────────────────────────

  /**
   * Create a new reseller account.
   * @param {object} opts
   * @param {string}  opts.name         - Internal company name
   * @param {string}  [opts.brandName]  - Brand shown to churches (e.g. "AV Solutions Pro")
   * @param {string}  [opts.supportEmail]
   * @param {string}  [opts.logoUrl]
   * @param {string}  [opts.webhookUrl] - Optional webhook for events
   * @param {number}  [opts.churchLimit] - Max churches (default 10)
   * @returns {{ resellerId, apiKey, name }}
   */
  createReseller({ name, brandName, supportEmail, logoUrl, webhookUrl, churchLimit = 10 }) {
    if (!name) throw new Error('name required');

    const resellerId = uuidv4();
    const apiKey     = 'rsl_' + crypto.randomBytes(20).toString('hex');
    const createdAt  = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO resellers (id, name, api_key, brand_name, support_email, logo_url, webhook_url, church_limit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(resellerId, name, apiKey, brandName || null, supportEmail || null, logoUrl || null, webhookUrl || null, churchLimit, createdAt);

    console.log(`[ResellerSystem] Created reseller: "${name}" (${resellerId})`);
    return { resellerId, apiKey, name };
  }

  /**
   * Look up a reseller by API key.
   * @param {string} apiKey
   * @returns {object|null}
   */
  getReseller(apiKey) {
    if (!apiKey) return null;
    return this.db.prepare('SELECT * FROM resellers WHERE api_key = ?').get(apiKey) || null;
  }

  /**
   * Look up a reseller by ID.
   * @param {string} id
   * @returns {object|null}
   */
  getResellerById(id) {
    if (!id) return null;
    return this.db.prepare('SELECT * FROM resellers WHERE id = ?').get(id) || null;
  }

  /**
   * List all resellers with church counts. API keys are omitted from the response.
   * @returns {object[]}
   */
  listResellers() {
    const resellers = this.db.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all();
    return resellers.map(r => {
      const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE reseller_id = ?').get(r.id);
      const { api_key, ...safe } = r; // never expose API key in list
      return { ...safe, churchCount: countRow ? countRow.cnt : 0 };
    });
  }

  /**
   * Get reseller detail with their churches. API key omitted.
   * @param {string} resellerId
   * @returns {{ reseller, churches }|null}
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
   * @param {string} resellerId
   * @returns {object[]}
   */
  getResellerChurches(resellerId) {
    return this.db.prepare('SELECT * FROM churches WHERE reseller_id = ?').all(resellerId);
  }

  /**
   * Check whether a reseller is under their church limit.
   * @param {string} resellerId
   * @returns {boolean}
   */
  canAddChurch(resellerId) {
    const reseller = this.getResellerById(resellerId);
    if (!reseller) return false;
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE reseller_id = ?').get(resellerId);
    const count = countRow ? countRow.cnt : 0;
    return count < reseller.church_limit;
  }

  /**
   * Assign a newly-created church to this reseller.
   * Should be called after the church is already inserted into the DB.
   * @param {string} resellerId
   * @param {string} churchId
   * @param {string} name       - Church name (for logging)
   * @returns {object} Full church row from DB
   */
  registerChurch(resellerId, churchId, name) {
    this.db.prepare('UPDATE churches SET reseller_id = ? WHERE churchId = ?').run(resellerId, churchId);
    console.log(`[ResellerSystem] Assigned church "${name}" (${churchId}) to reseller ${resellerId}`);
    return this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
  }

  /**
   * Get branding info for a reseller (used in client-facing white-label messages).
   * @param {string} resellerId
   * @returns {{ brandName, supportEmail, logoUrl }|null}
   */
  getBranding(resellerId) {
    const r = this.getResellerById(resellerId);
    if (!r) return null;
    return {
      brandName:    r.brand_name    || null,
      supportEmail: r.support_email || null,
      logoUrl:      r.logo_url      || null,
    };
  }
}

module.exports = { ResellerSystem };
