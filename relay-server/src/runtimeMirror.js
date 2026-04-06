'use strict';

/**
 * Mirrors church state from peer relay instances via the runtime coordinator's
 * Redis pub/sub channel.  Provides a unified view (local + remote) so that
 * controllers and the portal can see every connected church regardless of
 * which instance owns the WebSocket.
 */

function createRuntimeMirror({
  churches,
  runtimeCoordinator,
  wsOpen,
  logger = console,
} = {}) {
  // churchId → mirrored church object from remote instances
  const mirrored = new Map();
  let unsubscribe = null;

  /**
   * Return a single church record merging local (owned) and mirrored (remote).
   * Local always wins if present and connected.
   */
  function getObservedChurch(churchId) {
    const local = churches.get(churchId);
    if (local) {
      // If the local record has a live socket, prefer it
      if (local.ws?.readyState === wsOpen) return local;
      if (local.sockets?.size) {
        for (const s of local.sockets.values()) {
          if (s?.readyState === wsOpen) return local;
        }
      }
    }
    return mirrored.get(churchId) || local || null;
  }

  /**
   * Return the full list of observed churches (local + mirrored), de-duped by churchId.
   */
  function listObservedChurches() {
    const seen = new Map();
    // Local churches first (they win)
    for (const [id, church] of churches) {
      seen.set(id, church);
    }
    // Fill in remote-only churches
    for (const [id, church] of mirrored) {
      if (!seen.has(id)) seen.set(id, church);
    }
    return Array.from(seen.values());
  }

  /**
   * Begin listening to runtime coordination events and updating the mirror.
   */
  async function start({ onMirroredEvent, onRawEvent } = {}) {
    if (!runtimeCoordinator?.enabled) return;

    unsubscribe = await runtimeCoordinator.subscribe((event) => {
      // Let the server handle raw coordination events (commands, etc.)
      if (typeof onRawEvent === 'function') {
        try { onRawEvent(event); } catch (err) {
          logger.warn?.(`[runtimeMirror] onRawEvent error: ${err.message}`);
        }
      }

      // Skip events from our own instance
      if (event.instanceId === runtimeCoordinator.instanceId) return;

      const payload = event.payload || {};
      const churchId = payload.churchId;
      if (!churchId) return;

      // Update mirrored state based on event type
      let mirroredChurch = mirrored.get(churchId);

      switch (event.type) {
        case 'church_connected': {
          mirroredChurch = {
            churchId,
            name: payload.name || churchId,
            connected: true,
            status: payload.status || {},
            lastSeen: payload.lastSeen || new Date().toISOString(),
            lastHeartbeat: payload.lastHeartbeat || null,
            instanceId: event.instanceId,
            instanceStatus: payload.instanceStatus || {},
            roomInstanceMap: payload.roomInstanceMap || {},
            instances: payload.instances || [],
          };
          mirrored.set(churchId, mirroredChurch);
          break;
        }
        case 'church_disconnected': {
          if (mirroredChurch) {
            mirroredChurch.connected = false;
            mirroredChurch.status = payload.status || mirroredChurch.status;
          }
          break;
        }
        case 'instance_disconnected': {
          if (mirroredChurch) {
            mirroredChurch.instanceStatus = payload.instanceStatus || mirroredChurch.instanceStatus || {};
            mirroredChurch.roomInstanceMap = payload.roomInstanceMap || mirroredChurch.roomInstanceMap || {};
          }
          break;
        }
        case 'church_status': {
          if (!mirroredChurch) {
            mirroredChurch = {
              churchId,
              name: payload.name || churchId,
              connected: true,
              status: {},
              instanceId: event.instanceId,
              instanceStatus: {},
              roomInstanceMap: {},
            };
            mirrored.set(churchId, mirroredChurch);
          }
          mirroredChurch.status = payload.status || mirroredChurch.status;
          mirroredChurch.lastSeen = payload.lastSeen || new Date().toISOString();
          mirroredChurch.instanceStatus = payload.instanceStatus || mirroredChurch.instanceStatus;
          mirroredChurch.roomInstanceMap = payload.roomInstanceMap || mirroredChurch.roomInstanceMap;
          break;
        }
        default:
          break;
      }

      // Notify server of mirrored event for rebroadcasting to controllers/portal
      if (typeof onMirroredEvent === 'function') {
        try {
          onMirroredEvent({
            churchId,
            eventType: event.type,
            mirroredChurch: mirroredChurch || null,
            rebroadcastEvent: payload,
          });
        } catch (err) {
          logger.warn?.(`[runtimeMirror] onMirroredEvent error: ${err.message}`);
        }
      }
    });
  }

  async function close() {
    if (typeof unsubscribe === 'function') {
      try { await unsubscribe(); } catch { /* ignore */ }
      unsubscribe = null;
    }
    mirrored.clear();
  }

  return {
    getObservedChurch,
    listObservedChurches,
    start,
    close,
  };
}

module.exports = { createRuntimeMirror };
