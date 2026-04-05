const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { resolveDatabaseConfig } = require('./config');
const { createQueryClient } = require('./queryClient');

function ensureParentDir(filePath) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function createSqliteDatabase(config) {
  ensureParentDir(config.sqlitePath);

  const db = new Database(config.sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

function isIgnorableBootstrapExecError(sql, error) {
  const message = String(error?.message || '');
  if (/^\s*PRAGMA\b/i.test(sql)) return true;
  if (/^\s*ALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b/i.test(sql) && /duplicate column|already exists/i.test(message)) {
    return true;
  }
  if (/^\s*ALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b/i.test(sql) && /relation .* does not exist|no such table/i.test(message)) {
    return true;
  }
  if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(sql) && /relation .* does not exist|no such table/i.test(message)) {
    return true;
  }
  return false;
}

function createBootstrapCompatibleDb(queryClient) {
  let queue = Promise.resolve();
  let firstError = null;
  let opId = 0;
  const debug = process.env.DB_BOOTSTRAP_DEBUG === '1';

  const enqueue = (task) => {
    queue = queue.then(task).catch((error) => {
      if (!firstError) firstError = error;
    });
    return queue;
  };

  return {
    queryClient,
    exec(sql) {
      const currentId = ++opId;
      const label = String(sql || '').trim().split('\n')[0].slice(0, 120);
      enqueue(async () => {
        if (debug) console.log(`[db-bootstrap] start #${currentId}: ${label}`);
        try {
          await queryClient.exec(sql);
          if (debug) console.log(`[db-bootstrap] ok #${currentId}`);
        } catch (error) {
          if (isIgnorableBootstrapExecError(sql, error)) {
            if (debug) console.log(`[db-bootstrap] ignore #${currentId}: ${error.message}`);
            return;
          }
          if (debug) console.log(`[db-bootstrap] fail #${currentId}: ${error.message}`);
          throw error;
        }
      });
    },
    async close() {
      await queryClient.close();
    },
    async whenReady() {
      await Promise.resolve();
      await queue;
      if (firstError) throw firstError;
    },
  };
}

function createAppDatabase(options = {}) {
  const { env = process.env, onInfo } = options;
  const config = resolveDatabaseConfig(env);

  if (config.isPostgres) {
    if (!config.databaseUrl) {
      throw new Error('[STARTUP] DATABASE_URL is required when DATABASE_DRIVER=postgres.');
    }
    const queryClient = createQueryClient({ config });
    const db = createBootstrapCompatibleDb(queryClient);
    if (typeof queryClient.setStartupBarrier === 'function') {
      queryClient.setStartupBarrier(() => db.whenReady());
    }
    if (typeof onInfo === 'function') {
      onInfo('[db] Using postgres database runtime', {
        event: 'db_runtime_selected',
        databaseDriver: config.driver,
        databaseUrlConfigured: true,
      });
    }
    return { db, config, queryClient };
  }

  const db = createSqliteDatabase(config);
  const queryClient = createQueryClient({ config, sqliteDb: db });
  if (typeof onInfo === 'function') {
    onInfo(`[db] Using sqlite database at ${config.sqlitePath}`, {
      event: 'db_runtime_selected',
      databaseDriver: config.driver,
      databasePath: config.sqlitePath,
    });
  }

  return { db, config, queryClient };
}

module.exports = {
  createAppDatabase,
  createSqliteDatabase,
  createQueryClient,
};
