#!/usr/bin/env node

'use strict';

const Database = require('better-sqlite3');
const { Client } = require('pg');

const BATCH_SIZE = Number(process.env.MIGRATION_BATCH_SIZE || 200);
const PREFERRED_ORDER = [
  'resellers',
  'admin_users',
  'churches',
  'rooms',
  'room_equipment',
  'church_tds',
  'td_oncall',
  'td_room_assignments',
  'billing_customers',
  'church_ai_settings',
  'church_memory',
  'church_documents',
  'church_macros',
  'presets',
  'onboarding_sessions',
  'guest_tokens',
  'mobile_devices',
  'mobile_notification_prefs',
  'email_preferences',
  'email_sends',
  'email_template_overrides',
  'support_triage_runs',
  'support_tickets',
  'support_ticket_updates',
  'status_components',
  'status_incidents',
  'alerts',
  'incident_chains',
  'incident_summaries',
  'ai_usage_log',
  'ai_chat_log',
  'ai_diagnostic_usage',
  'ai_triage_events',
  'ai_resolutions',
  'diagnostic_bundles',
  'problem_finder_reports',
  'service_events',
  'service_sessions',
  'preservice_check_results',
  'preservice_confirmations',
  'preservice_rundowns',
  'post_service_reports',
  'viewer_baselines',
  'viewer_snapshots',
  'network_topology',
  'automation_rules',
  'autopilot_session_fires',
  'active_rundowns',
  'rundowns',
  'pc_plans',
  'processed_webhook_events',
  'sales_leads',
  'referrals',
  'church_reviews',
  'smart_plugs',
  'version_requirements',
  '_health_probe',
];

function parseArgs(argv) {
  const args = {
    dryRun: false,
    only: null,
    sqlitePath: process.env.SQLITE_PATH || '',
    databaseUrl: process.env.DATABASE_URL || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--sqlite') {
      args.sqlitePath = argv[i + 1] || '';
      i += 1;
    } else if (token === '--database-url') {
      args.databaseUrl = argv[i + 1] || '';
      i += 1;
    } else if (token === '--only') {
      args.only = (argv[i + 1] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      i += 1;
    }
  }

  return args;
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function chunk(values, size) {
  const items = [];
  for (let index = 0; index < values.length; index += size) {
    items.push(values.slice(index, index + size));
  }
  return items;
}

function sortTables(tables) {
  const rank = new Map(PREFERRED_ORDER.map((name, index) => [name, index]));
  return [...tables].sort((left, right) => {
    const leftRank = rank.has(left) ? rank.get(left) : Number.MAX_SAFE_INTEGER;
    const rightRank = rank.has(right) ? rank.get(right) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
}

function convertBooleanValue(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 't' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === 'f' || normalized === '0' || normalized === 'no') return false;
  }
  return Boolean(value);
}

async function getPostgresTables(client) {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC
  `);
  return result.rows.map((row) => row.table_name);
}

async function getPostgresColumns(client) {
  const result = await client.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY ordinal_position ASC
  `);
  const columnsByTable = new Map();
  for (const row of result.rows) {
    if (!columnsByTable.has(row.table_name)) {
      columnsByTable.set(row.table_name, []);
    }
    columnsByTable.get(row.table_name).push({
      name: row.column_name,
      dataType: row.data_type,
    });
  }
  return columnsByTable;
}

async function getPostgresSequences(client) {
  const result = await client.query(`
    SELECT
      c.table_name,
      c.column_name,
      pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) AS sequence_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_default LIKE 'nextval(%'
    ORDER BY c.table_name ASC, c.column_name ASC
  `);
  return result.rows.filter((row) => row.sequence_name);
}

function getSqliteTables(sqlite) {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name ASC")
    .all('table', 'sqlite_%')
    .map((row) => row.name);
}

function getSqliteColumns(sqlite, tableName) {
  return sqlite
    .prepare(`PRAGMA table_info(${quoteIdent(tableName)})`)
    .all()
    .map((row) => row.name);
}

function buildInsertStatement(tableName, mappings, rowCount) {
  const targetColumns = mappings.map((mapping) => mapping.pgName);
  const quotedColumns = targetColumns.map(quoteIdent).join(', ');
  const valueGroups = [];
  const parameterValues = [];
  let parameterIndex = 1;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const placeholders = targetColumns.map(() => `$${parameterIndex++}`);
    valueGroups.push(`(${placeholders.join(', ')})`);
  }

  return {
    sql: `INSERT INTO ${quoteIdent(tableName)} (${quotedColumns}) VALUES ${valueGroups.join(', ')}`,
    pushRow(row, coercers) {
      for (const mapping of mappings) {
        const value = row[mapping.sqliteName];
        parameterValues.push(coercers.get(mapping.pgName)?.(value) ?? value);
      }
    },
    values: parameterValues,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sqlitePath) {
    throw new Error('Missing SQLite source. Set SQLITE_PATH or pass --sqlite /path/to/churches.db');
  }
  if (!args.databaseUrl) {
    throw new Error('Missing Postgres target. Set DATABASE_URL or pass --database-url <postgres-uri>');
  }

  const sqlite = new Database(args.sqlitePath, { readonly: true, fileMustExist: true });
  const client = new Client({ connectionString: args.databaseUrl });

  try {
    await client.connect();

    const sqliteTables = getSqliteTables(sqlite);
    const postgresTables = await getPostgresTables(client);
    const postgresColumns = await getPostgresColumns(client);
    const postgresSequences = await getPostgresSequences(client);

    let commonTables = sqliteTables.filter((table) => postgresTables.includes(table));
    if (args.only?.length) {
      const requested = new Set(args.only);
      commonTables = commonTables.filter((table) => requested.has(table));
    }
    commonTables = sortTables(commonTables);

    if (!commonTables.length) {
      throw new Error('No common tables found between SQLite and Postgres for the selected filters.');
    }

    console.log(JSON.stringify({
      ok: true,
      dryRun: args.dryRun,
      sqlitePath: args.sqlitePath,
      tableCount: commonTables.length,
      tables: commonTables,
    }, null, 2));

    if (args.dryRun) {
      for (const tableName of commonTables) {
        const row = sqlite.prepare(`SELECT COUNT(*) AS cnt FROM ${quoteIdent(tableName)}`).get();
        console.log(`${tableName}: ${Number(row?.cnt || 0)} row(s)`);
      }
      return;
    }

    await client.query('BEGIN');

    for (const tableName of commonTables) {
      const sqliteColumns = getSqliteColumns(sqlite, tableName);
      const pgColumns = postgresColumns.get(tableName) || [];
      const pgColumnsByLowerName = new Map(
        pgColumns.map((column) => [String(column.name).toLowerCase(), column])
      );
      const columnMappings = sqliteColumns
        .map((sqliteName) => {
          const pgColumn = pgColumnsByLowerName.get(String(sqliteName).toLowerCase());
          return pgColumn
            ? { sqliteName, pgName: pgColumn.name }
            : null;
        })
        .filter(Boolean);

      if (!columnMappings.length) {
        console.log(`${tableName}: skipped (no common columns)`);
        continue;
      }

      const rowCount = Number(sqlite.prepare(`SELECT COUNT(*) AS cnt FROM ${quoteIdent(tableName)}`).get()?.cnt || 0);
      console.log(`${tableName}: truncating and importing ${rowCount} row(s)`);
      await client.query(`TRUNCATE TABLE ${quoteIdent(tableName)} RESTART IDENTITY CASCADE`);

      if (rowCount === 0) continue;

      const selectSql = `SELECT ${columnMappings.map((mapping) => quoteIdent(mapping.sqliteName)).join(', ')} FROM ${quoteIdent(tableName)}`;
      const rows = sqlite.prepare(selectSql).all();
      const coercers = new Map();
      for (const column of pgColumns) {
        if (column.dataType === 'boolean') {
          coercers.set(column.name, convertBooleanValue);
        }
      }

      for (const rowBatch of chunk(rows, BATCH_SIZE)) {
        const statement = buildInsertStatement(tableName, columnMappings, rowBatch.length);
        for (const row of rowBatch) {
          statement.pushRow(row, coercers);
        }
        await client.query(statement.sql, statement.values);
      }
    }

    for (const sequence of postgresSequences) {
      const maxResult = await client.query(
        `SELECT COALESCE(MAX(${quoteIdent(sequence.column_name)}), 0) AS max_value FROM ${quoteIdent(sequence.table_name)}`
      );
      const maxValue = Number(maxResult.rows[0]?.max_value || 0);
      if (maxValue > 0) {
        await client.query('SELECT setval($1, $2, true)', [sequence.sequence_name, maxValue]);
      } else {
        await client.query('SELECT setval($1, 1, false)', [sequence.sequence_name]);
      }
    }

    await client.query('COMMIT');
    console.log('Migration complete.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    sqlite.close();
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
