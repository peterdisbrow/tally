/**
 * roomEquipment.js — REST endpoints for server-side room equipment config.
 *
 * Stores per-room equipment as a JSON blob so any machine can pull config
 * on sign-in ("sign in and go").  The Electron app pushes here on every
 * save-equipment and fetches on room-switch / startup.
 */

// ── Valid role keys and which device types are compatible with each role ──
const ROLE_DEFINITIONS = {
  primary_switcher:  { label: 'Primary Switcher',  compatible: ['atem', 'vmix', 'obs'] },
  recording_device:  { label: 'Recording Device',  compatible: ['hyperdeck', 'atem', 'encoder', 'vmix', 'obs'] },
  streaming_device:  { label: 'Streaming Device',  compatible: ['encoder', 'obs', 'vmix', 'atem'] },
  presentation:      { label: 'Presentation',      compatible: ['proPresenter'] },
  audio_mixer:       { label: 'Audio Mixer',       compatible: ['mixer', 'atem'] },
  backup_encoder:    { label: 'Backup Encoder',    compatible: ['encoder', 'obs', 'vmix'] },
};

const VALID_ROLE_KEYS = Object.keys(ROLE_DEFINITIONS);

/** Auto-detect reasonable defaults from equipment config. */
function autoDetectRoles(equipment) {
  if (!equipment || typeof equipment !== 'object') return {};
  const roles = {};

  // Helper: check if a device type is configured
  function has(key) {
    const val = equipment[key];
    if (!val) return false;
    if (Array.isArray(val)) return val.some(e => e.ip || e.host || e.encoderType);
    if (typeof val === 'object') return !!(val.configured || val.ip || val.host || val.type);
    return false;
  }

  // Switcher: atem > vmix > obs
  if (has('atem') || has('atems')) roles.primary_switcher = 'atem';
  else if (has('vmix')) roles.primary_switcher = 'vmix';
  else if (has('obs')) roles.primary_switcher = 'obs';

  // Recording: hyperdeck > atem > encoder > vmix > obs
  if (has('hyperdeck')) roles.recording_device = 'hyperdeck';
  else if (has('atem') || has('atems')) roles.recording_device = 'atem';
  else if (has('encoder')) roles.recording_device = 'encoder';
  else if (has('vmix')) roles.recording_device = 'vmix';
  else if (has('obs')) roles.recording_device = 'obs';

  // Streaming: encoder > obs > vmix > atem
  if (has('encoder')) roles.streaming_device = 'encoder';
  else if (has('obs')) roles.streaming_device = 'obs';
  else if (has('vmix')) roles.streaming_device = 'vmix';
  else if (has('atem') || has('atems')) roles.streaming_device = 'atem';

  // Presentation
  if (has('propresenter')) roles.presentation = 'proPresenter';

  // Audio
  if (has('mixer')) roles.audio_mixer = 'mixer';
  else if (has('atem') || has('atems')) roles.audio_mixer = 'atem';

  // Backup encoder
  const encoders = equipment.encoder;
  if (Array.isArray(encoders) && encoders.filter(e => e.encoderType).length > 1) {
    roles.backup_encoder = 'encoder';
  }

  return roles;
}

function setupRoomEquipmentRoutes(app, ctx) {
  const { db, requireChurchAppAuth, requireChurchWriteAccess, safeErrorMessage, log } = ctx;

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Check that a room belongs to this church. */
  function verifyRoomAccess(roomId, churchId) {
    return db.prepare('SELECT id FROM rooms WHERE id = ? AND campus_id = ? AND deleted_at IS NULL').get(roomId, churchId);
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

  // ── GET /api/church/app/rooms/:roomId/roles ─────────────────────────────
  // Returns current role assignments. Auto-populates defaults if none saved.

  app.get('/api/church/app/rooms/:roomId/roles', requireChurchAppAuth, (req, res) => {
    try {
      const { roomId } = req.params;
      const churchId = req.church.churchId;

      if (!verifyRoomAccess(roomId, churchId)) {
        return res.status(404).json({ error: 'Room not found or not accessible' });
      }

      const row = db.prepare('SELECT equipment, updated_at FROM room_equipment WHERE room_id = ?').get(roomId);
      let equipment = {};
      try { equipment = JSON.parse(row?.equipment || '{}'); } catch { }

      const savedRoles = equipment._roles || null;
      const autoRoles = autoDetectRoles(equipment);
      const roles = savedRoles || autoRoles;

      res.json({
        roles,
        autoDetected: !savedRoles,
        defaults: autoRoles,
        roleDefinitions: ROLE_DEFINITIONS,
      });
    } catch (e) {
      log(`[roomEquipment] GET roles error: ${e.message}`);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── PUT /api/church/app/rooms/:roomId/roles ─────────────────────────────
  // Save role assignments into the equipment JSON under _roles key.

  app.put('/api/church/app/rooms/:roomId/roles', requireChurchAppAuth, requireChurchWriteAccess, (req, res) => {
    try {
      const { roomId } = req.params;
      const churchId = req.church.churchId;

      if (!verifyRoomAccess(roomId, churchId)) {
        return res.status(404).json({ error: 'Room not found or not accessible' });
      }

      const roles = req.body?.roles;
      if (!roles || typeof roles !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid roles object' });
      }

      // Validate role keys
      for (const key of Object.keys(roles)) {
        if (!VALID_ROLE_KEYS.includes(key)) {
          return res.status(400).json({ error: `Invalid role key: ${key}` });
        }
      }

      // Read existing equipment, merge _roles in
      const row = db.prepare('SELECT equipment FROM room_equipment WHERE room_id = ?').get(roomId);
      let equipment = {};
      try { equipment = JSON.parse(row?.equipment || '{}'); } catch { }

      equipment._roles = roles;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO room_equipment (room_id, church_id, equipment, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          equipment = excluded.equipment,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(roomId, churchId, JSON.stringify(equipment), now, churchId);

      res.json({ ok: true, roles, updatedAt: now });
    } catch (e) {
      log(`[roomEquipment] PUT roles error: ${e.message}`);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });
};

module.exports = setupRoomEquipmentRoutes;
module.exports.ROLE_DEFINITIONS = ROLE_DEFINITIONS;
module.exports.autoDetectRoles = autoDetectRoles;
module.exports.VALID_ROLE_KEYS = VALID_ROLE_KEYS;
