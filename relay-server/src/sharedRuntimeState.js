'use strict';

const { hasRedisSocketConfig, createRedisSocketClient } = require('./sharedRedis');

const DEFAULT_KEY_PREFIX = 'tally:runtime:shared';

function createNoopSharedRuntimeState() {
  const noop = async () => false;
  return {
    enabled: false,
    enqueueMessage: noop,
    drainQueuedMessages: async () => [],
    clearQueuedMessages: noop,
    setPreviewFrame: noop,
    getPreviewFrame: async () => null,
    clearPreviewFrame: noop,
    close: async () => {},
  };
}

function createSharedRuntimeState({
  env = process.env,
  logger = console,
  RedisCtor = null,
} = {}) {
  if (!hasRedisSocketConfig(env)) {
    return createNoopSharedRuntimeState();
  }

  const keyPrefix = String(env.RUNTIME_SHARED_PREFIX || DEFAULT_KEY_PREFIX).trim() || DEFAULT_KEY_PREFIX;
  const client = createRedisSocketClient({
    env,
    RedisCtor,
    connectionName: `tally-runtime-shared:${env.TALLY_INSTANCE_ID || process.pid}`,
  });
  let connected = false;

  async function ensureReady() {
    if (connected) return;
    await client.connect();
    connected = true;
  }

  function queueKey(churchId) {
    return `${keyPrefix}:queue:${churchId}`;
  }

  function previewKey(churchId) {
    return `${keyPrefix}:preview:${churchId}`;
  }

  async function enqueueMessage(churchId, item, { maxQueueSize = 10, ttlMs = 30_000 } = {}) {
    if (!churchId || !item) return false;
    await ensureReady();
    const key = queueKey(churchId);
    await client.rpush(key, JSON.stringify(item));
    await client.ltrim(key, -Math.max(1, Number(maxQueueSize) || 1), -1);
    await client.pexpire(key, Math.max(1_000, Number(ttlMs) || 30_000));
    return true;
  }

  async function drainQueuedMessages(churchId) {
    if (!churchId) return [];
    await ensureReady();
    const key = queueKey(churchId);
    const rawItems = await client.lrange(key, 0, -1);
    await client.del(key);
    const items = [];
    for (const raw of rawItems || []) {
      try {
        items.push(JSON.parse(raw));
      } catch (error) {
        logger.warn?.(`[sharedRuntimeState] Failed to parse queued command: ${error.message}`);
      }
    }
    return items;
  }

  async function clearQueuedMessages(churchId) {
    if (!churchId) return false;
    await ensureReady();
    await client.del(queueKey(churchId));
    return true;
  }

  async function setPreviewFrame(churchId, frame, ttlMs = 30_000) {
    if (!churchId || !frame) return false;
    await ensureReady();
    await client.set(
      previewKey(churchId),
      JSON.stringify(frame),
      'PX',
      Math.max(1_000, Number(ttlMs) || 30_000),
    );
    return true;
  }

  async function getPreviewFrame(churchId) {
    if (!churchId) return null;
    await ensureReady();
    const raw = await client.get(previewKey(churchId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      logger.warn?.(`[sharedRuntimeState] Failed to parse preview frame: ${error.message}`);
      return null;
    }
  }

  async function clearPreviewFrame(churchId) {
    if (!churchId) return false;
    await ensureReady();
    await client.del(previewKey(churchId));
    return true;
  }

  async function close() {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  return {
    enabled: true,
    enqueueMessage,
    drainQueuedMessages,
    clearQueuedMessages,
    setPreviewFrame,
    getPreviewFrame,
    clearPreviewFrame,
    close,
  };
}

module.exports = {
  createSharedRuntimeState,
};
