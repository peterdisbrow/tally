'use strict';

const TENANT_SCOPED_TABLES = [
  { table: 'church_tds', column: 'church_id', index: 'idx_church_tds_church_id' },
  { table: 'alerts', column: 'church_id', index: 'idx_alerts_church_id' },
  { table: 'service_events', column: 'church_id', index: 'idx_service_events_church_id' },
  { table: 'service_sessions', column: 'church_id', index: 'idx_service_sessions_church_id' },
  { table: 'billing_customers', column: 'church_id', index: 'idx_billing_customers_church_id' },
  { table: 'room_equipment', column: 'church_id', index: 'idx_room_equipment_church' },
  { table: 'support_triage_runs', column: 'church_id', index: 'idx_support_triage_church' },
  { table: 'support_tickets', column: 'church_id', index: 'idx_support_ticket_church' },
  { table: 'network_topology', column: 'church_id', index: 'idx_network_topology_church' },
  { table: 'problem_finder_reports', column: 'church_id', index: 'idx_pf_reports_church' },
  { table: 'ai_usage_log', column: 'church_id', index: 'idx_ai_usage_church' },
  { table: 'ai_chat_log', column: 'church_id', index: 'idx_ai_chat_log_church' },
  { table: 'viewer_snapshots', column: 'church_id', index: 'idx_viewer_snaps_church' },
  { table: 'rooms', column: 'church_id', index: 'idx_rooms_church_id', legacyAlias: 'campus_id' },
  { table: 'guest_tokens', column: 'church_id', index: 'idx_guest_tokens_church_id', legacyAlias: 'churchId' },
  { table: 'diagnostic_bundles', column: 'church_id', index: 'idx_diagnostic_bundles_church', legacyAlias: 'churchId' },
];

const CANONICAL_TENANT_COLUMNS = TENANT_SCOPED_TABLES.filter((definition) => definition.legacyAlias);

function getTenantIdFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  return row.church_id ?? row.churchId ?? row.campus_id ?? row.campusId ?? null;
}

async function canSelectTenantColumn(queryClient, table, column) {
  try {
    await queryClient.queryOne(`SELECT ${column} FROM ${table} LIMIT 1`);
    return true;
  } catch (error) {
    const message = String(error?.message || '');
    if (/no such table|relation .* does not exist|does not exist/i.test(message)) return false;
    if (/no such column|column .* does not exist/i.test(message)) return false;
    throw error;
  }
}

async function ensureCanonicalTenantColumns(queryClient, {
  logger = console,
  definitions = CANONICAL_TENANT_COLUMNS,
} = {}) {
  const results = [];

  for (const definition of definitions) {
    const legacyPresent = await canSelectTenantColumn(queryClient, definition.table, definition.legacyAlias);
    if (!legacyPresent) {
      results.push({ ...definition, status: 'legacy_missing' });
      continue;
    }

    const canonicalPresent = await canSelectTenantColumn(queryClient, definition.table, definition.column);
    if (!canonicalPresent) {
      try {
        await queryClient.exec(`ALTER TABLE ${definition.table} ADD COLUMN ${definition.column} TEXT`);
      } catch (error) {
        if (!/duplicate column|already exists/i.test(String(error?.message || ''))) throw error;
      }
    }

    await queryClient.run(`
      UPDATE ${definition.table}
      SET ${definition.column} = ${definition.legacyAlias}
      WHERE (${definition.column} IS NULL OR ${definition.column} = '')
        AND ${definition.legacyAlias} IS NOT NULL
    `);

    results.push({
      ...definition,
      status: canonicalPresent ? 'canonical_present' : 'canonical_added',
    });
  }

  const migrated = results.filter((result) => result.status === 'canonical_added');
  if (migrated.length > 0) {
    logger.log?.(`[tenantGuardrails] Added canonical church_id columns on ${migrated.length} legacy table(s): ${migrated.map((item) => item.table).join(', ')}`);
  }

  return results;
}

async function ensureTenantGuardrails(queryClient, {
  logger = console,
  definitions = TENANT_SCOPED_TABLES,
} = {}) {
  const results = [];

  for (const definition of definitions) {
    const present = await canSelectTenantColumn(queryClient, definition.table, definition.column);
    if (!present) {
      results.push({ ...definition, status: 'missing' });
      continue;
    }

    try {
      await queryClient.exec(`CREATE INDEX IF NOT EXISTS ${definition.index} ON ${definition.table}(${definition.column})`);
      results.push({ ...definition, status: 'ok' });
    } catch (error) {
      results.push({ ...definition, status: 'index_error', error: error.message });
    }
  }

  const missing = results.filter((result) => result.status === 'missing');
  const errors = results.filter((result) => result.status === 'index_error');
  const legacy = results.filter((result) => result.legacyAlias);

  if (missing.length > 0) {
    logger.warn?.(`[tenantGuardrails] Missing tenant columns on ${missing.length} table(s): ${missing.map((item) => `${item.table}.${item.column}`).join(', ')}`);
  }

  if (errors.length > 0) {
    logger.warn?.(`[tenantGuardrails] Failed to enforce ${errors.length} tenant index(es): ${errors.map((item) => `${item.table}.${item.column}`).join(', ')}`);
  }

  if (legacy.length > 0) {
    logger.warn?.(`[tenantGuardrails] Legacy tenant columns still active: ${legacy.map((item) => `${item.table}.${item.legacyAlias || item.column}`).join(', ')}`);
  }

  return results;
}

module.exports = {
  CANONICAL_TENANT_COLUMNS,
  TENANT_SCOPED_TABLES,
  getTenantIdFromRow,
  ensureCanonicalTenantColumns,
  ensureTenantGuardrails,
};
