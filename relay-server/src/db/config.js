const path = require('path');

const DEFAULT_SQLITE_PATH = './data/churches.db';
const SUPPORTED_DATABASE_DRIVERS = Object.freeze(['sqlite', 'postgres']);

function normalizeDatabaseDriver(raw) {
  const value = String(raw || 'sqlite').trim().toLowerCase();
  if (!value) return 'sqlite';
  if (value === 'postgresql') return 'postgres';
  return value;
}

function resolveDatabaseConfig(env = process.env) {
  const driver = normalizeDatabaseDriver(env.DATABASE_DRIVER || env.DB_DRIVER || 'sqlite');
  if (!SUPPORTED_DATABASE_DRIVERS.includes(driver)) {
    throw new Error(
      `[DB] Unsupported DATABASE_DRIVER "${driver}". Expected one of: ${SUPPORTED_DATABASE_DRIVERS.join(', ')}.`
    );
  }

  const sqlitePathRaw = env.DATABASE_PATH || DEFAULT_SQLITE_PATH;
  const databaseUrl = String(env.DATABASE_URL || '').trim();

  return {
    driver,
    databaseUrl,
    sqlitePathRaw,
    sqlitePath: path.resolve(sqlitePathRaw),
    isSqlite: driver === 'sqlite',
    isPostgres: driver === 'postgres',
  };
}

function assertSqliteDriver(config, context = 'This command') {
  if (config?.isSqlite) return config;

  throw new Error(
    `[DB] ${context} currently only supports SQLite. Current DATABASE_DRIVER=${config?.driver || 'unknown'}. ` +
    'Use DATABASE_DRIVER=sqlite for this command.'
  );
}

function resolveSqliteBackupConfig(env = process.env) {
  const config = assertSqliteDriver(resolveDatabaseConfig(env), 'SQLite backup tooling');

  return {
    ...config,
    backupDir: path.resolve(env.BACKUP_DIR || path.join(path.dirname(config.sqlitePath), 'backups')),
    retainCount: Number(env.BACKUP_RETAIN_COUNT || 96),
    label: env.BACKUP_LABEL || 'manual',
    encryptionKey: env.BACKUP_ENCRYPTION_KEY || '',
  };
}

module.exports = {
  DEFAULT_SQLITE_PATH,
  SUPPORTED_DATABASE_DRIVERS,
  normalizeDatabaseDriver,
  resolveDatabaseConfig,
  resolveSqliteBackupConfig,
  assertSqliteDriver,
};
