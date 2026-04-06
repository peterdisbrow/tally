/**
 * Time API – provides server time for NTP-like sync
 * GET /api/time → { serverTime, isoTime }
 */
module.exports = function timeRoutes(app) {
  app.get('/api/time', (_req, res) => {
    const now = Date.now();
    res.json({ serverTime: now, isoTime: new Date(now).toISOString() });
  });
};
