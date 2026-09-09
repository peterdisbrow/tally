'use strict';

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'test') return 'test-jwt-secret';
  throw new Error('JWT_SECRET is required');
}

/**
 * Secret used to both sign and verify unsubscribe JWTs.
 *
 * The verifier historically used `UNSUBSCRIBE_SECRET || JWT_SECRET` while the
 * signer used `JWT_SECRET` only. If those env values ever differed, every
 * unsubscribe link 400'd (docs/EMAIL_SYSTEM_REVIEW.md P1-7).
 */
function getUnsubscribeSecret() {
  return process.env.UNSUBSCRIBE_SECRET || getJwtSecret();
}

module.exports = { getJwtSecret, getUnsubscribeSecret };
