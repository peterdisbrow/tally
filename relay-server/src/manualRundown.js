/**
 * Manual Rundown Plans — CRUD for manually created service rundowns.
 *
 * Stores plans and items in SQLite so churches without PCO can build
 * rundowns directly from the portal.  Plans can also be saved as templates
 * and cloned for weekly reuse.
 *
 * Tables:
 *   manual_rundown_plans — one row per plan (or template)
 *   manual_rundown_items — ordered items within each plan
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

class ManualRundownStore {
  constructor({ queryClient, log = console.log } = {}) {
    this._db = queryClient;
    this._log = log;
    this.ready = this._db ? this._init().catch(err => {
      console.error('[ManualRundownStore] DB init failed:', err);
    }) : Promise.resolve();
  }

  // ─── DB INIT ───────────────────────────────────────────────────────────────

  async _init() {
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS rundown_shares (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        church_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      )
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rs_token ON rundown_shares(token)
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rs_plan ON rundown_shares(plan_id)
    `);
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS manual_rundown_plans (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        title TEXT NOT NULL,
        service_date TEXT,
        is_template INTEGER NOT NULL DEFAULT 0,
        template_name TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    // Migrate existing tables that were created with INTEGER instead of BIGINT for timestamps.
    // Date.now() exceeds the 32-bit INTEGER max (~2.1B) — millisecond timestamps require BIGINT.
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_plans ALTER COLUMN created_at TYPE BIGINT`);
      await this._db.exec(`ALTER TABLE manual_rundown_plans ALTER COLUMN updated_at TYPE BIGINT`);
    } catch { /* already BIGINT, or SQLite (which ignores column types) — safe to ignore */ }
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mrp_church
        ON manual_rundown_plans(church_id, is_template, service_date)
    `);
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS manual_rundown_items (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        title TEXT NOT NULL,
        item_type TEXT NOT NULL DEFAULT 'other',
        length_seconds INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        FOREIGN KEY (plan_id) REFERENCES manual_rundown_plans(id) ON DELETE CASCADE
      )
    `);
    // Same migration for items table.
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_items ALTER COLUMN created_at TYPE BIGINT`);
      await this._db.exec(`ALTER TABLE manual_rundown_items ALTER COLUMN updated_at TYPE BIGINT`);
    } catch { /* already BIGINT, or SQLite — safe to ignore */ }
    // Add assignee column (migration for existing tables)
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_items ADD COLUMN assignee TEXT DEFAULT ''`);
    } catch { /* column already exists — safe to ignore */ }
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mri_plan
        ON manual_rundown_items(plan_id, sort_order)
    `);
  }

  // ─── PLANS ─────────────────────────────────────────────────────────────────

  async createPlan(churchId, { title, serviceDate, isTemplate = false, templateName = null }) {
    await this.ready;
    const id = uuidv4();
    const now = Date.now();
    try {
      await this._db.run(`
        INSERT INTO manual_rundown_plans (id, church_id, title, service_date, is_template, template_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, churchId, title, serviceDate || null, isTemplate ? 1 : 0, templateName || null, now, now]);
    } catch (err) {
      console.error('[ManualRundownStore] createPlan INSERT failed:', err);
      throw err;
    }
    return this.getPlan(id);
  }

  async getPlan(planId) {
    const row = await this._db.queryOne(
      `SELECT * FROM manual_rundown_plans WHERE id = ?`, [planId]
    );
    if (!row) return null;
    const items = await this.getItems(planId);
    return this._toPlan(row, items);
  }

  async listPlans(churchId, { includeTemplates = false } = {}) {
    await this.ready;
    const rows = includeTemplates
      ? await this._db.query(
          `SELECT * FROM manual_rundown_plans WHERE church_id = ? ORDER BY is_template DESC, service_date DESC, created_at DESC`,
          [churchId]
        )
      : await this._db.query(
          `SELECT * FROM manual_rundown_plans WHERE church_id = ? AND is_template = 0 ORDER BY service_date DESC, created_at DESC`,
          [churchId]
        );
    const plans = [];
    for (const row of rows) {
      const items = await this.getItems(row.id);
      plans.push(this._toPlan(row, items));
    }
    return plans;
  }

  async listTemplates(churchId) {
    const rows = await this._db.query(
      `SELECT * FROM manual_rundown_plans WHERE church_id = ? AND is_template = 1 ORDER BY template_name ASC, created_at DESC`,
      [churchId]
    );
    const templates = [];
    for (const row of rows) {
      const items = await this.getItems(row.id);
      templates.push(this._toPlan(row, items));
    }
    return templates;
  }

  async updatePlan(planId, { title, serviceDate, templateName }) {
    const sets = [];
    const params = [];
    if (title !== undefined) { sets.push('title = ?'); params.push(title); }
    if (serviceDate !== undefined) { sets.push('service_date = ?'); params.push(serviceDate); }
    if (templateName !== undefined) { sets.push('template_name = ?'); params.push(templateName); }
    if (sets.length === 0) return this.getPlan(planId);
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(planId);
    await this._db.run(
      `UPDATE manual_rundown_plans SET ${sets.join(', ')} WHERE id = ?`, params
    );
    return this.getPlan(planId);
  }

  async deletePlan(planId) {
    await this._db.run(`DELETE FROM manual_rundown_items WHERE plan_id = ?`, [planId]);
    await this._db.run(`DELETE FROM manual_rundown_plans WHERE id = ?`, [planId]);
  }

  // ─── ITEMS ─────────────────────────────────────────────────────────────────

  async getItems(planId) {
    const rows = await this._db.query(
      `SELECT * FROM manual_rundown_items WHERE plan_id = ? ORDER BY sort_order ASC, created_at ASC`,
      [planId]
    );
    return rows.map(r => this._toItem(r));
  }

  async addItem(planId, { title, itemType = 'other', lengthSeconds = 0, notes = '', assignee = '' }) {
    const id = uuidv4();
    const now = Date.now();
    // Get max sort_order
    const max = await this._db.queryOne(
      `SELECT COALESCE(MAX(sort_order), -1) as mx FROM manual_rundown_items WHERE plan_id = ?`, [planId]
    );
    const sortOrder = (max?.mx ?? -1) + 1;
    await this._db.run(`
      INSERT INTO manual_rundown_items (id, plan_id, title, item_type, length_seconds, notes, assignee, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, planId, title, itemType, lengthSeconds, notes || '', assignee || '', sortOrder, now, now]);
    // Update plan's updated_at
    await this._db.run(`UPDATE manual_rundown_plans SET updated_at = ? WHERE id = ?`, [now, planId]);
    return this._toItem({ id, plan_id: planId, title, item_type: itemType, length_seconds: lengthSeconds, notes: notes || '', assignee: assignee || '', sort_order: sortOrder, created_at: now, updated_at: now });
  }

  async updateItem(itemId, { title, itemType, lengthSeconds, notes, assignee }) {
    const sets = [];
    const params = [];
    if (title !== undefined) { sets.push('title = ?'); params.push(title); }
    if (itemType !== undefined) { sets.push('item_type = ?'); params.push(itemType); }
    if (lengthSeconds !== undefined) { sets.push('length_seconds = ?'); params.push(lengthSeconds); }
    if (notes !== undefined) { sets.push('notes = ?'); params.push(notes); }
    if (assignee !== undefined) { sets.push('assignee = ?'); params.push(assignee); }
    if (sets.length === 0) return;
    const now = Date.now();
    sets.push('updated_at = ?');
    params.push(now);
    params.push(itemId);
    await this._db.run(
      `UPDATE manual_rundown_items SET ${sets.join(', ')} WHERE id = ?`, params
    );
    // Update parent plan timestamp
    const item = await this._db.queryOne(`SELECT plan_id FROM manual_rundown_items WHERE id = ?`, [itemId]);
    if (item) await this._db.run(`UPDATE manual_rundown_plans SET updated_at = ? WHERE id = ?`, [now, item.plan_id]);
  }

  async deleteItem(itemId) {
    const item = await this._db.queryOne(`SELECT plan_id FROM manual_rundown_items WHERE id = ?`, [itemId]);
    await this._db.run(`DELETE FROM manual_rundown_items WHERE id = ?`, [itemId]);
    if (item) await this._db.run(`UPDATE manual_rundown_plans SET updated_at = ? WHERE id = ?`, [Date.now(), item.plan_id]);
  }

  async reorderItems(planId, itemIds) {
    const now = Date.now();
    for (let i = 0; i < itemIds.length; i++) {
      await this._db.run(
        `UPDATE manual_rundown_items SET sort_order = ?, updated_at = ? WHERE id = ? AND plan_id = ?`,
        [i, now, itemIds[i], planId]
      );
    }
    await this._db.run(`UPDATE manual_rundown_plans SET updated_at = ? WHERE id = ?`, [now, planId]);
  }

  // ─── TEMPLATES ─────────────────────────────────────────────────────────────

  async saveAsTemplate(planId, templateName) {
    const plan = await this.getPlan(planId);
    if (!plan) return null;
    const newPlan = await this.createPlan(plan.churchId, {
      title: plan.title,
      isTemplate: true,
      templateName: templateName || plan.title,
    });
    // Copy items
    for (const item of plan.items) {
      await this.addItem(newPlan.id, {
        title: item.title,
        itemType: item.itemType,
        lengthSeconds: item.lengthSeconds,
        notes: item.notes,
        assignee: item.assignee,
      });
    }
    return this.getPlan(newPlan.id);
  }

  async createFromTemplate(templateId, { title, serviceDate }) {
    const template = await this.getPlan(templateId);
    if (!template) return null;
    const newPlan = await this.createPlan(template.churchId, {
      title: title || template.title,
      serviceDate,
      isTemplate: false,
    });
    // Copy items from template
    for (const item of template.items) {
      await this.addItem(newPlan.id, {
        title: item.title,
        itemType: item.itemType,
        lengthSeconds: item.lengthSeconds,
        notes: item.notes,
        assignee: item.assignee,
      });
    }
    return this.getPlan(newPlan.id);
  }

  // ─── SHARES ────────────────────────────────────────────────────────────────

  async createShare(planId, churchId, { expiresInDays = 7 } = {}) {
    await this.ready;
    // Deactivate any existing active share for this plan
    await this._db.run(
      `UPDATE rundown_shares SET is_active = 0 WHERE plan_id = ? AND church_id = ?`,
      [planId, churchId]
    );
    const id = uuidv4();
    const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, ''); // 64-char token
    const now = Date.now();
    const expiresAt = now + expiresInDays * 24 * 60 * 60 * 1000;
    await this._db.run(
      `INSERT INTO rundown_shares (id, plan_id, church_id, token, created_at, expires_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [id, planId, churchId, token, now, expiresAt]
    );
    return this._toShare({ id, plan_id: planId, church_id: churchId, token, created_at: now, expires_at: expiresAt, is_active: 1 });
  }

  async getShareByToken(token) {
    await this.ready;
    const row = await this._db.queryOne(
      `SELECT * FROM rundown_shares WHERE token = ? AND is_active = 1`,
      [token]
    );
    if (!row) return null;
    return this._toShare(row);
  }

  async getShareByPlanId(planId) {
    await this.ready;
    const row = await this._db.queryOne(
      `SELECT * FROM rundown_shares WHERE plan_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`,
      [planId]
    );
    if (!row) return null;
    return this._toShare(row);
  }

  async revokeShare(shareId) {
    await this.ready;
    await this._db.run(
      `UPDATE rundown_shares SET is_active = 0 WHERE id = ?`,
      [shareId]
    );
  }

  // ─── HELPERS ───────────────────────────────────────────────────────────────

  _toPlan(row, items = []) {
    return {
      id: row.id,
      churchId: row.church_id,
      title: row.title,
      serviceDate: row.service_date || null,
      isTemplate: !!row.is_template,
      templateName: row.template_name || null,
      source: 'manual',
      items,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _toItem(row) {
    return {
      id: row.id,
      planId: row.plan_id,
      title: row.title,
      itemType: row.item_type,
      lengthSeconds: row.length_seconds,
      notes: row.notes || '',
      assignee: row.assignee || '',
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _toShare(row) {
    return {
      id: row.id,
      planId: row.plan_id,
      churchId: row.church_id,
      token: row.token,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      isActive: !!row.is_active,
    };
  }
}

module.exports = { ManualRundownStore };
