import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';

const require = createRequire(import.meta.url);
const { createRuntimeCoordinator } = require('../src/runtimeCoordination');

class FakeRedis extends EventEmitter {
  static instances = [];
  static store = new Map();

  static reset() {
    FakeRedis.instances = [];
    FakeRedis.store = new Map();
  }

  constructor(urlOrOptions, options = {}) {
    super();
    this.urlOrOptions = urlOrOptions;
    this.options = options;
    this.connected = false;
    this.subscriptions = new Set();
    FakeRedis.instances.push(this);
  }

  async connect() {
    this.connected = true;
  }

  async set(key, value, mode, ttlMs) {
    FakeRedis.store.set(key, { value, mode, ttlMs });
    return 'OK';
  }

  async del(key) {
    FakeRedis.store.delete(key);
    return 1;
  }

  async publish(channel, payload) {
    for (const client of FakeRedis.instances) {
      if (client.subscriptions.has(channel)) {
        client.emit('message', channel, payload);
      }
    }
    return 1;
  }

  async subscribe(channel) {
    this.subscriptions.add(channel);
  }

  async unsubscribe(channel) {
    this.subscriptions.delete(channel);
  }

  async quit() {
    this.connected = false;
  }

  disconnect() {
    this.connected = false;
  }
}

describe('createRuntimeCoordinator', () => {
  beforeEach(() => {
    FakeRedis.reset();
  });

  it('returns a no-op coordinator when socket Redis is not configured', async () => {
    const coordinator = createRuntimeCoordinator({ env: { HOSTNAME: 'test-host' } });

    expect(coordinator.enabled).toBe(false);
    await coordinator.recordChurchPresence({ churchId: 'church-1' });
    await coordinator.publishEvent('church_status', { churchId: 'church-1' });
    await coordinator.close();
  });

  it('records and clears church/controller presence in Redis', async () => {
    const coordinator = createRuntimeCoordinator({
      env: {
        REDIS_URL: 'redis://localhost:6379',
        TALLY_INSTANCE_ID: 'instance-a',
        RUNTIME_COORDINATION_PREFIX: 'tally:test',
      },
      RedisCtor: FakeRedis,
    });

    await coordinator.recordChurchPresence({
      churchId: 'church-1',
      name: 'First Baptist',
      lastSeen: '2026-04-05T00:00:00.000Z',
    }, { instance: 'sanctuary', statusMode: 'delta' });

    const churchKey = 'tally:test:presence:church:church-1:instance-a:sanctuary';
    expect(FakeRedis.store.has(churchKey)).toBe(true);
    expect(JSON.parse(FakeRedis.store.get(churchKey).value)).toMatchObject({
      type: 'church',
      churchId: 'church-1',
      name: 'First Baptist',
      instance: 'sanctuary',
      instanceId: 'instance-a',
      statusMode: 'delta',
    });

    await coordinator.recordControllerPresence('controller-1', { ip: '127.0.0.1' });
    const controllerKey = 'tally:test:presence:controller:controller-1:instance-a';
    expect(FakeRedis.store.has(controllerKey)).toBe(true);

    await coordinator.clearChurchPresence('church-1', 'sanctuary');
    await coordinator.clearControllerPresence('controller-1');
    expect(FakeRedis.store.has(churchKey)).toBe(false);
    expect(FakeRedis.store.has(controllerKey)).toBe(false);

    await coordinator.close();
  });

  it('publishes and subscribes to coordination events', async () => {
    const coordinator = createRuntimeCoordinator({
      env: {
        REDIS_URL: 'redis://localhost:6379',
        TALLY_INSTANCE_ID: 'instance-a',
        RUNTIME_COORDINATION_PREFIX: 'tally:test',
      },
      RedisCtor: FakeRedis,
    });

    const received = [];
    const unsubscribe = await coordinator.subscribe((event) => received.push(event));
    await coordinator.publishEvent('church_status', { churchId: 'church-1', statusMode: 'delta' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'church_status',
      instanceId: 'instance-a',
      payload: { churchId: 'church-1', statusMode: 'delta' },
    });

    await unsubscribe();
    await coordinator.close();
  });
});
