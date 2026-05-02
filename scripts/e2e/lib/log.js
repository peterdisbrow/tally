/**
 * Tiny logger that respects E2E_LOG_LEVEL. Used by every harness module so
 * we can quiet the harness for CI ('silent') or verbose-trace it for
 * debugging ('debug') without grep-bombing console.log.
 */

'use strict';

const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };

function makeLogger(level = 'info', prefix = '') {
  const lvl = LEVELS[level] ?? LEVELS.info;
  const tag = prefix ? `[${prefix}] ` : '';
  function emit(at, ...args) {
    if (lvl >= LEVELS[at]) {
      const stream = at === 'error' ? process.stderr : process.stdout;
      stream.write(`${tag}${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
    }
  }
  return {
    error: (...a) => emit('error', ...a),
    info:  (...a) => emit('info', ...a),
    debug: (...a) => emit('debug', ...a),
    child: (childPrefix) => makeLogger(level, prefix ? `${prefix}/${childPrefix}` : childPrefix),
  };
}

module.exports = { makeLogger };
