'use strict';

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'test') return 'test-jwt-secret';
  throw new Error('JWT_SECRET is required');
}

module.exports = { getJwtSecret };
