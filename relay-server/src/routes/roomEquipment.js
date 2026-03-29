/**
 * roomEquipment.js — REST endpoints for server-side room equipment config.
 *
 * Stores per-room equipment as a JSON blob so any machine can pull config
 * on sign-in ("sign in and go").  The Electron app pushes here on every
 * save-equipment and fetches on room-switch / startup.
 */

module.exports = function setupRoomEquipmentRoutes(app, ctx) {
  const { db, requireChurchAppAuth, requireChurchWriteAccess, safeErrorMessage, log } = ctx;

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Check that a room belongs to this church. (rooms.campus_id stores the owning churchId) */
  function verifyRoomAccess(roomId, churchId) {
    return db.prepare('SELECT id FROM rooms WHERE id = ? AND campus_id = ?').get(roomId, churchId);
  }

  // ── GET /api/church/app/rooms/:roomId/equipment ──────────────────────────

  app.get('/api/church/app/rooms/:roomId/equipment', requireChurchAppAuth, (req, res) => {
    try {
      const { roomId } = req.params;
      const churchId = req.church.churchId;

      if (!verifyRoomAccess(roomId, churchId)) {
        return res.status(404).json({ error: 'Room not found or not accessible' });
      }

      const row = db.prepare('SELECT equipment, updated_at FROM room_equipment WHERE room_id = ?').get(roomId);
      if (!row) {
        return res.json({ equipment: {}, updatedAt: null });
      }

      let equipment = {};
      try { equipment = JSON.parse(row.equipment); } catch { /* corrupt — return empty */ }
      res.json({ equipment, updatedAt: row.updated_at });
    } catch (e) {
      log(`[roomEquipment] GET error: ${e.message}`);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── PUT /api/church/app/rooms/:roomId/equipment ──────────────────────────

  app.put('/api/church/app/rooms/:roomId/equipment', requireChurchAppAuth, requireChurchWriteAccess, (req, res) => {
    try {
      const { roomId } = req.params;
      const churchId = req.church.churchId;

      if (!verifyRoomAccess(roomId, churchId)) {
        return res.status(404).json({ error: 'Room not found or not accessible' });
      }

      const equipment = req.body?.equipment;
      if (!equipment || typeof equipment !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid equipment object' });
      }

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO room_equipment (room_id, church_id, equipment, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          equipment = excluded.equipment,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(roomId, churchId, JSON.stringify(equipment), now, churchId);

      res.json({ ok: true, updatedAt: now });
    } catch (e) {
      log(`[roomEquipment] PUT error: ${e.message}`);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });
};
