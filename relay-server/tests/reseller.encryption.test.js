import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { ResellerSystem } = require('../src/reseller');
const { isEncrypted, decryptSecret, lookupHash } = require('../src/secretCrypto');

// secretCrypto uses a dev key in NODE_ENV=test, so encryption is active here.

describe('reseller api_key encryption at rest (H4)', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    // ResellerSystem._ensureSchemaSync touches the churches table.
    db.exec('CREATE TABLE churches (churchId TEXT PRIMARY KEY, name TEXT, reseller_id TEXT, registration_code TEXT)');
  });

  it('stores api_key encrypted with a populated api_key_hash on create', () => {
    const rs = new ResellerSystem(db);
    const { resellerId, apiKey } = rs.createReseller({ name: 'Acme AV' });

    const row = db.prepare('SELECT api_key, api_key_hash FROM resellers WHERE id = ?').get(resellerId);
    expect(isEncrypted(row.api_key)).toBe(true);          // ciphertext at rest
    expect(decryptSecret(row.api_key)).toBe(apiKey);       // round-trips
    expect(row.api_key_hash).toBe(lookupHash(apiKey));     // deterministic lookup hash
    expect(apiKey.startsWith('rsl_')).toBe(true);          // caller still gets plaintext once
  });

  it('looks up a reseller by plaintext key (hash match) and returns decrypted api_key', () => {
    const rs = new ResellerSystem(db);
    const { resellerId, apiKey } = rs.createReseller({ name: 'Beta AV' });

    const found = rs.getReseller(apiKey);
    expect(found).not.toBeNull();
    expect(found.id).toBe(resellerId);
    expect(found.api_key).toBe(apiKey);   // decrypted for display, not ciphertext
    expect(rs.getReseller('rsl_wrong')).toBeNull();
  });

  it('backfills a legacy plaintext api_key on startup (encrypts + hashes, lookup still works)', () => {
    // Seed schema + a legacy plaintext row, bypassing the encrypting create path.
    const seed = new ResellerSystem(db); // ensures schema exists
    seed.createReseller({ name: 'placeholder' });
    const legacyKey = 'rsl_legacyplaintextkey';
    db.prepare("INSERT INTO resellers (id, name, api_key, created_at, active) VALUES (?, ?, ?, ?, 1)")
      .run('legacy-1', 'Legacy Co', legacyKey, new Date(0).toISOString());

    // Re-instantiate → constructor runs _backfillApiKeyEncryptionSync().
    const rs = new ResellerSystem(db);
    const row = db.prepare('SELECT api_key, api_key_hash FROM resellers WHERE id = ?').get('legacy-1');
    expect(isEncrypted(row.api_key)).toBe(true);
    expect(decryptSecret(row.api_key)).toBe(legacyKey);
    expect(row.api_key_hash).toBe(lookupHash(legacyKey));
    expect(rs.getReseller(legacyKey)?.id).toBe('legacy-1');
  });
});
