/**
 * Shared helpers for command handlers.
 */

function toInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

module.exports = { toInt };
