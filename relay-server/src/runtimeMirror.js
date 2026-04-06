'use strict';

function clonePlain(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function listOpenInstances(church, wsOpen) {
  if (!church?.sockets?.size) return [];
  return Array.from(church.sockets.entries())
    .filter(([, ws]) => ws?.readyState === wsOpen)
    .map(([instance]) => instance);
}

function hasOpenSocket(church, wsOpen) {
  return listOpenInstances(church, wsOpen).length > 0;
}

function normalizeRuntimeChurch(church = {}) {
  return {
    churchId: church.churchId || null,
    name: church.name || null,
    connected: !!church.connected,
    status: clonePlain(church.status || {}),
    lastSeen: church.lastSeen || null,
    lastHeartbeat: church.lastHeartbeat || null,
    disconnectedAt: church.disconnectedAt || null,
    instanceStatus: clonePlain(church.instanceStatus || {}),
    roomInstanceMap: clonePlain(church.roomInstanceMap || {}),
    instances: Array.isArray(church.instances) ? [...church.instances] : [],
    activeAlerts: Number(church.activeAlerts || 0),
    encoderActive: !!church.encoderActive,
    syncStatus: church.syncStatus || null,
    church_type: church.church_type || 'recurring',
    event_expires_at: church.event_expires_at || null,
    event_label: church.event_label || null,
    reseller_id: church.reseller_id || null,
    audio_via_atem: church.audio_via_atem || 0,
    updatedAt: church.updatedAt || new Date().toISOString(),
  };
}

function createRuntimeMirror({
  churches = new Map(),
  runtimeCoordinator = null,
  wsOpen = 1,
  logger = console,
} = {}) {
  const remoteChurches = new Map();
  let unsubscribe = null;

  function aggregateRemoteChurch(churchId) {
    const sourceMap = remoteChurches.get(churchId);
    if (!(sourceMap instanceof Map) || sourceMap.size === 0) return null;

    const sources = Array.from(sourceMap.values()).filter(Boolean);
    if (sources.length === 0) return null;

    let latest = null;
    let latestConnected = null;
    let latestAt = 0;
    let latestConnectedAt = 0;

    const aggregated = normalizeRuntimeChurch({
      churchId,
      name: sources.find((source) => source?.name)?.name || churchId,
    });
    aggregated.instances = [];
    aggregated.instanceStatus = {};
    aggregated.roomInstanceMap = {};
    aggregated.connected = false;
    aggregated.activeAlerts = 0;
    aggregated.encoderActive = false;

    for (const source of sources) {
      const updatedAt = Date.parse(source.updatedAt || source.lastSeen || 0) || 0;
      if (!latest || updatedAt >= latestAt) {
        latest = source;
        latestAt = updatedAt;
      }
      if (source.connected && (!latestConnected || updatedAt >= latestConnectedAt)) {
        latestConnected = source;
        latestConnectedAt = updatedAt;
      }

      aggregated.connected = aggregated.connected || !!source.connected;
      aggregated.instances.push(...(source.instances || []));
      Object.assign(aggregated.instanceStatus, clonePlain(source.instanceStatus || {}));
      Object.assign(aggregated.roomInstanceMap, clonePlain(source.roomInstanceMap || {}));

      if (!aggregated.lastSeen || ((Date.parse(source.lastSeen || 0) || 0) >= (Date.parse(aggregated.lastSeen || 0) || 0))) {
        aggregated.lastSeen = source.lastSeen || aggregated.lastSeen;
      }
      const heartbeat = Number(source.lastHeartbeat || 0);
      if (heartbeat > Number(aggregated.lastHeartbeat || 0)) {
        aggregated.lastHeartbeat = heartbeat;
      }

      aggregated.activeAlerts = Math.max(aggregated.activeAlerts, Number(source.activeAlerts || 0));
      aggregated.encoderActive = aggregated.encoderActive || !!source.encoderActive;
      if (!aggregated.syncStatus && source.syncStatus) aggregated.syncStatus = source.syncStatus;
      if (!aggregated.reseller_id && source.reseller_id) aggregated.reseller_id = source.reseller_id;
      if (!aggregated.event_expires_at && source.event_expires_at) aggregated.event_expires_at = source.event_expires_at;
      if (!aggregated.event_label && source.event_label) aggregated.event_label = source.event_label;
      if ((aggregated.church_type === 'recurring' || !aggregated.church_type) && source.church_type) {
        aggregated.church_type = source.church_type;
      }
      if (Number(aggregated.audio_via_atem || 0) === 0 && source.audio_via_atem) {
        aggregated.audio_via_atem = source.audio_via_atem;
      }
    }

    const preferred = latestConnected || latest;
    aggregated.status = clonePlain(preferred?.status || {});
    aggregated.disconnectedAt = aggregated.connected ? null : (preferred?.disconnectedAt || null);
    aggregated.updatedAt = preferred?.updatedAt || null;
    aggregated.instances = Array.from(new Set(aggregated.instances));
    return aggregated;
  }

  function remoteWins(localChurch, remoteChurch) {
    if (!remoteChurch) return false;
    if (!localChurch) return true;
    return !hasOpenSocket(localChurch, wsOpen);
  }

  function mergeChurch(localChurch, remoteChurch) {
    if (!localChurch && !remoteChurch) return null;

    const localConnected = hasOpenSocket(localChurch, wsOpen);
    const localInstances = listOpenInstances(localChurch, wsOpen);
    const preferredRemote = remoteWins(localChurch, remoteChurch);

    const merged = {
      churchId: localChurch?.churchId || remoteChurch?.churchId || null,
      name: localChurch?.name || remoteChurch?.name || null,
      connected: preferredRemote ? !!remoteChurch?.connected : localConnected,
      status: clonePlain(
        preferredRemote
          ? (remoteChurch?.status || {})
          : (localChurch?.status || remoteChurch?.status || {})
      ),
      lastSeen: preferredRemote
        ? (remoteChurch?.lastSeen || localChurch?.lastSeen || null)
        : (localChurch?.lastSeen || remoteChurch?.lastSeen || null),
      lastHeartbeat: preferredRemote
        ? (remoteChurch?.lastHeartbeat || localChurch?.lastHeartbeat || null)
        : (localChurch?.lastHeartbeat || remoteChurch?.lastHeartbeat || null),
      disconnectedAt: preferredRemote
        ? (remoteChurch?.disconnectedAt || localChurch?.disconnectedAt || null)
        : (localChurch?.disconnectedAt || remoteChurch?.disconnectedAt || null),
      instanceStatus: clonePlain(
        preferredRemote
          ? (remoteChurch?.instanceStatus || {})
          : (localChurch?.instanceStatus || remoteChurch?.instanceStatus || {})
      ),
      roomInstanceMap: clonePlain(
        preferredRemote
          ? (remoteChurch?.roomInstanceMap || {})
          : (localChurch?.roomInstanceMap || remoteChurch?.roomInstanceMap || {})
      ),
      instances: Array.from(new Set([
        ...localInstances,
        ...(remoteChurch?.instances || []),
      ])),
      activeAlerts: preferredRemote
        ? Number(remoteChurch?.activeAlerts || 0)
        : Number(localChurch?.activeAlerts || remoteChurch?.activeAlerts || 0),
      encoderActive: preferredRemote
        ? !!remoteChurch?.encoderActive
        : !!(localChurch?.encoderActive || remoteChurch?.encoderActive),
      syncStatus: preferredRemote
        ? (remoteChurch?.syncStatus || null)
        : (localChurch?.syncStatus || remoteChurch?.syncStatus || null),
      church_type: localChurch?.church_type || remoteChurch?.church_type || 'recurring',
      event_expires_at: localChurch?.event_expires_at || remoteChurch?.event_expires_at || null,
      event_label: localChurch?.event_label || remoteChurch?.event_label || null,
      reseller_id: localChurch?.reseller_id || remoteChurch?.reseller_id || null,
      audio_via_atem: localChurch?.audio_via_atem ?? remoteChurch?.audio_via_atem ?? 0,
      updatedAt: remoteChurch?.updatedAt || localChurch?.lastSeen || null,
    };

    return merged;
  }

  function getObservedChurch(churchId) {
    return mergeChurch(churches.get(churchId), aggregateRemoteChurch(churchId));
  }

  function listObservedChurches() {
    const churchIds = new Set([
      ...churches.keys(),
      ...remoteChurches.keys(),
    ]);
    return Array.from(churchIds)
      .map((churchId) => getObservedChurch(churchId))
      .filter(Boolean);
  }

  function applyEvent(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.instanceId && event.instanceId === runtimeCoordinator?.instanceId) return null;

    const payload = event.payload || {};
    const churchData = payload.church && payload.church.churchId
      ? normalizeRuntimeChurch(payload.church)
      : null;
    const churchId = churchData?.churchId || payload.churchId || null;
    const sourceInstanceId = event.instanceId || 'unknown';
    if (!churchId) return null;

    if (churchData) {
      if (!remoteChurches.has(churchId)) remoteChurches.set(churchId, new Map());
      remoteChurches.get(churchId).set(sourceInstanceId, churchData);
    } else {
      const sourceMap = remoteChurches.get(churchId) || new Map();
      const current = normalizeRuntimeChurch(sourceMap.get(sourceInstanceId) || {
        churchId,
        name: payload.name || null,
      });
      if (payload.name) current.name = payload.name;
      if (payload.instance && !current.instances.includes(payload.instance)) {
        current.instances.push(payload.instance);
      }
      if (event.type === 'church_disconnected') {
        current.connected = false;
        current.disconnectedAt = payload.disconnectedAt || event.timestamp || new Date().toISOString();
      }
      if (event.type === 'church_connected' || event.type === 'church_status') {
        current.connected = true;
        current.lastSeen = payload.timestamp || event.timestamp || current.lastSeen;
        current.lastHeartbeat = payload.lastHeartbeat || current.lastHeartbeat;
      }
      current.updatedAt = event.timestamp || current.updatedAt || new Date().toISOString();
      if (!remoteChurches.has(churchId)) remoteChurches.set(churchId, new Map());
      remoteChurches.get(churchId).set(sourceInstanceId, current);
    }

    return {
      churchId,
      eventType: event.type,
      mirroredChurch: getObservedChurch(churchId),
      rebroadcastEvent: payload.event || null,
      rawEvent: event,
    };
  }

  async function start(handlers = null) {
    if (!runtimeCoordinator?.enabled || typeof runtimeCoordinator.subscribe !== 'function' || unsubscribe) {
      return;
    }

    const onMirroredEvent = typeof handlers === 'function'
      ? handlers
      : handlers?.onMirroredEvent || null;
    const onRawEvent = typeof handlers === 'function'
      ? null
      : handlers?.onRawEvent || null;

    unsubscribe = await runtimeCoordinator.subscribe((event) => {
      const applied = applyEvent(event);
      if (applied && typeof onMirroredEvent === 'function') {
        try {
          onMirroredEvent(applied);
        } catch (error) {
          logger.warn?.(`[runtimeMirror] event handler failed: ${error.message}`);
        }
      }
      if (typeof onRawEvent === 'function') {
        try {
          onRawEvent(event, applied);
        } catch (error) {
          logger.warn?.(`[runtimeMirror] raw event handler failed: ${error.message}`);
        }
      }
    });
  }

  async function close() {
    const off = unsubscribe;
    unsubscribe = null;
    if (typeof off === 'function') {
      await Promise.resolve(off()).catch(() => {});
    }
  }

  return {
    enabled: !!runtimeCoordinator?.enabled,
    instanceId: runtimeCoordinator?.instanceId || null,
    applyEvent,
    getObservedChurch,
    listObservedChurches,
    start,
    close,
    _remoteChurches: remoteChurches,
  };
}

module.exports = {
  createRuntimeMirror,
};
