/**
 * Health / root endpoints.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupHealthRoutes(app, ctx) {
  const { churches, controllers, RELAY_VERSION, RELAY_BUILD, WebSocket } = ctx;

  // Basic health check
  app.get('/', (_req, res) => {
    res.json({
      service: 'tally-relay',
      version: RELAY_VERSION,
      churches: churches.size,
      controllers: controllers.size,
    });
  });

  // Detailed health/stats (+ /health alias for load-balancers / uptime monitors)
  function detailedHealth(_req, res) {
    const connectedCount = Array.from(churches.values()).filter(c => c.ws?.readyState === WebSocket.OPEN).length;
    res.json({
      service: 'tally-relay',
      version: RELAY_VERSION,
      build: RELAY_BUILD,
      uptime: Math.floor(process.uptime()),
      registeredChurches: churches.size,
      connectedChurches: connectedCount,
      controllers: controllers.size,
      totalMessagesRelayed: ctx.totalMessagesRelayed,
    });
  }
  app.get('/api/health', detailedHealth);
  app.get('/health', detailedHealth);
};
