/**
 * Admin church management routes: list, billing update, delete.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupAdminChurchRoutes(app, ctx) {
  const { db, churches, requireAdmin, stmtGet, stmtDelete,
          billing, normalizeBillingInterval, messageQueues,
          BILLING_TIERS, BILLING_STATUSES, log } = ctx;
  const WebSocket = require('ws').WebSocket;

  // ─── Helper: cascade-delete all church data ──────────────────────────────────
  function deleteChurchCascade(churchId) {
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all();

    const tx = db.transaction((id) => {
      for (const row of tables) {
        const table = row?.name;
        if (!table || table === 'churches' || !ident.test(table)) continue;
        const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
        for (const fk of fks) {
          if (fk.table !== 'churches') continue;
          const col = fk.from;
          if (!col || !ident.test(col)) continue;
          db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(id);
        }
      }
      stmtDelete.run(id);
    });

    tx(churchId);
  }

  // List all churches
  app.get('/api/churches', requireAdmin, (req, res) => {
    const allRows = db.prepare('SELECT * FROM churches').all();
    const rowMap = new Map(allRows.map(r => [r.churchId, r]));

    const list = Array.from(churches.values()).map(c => {
      const row = rowMap.get(c.churchId) || {};
      return {
        churchId:         c.churchId,
        name:             c.name,
        connected:        c.ws?.readyState === WebSocket.OPEN,
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
  app.put('/api/churches/:churchId/billing', requireAdmin, (req, res) => {
    const { churchId } = req.params;
    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    const row = stmtGet.get(churchId);
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

    db.prepare('UPDATE churches SET billing_tier = ?, billing_status = ?, billing_interval = ? WHERE churchId = ?')
      .run(nextTier, nextStatus, nextInterval, churchId);

    const now = new Date().toISOString();
    const billingRecord = db.prepare('SELECT id FROM billing_customers WHERE church_id = ?').get(churchId);
    if (billingRecord?.id) {
      db.prepare('UPDATE billing_customers SET tier = ?, billing_interval = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(nextTier, nextInterval, nextStatus, now, billingRecord.id);
    } else {
      db.prepare(`
        INSERT INTO billing_customers
          (id, church_id, tier, billing_interval, status, email, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`manual_${churchId}`, churchId, nextTier, nextInterval, nextStatus, row.portal_email || row.email || '', now, now);
    }

    res.json({
      ok: true,
      churchId,
      billing: { tier: nextTier, billingInterval: nextInterval, status: nextStatus },
    });
  });

  // Delete a church
  app.delete('/api/churches/:churchId', requireAdmin, (req, res) => {
    const { churchId } = req.params;
    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    if (church.ws?.readyState === WebSocket.OPEN) {
      church.ws.close(1000, 'church deleted');
    }

    try {
      deleteChurchCascade(churchId);
    } catch (e) {
      console.error(`[DeleteChurch] Failed for ${churchId}:`, e.message);
      return res.status(500).json({ error: 'Failed to delete church', details: e.message });
    }
    churches.delete(churchId);
    messageQueues.delete(churchId);

    log(`Deleted church: ${church.name} (${churchId})`);
    res.json({ deleted: true, name: church.name });
  });
};
