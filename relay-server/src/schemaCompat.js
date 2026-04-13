const syncColumnCache = new WeakMap();
const asyncColumnCache = new WeakMap();

function validateIdentifier(identifier) {
  if (typeof identifier !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`[schemaCompat] Invalid SQL identifier: ${identifier}`);
  }
  return identifier;
}

function quoteIdentifier(identifier) {
  return `"${validateIdentifier(identifier)}"`;
}

function getCache(cacheMap, key) {
  let cache = cacheMap.get(key);
  if (!cache) {
    cache = new Map();
    cacheMap.set(key, cache);
  }
  return cache;
}

function getCacheKey(table, column) {
  return `${validateIdentifier(table)}:${validateIdentifier(column)}`;
}

function readCachedValue(cacheMap, key, table, column) {
  const cache = getCache(cacheMap, key);
  const cacheKey = getCacheKey(table, column);
  return cache.has(cacheKey) ? cache.get(cacheKey) : undefined;
}

function writeCachedValue(cacheMap, key, table, column, value) {
  getCache(cacheMap, key).set(getCacheKey(table, column), value);
}

function clearCachedValue(cacheMap, key, table, column) {
  getCache(cacheMap, key).delete(getCacheKey(table, column));
}

function hasColumnSync(db, table, column) {
  const cached = readCachedValue(syncColumnCache, db, table, column);
  if (cached !== undefined) return cached;

  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  const present = rows.some(row => row.name === column);
  writeCachedValue(syncColumnCache, db, table, column, present);
  return present;
}

async function hasColumn(client, table, column) {
  const cached = readCachedValue(asyncColumnCache, client, table, column);
  if (cached !== undefined) return cached;

  let present = false;
  if (client?.driver === 'postgres') {
    validateIdentifier(table);
    validateIdentifier(column);
    const row = await client.queryOne(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = ANY(current_schemas(false))
        AND table_name = ?
        AND column_name = ?
      LIMIT 1
    `, [table, column]);
    present = !!row;
  } else {
    const rows = await client.query(`PRAGMA table_info(${quoteIdentifier(table)})`);
    present = rows.some(row => row.name === column);
  }

  writeCachedValue(asyncColumnCache, client, table, column, present);
  return present;
}

function ensureColumnSync(db, table, column, definition) {
  if (hasColumnSync(db, table, column)) return false;

  try {
    db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
  } catch (error) {
    clearCachedValue(syncColumnCache, db, table, column);
    if (!hasColumnSync(db, table, column)) throw error;
  }

  writeCachedValue(syncColumnCache, db, table, column, true);
  return true;
}

async function ensureColumn(client, table, column, definition) {
  if (await hasColumn(client, table, column)) return false;

  try {
    await client.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
  } catch (error) {
    clearCachedValue(asyncColumnCache, client, table, column);
    if (!(await hasColumn(client, table, column))) throw error;
  }

  writeCachedValue(asyncColumnCache, client, table, column, true);
  return true;
}

function buildNonTestSessionClauseSync(db, columnRef = 'session_type') {
  return hasColumnSync(db, 'service_sessions', 'session_type')
    ? ` AND (${columnRef} IS NULL OR ${columnRef} != 'test')`
    : '';
}

async function buildNonTestSessionClause(client, columnRef = 'session_type') {
  return (await hasColumn(client, 'service_sessions', 'session_type'))
    ? ` AND (${columnRef} IS NULL OR ${columnRef} != 'test')`
    : '';
}

function buildTestSessionPredicateSync(db, columnRef = 'session_type') {
  return hasColumnSync(db, 'service_sessions', 'session_type')
    ? `${columnRef} = 'test'`
    : '0 = 1';
}

async function buildTestSessionPredicate(client, columnRef = 'session_type') {
  return (await hasColumn(client, 'service_sessions', 'session_type'))
    ? `${columnRef} = 'test'`
    : '0 = 1';
}

module.exports = {
  hasColumnSync,
  hasColumn,
  ensureColumnSync,
  ensureColumn,
  buildNonTestSessionClauseSync,
  buildNonTestSessionClause,
  buildTestSessionPredicateSync,
  buildTestSessionPredicate,
};
