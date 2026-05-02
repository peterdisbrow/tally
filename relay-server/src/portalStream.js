'use strict';

/**
 * Portal SSE snapshot helpers.
 *
 * Portal clients receive `status_update` messages as deltas after their first
 * subscribe. If a delta is missed (transient network issue, agent reconnect
 * mid-stream, late subscribe between an instance disconnect and the next
 * instance reconnect), the client will hold a stale or partial view of the
 * church state — bridges may appear blank even though the agent has been
 * connected for a while.
 *
 * The helpers here address that:
 *   - buildPortalSnapshot: produces a `status_snapshot` frame from the
 *     currently-merged church state.
 *   - sendPortalSnapshotToClient: writes one snapshot to one SSE response,
 *     always pulling fresh state via the injected `getObservedChurch`.
 *   - broadcastPortalSnapshot / broadcastAllPortalSnapshots: fan a fresh
 *     snapshot out to every connected portal SSE client.
 *   - startPortalSnapshotHeartbeat: a periodic re-snapshot tick so clients
 *     self-heal even if no further status_update arrives.
 *
 * `getObservedChurch(churchId)` is expected to return the post-delta-merged
 * view of the church (e.g. the runtime mirror's getObservedChurch).
 */

function buildPortalSnapshot(church) {
  return {
    type: 'status_snapshot',
    connected: !!church?.connected,
    status: church?.status || {},
    instanceStatus: church?.instanceStatus || {},
    roomInstanceMap: church?.roomInstanceMap || {},
    lastSeen: church?.lastSeen || null,
  };
}

function writeSseFrame(res, frame) {
  try {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function sendPortalSnapshotToClient(res, churchId, getObservedChurch) {
  if (typeof getObservedChurch !== 'function') return false;
  const church = getObservedChurch(churchId);
  return writeSseFrame(res, buildPortalSnapshot(church));
}

function broadcastPortalSnapshot(churchId, { portalSseClients, getObservedChurch }) {
  if (typeof getObservedChurch !== 'function') return 0;
  const clients = portalSseClients?.get?.(churchId);
  if (!clients || clients.size === 0) return 0;
  const frame = buildPortalSnapshot(getObservedChurch(churchId));
  const payload = `data: ${JSON.stringify(frame)}\n\n`;
  let sent = 0;
  for (const res of clients) {
    try {
      res.write(payload);
      sent += 1;
    } catch {
      // Dead client — the SSE handler's req.on('close') is responsible for
      // pruning it from the set; skip silently here.
    }
  }
  return sent;
}

function broadcastAllPortalSnapshots({ portalSseClients, getObservedChurch }) {
  if (!portalSseClients || portalSseClients.size === 0) return 0;
  let total = 0;
  for (const churchId of portalSseClients.keys()) {
    total += broadcastPortalSnapshot(churchId, { portalSseClients, getObservedChurch });
  }
  return total;
}

function startPortalSnapshotHeartbeat({ portalSseClients, getObservedChurch, intervalMs = 30_000 }) {
  return setInterval(() => {
    broadcastAllPortalSnapshots({ portalSseClients, getObservedChurch });
  }, intervalMs);
}

module.exports = {
  buildPortalSnapshot,
  sendPortalSnapshotToClient,
  broadcastPortalSnapshot,
  broadcastAllPortalSnapshots,
  startPortalSnapshotHeartbeat,
};
