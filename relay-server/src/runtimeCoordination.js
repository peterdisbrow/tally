'use strict';

const os = require('os');

const { hasRedisSocketConfig, createRedisSocketClient } = require('./sharedRedis');

const DEFAULT_PRESENCE_TTL_MS = 45_000;
const DEFAULT_KEY_PREFIX = 'tally:runtime';

function createNoopCoordinator(instanceId) {
  const noop = async () => {};
  return {
    enabled: false,
    instanceId,
    publishChannel: null,
    logStatus() {},
    recordChurchPresence: noop,
    clearChurchPresence: noop,
    recordControllerPresence: noop,
    clearControllerPresence: noop,
    publishEvent: noop,
    subscribe: async () => noop,
    close: noop,
  };
}

function createRuntimeCoordinator({
  env = process.env,
  logger = console,
  RedisCtor = null,
} = {}) {
  const instanceId = String(
    env.TALLY_INSTANCE_ID ||
    env.RAILWAY_REPLICA_ID ||
    env.HOSTNAME ||
    `${os.hostname()}-${process.pid}`
  );

  if (!hasRedisSocketConfig(env)) {
    return createNoopCoordinator(instanceId);
  }

  const keyPrefix = String(env.RUNTIME_COORDINATION_PREFIX || DEFAULT_KEY_PREFIX).trim() || DEFAULT_KEY_PREFIX;
  const publishChannel = String(env.RUNTIME_COORDINATION_CHANNEL || `${keyPrefix}:events`).trim();
  const presenceTtlMs = Math.max(15_000, Number(env.RUNTIME_PRESENCE_TTL_MS || DEFAULT_PRESENCE_TTL_MS));
  const pub = createRedisSocketClient({
    env,
    RedisCtor,
    connectionName: `tally-runtime-pub:${instanceId}`,
  });
  let sub = null;
  let connected = false;

  async function ensurePubReady() {
    if (connected) return;
    await pub.connect();
    connected = true;
  }

  function buildPresenceKey(kind, entityId, suffix = '') {
    const parts = [keyPrefix, 'presence', kind, entityId, instanceId];
    if (suffix) parts.push(suffix);
    return parts.join(':');
  }

  async function setPresence(key, payload, ttlMs = presenceTtlMs) {
    await ensurePubReady();
    await pub.set(key, JSON.stringify(payload), 'PX', ttlMs);
  }

  async function deleteKey(key) {
    await ensurePubReady();
    await pub.del(key);
  }

  async function recordChurchPresence(church, opts = {}) {
    if (!church?.churchId) return;
    const instance = opts.instance || 'primary';
    const payload = {
      type: 'church',
      churchId: church.churchId,
      name: church.name || null,
      instance,
      instanceId,
      connected: opts.connected !== false,
      lastSeen: church.lastSeen || null,
      lastHeartbeat: church.lastHeartbeat || null,
      statusMode: opts.statusMode || null,
      updatedAt: new Date().toISOString(),
    };
    await setPresence(buildPresenceKey('church', church.churchId, instance), payload, opts.ttlMs);
  }

  async function clearChurchPresence(churchId, instance = 'primary') {
    if (!churchId) return;
    await deleteKey(buildPresenceKey('church', churchId, instance));
  }

  async function recordControllerPresence(controllerId, payload = {}) {
    if (!controllerId) return;
    await setPresence(buildPresenceKey('controller', controllerId), {
      type: 'controller',
      controllerId,
      instanceId,
      ip: payload.ip || null,
      connectedAt: payload.connectedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, payload.ttlMs);
  }

  async function clearControllerPresence(controllerId) {
    if (!controllerId) return;
    await deleteKey(buildPresenceKey('controller', controllerId));
  }

  async function publishEvent(type, payload = {}) {
    await ensurePubReady();
    const event = JSON.stringify({
      type,
      instanceId,
      timestamp: new Date().toISOString(),
      payload,
    });
    await pub.publish(publishChannel, event);
  }

  async function subscribe(handler) {
    if (typeof handler !== 'function') return async () => {};

    if (!sub) {
      sub = createRedisSocketClient({
        env,
        RedisCtor,
        connectionName: `tally-runtime-sub:${instanceId}`,
      });
      await sub.connect();
    }

    const listener = (channel, raw) => {
      if (channel !== publishChannel) return;
      try {
        handler(JSON.parse(raw));
      } catch (error) {
        logger.warn?.(`[runtimeCoordination] Failed to parse event: ${error.message}`);
      }
    };

    sub.on('message', listener);
    await sub.subscribe(publishChannel);

    return async () => {
      if (!sub) return;
      sub.off('message', listener);
      try {
        await sub.unsubscribe(publishChannel);
      } catch (err) {
        // ignore unsubscribe races during shutdown
        console.debug('[runtimeCoordination] redis unsubscribe race:', err?.message);
      }
    };
  }

  function logStatus() {
    logger.log?.(`[runtimeCoordination] Redis coordination enabled for instance ${instanceId}`);
  }

  async function close() {
    const closers = [];
    if (sub) closers.push(sub.quit().catch(() => sub.disconnect()));
    closers.push(pub.quit().catch(() => pub.disconnect()));
    await Promise.allSettled(closers);
  }

  return {
    enabled: true,
    instanceId,
    publishChannel,
    logStatus,
    recordChurchPresence,
    clearChurchPresence,
    recordControllerPresence,
    clearControllerPresence,
    publishEvent,
    subscribe,
    close,
  };
}

module.exports = {
  createRuntimeCoordinator,
};
