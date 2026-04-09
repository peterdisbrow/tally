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
const VALID_COLUMN_TYPES = new Set(['text', 'dropdown']);
const VALID_COLLABORATOR_ROLES = new Set(['owner', 'editor', 'viewer']);
const VALID_COLLABORATOR_STATUSES = new Set(['active', 'offline', 'revoked']);

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
    // Add status column: draft, rehearsal, show_ready, live, archived
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'`);
    } catch { /* column already exists — safe to ignore */ }
    // Add room_id column: links plan to a specific room
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_plans ADD COLUMN room_id TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists — safe to ignore */ }
    // Add live-cueing columns: start_type, hard_start_time, auto_advance
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_items ADD COLUMN start_type TEXT NOT NULL DEFAULT 'soft'`);
    } catch { /* column already exists */ }
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_items ADD COLUMN hard_start_time TEXT DEFAULT NULL`);
    } catch { /* column already exists */ }
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_items ADD COLUMN auto_advance INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    // Phase 10.1: parent_id for cue stacks / nested items
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_items ADD COLUMN parent_id TEXT DEFAULT NULL`);
    } catch { /* column already exists */ }
    // Add share_token column for public timer/share links
    try {
      await this._db.exec(`ALTER TABLE manual_rundown_plans ADD COLUMN share_token TEXT`);
    } catch { /* column already exists — safe to ignore */ }
    try {
      await this._db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mrp_share_token ON manual_rundown_plans(share_token) WHERE share_token IS NOT NULL`);
    } catch { /* index already exists or SQLite partial index limitation — safe to ignore */ }
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mri_plan
        ON manual_rundown_items(plan_id, sort_order)
    `);
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS rundown_collaborators (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        church_id TEXT NOT NULL,
        collaborator_key TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'editor',
        status TEXT NOT NULL DEFAULT 'active',
        joined_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        left_at BIGINT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(plan_id, collaborator_key)
      )
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rcollab_plan
        ON rundown_collaborators(plan_id, status, last_seen_at DESC)
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rcollab_church
        ON rundown_collaborators(church_id, plan_id, role)
    `);

    // ── Live show state table (per-plan cueing state) ─────────────────────────
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS rundown_live_state (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        church_id TEXT NOT NULL,
        is_live INTEGER NOT NULL DEFAULT 0,
        current_cue_index INTEGER NOT NULL DEFAULT 0,
        started_at BIGINT,
        updated_at BIGINT NOT NULL,
        current_cue_started_at BIGINT,
        FOREIGN KEY (plan_id) REFERENCES manual_rundown_plans(id) ON DELETE CASCADE
      )
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rls_plan
        ON rundown_live_state(plan_id)
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rls_church_live
        ON rundown_live_state(church_id, is_live)
    `);

    // ── Custom columns tables ──────────────────────────────────────────────
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS rundown_columns (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        church_id TEXT NOT NULL,
        name TEXT NOT NULL,
        department TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      )
    `);
    try {
      await this._db.exec(`ALTER TABLE rundown_columns ADD COLUMN column_type TEXT NOT NULL DEFAULT 'text'`);
    } catch { /* column already exists */ }
    try {
      await this._db.exec(`ALTER TABLE rundown_columns ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }
    try {
      await this._db.exec(`ALTER TABLE rundown_columns ADD COLUMN equipment_binding TEXT DEFAULT NULL`);
    } catch { /* column already exists */ }
    // Phase 10.3: column-level edit permissions (JSON array of allowed roles, null = all editors)
    try {
      await this._db.exec(`ALTER TABLE rundown_columns ADD COLUMN editable_roles TEXT DEFAULT NULL`);
    } catch { /* column already exists */ }
    // Phase 10.4: conditional formatting / validation rules (JSON array of rule objects)
    try {
      await this._db.exec(`ALTER TABLE rundown_columns ADD COLUMN validation_json TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rc_plan ON rundown_columns(plan_id, sort_order)
    `);
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS rundown_column_values (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        column_id TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        updated_at BIGINT NOT NULL
      )
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rcv_item ON rundown_column_values(item_id)
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rcv_col ON rundown_column_values(column_id)
    `);

    // ── Attachments table ──────────────────────────────────────────────────
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS rundown_attachments (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        church_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mimetype TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ra_item ON rundown_attachments(item_id)
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ra_plan ON rundown_attachments(plan_id)
    `);

    // ── Room permissions table ──────────────────────────────────────────────
    await this._initRoomPermissions();
  }

  // ─── PLANS ─────────────────────────────────────────────────────────────────

  async createPlan(churchId, {
    title,
    serviceDate,
    isTemplate = false,
    templateName = null,
    status = 'draft',
    roomId = '',
    ownerKey = null,
    ownerName = '',
    ownerRole = 'owner',
  } = {}) {
    await this.ready;
    const id = uuidv4();
    const now = Date.now();
    try {
      await this._db.run(`
        INSERT INTO manual_rundown_plans (id, church_id, title, service_date, is_template, template_name, status, room_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, churchId, title, serviceDate || null, isTemplate ? 1 : 0, templateName || null, status || 'draft', roomId || '', now, now]);
    } catch (err) {
      console.error('[ManualRundownStore] createPlan INSERT failed:', err);
      throw err;
    }
    if (ownerKey || ownerName) {
      await this.upsertCollaborator(id, churchId, {
        collaboratorKey: ownerKey || ownerName || id,
        displayName: ownerName || '',
        role: ownerRole,
        status: 'active',
        joinedAt: now,
        lastSeenAt: now,
      });
    }
    return this.getPlan(id);
  }

  async getPlan(planId) {
    const row = await this._db.queryOne(
      `SELECT * FROM manual_rundown_plans WHERE id = ?`, [planId]
    );
    if (!row) return null;
    const items = await this.getItems(planId);
    const collaborators = await this.getCollaborators(planId);
    return this._toPlan(row, items, collaborators);
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
      const collaborators = await this.getCollaborators(row.id);
      plans.push(this._toPlan(row, items, collaborators));
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
      const collaborators = await this.getCollaborators(row.id);
      templates.push(this._toPlan(row, items, collaborators));
    }
    return templates;
  }

  async updatePlan(planId, { title, serviceDate, templateName, status, roomId }) {
    const sets = [];
    const params = [];
    if (title !== undefined) { sets.push('title = ?'); params.push(title); }
    if (serviceDate !== undefined) { sets.push('service_date = ?'); params.push(serviceDate); }
    if (templateName !== undefined) { sets.push('template_name = ?'); params.push(templateName); }
    if (status !== undefined) { sets.push('status = ?'); params.push(status); }
    if (roomId !== undefined) { sets.push('room_id = ?'); params.push(roomId); }
    if (sets.length === 0) return this.getPlan(planId);
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(planId);
    await this._db.run(
      `UPDATE manual_rundown_plans SET ${sets.join(', ')} WHERE id = ?`, params
    );
    return this.getPlan(planId);
  }

  async updateStatus(planId, status) {
    const valid = ['draft', 'rehearsal', 'show_ready', 'live', 'archived'];
    if (!valid.includes(status)) throw new Error('Invalid status: ' + status);
    const now = Date.now();
    await this._db.run(
      `UPDATE manual_rundown_plans SET status = ?, updated_at = ? WHERE id = ?`,
      [status, now, planId]
    );
    return this.getPlan(planId);
  }

  async duplicatePlan(planId, { ownerKey = null, ownerName = '' } = {}) {
    const plan = await this.getPlan(planId);
    if (!plan) return null;
    const newPlan = await this.createPlan(plan.churchId, {
      title: plan.title + ' (Copy)',
      serviceDate: plan.serviceDate,
      status: 'draft',
      roomId: plan.roomId || '',
      ownerKey,
      ownerName,
    });
    const itemIdMap = {};
    for (const item of plan.items) {
      const newItem = await this.addItem(newPlan.id, {
        title: item.title,
        itemType: item.itemType,
        lengthSeconds: item.lengthSeconds,
        notes: item.notes,
        assignee: item.assignee,
        startType: item.startType,
        hardStartTime: item.hardStartTime,
        autoAdvance: item.autoAdvance,
        // parentId mapped after all items are created (second pass below)
      });
      itemIdMap[item.id] = newItem.id;
    }
    // Second pass: update parentId references using the id map
    for (const item of plan.items) {
      if (item.parentId && itemIdMap[item.parentId] && itemIdMap[item.id]) {
        await this.updateItem(itemIdMap[item.id], { parentId: itemIdMap[item.parentId] });
      }
    }
    await this.copyCollaborators(planId, newPlan.id, plan.churchId, { skipOwner: true });
    await this._copyColumns(planId, newPlan.id, plan.churchId, itemIdMap);
    return this.getPlan(newPlan.id);
  }

  async deletePlan(planId) {
    await this._db.run(
      `DELETE FROM rundown_column_values WHERE column_id IN (SELECT id FROM rundown_columns WHERE plan_id = ?)`,
      [planId]
    );
    await this._db.run(`DELETE FROM rundown_columns WHERE plan_id = ?`, [planId]);
    await this._db.run(`DELETE FROM rundown_attachments WHERE plan_id = ?`, [planId]);
    await this._db.run(`DELETE FROM rundown_shares WHERE plan_id = ?`, [planId]);
    await this._db.run(`DELETE FROM rundown_live_state WHERE plan_id = ?`, [planId]);
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

  async addItem(planId, { title, itemType = 'other', lengthSeconds = 0, notes = '', assignee = '', startType = 'soft', hardStartTime = null, autoAdvance = false, parentId = null }) {
    const id = uuidv4();
    const now = Date.now();
    // Get max sort_order
    const max = await this._db.queryOne(
      `SELECT COALESCE(MAX(sort_order), -1) as mx FROM manual_rundown_items WHERE plan_id = ?`, [planId]
    );
    const sortOrder = (max?.mx ?? -1) + 1;
    await this._db.run(`
      INSERT INTO manual_rundown_items (id, plan_id, title, item_type, length_seconds, notes, assignee, sort_order, start_type, hard_start_time, auto_advance, parent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, planId, title, itemType, lengthSeconds, notes || '', assignee || '', sortOrder, startType, hardStartTime || null, autoAdvance ? 1 : 0, parentId || null, now, now]);
    // Update plan's updated_at
    await this._db.run(`UPDATE manual_rundown_plans SET updated_at = ? WHERE id = ?`, [now, planId]);
    return this._toItem({ id, plan_id: planId, title, item_type: itemType, length_seconds: lengthSeconds, notes: notes || '', assignee: assignee || '', sort_order: sortOrder, start_type: startType, hard_start_time: hardStartTime || null, auto_advance: autoAdvance ? 1 : 0, parent_id: parentId || null, created_at: now, updated_at: now });
  }

  async updateItem(itemId, { title, itemType, lengthSeconds, notes, assignee, startType, hardStartTime, autoAdvance, parentId }) {
    const sets = [];
    const params = [];
    if (title !== undefined) { sets.push('title = ?'); params.push(title); }
    if (itemType !== undefined) { sets.push('item_type = ?'); params.push(itemType); }
    if (lengthSeconds !== undefined) { sets.push('length_seconds = ?'); params.push(lengthSeconds); }
    if (notes !== undefined) { sets.push('notes = ?'); params.push(notes); }
    if (assignee !== undefined) { sets.push('assignee = ?'); params.push(assignee); }
    if (startType !== undefined) { sets.push('start_type = ?'); params.push(startType); }
    if (hardStartTime !== undefined) { sets.push('hard_start_time = ?'); params.push(hardStartTime || null); }
    if (autoAdvance !== undefined) { sets.push('auto_advance = ?'); params.push(autoAdvance ? 1 : 0); }
    if (parentId !== undefined) { sets.push('parent_id = ?'); params.push(parentId || null); }
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
    await this._db.run(`DELETE FROM rundown_column_values WHERE item_id = ?`, [itemId]);
    await this._db.run(`DELETE FROM rundown_attachments WHERE item_id = ?`, [itemId]);
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

  async saveAsTemplate(planId, templateName, { ownerKey = null, ownerName = '' } = {}) {
    const plan = await this.getPlan(planId);
    if (!plan) return null;
    const newPlan = await this.createPlan(plan.churchId, {
      title: plan.title,
      isTemplate: true,
      templateName: templateName || plan.title,
      roomId: plan.roomId || '',
      ownerKey,
      ownerName,
    });
    // Copy items and build ID mapping for column values
    const itemIdMap = {};
    for (const item of plan.items) {
      const newItem = await this.addItem(newPlan.id, {
        title: item.title,
        itemType: item.itemType,
        lengthSeconds: item.lengthSeconds,
        notes: item.notes,
        assignee: item.assignee,
        startType: item.startType,
        hardStartTime: item.hardStartTime,
        autoAdvance: item.autoAdvance,
      });
      itemIdMap[item.id] = newItem.id;
    }
    // Map parentId references to new IDs
    for (const item of plan.items) {
      if (item.parentId && itemIdMap[item.parentId] && itemIdMap[item.id]) {
        await this.updateItem(itemIdMap[item.id], { parentId: itemIdMap[item.parentId] });
      }
    }
    await this.copyCollaborators(planId, newPlan.id, plan.churchId, { skipOwner: true });
    // Copy custom columns and their values
    await this._copyColumns(planId, newPlan.id, plan.churchId, itemIdMap);
    return this.getPlan(newPlan.id);
  }

  async createFromTemplate(templateId, { title, serviceDate, roomId, ownerKey = null, ownerName = '' }) {
    const template = await this.getPlan(templateId);
    if (!template) return null;
    // Preserve the template's roomId by default, allow override via roomId param
    const effectiveRoomId = roomId !== undefined ? roomId : (template.roomId || '');
    const newPlan = await this.createPlan(template.churchId, {
      title: title || template.title,
      serviceDate,
      isTemplate: false,
      roomId: effectiveRoomId,
      ownerKey,
      ownerName,
    });
    // Copy items from template and build ID mapping
    const itemIdMap = {};
    for (const item of template.items) {
      const newItem = await this.addItem(newPlan.id, {
        title: item.title,
        itemType: item.itemType,
        lengthSeconds: item.lengthSeconds,
        notes: item.notes,
        assignee: item.assignee,
        startType: item.startType,
        hardStartTime: item.hardStartTime,
        autoAdvance: item.autoAdvance,
      });
      itemIdMap[item.id] = newItem.id;
    }
    // Map parentId references to new IDs
    for (const item of template.items) {
      if (item.parentId && itemIdMap[item.parentId] && itemIdMap[item.id]) {
        await this.updateItem(itemIdMap[item.id], { parentId: itemIdMap[item.parentId] });
      }
    }
    await this.copyCollaborators(templateId, newPlan.id, template.churchId, { skipOwner: true });
    // Copy custom columns and their values
    await this._copyColumns(templateId, newPlan.id, template.churchId, itemIdMap);
    return this.getPlan(newPlan.id);
  }

  async copyCollaborators(sourcePlanId, targetPlanId, churchId, { skipOwner = false } = {}) {
    const collaborators = await this.getCollaborators(sourcePlanId);
    const now = Date.now();
    for (const collaborator of collaborators) {
      if (skipOwner && collaborator.role === 'owner') continue;
      await this.upsertCollaborator(targetPlanId, churchId, {
        collaboratorKey: collaborator.collaboratorKey,
        displayName: collaborator.displayName,
        role: collaborator.role,
        status: collaborator.status === 'active' ? 'offline' : collaborator.status,
        joinedAt: collaborator.joinedAt || now,
        lastSeenAt: collaborator.lastSeenAt || now,
        leftAt: collaborator.leftAt || null,
        metadata: collaborator.metadata || {},
      });
    }
  }

  async _copyColumns(sourcePlanId, targetPlanId, churchId, itemIdMap) {
    const columns = await this.getColumns(sourcePlanId);
    const colIdMap = {};
    for (const col of columns) {
      const newCol = await this.addColumn(targetPlanId, churchId, {
        name: col.name,
        department: col.department,
        sortOrder: col.sortOrder,
        type: col.type,
        options: col.options,
        equipmentBinding: col.equipmentBinding,
        editableRoles: col.editableRoles,
        validationRules: col.validationRules,
      });
      colIdMap[col.id] = newCol.id;
    }
    // Copy column values
    const values = await this.getColumnValues(sourcePlanId);
    for (const val of values) {
      const newItemId = itemIdMap[val.itemId];
      const newColId = colIdMap[val.columnId];
      if (newItemId && newColId) {
        await this.setColumnValue(newItemId, newColId, val.value);
      }
    }
  }

  // ─── CUSTOM COLUMNS ─────────────────────────────────────────────────────────

  async getColumns(planId) {
    const rows = await this._db.query(
      `SELECT * FROM rundown_columns WHERE plan_id = ? ORDER BY sort_order ASC, created_at ASC`, [planId]
    );
    return rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      churchId: r.church_id,
      name: r.name,
      department: r.department || '',
      sortOrder: r.sort_order,
      type: VALID_COLUMN_TYPES.has(r.column_type) ? r.column_type : 'text',
      options: this._parseColumnOptions(r.options_json),
      equipmentBinding: r.equipment_binding || null,
      editableRoles: r.editable_roles ? this._parseJson(r.editable_roles, null) : null,
      validationRules: this._parseJson(r.validation_json, []),
      createdAt: r.created_at,
    }));
  }

  _parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  async addColumn(planId, churchId, { name, department = '', sortOrder, type = 'text', options = [], equipmentBinding = null, editableRoles = null, validationRules = [] }) {
    const id = uuidv4();
    const now = Date.now();
    const normalizedType = VALID_COLUMN_TYPES.has(type) ? type : 'text';
    const normalizedOptions = this._normalizeColumnOptions(options, normalizedType);
    const normalizedEditableRoles = Array.isArray(editableRoles) && editableRoles.length ? JSON.stringify(editableRoles) : null;
    const normalizedValidation = Array.isArray(validationRules) ? JSON.stringify(validationRules) : '[]';
    if (sortOrder === undefined || sortOrder === null) {
      const max = await this._db.queryOne(`SELECT COALESCE(MAX(sort_order), -1) as mx FROM rundown_columns WHERE plan_id = ?`, [planId]);
      sortOrder = (max?.mx ?? -1) + 1;
    }
    await this._db.run(
      `INSERT INTO rundown_columns (id, plan_id, church_id, name, department, sort_order, column_type, options_json, equipment_binding, editable_roles, validation_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, planId, churchId, name, department || '', sortOrder, normalizedType, JSON.stringify(normalizedOptions), equipmentBinding || null, normalizedEditableRoles, normalizedValidation, now]
    );
    return {
      id,
      planId,
      churchId,
      name,
      department: department || '',
      sortOrder,
      type: normalizedType,
      options: normalizedOptions,
      equipmentBinding: equipmentBinding || null,
      editableRoles: editableRoles || null,
      validationRules: validationRules || [],
      createdAt: now,
    };
  }

  async updateColumn(colId, { name, sortOrder, type, options, equipmentBinding, editableRoles, validationRules }) {
    const sets = [];
    const params = [];
    if (name !== undefined) { sets.push('name = ?'); params.push(name); }
    if (sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(sortOrder); }
    const normalizedType = type !== undefined ? (VALID_COLUMN_TYPES.has(type) ? type : 'text') : undefined;
    if (normalizedType !== undefined) {
      sets.push('column_type = ?');
      params.push(normalizedType);
    }
    if (options !== undefined || (normalizedType !== undefined && normalizedType !== 'dropdown')) {
      sets.push('options_json = ?');
      params.push(JSON.stringify(this._normalizeColumnOptions(options, normalizedType || 'text')));
    }
    if (equipmentBinding !== undefined) {
      sets.push('equipment_binding = ?');
      params.push(equipmentBinding || null);
    }
    if (editableRoles !== undefined) {
      sets.push('editable_roles = ?');
      params.push(Array.isArray(editableRoles) && editableRoles.length ? JSON.stringify(editableRoles) : null);
    }
    if (validationRules !== undefined) {
      sets.push('validation_json = ?');
      params.push(Array.isArray(validationRules) ? JSON.stringify(validationRules) : '[]');
    }
    if (sets.length === 0) return;
    params.push(colId);
    await this._db.run(`UPDATE rundown_columns SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async deleteColumn(colId) {
    // Delete all values for this column first
    await this._db.run(`DELETE FROM rundown_column_values WHERE column_id = ?`, [colId]);
    await this._db.run(`DELETE FROM rundown_columns WHERE id = ?`, [colId]);
  }

  // ─── COLLABORATORS ─────────────────────────────────────────────────────────

  async getCollaborators(planId) {
    const rows = await this._db.query(
      `SELECT * FROM rundown_collaborators WHERE plan_id = ? ORDER BY
        CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END,
        CASE status WHEN 'active' THEN 0 WHEN 'offline' THEN 1 WHEN 'revoked' THEN 2 ELSE 3 END,
        last_seen_at DESC,
        created_at ASC`,
      [planId]
    );
    return rows.map((row) => this._toCollaborator(row));
  }

  async getCollaborator(planId, collaboratorKey) {
    if (!collaboratorKey) return null;
    const row = await this._db.queryOne(
      `SELECT * FROM rundown_collaborators WHERE plan_id = ? AND collaborator_key = ?`,
      [planId, collaboratorKey]
    );
    return row ? this._toCollaborator(row) : null;
  }

  async upsertCollaborator(planId, churchId, {
    collaboratorKey,
    displayName = '',
    role = 'editor',
    status = 'active',
    joinedAt,
    lastSeenAt,
    leftAt = null,
    metadata = {},
  }) {
    if (!collaboratorKey) throw new Error('collaboratorKey is required');
    const normalizedRole = VALID_COLLABORATOR_ROLES.has(role) ? role : 'editor';
    const normalizedStatus = VALID_COLLABORATOR_STATUSES.has(status) ? status : 'active';
    const now = Date.now();
    const existing = await this.getCollaborator(planId, collaboratorKey);
    const payload = {
      id: existing?.id || uuidv4(),
      planId,
      churchId,
      collaboratorKey,
      displayName: String(displayName || '').trim(),
      role: normalizedRole,
      status: normalizedStatus,
      joinedAt: existing?.joinedAt || joinedAt || now,
      lastSeenAt: lastSeenAt || now,
      leftAt: leftAt ?? existing?.leftAt ?? null,
      metadata: metadata || {},
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await this._db.run(`
      INSERT INTO rundown_collaborators (
        id, plan_id, church_id, collaborator_key, display_name, role, status,
        joined_at, last_seen_at, left_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id, collaborator_key) DO UPDATE SET
        church_id = excluded.church_id,
        display_name = excluded.display_name,
        role = excluded.role,
        status = excluded.status,
        joined_at = CASE
          WHEN rundown_collaborators.joined_at IS NULL THEN excluded.joined_at
          ELSE rundown_collaborators.joined_at
        END,
        last_seen_at = excluded.last_seen_at,
        left_at = excluded.left_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `, [
      payload.id,
      payload.planId,
      payload.churchId,
      payload.collaboratorKey,
      payload.displayName,
      payload.role,
      payload.status,
      payload.joinedAt,
      payload.lastSeenAt,
      payload.leftAt,
      JSON.stringify(payload.metadata || {}),
      payload.createdAt,
      payload.updatedAt,
    ]);
    return this.getCollaborator(planId, collaboratorKey);
  }

  async markCollaboratorOffline(planId, collaboratorKey, { leftAt = Date.now() } = {}) {
    const existing = await this.getCollaborator(planId, collaboratorKey);
    if (!existing) return null;
    await this._db.run(
      `UPDATE rundown_collaborators SET status = 'offline', left_at = ?, updated_at = ? WHERE plan_id = ? AND collaborator_key = ?`,
      [leftAt, Date.now(), planId, collaboratorKey]
    );
    return this.getCollaborator(planId, collaboratorKey);
  }

  async revokeCollaborator(planId, collaboratorKey) {
    const existing = await this.getCollaborator(planId, collaboratorKey);
    if (!existing) return null;
    await this._db.run(
      `UPDATE rundown_collaborators SET status = 'revoked', left_at = ?, updated_at = ? WHERE plan_id = ? AND collaborator_key = ?`,
      [Date.now(), Date.now(), planId, collaboratorKey]
    );
    return this.getCollaborator(planId, collaboratorKey);
  }

  async cleanupStaleCollaborators(staleBeforeMs) {
    const threshold = typeof staleBeforeMs === 'number' ? staleBeforeMs : Date.now();
    await this._db.run(
      `UPDATE rundown_collaborators
       SET status = CASE WHEN status = 'revoked' THEN status ELSE 'offline' END,
           left_at = CASE WHEN left_at IS NULL THEN ? ELSE left_at END,
           updated_at = ?
       WHERE status = 'active' AND last_seen_at < ?`,
      [threshold, Date.now(), threshold]
    );
  }

  async getColumnValues(planId) {
    // Get all column values for all items in a plan (via the columns table)
    const rows = await this._db.query(
      `SELECT cv.* FROM rundown_column_values cv
       INNER JOIN rundown_columns c ON cv.column_id = c.id
       WHERE c.plan_id = ?`, [planId]
    );
    return rows.map(r => ({ id: r.id, itemId: r.item_id, columnId: r.column_id, value: r.value, updatedAt: r.updated_at }));
  }

  async setColumnValue(itemId, columnId, value) {
    const now = Date.now();
    const existing = await this._db.queryOne(
      `SELECT id FROM rundown_column_values WHERE item_id = ? AND column_id = ?`, [itemId, columnId]
    );
    if (existing) {
      await this._db.run(`UPDATE rundown_column_values SET value = ?, updated_at = ? WHERE id = ?`, [value, now, existing.id]);
    } else {
      const id = uuidv4();
      await this._db.run(
        `INSERT INTO rundown_column_values (id, item_id, column_id, value, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [id, itemId, columnId, value, now]
      );
    }
  }

  // ─── ATTACHMENTS ──────────────────────────────────────────────────────────

  async addAttachment(itemId, planId, churchId, { filename, mimetype, size, storagePath }) {
    const id = uuidv4();
    const now = Date.now();
    await this._db.run(
      `INSERT INTO rundown_attachments (id, item_id, plan_id, church_id, filename, mimetype, size, storage_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, itemId, planId, churchId, filename, mimetype || '', size, storagePath, now]
    );
    return { id, itemId, planId, churchId, filename, mimetype: mimetype || '', size, storagePath, createdAt: now };
  }

  async getAttachments(itemId) {
    const rows = await this._db.query(
      `SELECT * FROM rundown_attachments WHERE item_id = ? ORDER BY created_at ASC`, [itemId]
    );
    return rows.map(r => ({ id: r.id, itemId: r.item_id, planId: r.plan_id, churchId: r.church_id, filename: r.filename, mimetype: r.mimetype, size: r.size, storagePath: r.storage_path, createdAt: r.created_at }));
  }

  async getAttachmentsByPlan(planId) {
    const rows = await this._db.query(
      `SELECT * FROM rundown_attachments WHERE plan_id = ? ORDER BY created_at ASC`, [planId]
    );
    return rows.map(r => ({ id: r.id, itemId: r.item_id, planId: r.plan_id, churchId: r.church_id, filename: r.filename, mimetype: r.mimetype, size: r.size, storagePath: r.storage_path, createdAt: r.created_at }));
  }

  async getAttachment(attachmentId) {
    const r = await this._db.queryOne(`SELECT * FROM rundown_attachments WHERE id = ?`, [attachmentId]);
    if (!r) return null;
    return { id: r.id, itemId: r.item_id, planId: r.plan_id, churchId: r.church_id, filename: r.filename, mimetype: r.mimetype, size: r.size, storagePath: r.storage_path, createdAt: r.created_at };
  }

  async deleteAttachment(attachmentId) {
    const att = await this.getAttachment(attachmentId);
    if (!att) return null;
    await this._db.run(`DELETE FROM rundown_attachments WHERE id = ?`, [attachmentId]);
    return att;
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

  async setShareToken(planId, token) {
    await this._db.run(
      `UPDATE manual_rundown_plans SET share_token = ?, updated_at = ? WHERE id = ?`,
      [token || null, Date.now(), planId]
    );
  }

  async clearShareToken(planId) {
    await this.setShareToken(planId, null);
  }

  async resolvePublicAccess(token) {
    if (!token) return null;
    const now = Date.now();
    const share = await this.getShareByToken(token);
    if (share) {
      if (share.expiresAt < now) return null;
      const plan = await this.getPlan(share.planId);
      if (!plan) return null;
      return { plan, share, isLegacyToken: false };
    }
    const plan = await this.getPlanByShareToken(token);
    if (!plan) return null;
    const activeShare = await this.getShareByPlanId(plan.id);
    if (!activeShare || activeShare.expiresAt < now) return null;
    return { plan, share: activeShare, isLegacyToken: true };
  }

  // ─── HELPERS ───────────────────────────────────────────────────────────────

  // ─── SHARE TOKENS ──────────────────────────────────────────────────────────

  async getOrCreateShareToken(planId) {
    const row = await this._db.queryOne(
      `SELECT share_token FROM manual_rundown_plans WHERE id = ?`, [planId]
    );
    if (!row) return null;
    if (row.share_token) return row.share_token;
    const token = uuidv4().replace(/-/g, '').slice(0, 16);
    await this._db.run(
      `UPDATE manual_rundown_plans SET share_token = ?, updated_at = ? WHERE id = ?`,
      [token, Date.now(), planId]
    );
    return token;
  }

  async getPlanByShareToken(token) {
    if (!token) return null;
    const row = await this._db.queryOne(
      `SELECT * FROM manual_rundown_plans WHERE share_token = ?`, [token]
    );
    if (!row) return null;
    const items = await this.getItems(row.id);
    const collaborators = await this.getCollaborators(row.id);
    return this._toPlan(row, items, collaborators);
  }

  _toPlan(row, items = [], collaborators = []) {
    return {
      id: row.id,
      churchId: row.church_id,
      title: row.title,
      serviceDate: row.service_date || null,
      isTemplate: !!row.is_template,
      templateName: row.template_name || null,
      status: row.status || 'draft',
      roomId: row.room_id || '',
      shareToken: row.share_token || null,
      source: 'manual',
      items,
      collaborators,
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
      parentId: row.parent_id || null,
      startType: row.start_type || 'soft',
      hardStartTime: row.hard_start_time || null,
      autoAdvance: !!row.auto_advance,
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

  _toCollaborator(row) {
    return {
      id: row.id,
      planId: row.plan_id,
      churchId: row.church_id,
      collaboratorKey: row.collaborator_key,
      displayName: row.display_name || '',
      role: VALID_COLLABORATOR_ROLES.has(row.role) ? row.role : 'editor',
      status: VALID_COLLABORATOR_STATUSES.has(row.status) ? row.status : 'active',
      joinedAt: row.joined_at,
      lastSeenAt: row.last_seen_at,
      leftAt: row.left_at || null,
      metadata: this._parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ─── LIVE STATE ─────────────────────────────────────────────────────────────

  async getLiveState(planId) {
    const row = await this._db.queryOne(
      `SELECT * FROM rundown_live_state WHERE plan_id = ? AND is_live = 1`, [planId]
    );
    return row ? this._toLiveState(row) : null;
  }

  async startLive(planId, churchId) {
    await this.ready;
    const now = Date.now();
    await this._db.run(`UPDATE rundown_live_state SET is_live = 0, updated_at = ? WHERE plan_id = ?`, [now, planId]);
    const id = uuidv4();
    await this._db.run(`
      INSERT INTO rundown_live_state (id, plan_id, church_id, is_live, current_cue_index, started_at, updated_at, current_cue_started_at)
      VALUES (?, ?, ?, 1, 0, ?, ?, ?)
    `, [id, planId, churchId, now, now, now]);
    return this._toLiveState({ id, plan_id: planId, church_id: churchId, is_live: 1, current_cue_index: 0, started_at: now, updated_at: now, current_cue_started_at: now });
  }

  async stopLive(planId) {
    const now = Date.now();
    await this._db.run(`UPDATE rundown_live_state SET is_live = 0, updated_at = ? WHERE plan_id = ?`, [now, planId]);
    return { ok: true };
  }

  async updateLiveState(planId, { currentCueIndex, currentCueStartedAt }) {
    const sets = [];
    const params = [];
    if (currentCueIndex !== undefined) { sets.push('current_cue_index = ?'); params.push(currentCueIndex); }
    if (currentCueStartedAt !== undefined) { sets.push('current_cue_started_at = ?'); params.push(currentCueStartedAt); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(planId);
    await this._db.run(
      `UPDATE rundown_live_state SET ${sets.join(', ')} WHERE plan_id = ? AND is_live = 1`, params
    );
    return this.getLiveState(planId);
  }

  _toLiveState(row) {
    return {
      id: row.id,
      planId: row.plan_id,
      churchId: row.church_id,
      isLive: !!row.is_live,
      currentCueIndex: row.current_cue_index,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      currentCueStartedAt: row.current_cue_started_at,
    };
  }

  _parseColumnOptions(optionsJson) {
    try {
      const parsed = JSON.parse(optionsJson || '[]');
      return this._normalizeColumnOptions(parsed, 'dropdown');
    } catch {
      return [];
    }
  }

  _normalizeColumnOptions(options, type) {
    if (type !== 'dropdown') return [];
    const list = Array.isArray(options)
      ? options
      : String(options || '')
        .split(',');
    return [...new Set(
      list
        .map((option) => String(option || '').trim())
        .filter(Boolean)
    )];
  }

  _parseJson(value, fallback) {
    try {
      if (value == null || value === '') return fallback;
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  // ─── ROOM PERMISSIONS ──────────────────────────────────────────────────────

  async _initRoomPermissions() {
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS rundown_room_permissions (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        room_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'editor',
        display_name TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(church_id, user_key, room_id)
      )
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rrp_church_user
        ON rundown_room_permissions(church_id, user_key)
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rrp_church_room
        ON rundown_room_permissions(church_id, room_id)
    `);
  }

  /**
   * Set a user's permission for a specific room.
   * @param {string} churchId
   * @param {string} userKey - session ID or user identifier
   * @param {string} roomId
   * @param {string} role - 'owner', 'editor', 'viewer', or 'none' (removes permission)
   * @param {string} displayName
   */
  async setRoomPermission(churchId, userKey, roomId, role, displayName = '') {
    await this.ready;
    if (role === 'none') {
      await this._db.run(
        `DELETE FROM rundown_room_permissions WHERE church_id = ? AND user_key = ? AND room_id = ?`,
        [churchId, userKey, roomId]
      );
      return null;
    }
    const now = Date.now();
    const id = uuidv4();
    await this._db.run(`
      INSERT INTO rundown_room_permissions (id, church_id, user_key, room_id, role, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(church_id, user_key, room_id) DO UPDATE SET
        role = excluded.role,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `, [id, churchId, userKey, roomId, role, displayName, now, now]);
    return { churchId, userKey, roomId, role, displayName };
  }

  /**
   * Get a user's permissions for all rooms.
   * Returns array of { roomId, role, displayName }.
   */
  async getUserRoomPermissions(churchId, userKey) {
    await this.ready;
    const rows = await this._db.query(
      `SELECT * FROM rundown_room_permissions WHERE church_id = ? AND user_key = ?`,
      [churchId, userKey]
    );
    return rows.map(r => ({
      id: r.id,
      churchId: r.church_id,
      userKey: r.user_key,
      roomId: r.room_id,
      role: r.role,
      displayName: r.display_name || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Get all permissions for a specific room.
   * Returns array of { userKey, role, displayName }.
   */
  async getRoomPermissions(churchId, roomId) {
    await this.ready;
    const rows = await this._db.query(
      `SELECT * FROM rundown_room_permissions WHERE church_id = ? AND room_id = ?`,
      [churchId, roomId]
    );
    return rows.map(r => ({
      id: r.id,
      churchId: r.church_id,
      userKey: r.user_key,
      roomId: r.room_id,
      role: r.role,
      displayName: r.display_name || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Check if a user has at least the specified role for a room.
   * Returns true if they have permission, or if no room permissions exist
   * for this church (permissions are opt-in).
   */
  async checkRoomAccess(churchId, userKey, roomId, minimumRole = 'editor') {
    await this.ready;
    if (!roomId) return true; // no room = no restriction
    // Check if any room permissions exist for this church
    const anyPerms = await this._db.queryOne(
      `SELECT COUNT(*) as cnt FROM rundown_room_permissions WHERE church_id = ?`,
      [churchId]
    );
    if (!anyPerms || anyPerms.cnt === 0) return true; // no permissions configured = open access

    const perm = await this._db.queryOne(
      `SELECT role FROM rundown_room_permissions WHERE church_id = ? AND user_key = ? AND room_id = ?`,
      [churchId, userKey, roomId]
    );
    if (!perm) return false; // user has no explicit permission for this room

    const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };
    return (ROLE_RANK[perm.role] ?? 0) >= (ROLE_RANK[minimumRole] ?? 0);
  }

  /**
   * Delete all room permissions for a user.
   */
  async deleteUserRoomPermissions(churchId, userKey) {
    await this.ready;
    await this._db.run(
      `DELETE FROM rundown_room_permissions WHERE church_id = ? AND user_key = ?`,
      [churchId, userKey]
    );
  }
}

module.exports = { ManualRundownStore };
