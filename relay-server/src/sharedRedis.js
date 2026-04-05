'use strict';

function hasRedisSocketConfig(env = process.env) {
  return !!(
    env.REDIS_URL ||
    env.UPSTASH_REDIS_URL ||
    env.REDIS_HOST
  );
}

function resolveRedisSocketConfig(env = process.env) {
  const url = (env.REDIS_URL || env.UPSTASH_REDIS_URL || '').trim();
  if (url) {
    return {
      url,
      tls: /^rediss:\/\//i.test(url),
    };
  }

  const host = String(env.REDIS_HOST || '').trim();
  if (!host) return null;

  const port = Number(env.REDIS_PORT || 6379);
  const password = String(env.REDIS_PASSWORD || '').trim() || undefined;
  const username = String(env.REDIS_USERNAME || '').trim() || undefined;
  const tlsEnabled = /^(1|true|yes|on)$/i.test(String(env.REDIS_TLS || ''));

  return {
    host,
    port,
    password,
    username,
    tls: tlsEnabled,
  };
}

function createRedisSocketClient({
  env = process.env,
  RedisCtor = null,
  connectionName = 'tally-relay',
} = {}) {
  const config = resolveRedisSocketConfig(env);
  if (!config) {
    throw new Error('redis-socket-config-missing');
  }

  const Redis = RedisCtor || require('ioredis');
  const common = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectionName,
  };

  if (config.url) {
    return new Redis(config.url, common);
  }

  return new Redis({
    ...common,
    host: config.host,
    port: config.port,
    password: config.password,
    username: config.username,
    tls: config.tls ? {} : undefined,
  });
}

module.exports = {
  hasRedisSocketConfig,
  resolveRedisSocketConfig,
  createRedisSocketClient,
};
