import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  DEFAULT_SQLITE_PATH,
  resolveDatabaseConfig,
  resolveSqliteBackupConfig,
  assertSqliteDriver,
} = require('../src/db/config');
const { createAppDatabase, createQueryClient } = require('../src/db');
const { convertPlaceholders } = require('../src/db/queryClient');

describe('resolveDatabaseConfig', () => {
  it('defaults to sqlite and the standard db path', () => {
    const config = resolveDatabaseConfig({});
    expect(config.driver).toBe('sqlite');
    expect(config.isSqlite).toBe(true);
    expect(config.sqlitePath).toBe(path.resolve(DEFAULT_SQLITE_PATH));
    expect(config.databaseUrl).toBe('');
  });

  it('does not implicitly flip to postgres when DATABASE_URL is present', () => {
    const config = resolveDatabaseConfig({
      DATABASE_URL: 'postgresql://example',
    });
    expect(config.driver).toBe('sqlite');
    expect(config.databaseUrl).toBe('postgresql://example');
  });

  it('normalizes postgresql to postgres', () => {
    const config = resolveDatabaseConfig({
      DATABASE_DRIVER: 'postgresql',
      DATABASE_URL: 'postgresql://example',
    });
    expect(config.driver).toBe('postgres');
    expect(config.isPostgres).toBe(true);
  });

  it('rejects unsupported drivers', () => {
    expect(() => resolveDatabaseConfig({ DATABASE_DRIVER: 'mysql' }))
      .toThrow('Unsupported DATABASE_DRIVER');
  });
});

describe('resolveSqliteBackupConfig', () => {
  it('derives the backup directory beside the sqlite file', () => {
    const config = resolveSqliteBackupConfig({
      DATABASE_PATH: './var/data/churches.db',
    });
    expect(config.backupDir).toBe(path.resolve('./var/data/backups'));
    expect(config.retainCount).toBe(96);
  });

  it('blocks backup helpers when postgres is selected', () => {
    const config = resolveDatabaseConfig({
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://example',
    });
    expect(() => assertSqliteDriver(config, 'Backup script')).toThrow('only supports SQLite');
  });
});

describe('createAppDatabase', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a sqlite database with WAL mode enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-db-config-'));
    tempDirs.push(tempDir);

    const { db, config, queryClient } = createAppDatabase({
      env: {
        DATABASE_PATH: path.join(tempDir, 'churches.db'),
      },
    });

    try {
      expect(config.driver).toBe('sqlite');
      expect(fs.existsSync(config.sqlitePath)).toBe(true);
      expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
      await queryClient.exec('CREATE TABLE IF NOT EXISTS smoke_test (value TEXT)');
      await queryClient.run('INSERT INTO smoke_test (value) VALUES (?)', ['ready']);
      const row = await queryClient.queryOne('SELECT value FROM smoke_test WHERE value = ?', ['ready']);
      expect(row?.value).toBe('ready');
    } finally {
      db.close();
    }
  });

  it('creates a bootstrap-compatible postgres runtime wrapper', async () => {
    const { db, config, queryClient } = createAppDatabase({
      env: {
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'postgresql://example',
      },
    });

    expect(config.driver).toBe('postgres');
    expect(queryClient.driver).toBe('postgres');
    expect(typeof db.whenReady).toBe('function');
    await db.close();
  });
});

describe('createQueryClient', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports sqlite-style parameter placeholders through the async facade', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-query-client-'));
    tempDirs.push(tempDir);

    const { db, config } = createAppDatabase({
      env: {
        DATABASE_PATH: path.join(tempDir, 'query-client.db'),
      },
    });

    try {
      const client = createQueryClient({ config, sqliteDb: db });
      await client.exec('CREATE TABLE IF NOT EXISTS query_client_test (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
      await client.run('INSERT INTO query_client_test (value) VALUES (?)', ['alpha']);
      const row = await client.queryOne('SELECT value FROM query_client_test WHERE value = ?', ['alpha']);
      expect(row?.value).toBe('alpha');
    } finally {
      db.close();
    }
  });
});

describe('convertPlaceholders', () => {
  it('converts sqlite placeholders to postgres parameters', () => {
    expect(convertPlaceholders('SELECT * FROM test WHERE a = ? AND b = ?'))
      .toBe('SELECT * FROM test WHERE a = $1 AND b = $2');
  });

  it('does not replace question marks inside SQL strings', () => {
    expect(convertPlaceholders("SELECT '?' AS literal, value FROM test WHERE a = ?"))
      .toBe("SELECT '?' AS literal, value FROM test WHERE a = $1");
  });
});
