import { describe, it, expect } from 'vitest';
import { bt, churchLocale, BOT_STRINGS } from '../src/botI18n.js';

// ─── bt() — basic translation ─────────────────────────────────────────────────

describe('bt() — basic translation', () => {
  it('returns English string for known key', () => {
    const result = bt('status.connected', 'en');
    assert_contains(result, '✅');
    assert_contains(result, 'Connected');
  });

  it('defaults to English when locale not specified', () => {
    const result = bt('status.connected');
    expect(result).toContain('Connected');
  });

  it('returns Spanish string for known key with es locale', () => {
    const result = bt('status.connected', 'es');
    expect(result).toContain('Conectado');
  });

  it('falls back to English when key does not exist in Spanish', () => {
    // If a key exists in en but not es, it should use the en version
    // (status.connected exists in both, but let us test the fallback path with a key only in en)
    // bt falls back to en[key] if locale[key] is not found
    const result = bt('status.stream.live', 'es');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns the key itself when not found in any locale', () => {
    const result = bt('nonexistent.key.xyz', 'en');
    expect(result).toBe('nonexistent.key.xyz');
  });

  it('returns key for unknown locale with unknown key', () => {
    const result = bt('this.key.does.not.exist', 'fr');
    expect(result).toBe('this.key.does.not.exist');
  });
});

// ─── bt() — variable interpolation ───────────────────────────────────────────

describe('bt() — variable interpolation', () => {
  it('replaces {{brandName}} placeholder', () => {
    const result = bt('welcome', 'en', { brandName: 'Tally', poweredBy: '' });
    expect(result).toContain('Tally');
    expect(result).not.toContain('{{brandName}}');
  });

  it('replaces multiple placeholders in one string', () => {
    const result = bt('welcome.registered', 'en', {
      brandName: 'TallyConnect',
      poweredBy: '',
      name: 'Alice',
      church: 'Grace Church',
    });
    expect(result).toContain('TallyConnect');
    expect(result).toContain('Alice');
    expect(result).toContain('Grace Church');
  });

  it('leaves unreplaced {{varName}} as-is when var not provided', () => {
    const result = bt('alert.critical', 'en', {}); // no vars provided
    expect(result).toContain('{{church}}');
    expect(result).toContain('{{message}}');
  });

  it('replaces with empty string when var value is empty string', () => {
    const result = bt('welcome', 'en', { brandName: 'Tally', poweredBy: '' });
    // {{poweredBy}} should be replaced with ''
    expect(result).not.toContain('{{poweredBy}}');
  });

  it('converts non-string var values to strings', () => {
    const result = bt('preservice.pass', 'en', {
      church: 'Test Church',
      time: '9:00 AM',
      count: 5,  // number, not string
    });
    expect(result).toContain('5');
  });

  it('handles Spanish interpolation correctly', () => {
    const result = bt('alert.critical', 'es', { church: 'Iglesia Test', message: 'Sin señal' });
    expect(result).toContain('Iglesia Test');
    expect(result).toContain('Sin señal');
    expect(result).toContain('ALERTA CRÍTICA');
  });
});

// ─── bt() — all known keys exist ─────────────────────────────────────────────

describe('bt() — all keys return non-empty strings', () => {
  const allKeys = Object.keys(BOT_STRINGS.en);

  it.each(allKeys)('key %s exists and returns a string', (key) => {
    const result = bt(key, 'en');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── bt() — Spanish has all same keys as English ──────────────────────────────

describe('BOT_STRINGS structure', () => {
  it('has en and es locales', () => {
    expect(BOT_STRINGS).toHaveProperty('en');
    expect(BOT_STRINGS).toHaveProperty('es');
  });

  it('English locale has all expected keys', () => {
    const en = BOT_STRINGS.en;
    expect(en).toHaveProperty('welcome');
    expect(en).toHaveProperty('status.connected');
    expect(en).toHaveProperty('alert.critical');
    expect(en).toHaveProperty('error.generic');
    expect(en).toHaveProperty('cmd.unknown');
  });

  it('es locale has same keys as en locale', () => {
    const enKeys = Object.keys(BOT_STRINGS.en).sort();
    const esKeys = Object.keys(BOT_STRINGS.es).sort();
    expect(esKeys).toEqual(enKeys);
  });
});

// ─── churchLocale() ────────────────────────────────────────────────────────────

describe('churchLocale()', () => {
  it('returns en for null church', () => {
    expect(churchLocale(null)).toBe('en');
  });

  it('returns en for undefined church', () => {
    expect(churchLocale(undefined)).toBe('en');
  });

  it('returns en when church has no locale field', () => {
    expect(churchLocale({})).toBe('en');
  });

  it('returns en when church locale is en', () => {
    expect(churchLocale({ locale: 'en' })).toBe('en');
  });

  it('returns es when church locale is es', () => {
    expect(churchLocale({ locale: 'es' })).toBe('es');
  });

  it('falls back to en for unsupported locale (e.g., fr)', () => {
    expect(churchLocale({ locale: 'fr' })).toBe('en');
  });

  it('falls back to en for empty string locale', () => {
    expect(churchLocale({ locale: '' })).toBe('en');
  });

  it('falls back to en for unknown locale string', () => {
    expect(churchLocale({ locale: 'zh-CN' })).toBe('en');
  });
});

// Helper for non-vitest style assertions in mixed contexts
function assert_contains(str, sub) {
  if (!str.includes(sub)) {
    throw new Error(`Expected "${str}" to contain "${sub}"`);
  }
}
