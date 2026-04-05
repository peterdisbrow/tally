const { Pool } = require('pg');

function convertPlaceholders(sql) {
  let index = 0;
  let out = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '-' && next === '-') {
        out += ch + next;
        i++;
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        out += ch + next;
        i++;
        inBlockComment = true;
        continue;
      }
    }

    if (ch === '\'' && !inDoubleQuote) {
      out += ch;
      if (inSingleQuote && next === '\'') {
        out += next;
        i++;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      out += ch;
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (ch === '?' && !inSingleQuote && !inDoubleQuote) {
      index++;
      out += `$${index}`;
      continue;
    }

    out += ch;
  }

  return out;
}

class SqliteQueryClient {
  constructor(db) {
    this.db = db;
    this.driver = 'sqlite';
    this.startupBarrier = null;
  }

  setStartupBarrier(barrier) {
    this.startupBarrier = barrier || null;
  }

  async _awaitStartupBarrier() {
    if (!this.startupBarrier) return;
    if (typeof this.startupBarrier === 'function') {
      await this.startupBarrier();
      return;
    }
    await this.startupBarrier;
  }

  async exec(sql) {
    this.db.exec(sql);
  }

  async query(sql, params = []) {
    await this._awaitStartupBarrier();
    return this.db.prepare(sql).all(...params);
  }

  async queryOne(sql, params = []) {
    await this._awaitStartupBarrier();
    return this.db.prepare(sql).get(...params) || null;
  }

  async queryValue(sql, params = []) {
    const row = await this.queryOne(sql, params);
    if (!row) return null;
    const [firstValue] = Object.values(row);
    return firstValue ?? null;
  }

  async run(sql, params = []) {
    await this._awaitStartupBarrier();
    const info = this.db.prepare(sql).run(...params);
    return {
      changes: Number(info?.changes || 0),
      lastInsertRowid: info?.lastInsertRowid ?? null,
      rows: [],
    };
  }

  async close() {}
}

class PostgresQueryClient {
  constructor(options = {}) {
    const {
      connectionString,
      max = Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
      ssl = { rejectUnauthorized: false },
    } = options;

    this.driver = 'postgres';
    this.startupBarrier = null;
    this.pool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis,
      ssl,
    });
  }

  setStartupBarrier(barrier) {
    this.startupBarrier = barrier || null;
  }

  async _awaitStartupBarrier() {
    if (!this.startupBarrier) return;
    if (typeof this.startupBarrier === 'function') {
      await this.startupBarrier();
      return;
    }
    await this.startupBarrier;
  }

  async exec(sql) {
    await this.pool.query(sql);
  }

  async query(sql, params = []) {
    await this._awaitStartupBarrier();
    const result = await this.pool.query(convertPlaceholders(sql), params);
    return result.rows;
  }

  async queryOne(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] || null;
  }

  async queryValue(sql, params = []) {
    const row = await this.queryOne(sql, params);
    if (!row) return null;
    const [firstValue] = Object.values(row);
    return firstValue ?? null;
  }

  async run(sql, params = []) {
    await this._awaitStartupBarrier();
    const result = await this.pool.query(convertPlaceholders(sql), params);
    return {
      changes: Number(result?.rowCount || 0),
      lastInsertRowid: null,
      rows: result?.rows || [],
    };
  }

  async close() {
    await this.pool.end();
  }
}

function createQueryClient(options = {}) {
  const { config, sqliteDb } = options;
  if (!config) throw new Error('[DB] createQueryClient requires a resolved config object.');

  if (config.isPostgres) {
    if (!config.databaseUrl) {
      throw new Error('[DB] DATABASE_URL is required when DATABASE_DRIVER=postgres.');
    }
    return new PostgresQueryClient({ connectionString: config.databaseUrl });
  }

  if (!sqliteDb) {
    throw new Error('[DB] sqliteDb is required when DATABASE_DRIVER=sqlite.');
  }

  return new SqliteQueryClient(sqliteDb);
}

module.exports = {
  SqliteQueryClient,
  PostgresQueryClient,
  createQueryClient,
  convertPlaceholders,
};
