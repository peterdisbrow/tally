/**
 * Security tests — input validation, XSS handling, SQL injection safety,
 * and edge-case inputs for the auth and escapeHtml utilities.
 *
 * These tests verify the system handles malicious or unusual inputs safely:
 * - They are stored verbatim (no execution), or rejected, not destructive.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { hashPassword, verifyPassword } = require('../src/auth');
const { escapeHtml } = require('../src/escapeHtml');

// ─── escapeHtml — XSS sanitization ───────────────────────────────────────────

describe('escapeHtml — XSS payload escaping', () => {
  it('escapes a basic script tag', () => {
    const result = escapeHtml('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes angle brackets in any HTML tag', () => {
    const result = escapeHtml('<img src=x onerror=alert(1)>');
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });

  it('escapes double quotes', () => {
    const result = escapeHtml('" onmouseover="alert(1)"');
    expect(result).not.toContain('"');
    expect(result).toContain('&quot;');
  });

  it('escapes single quotes', () => {
    const result = escapeHtml("' or '1'='1");
    expect(result).not.toContain("'");
    expect(result).toContain('&#39;');
  });

  it('escapes ampersands', () => {
    const result = escapeHtml('foo & bar');
    expect(result).toContain('&amp;');
    expect(result).not.toContain('foo & bar');
  });

  it('handles an svg/event-handler XSS vector', () => {
    const input = '<svg onload=alert(document.cookie)>';
    const result = escapeHtml(input);
    expect(result).not.toContain('<svg');
    expect(result).not.toContain('>');
    expect(result).toContain('&lt;svg');
  });

  it('handles javascript: URI XSS attempt', () => {
    const result = escapeHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain('<a');
    expect(result).toContain('&lt;a');
  });

  it('handles an iframe injection attempt', () => {
    const result = escapeHtml('<iframe src="http://evil.com"></iframe>');
    expect(result).not.toContain('<iframe');
  });

  it('does not double-escape already escaped text', () => {
    // Plain text with no special chars should pass through unchanged
    const plain = 'Hello, Church Name Here';
    expect(escapeHtml(plain)).toBe(plain);
  });

  it('handles an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('handles null by coercing to string "null"', () => {
    // escapeHtml calls String(str) so null becomes 'null'
    expect(escapeHtml(null)).toBe('null');
  });

  it('handles a number input by coercing to string', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  it('handles a very long XSS payload (10,000 chars)', () => {
    const longXss = '<script>' + 'a'.repeat(10000) + '</script>';
    const result = escapeHtml(longXss);
    expect(result).not.toContain('<script>');
    expect(result.length).toBeGreaterThan(10000);
  });
});

// ─── SQLite — parameterised queries prevent injection ────────────────────────

describe('SQLite parameterised queries — SQL injection safety', () => {
  function makeChurchDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (
        churchId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT DEFAULT ''
      )
    `);
    db.prepare('INSERT INTO churches (churchId, name, email) VALUES (?, ?, ?)')
      .run('c-1', 'Safe Church', 'safe@church.com');
    return db;
  }

  it('stores SQL injection string verbatim as church name — does not drop table', () => {
    const db = makeChurchDb();
    const injectionName = "'; DROP TABLE churches; --";
    // A parameterised INSERT must store it safely
    db.prepare('INSERT INTO churches (churchId, name, email) VALUES (?, ?, ?)')
      .run('c-inject', injectionName, 'inject@test.com');

    // Table still exists and has 2 rows
    const rows = db.prepare('SELECT * FROM churches').all();
    expect(rows.length).toBe(2);
    const stored = db.prepare('SELECT name FROM churches WHERE churchId = ?').get('c-inject');
    expect(stored.name).toBe(injectionName);
    db.close();
  });

  it('stores union-based injection string verbatim', () => {
    const db = makeChurchDb();
    const unionPayload = "' UNION SELECT 1,2,3 --";
    db.prepare('INSERT INTO churches (churchId, name, email) VALUES (?, ?, ?)')
      .run('c-union', unionPayload, 'u@test.com');
    const row = db.prepare('SELECT name FROM churches WHERE churchId = ?').get('c-union');
    expect(row.name).toBe(unionPayload);
    db.close();
  });

  it('lookup by name with injection string finds nothing (no injection effect)', () => {
    const db = makeChurchDb();
    // Try to inject via a SELECT
    const injected = "' OR '1'='1";
    // Parameterised query treats this as a literal value
    const row = db.prepare('SELECT * FROM churches WHERE name = ?').get(injected);
    expect(row).toBeUndefined();
    db.close();
  });

  it('stores a null byte in text field without crashing', () => {
    const db = makeChurchDb();
    const nullByteStr = 'name\x00with\x00nulls';
    expect(() => {
      db.prepare('INSERT INTO churches (churchId, name, email) VALUES (?, ?, ?)')
        .run('c-null', nullByteStr, 'null@test.com');
    }).not.toThrow();
    db.close();
  });

  it('stores a 50,000-character string without error', () => {
    const db = makeChurchDb();
    const veryLong = 'A'.repeat(50000);
    expect(() => {
      db.prepare('INSERT INTO churches (churchId, name, email) VALUES (?, ?, ?)')
        .run('c-long', veryLong, 'long@test.com');
    }).not.toThrow();
    const row = db.prepare('SELECT name FROM churches WHERE churchId = ?').get('c-long');
    expect(row.name.length).toBe(50000);
    db.close();
  });

  it('stores unicode control characters in text field', () => {
    const db = makeChurchDb();
    const controlStr = 'Church\u0000\u0001\u001F Name\u007F';
    expect(() => {
      db.prepare('INSERT INTO churches (churchId, name, email) VALUES (?, ?, ?)')
        .run('c-ctrl', controlStr, 'ctrl@test.com');
    }).not.toThrow();
    db.close();
  });

  it('stores XSS payload in church name verbatim (does not sanitise at DB level)', () => {
    const db = makeChurchDb();
    const xssName = '<script>alert("xss")</script>';
    db.prepare('INSERT INTO churches (churchId, name, email) VALUES (?, ?, ?)')
      .run('c-xss', xssName, 'xss@test.com');
    const row = db.prepare('SELECT name FROM churches WHERE churchId = ?').get('c-xss');
    // DB stores as-is; caller is responsible for escaping on output
    expect(row.name).toBe(xssName);
    db.close();
  });
});

// ─── hashPassword / verifyPassword with injection-like inputs ─────────────────

describe('hashPassword / verifyPassword — injection and edge-case inputs', () => {
  it('correctly hashes and verifies a SQL injection string as password', () => {
    const pw = "'; DROP TABLE users; --";
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
    expect(verifyPassword("'; DROP TABLE users; --x", stored)).toBe(false);
  });

  it('correctly hashes and verifies an XSS string as password', () => {
    const pw = '<script>alert("xss")</script>';
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
    expect(verifyPassword('<script>alert("xss")</script>x', stored)).toBe(false);
  });

  it('handles a password containing only whitespace', () => {
    const pw = '      ';
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
    expect(verifyPassword('     ', stored)).toBe(false); // one fewer space
  });

  it('handles a password with null bytes', () => {
    const pw = 'pass\x00word';
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
    expect(verifyPassword('password', stored)).toBe(false);
  });

  it('handles a password with unicode control characters', () => {
    const pw = 'pw\u0001\u001f\u007f';
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
  });

  it('handles a 1-character password', () => {
    const stored = hashPassword('x');
    expect(verifyPassword('x', stored)).toBe(true);
    expect(verifyPassword('y', stored)).toBe(false);
  });

  it('throws a TypeError when password is a number (not a string/Buffer)', () => {
    // Node.js scryptSync requires string, ArrayBuffer, Buffer, TypedArray, or DataView.
    // Passing a raw integer throws a TypeError — callers must coerce to string first.
    expect(() => hashPassword(12345)).toThrow(TypeError);
  });
});

// ─── Input boundary conditions ────────────────────────────────────────────────

describe('Input boundary and numeric edge cases in SQLite', () => {
  function makeNumericDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count INTEGER NOT NULL,
        score REAL NOT NULL
      )
    `);
    return db;
  }

  it('stores a zero value correctly', () => {
    const db = makeNumericDb();
    db.prepare('INSERT INTO items (count, score) VALUES (?, ?)').run(0, 0.0);
    const row = db.prepare('SELECT * FROM items').get();
    expect(row.count).toBe(0);
    expect(row.score).toBe(0.0);
    db.close();
  });

  it('stores a negative integer correctly', () => {
    const db = makeNumericDb();
    db.prepare('INSERT INTO items (count, score) VALUES (?, ?)').run(-1, -0.5);
    const row = db.prepare('SELECT * FROM items').get();
    expect(row.count).toBe(-1);
    expect(row.score).toBe(-0.5);
    db.close();
  });

  it('stores a float as REAL correctly', () => {
    const db = makeNumericDb();
    db.prepare('INSERT INTO items (count, score) VALUES (?, ?)').run(1, 3.14159);
    const row = db.prepare('SELECT * FROM items').get();
    expect(row.score).toBeCloseTo(3.14159);
    db.close();
  });

  it('sqlite does not throw when a very large integer is stored', () => {
    const db = makeNumericDb();
    expect(() => {
      db.prepare('INSERT INTO items (count, score) VALUES (?, ?)').run(Number.MAX_SAFE_INTEGER, 1.0);
    }).not.toThrow();
    db.close();
  });
});

// ─── generateCsrfToken — token generation properties ─────────────────────────

describe('generateCsrfToken — entropy and uniqueness', () => {
  const { generateCsrfToken } = require('../src/csrf');

  it('produces a 64-character hex string', () => {
    const token = generateCsrfToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens on each call', () => {
    const tokens = new Set();
    for (let i = 0; i < 50; i++) {
      tokens.add(generateCsrfToken());
    }
    expect(tokens.size).toBe(50);
  });
});
