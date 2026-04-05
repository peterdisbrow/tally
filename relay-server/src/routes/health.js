/**
 * Health / root endpoints.
 *
 * Endpoints:
 *   GET /                  Basic liveness (service name, counts)
 *   GET /health            Detailed health — DB connectivity, memory, per-church lastSeen
 *   GET /api/health        Same as /health (alias for load-balancers)
 *   GET /health/deep       Thorough check — includes a DB write round-trip test
 *   GET /api/status        Machine-readable status for uptime monitors (BetterUptime, etc.)
 *
 * All endpoints are unauthenticated so external monitoring services can poll them.
 * Rate-limited to 60 req/min per IP to prevent scraping / accidental DoS.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
const { createRateLimit } = require('../rateLimit');

// 60 requests per minute per IP — generous enough for any real monitor, restrictive enough
// to block accidental hammering or automated scrapers.
const healthRateLimit = createRateLimit({
  scope: 'health',
  maxAttempts: 60,
  windowMs: 60 * 1000,
});

module.exports = function setupHealthRoutes(app, ctx) {
  const { churches, controllers, RELAY_VERSION, RELAY_BUILD, WebSocket } = ctx;
  // db is optional — when omitted (tests, early boot) DB checks report 'skipped'
  const db = ctx.db || null;
  const queryClient = ctx.queryClient || null;
  const runtimeMetrics = ctx.runtimeMetrics || null;
  const runtimeCoordinator = ctx.runtimeCoordinator || null;
  const messageQueues = ctx.messageQueues || null;
  const getPreviewCacheSummary = typeof ctx.getPreviewCacheSummary === 'function'
    ? ctx.getPreviewCacheSummary
    : () => ({ cachedChurches: 0, newestAgeMs: 0, oldestAgeMs: 0 });
  const listObservedChurches = typeof ctx.listObservedChurches === 'function'
    ? ctx.listObservedChurches
    : () => Array.from(churches.values());

  // ─── Shared helpers ─────────────────────────────────────────────────────────

  function controllerSockets() {
    if (!controllers) return [];
    if (typeof controllers.values === 'function') return Array.from(controllers.values());
    return Array.from(controllers);
  }

  function isConnected(church) {
    if (!church) return false;
    if (typeof church.connected === 'boolean') return church.connected;
    return !!(church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN));
  }

  function countConnected() {
    return listObservedChurches().filter(isConnected).length;
  }

  function countOpenChurchInstances() {
    return listObservedChurches().reduce((total, church) => {
      if (Array.isArray(church.instances)) return total + church.instances.length;
      if (church.sockets?.size) {
        let count = 0;
        for (const socket of church.sockets.values()) {
          if (socket?.readyState === WebSocket.OPEN) count++;
        }
        return total + count;
      }
      return total + (church.ws?.readyState === WebSocket.OPEN ? 1 : 0);
    }, 0);
  }

  function countPreviewSubscriptions() {
    let count = 0;
    for (const ws of controllerSockets()) {
      if (ws?._previewSubscriptions instanceof Set) count += ws._previewSubscriptions.size;
    }
    return count;
  }

  function queueSummary() {
    if (!messageQueues?.values) return { queuedChurches: 0, queuedMessages: 0 };
    let queuedMessages = 0;
    let queuedChurches = 0;
    for (const queue of messageQueues.values()) {
      if (!Array.isArray(queue) || queue.length === 0) continue;
      queuedChurches++;
      queuedMessages += queue.length;
    }
    return { queuedChurches, queuedMessages };
  }

  function realtimeSummary() {
    const windowSeconds = 60;
    const metricsSnapshot = runtimeMetrics?.snapshot?.(windowSeconds) || {
      windowSeconds,
      counters: {},
      ratesPerSecond: {},
      totals: {},
    };
    const eventLoop = runtimeMetrics?.eventLoopSnapshot?.() || null;
    return {
      eventLoop,
      sockets: {
        connectedChurches: countConnected(),
        connectedChurchInstances: countOpenChurchInstances(),
        controllerConnections: controllers.size || 0,
        previewSubscriptions: countPreviewSubscriptions(),
      },
      queues: queueSummary(),
      previewCache: getPreviewCacheSummary(),
      rates1m: metricsSnapshot.ratesPerSecond,
      counters1m: metricsSnapshot.counters,
      totals: metricsSnapshot.totals,
      coordination: {
        enabled: !!runtimeCoordinator?.enabled,
        instanceId: runtimeCoordinator?.instanceId || null,
        channel: runtimeCoordinator?.publishChannel || null,
      },
    };
  }

  /** Memory usage in human-readable MB, rounded to one decimal place. */
  function memUsage() {
    const m = process.memoryUsage();
    const mb = (b) => Math.round(b / 1024 / 1024 * 10) / 10;
    return {
      rss_mb:        mb(m.rss),
      heap_used_mb:  mb(m.heapUsed),
      heap_total_mb: mb(m.heapTotal),
    };
  }

  /** Quick SELECT 1 to confirm the database is readable. */
  function dbReadCheck() {
    if (queryClient) {
      const t0 = Date.now();
      return queryClient.queryOne('SELECT 1 AS ok')
        .then(() => ({ status: 'ok', latency_ms: Date.now() - t0 }))
        .catch((e) => ({ status: 'error', error: e.message }));
    }
    if (!db) return { status: 'skipped' };
    const t0 = Date.now();
    try {
      db.prepare('SELECT 1').get();
      return { status: 'ok', latency_ms: Date.now() - t0 };
    } catch (e) {
      return { status: 'error', error: e.message };
    }
  }

  /**
   * Per-church connection summary for Sunday morning monitoring.
   * Only includes name + operational fields — no tokens or internal IDs.
   */
  function churchSummary() {
    return listObservedChurches().map(c => ({
      name:           c.name,
      connected:      isConnected(c),
      lastSeen:       c.lastSeen       || null,
      disconnectedAt: c.disconnectedAt || null,
    }));
  }

  /**
   * Derive an overall health status word from connectivity and DB state.
   * healthy   — everything looks good
   * degraded  — some churches offline or DB slow, but not completely down
   * unhealthy — DB error or all registered churches are disconnected
   */
  function overallStatus(connectedCount, dbStatus) {
    if (dbStatus.status === 'error') return 'unhealthy';
    const registered = listObservedChurches().length;
    if (registered === 0) return 'healthy';
    const ratio = connectedCount / registered;
    if (ratio === 0) return 'unhealthy';
    if (ratio < 1)   return 'degraded';
    return 'healthy';
  }

  // ─── GET / — basic liveness ─────────────────────────────────────────────────

  app.get('/', healthRateLimit, (_req, res) => {
    res.json({
      service:     'tally-relay',
      version:     RELAY_VERSION,
      churches:    listObservedChurches().length,
      controllers: controllers.size,
    });
  });

  // ─── GET /health and /api/health — detailed operational health ───────────────
  //
  // Returns everything the admin team needs to know on Sunday morning without logging
  // in to the dashboard:
  //   • server uptime & memory
  //   • database connectivity + read latency
  //   • connected vs. registered church counts
  //   • per-church name, lastSeen timestamp, and connection status
  //   • overall health summary word (healthy / degraded / unhealthy)

  function detailedHealth(_req, res) {
    const connectedCount = countConnected();
    const send = (dbStatus) => res.json({
      service:             'tally-relay',
      version:             RELAY_VERSION,
      build:               RELAY_BUILD,
      uptime:              Math.floor(process.uptime()),
      status:              overallStatus(connectedCount, dbStatus),
      registeredChurches:  listObservedChurches().length,
      connectedChurches:   connectedCount,
      controllers:         controllers.size,
      totalMessagesRelayed: ctx.totalMessagesRelayed,
      memoryUsage:         memUsage(),
      database:            dbStatus,
      realtime:            realtimeSummary(),
      churches:            churchSummary(),
    });
    const maybeDbStatus = dbReadCheck();
    if (maybeDbStatus && typeof maybeDbStatus.then === 'function') {
      return maybeDbStatus.then(send);
    }
    return send(maybeDbStatus);
  }

  app.get('/api/health', healthRateLimit, detailedHealth);
  app.get('/health',     healthRateLimit, detailedHealth);

  // ─── GET /health/deep — thorough check (includes DB write test) ──────────────
  //
  // Does everything /health does PLUS a write round-trip so you know SQLite
  // isn't in read-only mode. Use for scheduled monitoring (e.g. every 5 min);
  // not as a liveness probe since it writes to the DB.

  app.get('/health/deep', healthRateLimit, (_req, res) => {
    const connectedCount = countConnected();
    const send = (dbRead, dbWrite) => {
      const healthy = dbRead.status !== 'error' && dbWrite.status !== 'error';
      // Use read status for overall health word (write 'skipped' shouldn't degrade)
      const dbStatusForOverall = dbWrite.status === 'error' ? dbWrite : dbRead;

      res.status(healthy ? 200 : 503).json({
        service:             'tally-relay',
        version:             RELAY_VERSION,
        build:               RELAY_BUILD,
        uptime:              Math.floor(process.uptime()),
        status:              overallStatus(connectedCount, dbStatusForOverall),
        registeredChurches:  listObservedChurches().length,
        connectedChurches:   connectedCount,
        controllers:         controllers.size,
        totalMessagesRelayed: ctx.totalMessagesRelayed,
        memoryUsage:         memUsage(),
        database: {
          read:  dbRead,
          write: dbWrite,
        },
        realtime: realtimeSummary(),
        churches: churchSummary(),
      });
    };

    const runWriteCheck = async () => {
      if (queryClient) {
        try {
          await queryClient.exec(
            'CREATE TABLE IF NOT EXISTS _health_probe (id TEXT PRIMARY KEY, ts TEXT NOT NULL)'
          );
          const t0 = Date.now();
          const probeId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          await queryClient.run('INSERT INTO _health_probe(id, ts) VALUES (?, ?)', [probeId, new Date().toISOString()]);
          await queryClient.run('DELETE FROM _health_probe WHERE id = ?', [probeId]);
          return { status: 'ok', latency_ms: Date.now() - t0 };
        } catch (e) {
          return { status: 'error', error: e.message };
        }
      }
      if (!db) return { status: 'skipped' };
      try {
        db.exec(
          `CREATE TABLE IF NOT EXISTS _health_probe (id INTEGER PRIMARY KEY, ts TEXT NOT NULL)`
        );
        const t0     = Date.now();
        const ins    = db.prepare(`INSERT INTO _health_probe(ts) VALUES (?)`);
        const del    = db.prepare(`DELETE FROM _health_probe WHERE id = ?`);
        const result = ins.run(new Date().toISOString());
        del.run(result.lastInsertRowid);
        return { status: 'ok', latency_ms: Date.now() - t0 };
      } catch (e) {
        return { status: 'error', error: e.message };
      }
    };

    const maybeDbRead = dbReadCheck();
    if (maybeDbRead && typeof maybeDbRead.then === 'function') {
      return maybeDbRead
        .then(async (dbRead) => send(dbRead, await runWriteCheck()))
        .catch((error) => send({ status: 'error', error: error.message }, { status: 'skipped' }));
    }

    return runWriteCheck().then((dbWrite) => send(maybeDbRead, dbWrite));
  });

  // ─── GET /api/status — machine-readable status for uptime monitors ───────────
  //
  // Status values: 'operational' | 'degraded' | 'partial_outage' | 'major_outage'
  // HTTP 200 for operational/degraded, 503 for outage states.

  app.get('/api/status', healthRateLimit, (_req, res) => {
    const uptimeSeconds  = Math.floor(process.uptime());
    const connectedCount = Array.from(churches.values())
      .filter(c => !!(c.sockets?.size && [...c.sockets.values()].some(s => s.readyState === WebSocket.OPEN))).length;
    const registeredCount = churches.size;
    const connectRatio    = registeredCount > 0 ? connectedCount / registeredCount : 1;

    // Component statuses
    const websocketOk = connectedCount > 0 || registeredCount === 0;
    const relayOk     = uptimeSeconds > 30; // just restarted = degraded

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
          status:         relayOk ? 'operational' : 'degraded',
          uptime_seconds: uptimeSeconds,
          version:        RELAY_VERSION,
          build:          RELAY_BUILD,
        },
        websocket: {
          status:              websocketOk ? 'operational' : 'degraded',
          registered_churches: registeredCount,
          connected_churches:  connectedCount,
          connect_ratio:       registeredCount > 0 ? Math.round(connectRatio * 100) / 100 : null,
        },
        message_relay: {
          status:         'operational',
          total_messages: ctx.totalMessagesRelayed,
        },
      },
    };

    res.status(isOutage ? 503 : 200).json(body);
  });
};
