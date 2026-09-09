/**
 * jwtSecret — unsubscribe signer/verifier must share one secret (P1-7).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadJwtSecret() {
  const modPath = require.resolve('../src/jwtSecret');
  delete require.cache[modPath];
  return require('../src/jwtSecret');
}

describe('getUnsubscribeSecret', () => {
  const prevUnsub = process.env.UNSUBSCRIBE_SECRET;
  const prevJwt = process.env.JWT_SECRET;

  afterEach(() => {
    if (prevUnsub === undefined) delete process.env.UNSUBSCRIBE_SECRET;
    else process.env.UNSUBSCRIBE_SECRET = prevUnsub;
    if (prevJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwt;
  });

  it('falls back to JWT_SECRET when UNSUBSCRIBE_SECRET is unset', () => {
    delete process.env.UNSUBSCRIBE_SECRET;
    process.env.JWT_SECRET = 'jwt-only';
    const { getUnsubscribeSecret, getJwtSecret } = loadJwtSecret();
    expect(getUnsubscribeSecret()).toBe(getJwtSecret());
    expect(getUnsubscribeSecret()).toBe('jwt-only');
  });

  it('uses UNSUBSCRIBE_SECRET when set, even if JWT_SECRET differs', () => {
    process.env.JWT_SECRET = 'jwt-only';
    process.env.UNSUBSCRIBE_SECRET = 'unsub-only';
    const { getUnsubscribeSecret, getJwtSecret } = loadJwtSecret();
    expect(getJwtSecret()).toBe('jwt-only');
    expect(getUnsubscribeSecret()).toBe('unsub-only');
  });
});
