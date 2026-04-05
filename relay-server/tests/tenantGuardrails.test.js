import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  ensureCanonicalTenantColumns,
  getTenantIdFromRow,
  ensureTenantGuardrails,
} = require('../src/db/tenantGuardrails');

function makeQueryClient({ present = {}, failingIndexes = new Set() } = {}) {
  const execCalls = [];
  const runCalls = [];
  return {
    execCalls,
    runCalls,
    async queryOne(sql) {
      const match = sql.match(/SELECT\s+("?[\w]+"?)\s+FROM\s+("?[\w]+"?)/i);
      const column = match?.[1]?.replace(/"/g, '');
      const table = match?.[2]?.replace(/"/g, '');
      const key = `${table}.${column}`;

      if (present[key]) return { [column]: null };
      throw new Error('column does not exist');
    },
    async exec(sql) {
      execCalls.push(sql);
      for (const failingIndex of failingIndexes) {
        if (sql.includes(failingIndex)) {
          throw new Error(`failed to create ${failingIndex}`);
        }
      }
    },
    async run(sql) {
      runCalls.push(sql.replace(/\s+/g, ' ').trim());
      return { changes: 1 };
    },
  };
}

describe('getTenantIdFromRow', () => {
  it('prefers canonical church_id when present', () => {
    expect(getTenantIdFromRow({ church_id: 'church-1', campus_id: 'campus-1' })).toBe('church-1');
  });

  it('falls back to legacy churchId and campus_id aliases', () => {
    expect(getTenantIdFromRow({ churchId: 'church-2' })).toBe('church-2');
    expect(getTenantIdFromRow({ campus_id: 'campus-1' })).toBe('campus-1');
  });

  it('returns null for non-tenant rows', () => {
    expect(getTenantIdFromRow({ id: 'row-1' })).toBeNull();
  });
});

describe('ensureTenantGuardrails', () => {
  it('adds canonical church_id columns for legacy tables before enforcing indexes', async () => {
    const queryClient = makeQueryClient({
      present: {
        'rooms.campus_id': true,
        'guest_tokens.churchId': true,
      },
    });

    const results = await ensureCanonicalTenantColumns(queryClient, {
      definitions: [
        { table: 'rooms', column: 'church_id', legacyAlias: 'campus_id' },
        { table: 'guest_tokens', column: 'church_id', legacyAlias: 'churchId' },
      ],
    });

    expect(results).toEqual([
      expect.objectContaining({ table: 'rooms', status: 'canonical_added' }),
      expect.objectContaining({ table: 'guest_tokens', status: 'canonical_added' }),
    ]);
    expect(queryClient.execCalls).toEqual([
      'ALTER TABLE rooms ADD COLUMN church_id TEXT',
      'ALTER TABLE guest_tokens ADD COLUMN church_id TEXT',
    ]);
    expect(queryClient.runCalls).toEqual([
      "UPDATE rooms SET church_id = campus_id WHERE (church_id IS NULL OR church_id = '') AND campus_id IS NOT NULL",
      "UPDATE guest_tokens SET church_id = churchId WHERE (church_id IS NULL OR church_id = '') AND churchId IS NOT NULL",
    ]);
  });

  it('creates indexes for present tenant columns and warns on legacy or missing ones', async () => {
    const queryClient = makeQueryClient({
      present: {
        'alerts.church_id': true,
        'rooms.church_id': true,
      },
    });
    const warnings = [];
    const logger = { warn: (message) => warnings.push(message) };

    const results = await ensureTenantGuardrails(queryClient, {
      logger,
      definitions: [
        { table: 'alerts', column: 'church_id', index: 'idx_alerts_church_id' },
        { table: 'rooms', column: 'church_id', index: 'idx_rooms_church_id', legacyAlias: 'campus_id' },
        { table: 'viewer_snapshots', column: 'church_id', index: 'idx_viewer_snapshots_church_id' },
      ],
    });

    expect(results).toEqual([
      expect.objectContaining({ table: 'alerts', status: 'ok' }),
      expect.objectContaining({ table: 'rooms', status: 'ok', legacyAlias: 'campus_id' }),
      expect.objectContaining({ table: 'viewer_snapshots', status: 'missing' }),
    ]);
    expect(queryClient.execCalls).toEqual([
      'CREATE INDEX IF NOT EXISTS idx_alerts_church_id ON alerts(church_id)',
      'CREATE INDEX IF NOT EXISTS idx_rooms_church_id ON rooms(church_id)',
    ]);
    expect(warnings.some((warning) => warning.includes('viewer_snapshots.church_id'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('rooms.campus_id'))).toBe(true);
  });

  it('records index creation failures without aborting the whole pass', async () => {
    const queryClient = makeQueryClient({
      present: {
        'alerts.church_id': true,
      },
      failingIndexes: new Set(['idx_alerts_church_id']),
    });
    const warnings = [];
    const logger = { warn: (message) => warnings.push(message) };

    const results = await ensureTenantGuardrails(queryClient, {
      logger,
      definitions: [
        { table: 'alerts', column: 'church_id', index: 'idx_alerts_church_id' },
      ],
    });

    expect(results[0]).toMatchObject({
      table: 'alerts',
      status: 'index_error',
      error: 'failed to create idx_alerts_church_id',
    });
    expect(warnings.some((warning) => warning.includes('alerts.church_id'))).toBe(true);
  });
});
