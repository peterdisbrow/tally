/**
 * room-rejoin.js — decide whether the booth should auto-rejoin its last room
 * on launch (after a crash, kill -9, power loss, or a clean quit).
 *
 * Policy (Andrew, Sep 24 2026):
 *   - Rejoin automatically after ANY exit (crash or clean quit) unless the
 *     operator deliberately left: "Change Room" (leave) or sign-out clear the
 *     record. Booth PCs get restarted by OS updates / power; the operator's
 *     intent to leave is expressed explicitly, not by closing the app.
 *   - The saved room is NEVER trusted blindly (the original 30f33d5 bug was
 *     "loads into the wrong room"): it is bound to the signed-in church and
 *     re-validated against the relay's room list, then joined through the
 *     same server-authoritative path as picking it by hand.
 *   - Room gone / access revoked → picker with a plain message, record
 *     cleared (one attempt per launch — no loop, no fake connected state).
 *   - Relay unreachable at launch → rejoin in local mode (ATEM monitoring
 *     keeps working) and confirm the room once the relay is back.
 *
 * Pure functions only (no Electron / fs) so they are unit-testable.
 */
'use strict';

function buildRejoinRecord({ roomId, roomName, churchId, now = Date.now() }) {
  if (!roomId) return null;
  return {
    roomId: String(roomId),
    roomName: String(roomName || ''),
    churchId: churchId ? String(churchId) : null,
    savedAt: new Date(now).toISOString(),
    cleanExit: false,
  };
}

function isValidRecord(record) {
  return !!(record && typeof record === 'object' && typeof record.roomId === 'string' && record.roomId);
}

function tokenExpired(token, now = Date.now()) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return false;
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return !!(payload.exp && now >= payload.exp * 1000);
  } catch { return false; }
}

/**
 * @param {object}  p
 * @param {object}  p.record          saved rejoin record (or undefined)
 * @param {string}  p.tokenChurchId   churchId decoded from the current token
 * @param {boolean} p.tokenExpired    token past its exp
 * @param {object}  p.roomsResult     result of fetchRooms(): {success, rooms, status, network}
 * @returns {{action:'none'|'rejoin'|'rejoin-local'|'picker'|'signin', reason:string, roomId?:string, roomName?:string, message?:string, clearRecord:boolean}}
 */
function decideRejoin({ record, tokenChurchId, tokenExpired: expired, roomsResult }) {
  if (!isValidRecord(record)) return { action: 'none', reason: 'no-record', clearRecord: !!record };
  const roomName = record.roomName || 'your last room';
  const base = { roomId: record.roomId, roomName: record.roomName || '' };

  if (record.churchId && tokenChurchId && record.churchId !== tokenChurchId) {
    return { ...base, action: 'picker', reason: 'account-changed', clearRecord: true };
  }
  if (expired) {
    return { ...base, action: 'signin', reason: 'token-expired', clearRecord: false,
      message: 'Session expired. Please sign in again.' };
  }
  const r = roomsResult || {};
  if (!r.success) {
    if (r.status === 401) {
      return { ...base, action: 'signin', reason: 'token-rejected', clearRecord: true,
        message: 'Your session is no longer valid. Please sign in again.' };
    }
    if (r.status === 403) {
      return { ...base, action: 'picker', reason: 'access-revoked', clearRecord: true,
        message: `Couldn't rejoin “${roomName}” — this account no longer has access. Choose or create a room to continue.` };
    }
    if (r.network || !r.status || r.status >= 500) {
      return { ...base, action: 'rejoin-local', reason: 'relay-unreachable', clearRecord: false };
    }
    return { ...base, action: 'picker', reason: `rooms-error-${r.status}`, clearRecord: true,
      message: `Couldn't confirm “${roomName}” with the server. Choose or create a room to continue.` };
  }
  const rooms = Array.isArray(r.rooms) ? r.rooms : [];
  const match = rooms.find((x) => x && String(x.id) === record.roomId);
  if (!match) {
    return { ...base, action: 'picker', reason: 'room-gone', clearRecord: true,
      message: `Your last room “${roomName}” is no longer available. Choose or create a room to continue.` };
  }
  return { roomId: record.roomId, roomName: match.name || record.roomName || '', action: 'rejoin', reason: 'ok', clearRecord: false };
}

/** Outcome of the room-assign call during rejoin. */
function decideAssignOutcome(assignResult, roomName) {
  if (assignResult && assignResult.success) return { ok: true };
  const name = roomName || 'your last room';
  const status = assignResult && assignResult.status;
  if (status === 401) return { ok: false, action: 'signin', reason: 'token-rejected', message: 'Your session is no longer valid. Please sign in again.' };
  if (status === 403) return { ok: false, action: 'picker', reason: 'access-revoked', message: `Couldn't rejoin “${name}” — this account no longer has access. Choose or create a room to continue.` };
  if (status === 404) return { ok: false, action: 'picker', reason: 'room-gone', message: `Your last room “${name}” is no longer available. Choose or create a room to continue.` };
  return { ok: false, action: 'picker', reason: 'assign-failed', message: `Couldn't rejoin “${name}”. Choose or create a room to continue.` };
}

module.exports = { buildRejoinRecord, isValidRecord, tokenExpired, decideRejoin, decideAssignOutcome };
