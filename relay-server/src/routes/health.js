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

  // ─── STATUS PAGE ENDPOINT ──────────────────────────────────────────────────
  // Designed for uptime monitors (BetterUptime, UptimeRobot, statuspage.io).
  // Returns a machine-readable status summary with component breakdown.
  //
  // Status values: 'operational' | 'degraded' | 'partial_outage' | 'major_outage'
  // HTTP 200 for operational/degraded, 503 for outage states.
  app.get('/api/status', (_req, res) => {
    const uptimeSeconds = Math.floor(process.uptime());
    const connectedCount = Array.from(churches.values())
      .filter(c => c.ws?.readyState === WebSocket.OPEN).length;
    const registeredCount = churches.size;
    const connectRatio = registeredCount > 0 ? connectedCount / registeredCount : 1;

    // Component statuses
    const websocketOk = connectedCount > 0 || registeredCount === 0;
    const relayOk = uptimeSeconds > 30; // just restarted = degraded

    // Overall status derived from components
    let status;
    if (!relayOk) {
      status = 'degraded'; // relay just restarted
    } else if (registeredCount > 0 && connectRatio === 0) {
      status = 'major_outage'; // nothing connected at all
    } else if (registeredCount > 0 && connectRatio < 0.5) {
      status = 'partial_outage'; // more than half offline
    } else if (registeredCount > 0 && connectRatio < 1) {
      status = 'degraded'; // some churches offline
    } else {
      status = 'operational';
    }

    const isOutage = status === 'major_outage' || status === 'partial_outage';

    const body = {
      status,
      timestamp: new Date().toISOString(),
      components: {
        relay: {
          status: relayOk ? 'operational' : 'degraded',
          uptime_seconds: uptimeSeconds,
          version: RELAY_VERSION,
          build: RELAY_BUILD,
        },
        websocket: {
          status: websocketOk ? 'operational' : 'degraded',
          registered_churches: registeredCount,
          connected_churches: connectedCount,
          connect_ratio: registeredCount > 0 ? Math.round(connectRatio * 100) / 100 : null,
        },
        message_relay: {
          status: 'operational',
          total_messages: ctx.totalMessagesRelayed,
        },
      },
    };

    res.status(isOutage ? 503 : 200).json(body);
  });
};
