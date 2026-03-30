/**
 * Command Handlers — merged from domain files.
 *
 * Each domain file exports { 'domain.command': handlerFn, ... }
 * This index merges them into a single commandHandlers map.
 */

// Mixer exports mixerBrandName as a named helper (used by system.js);
// destructure it out so only command entries get spread.
const { mixerBrandName: _mb, ...mixerCommands } = require('./mixer');

const commandHandlers = {
  ...require('./atem'),
  ...mixerCommands,
  ...require('./vmix'),
  ...require('./obs'),
  ...require('./propresenter'),
  ...require('./resolume'),
  ...require('./ptz'),
  ...require('./camera'),
  ...require('./hyperdeck'),
  ...require('./encoder'),
  ...require('./videohub'),
  ...require('./system'),
  ...require('./recovery'),
  ...require('./failover'),
  ...require('./shelly'),
};

module.exports = { commandHandlers };
