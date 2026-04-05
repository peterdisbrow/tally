/**
 * networkTopology.js — REST endpoints for network device topology.
 *
 * The Electron app's deep network scanner pushes discovered devices here
 * so the AI (Tally Engineer), portal, and mobile clients can reference
 * the church's network layout.
 */

module.exports = function setupNetworkTopologyRoutes(app, ctx) {
  const { db, queryClient, requireChurchAppAuth, requireChurchOrAdmin } = ctx;
  const hasQueryClient = queryClient
    && typeof queryClient.queryOne === 'function'
    && typeof queryClient.query === 'function'
    && typeof queryClient.run === 'function';

  const qAll = async (sql, params = []) => (
    hasQueryClient ? queryClient.query(sql, params) : db.prepare(sql).all(...params)
  );
  const qRun = async (sql, params = []) => (
    hasQueryClient ? queryClient.run(sql, params) : db.prepare(sql).run(...params)
  );

  // ─── PUT /api/church/app/network-topology ──────────────────────────────────
  // Called by the Electron app after each deep scan to persist results.
  app.put('/api/church/app/network-topology', requireChurchAppAuth, async (req, res) => {
    try {
      const churchId = req.church?.churchId || req.churchId;
      const { roomId, devices, scanTime } = req.body;

      if (!Array.isArray(devices)) {
        return res.status(400).json({ error: 'devices must be an array' });
      }

      const effectiveRoomId = roomId || '__default__';
      const now = new Date().toISOString();

      await qRun(`
        INSERT INTO network_topology (church_id, room_id, devices, scan_time, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(church_id, room_id) DO UPDATE SET
          devices = excluded.devices,
          scan_time = excluded.scan_time,
          updated_at = excluded.updated_at
      `, [churchId, effectiveRoomId, JSON.stringify(devices), scanTime || now, now]);

      res.json({ ok: true, deviceCount: devices.length });
    } catch (err) {
      console.error('[NetworkTopology] PUT error:', err.message);
      res.status(500).json({ error: 'Failed to save network topology' });
    }
  });

  // ─── GET /api/church/app/network-topology ──────────────────────────────────
  // Returns the most recent scan results for this church (all rooms or a specific room).
  app.get('/api/church/app/network-topology', requireChurchAppAuth, async (req, res) => {
    try {
      const churchId = req.church?.churchId || req.churchId;
      const roomId = req.query.roomId;

      const rows = roomId
        ? await qAll('SELECT * FROM network_topology WHERE church_id = ? AND room_id = ?', [churchId, roomId])
        : await qAll('SELECT * FROM network_topology WHERE church_id = ?', [churchId]);

      const results = rows.map(row => ({
        roomId: row.room_id === '__default__' ? null : row.room_id,
        devices: JSON.parse(row.devices || '[]'),
        scanTime: row.scan_time,
        updatedAt: row.updated_at,
      }));

      // Flatten all devices across rooms for a unified view
      const allDevices = results.flatMap(r => r.devices);

      res.json({
        scans: results,
        allDevices,
        totalDevices: allDevices.length,
      });
    } catch (err) {
      console.error('[NetworkTopology] GET error:', err.message);
      res.status(500).json({ error: 'Failed to fetch network topology' });
    }
  });

  // ─── GET /api/admin/network-topology/:churchId ─────────────────────────────
  // Admin/portal access to a church's network topology.
  app.get('/api/admin/network-topology/:churchId', requireChurchOrAdmin, async (req, res) => {
    try {
      const churchId = req.params.churchId;
      const rows = await qAll('SELECT * FROM network_topology WHERE church_id = ?', [churchId]);

      const results = rows.map(row => ({
        roomId: row.room_id === '__default__' ? null : row.room_id,
        devices: JSON.parse(row.devices || '[]'),
        scanTime: row.scan_time,
        updatedAt: row.updated_at,
      }));

      const allDevices = results.flatMap(r => r.devices);

      res.json({
        churchId,
        scans: results,
        allDevices,
        totalDevices: allDevices.length,
      });
    } catch (err) {
      console.error('[NetworkTopology] Admin GET error:', err.message);
      res.status(500).json({ error: 'Failed to fetch network topology' });
    }
  });
};
