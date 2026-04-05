/**
 * Admin church management routes: list, billing update, delete.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupAdminChurchRoutes(app, ctx) {
  const { db, queryClient, churches, requireAdmin,
          billing, normalizeBillingInterval, messageQueues,
          BILLING_TIERS, BILLING_STATUSES, safeErrorMessage, log, logAudit } = ctx;
  const listObservedChurches = typeof ctx.listObservedChurches === 'function'
    ? ctx.listObservedChurches
    : () => Array.from(churches.values());
  const hasQueryClient = queryClient && typeof queryClient.queryOne === 'function';
  const qOne = (sql, params = []) => (
    hasQueryClient ? queryClient.queryOne(sql, params) : db.prepare(sql).get(...params) || null
  );
  const qAll = (sql, params = []) => (
    hasQueryClient ? queryClient.query(sql, params) : db.prepare(sql).all(...params)
  );
  const qRun = (sql, params = []) => (
    hasQueryClient ? queryClient.run(sql, params) : db.prepare(sql).run(...params)
  );

  function isConnected(church) {
    if (!church) return false;
    if (typeof church.connected === 'boolean') return church.connected;
    return !!(church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN));
  }

  function auditBilling(req, churchId, details) {
    if (!logAudit) return;
    const auth = req.headers['authorization'] || '';
    logAudit({
      adminUserId: req.adminUser?.id || null,
      adminEmail: req.adminUser?.email || 'api',
      action: 'billing_updated',
      targetType: 'church',
      targetId: churchId,
      details,
      ip: req.ip,
    });
  }
  const WebSocket = require('ws').WebSocket;

  // ─── Helper: cascade-delete all church data (explicit allowlist, no dynamic SQL) ─
  const ALLOWED_CASCADE_DELETES = [
    { table: 'chat_messages', column: 'churchId' },
    { table: 'alerts', column: 'church_id' },
    { table: 'support_tickets', column: 'church_id' },
    { table: 'support_triage_runs', column: 'church_id' },
    { table: 'church_tds', column: 'church_id' },
    { table: 'church_schedules', column: 'church_id' },
    { table: 'church_reviews', column: 'church_id' },
    { table: 'guest_tokens', column: 'church_id' },
    { table: 'maintenance_windows', column: 'churchId' },
    { table: 'email_sends', column: 'church_id' },
    { table: 'referrals', column: 'referrer_id' },
    { table: 'referrals', column: 'referred_id' },
    { table: 'viewer_snapshots', column: 'church_id' },
    { table: 'audit_log', column: 'target_id' },
    { table: 'ai_usage_log', column: 'church_id' },
    { table: 'onboarding_sessions', column: 'church_id' },
    { table: 'automation_rules', column: 'church_id' },
    { table: 'church_documents', column: 'church_id' },
    { table: 'church_macros', column: 'church_id' },
    { table: 'rooms', column: 'church_id' },
  ];

  async function deleteChurchCascade(churchId) {
    if (hasQueryClient) {
      try {
        const children = await qAll('SELECT churchId FROM churches WHERE parent_church_id = ?', [churchId]);
        for (const child of children) {
          for (const { table, column } of ALLOWED_CASCADE_DELETES) {
            try { await qRun(`DELETE FROM ${table} WHERE ${column} = ?`, [child.churchId]); } catch { /* table may not exist */ }
          }
          try { await qRun('DELETE FROM churches WHERE churchId = ?', [child.churchId]); } catch {}
          churches.delete(child.churchId);
        }
      } catch { /* parent_church_id column may not exist */ }

      for (const { table, column } of ALLOWED_CASCADE_DELETES) {
        try {
          await qRun(`DELETE FROM ${table} WHERE ${column} = ?`, [churchId]);
        } catch { /* table may not exist */ }
      }
      await qRun('DELETE FROM churches WHERE churchId = ?', [churchId]);
      return;
    }

    const tx = db.transaction((id) => {
      // Delete any child churches first
      try {
        const children = db.prepare('SELECT churchId FROM churches WHERE parent_church_id = ?').all(id);
        for (const child of children) {
          for (const { table, column } of ALLOWED_CASCADE_DELETES) {
            try { db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(child.churchId); } catch { /* table may not exist */ }
          }
          try { db.prepare('DELETE FROM churches WHERE churchId = ?').run(child.churchId); } catch {}
          churches.delete(child.churchId);
        }
      } catch { /* parent_church_id column may not exist */ }

      for (const { table, column } of ALLOWED_CASCADE_DELETES) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
        } catch { /* table may not exist */ }
      }
      db.prepare('DELETE FROM churches WHERE churchId = ?').run(id);
    });

    tx(churchId);
  }

  // List all churches
  app.get('/api/churches', requireAdmin, async (req, res) => {
    const allRows = await qAll('SELECT * FROM churches');
    const rowMap = new Map(allRows.map(r => [r.churchId, r]));

    const list = listObservedChurches().map(c => {
      const row = rowMap.get(c.churchId) || {};
      return {
        churchId:         c.churchId,
        name:             c.name,
        connected:        isConnected(c),
        status:           c.status,
        lastSeen:         c.lastSeen,
        church_type:      c.church_type      || 'recurring',
        event_expires_at: c.event_expires_at || null,
        event_label:      c.event_label      || null,
        reseller_id:      c.reseller_id      || null,
        portal_email:        row.portal_email || null,
        billing_tier:        row.billing_tier || null,
        billing_interval:    row.billing_interval || null,
        billing_status:      row.billing_status || 'inactive',
        billing_trial_ends:  row.billing_trial_ends || null,
        has_slack:            !!row.slack_webhook_url,
        registrationCode:    row.registration_code || c.registrationCode || null,
        token:               row.token || c.token || null,
      };
    });
    res.json(list);
  });

  // Update billing plan/status manually
  app.put('/api/churches/:churchId/billing', requireAdmin, async (req, res) => {
    const { churchId } = req.params;
    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    const row = await qOne('SELECT * FROM churches WHERE churchId = ?', [churchId]);
    if (!row) return res.status(404).json({ error: 'Church not found' });

    const inTier = req.body?.tier;
    const inStatus = req.body?.status;
    const inInterval = req.body?.billingInterval ?? req.body?.billingCycle ?? req.body?.interval;
    if (!inTier && !inStatus && inInterval === undefined) return res.status(400).json({ error: 'tier, status, or billingInterval required' });

    const nextTier = inTier ? String(inTier).toLowerCase() : String(row.billing_tier || 'connect').toLowerCase();
    const nextStatus = inStatus ? String(inStatus).toLowerCase() : String(row.billing_status || 'inactive').toLowerCase();
    const currentInterval = normalizeBillingInterval(
      row.billing_interval, nextTier,
      nextTier === 'event' ? 'one_time' : 'monthly',
    ) || (nextTier === 'event' ? 'one_time' : 'monthly');
    const nextInterval = inInterval === undefined
      ? currentInterval
      : normalizeBillingInterval(inInterval, nextTier, currentInterval);

    if (!BILLING_TIERS.has(nextTier)) return res.status(400).json({ error: 'invalid tier' });
    if (!BILLING_STATUSES.has(nextStatus)) return res.status(400).json({ error: 'invalid status' });
    if (!nextInterval) return res.status(400).json({ error: 'invalid billingInterval' });

    await qRun('UPDATE churches SET billing_tier = ?, billing_status = ?, billing_interval = ? WHERE churchId = ?', [nextTier, nextStatus, nextInterval, churchId]);

    const now = new Date().toISOString();
    const billingRecord = await qOne('SELECT id FROM billing_customers WHERE church_id = ?', [churchId]);
    if (billingRecord?.id) {
      await qRun('UPDATE billing_customers SET tier = ?, billing_interval = ?, status = ?, updated_at = ? WHERE id = ?', [nextTier, nextInterval, nextStatus, now, billingRecord.id]);
    } else {
      await qRun(`
        INSERT INTO billing_customers
          (id, church_id, tier, billing_interval, status, email, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [`manual_${churchId}`, churchId, nextTier, nextInterval, nextStatus, row.portal_email || row.email || '', now, now]);
    }

    auditBilling(req, churchId, { tier: nextTier, status: nextStatus, interval: nextInterval });
    res.json({
      ok: true,
      churchId,
      billing: { tier: nextTier, billingInterval: nextInterval, status: nextStatus },
    });
  });

  // Delete a church
  app.delete('/api/churches/:churchId', requireAdmin, async (req, res) => {
    const { churchId } = req.params;
    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    if (church.sockets?.size) {
      for (const sock of church.sockets.values()) {
        if (sock.readyState === WebSocket.OPEN) sock.close(1000, 'church deleted');
      }
    }

    try {
      await deleteChurchCascade(churchId);
    } catch (e) {
      console.error(`[DeleteChurch] Failed for ${churchId}:`, e.message);
      return res.status(500).json({ error: safeErrorMessage(e, 'Failed to delete church') });
    }
    churches.delete(churchId);
    messageQueues.delete(churchId);

    log(`Deleted church: ${church.name} (${churchId})`);
    res.json({ deleted: true, name: church.name });
  });
};
