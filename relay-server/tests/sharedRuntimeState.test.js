import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createSharedRuntimeState } = require('../src/sharedRuntimeState');

class FakeRedis {
  static store = new Map();

  static reset() {
    FakeRedis.store = new Map();
  }

  constructor() {
    this.connected = false;
  }

  async connect() {
    this.connected = true;
  }

  async set(key, value, mode, ttlMs) {
    FakeRedis.store.set(key, { type: 'string', value, mode, ttlMs });
    return 'OK';
  }

  async get(key) {
    return FakeRedis.store.get(key)?.value ?? null;
  }

  async del(key) {
    FakeRedis.store.delete(key);
    return 1;
  }

  async rpush(key, value) {
    const existing = FakeRedis.store.get(key);
    const list = existing?.type === 'list' ? [...existing.value] : [];
    list.push(value);
    FakeRedis.store.set(key, { type: 'list', value: list, ttlMs: existing?.ttlMs ?? null });
    return list.length;
  }

  async ltrim(key, start, stop) {
    const existing = FakeRedis.store.get(key);
    const list = existing?.type === 'list' ? [...existing.value] : [];
    const [from, to] = normalizeRange(list.length, start, stop);
    FakeRedis.store.set(key, { type: 'list', value: list.slice(from, to), ttlMs: existing?.ttlMs ?? null });
    return 'OK';
  }

  async lrange(key, start, stop) {
    const existing = FakeRedis.store.get(key);
    const list = existing?.type === 'list' ? existing.value : [];
    const [from, to] = normalizeRange(list.length, start, stop);
    return list.slice(from, to);
  }

  async pexpire(key, ttlMs) {
    const existing = FakeRedis.store.get(key);
    if (existing) {
      FakeRedis.store.set(key, { ...existing, ttlMs });
    }
    return 1;
  }

  async quit() {
    this.connected = false;
  }

  disconnect() {
    this.connected = false;
  }
}

function normalizeRange(length, start, stop) {
  const begin = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
  const endInclusive = stop < 0 ? Math.max(length + stop, -1) : Math.min(stop, length - 1);
  if (endInclusive < begin) return [0, 0];
  return [begin, endInclusive + 1];
}

describe('sharedRuntimeState', () => {
  beforeEach(() => {
    FakeRedis.reset();
  });

  it('returns a noop implementation when Redis is not configured', async () => {
    const state = createSharedRuntimeState({ env: {} });
    expect(state.enabled).toBe(false);
    await expect(state.getPreviewFrame('church-1')).resolves.toBeNull();
    await expect(state.drainQueuedMessages('church-1')).resolves.toEqual([]);
  });

  it('stores and drains queued messages with trimming', async () => {
    const state = createSharedRuntimeState({
      env: {
        REDIS_URL: 'redis://localhost:6379',
        TALLY_INSTANCE_ID: 'instance-a',
      },
      RedisCtor: FakeRedis,
    });

    await state.enqueueMessage('church-1', { msg: { id: '1' }, queuedAt: 1 }, { maxQueueSize: 2, ttlMs: 1000 });
    await state.enqueueMessage('church-1', { msg: { id: '2' }, queuedAt: 2 }, { maxQueueSize: 2, ttlMs: 1000 });
    await state.enqueueMessage('church-1', { msg: { id: '3' }, queuedAt: 3 }, { maxQueueSize: 2, ttlMs: 1000 });

    const drained = await state.drainQueuedMessages('church-1');
    expect(drained.map((item) => item.msg.id)).toEqual(['2', '3']);
    await expect(state.drainQueuedMessages('church-1')).resolves.toEqual([]);
  });

  it('stores and retrieves preview frames', async () => {
    const state = createSharedRuntimeState({
      env: {
        REDIS_URL: 'redis://localhost:6379',
        TALLY_INSTANCE_ID: 'instance-a',
      },
      RedisCtor: FakeRedis,
    });

    await state.setPreviewFrame('church-1', {
      churchId: 'church-1',
      frameId: 'frame-1',
      data: 'abc123',
    }, 30_000);

    await expect(state.getPreviewFrame('church-1')).resolves.toMatchObject({
      churchId: 'church-1',
      frameId: 'frame-1',
      data: 'abc123',
    });
  });
});
