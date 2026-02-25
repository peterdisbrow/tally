'use strict';

const { WebSocket } = require('ws');

/**
 * Health-check route handlers.
 *
 * @param {import('express').Express} app
 * @param {Object} ctx
 * @param {Map} ctx.churches
 * @param {Set} ctx.controllers
 * @param {string} ctx.RELAY_VERSION
 * @param {string|null} ctx.RELAY_BUILD
 * @param {Function} ctx.getTotalMessagesRelayed - getter for the mutable counter
 */
module.exports = function setupHealthRoutes(app, ctx) {
  const { churches, controllers, RELAY_VERSION, RELAY_BUILD, getTotalMessagesRelayed } = ctx;

  // Health check
  app.get('/', (req, res) => {
    res.json({
      service: 'tally-relay',
      version: RELAY_VERSION,
      churches: churches.size,
      controllers: controllers.size,
    });
  });

  // Detailed health/stats
  app.get('/api/health', (req, res) => {
    const connectedCount = Array.from(churches.values()).filter(c => c.ws?.readyState === WebSocket.OPEN).length;
    res.json({
      service: 'tally-relay',
      version: RELAY_VERSION,
      build: RELAY_BUILD,
      uptime: Math.floor(process.uptime()),
      registeredChurches: churches.size,
      connectedChurches: connectedCount,
      controllers: controllers.size,
      totalMessagesRelayed: getTotalMessagesRelayed(),
    });
  });
};
