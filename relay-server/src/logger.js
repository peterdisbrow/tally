'use strict';

function createLogger(scope = 'app') {
  const prefix = `[${String(scope || 'app')}]`;

  function write(method, args) {
    const fn = console[method] || console.log;
    fn(prefix, ...args);
  }

  return {
    info: (...args) => write('log', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

module.exports = { createLogger };
