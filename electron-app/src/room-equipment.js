'use strict';
/**
 * Room equipment decision after a room switch (pure).
 *
 * fetchResult: { ok: true, equipment: object|null } for a real relay answer,
 *              { ok: false, error } for anything else (network, timeout, 5xx,
 *              401/403, malformed body). A failed fetch is NEVER authoritative:
 *              it must not wipe the room's on-disk equipment.
 * localLoaded: switchRoomConfig found a saved per-room setup on this computer.
 *
 * Returns { action: 'apply-remote' | 'keep-local' | 'clear', source, fetchFailed }.
 *  - apply-remote: relay answered with equipment -> server-authoritative.
 *  - keep-local:   relay failed or has nothing, but this computer has this room's setup.
 *  - clear:        no setup anywhere for this room; clear active fields so the
 *                  previous room's devices don't leak in (previous room is already
 *                  saved under roomConfigs by switchRoomConfig).
 */
function isEquipmentObject(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e);
}

function decideRoomEquipment({ fetchResult, localLoaded }) {
  const fr = fetchResult || { ok: false, error: 'no result' };
  const fetchFailed = !fr.ok || (fr.equipment != null && !isEquipmentObject(fr.equipment));
  if (!fetchFailed && isEquipmentObject(fr.equipment) && Object.keys(fr.equipment).length > 0) {
    return { action: 'apply-remote', source: 'relay', fetchFailed: false };
  }
  if (localLoaded) return { action: 'keep-local', source: 'local', fetchFailed };
  return { action: 'clear', source: 'none', fetchFailed };
}

const FETCH_FAILED_WARNING = "Couldn't load this room's equipment from the relay. Using the setup saved on this computer.";
const FETCH_FAILED_NONE_WARNING = "Couldn't load this room's equipment from the relay, and this computer has no saved setup for it. Check Equipment once the relay is reachable.";

module.exports = { decideRoomEquipment, isEquipmentObject, FETCH_FAILED_WARNING, FETCH_FAILED_NONE_WARNING };
