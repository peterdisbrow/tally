#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  WebSocket = require(path.join(__dirname, '../../relay-server/node_modules/ws'));
}

const BASE_WS = String(process.env.BASE_WS || 'wss://api.tallyconnect.app').replace(/\/+$/, '');
const HEALTH_BASE_URL = String(process.env.HEALTH_BASE_URL || '').trim();
const CHURCH_TOKENS_FILE = String(process.env.CHURCH_TOKENS_FILE || '').trim();
const CHURCH_TOKEN = String(process.env.CHURCH_TOKEN || '').trim();
const CHURCH_ID = String(process.env.CHURCH_ID || '').trim();
const CHURCH_COUNT = Math.max(1, Number(process.env.CHURCH_COUNT || 1000));
const INSTANCES_PER_CHURCH = Math.max(1, Number(process.env.INSTANCES_PER_CHURCH || 1));
const CONTROLLER_CLIENTS = Math.max(0, Number(process.env.CONTROLLER_CLIENTS || 0));
const STATUS_INTERVAL_MS = Math.max(1000, Number(process.env.STATUS_INTERVAL_MS || 10_000));
const WARMUP_MS = Math.max(0, Number(process.env.WARMUP_MS || 5_000));
const DURATION_MS = Math.max(5000, Number(process.env.DURATION_MS || 60_000));
const CONNECT_BATCH_SIZE = Math.max(1, Number(process.env.CONNECT_BATCH_SIZE || 25));
const CONNECT_BATCH_INTERVAL_MS = Math.max(0, Number(process.env.CONNECT_BATCH_INTERVAL_MS || 250));
const CONNECT_TIMEOUT_MS = Math.max(1000, Number(process.env.CONNECT_TIMEOUT_MS || 15_000));
const LOG_EVERY_MS = Math.max(1000, Number(process.env.LOG_EVERY_MS || 5000));
const HEALTH_POLL_MS = Math.max(0, Number(process.env.HEALTH_POLL_MS || LOG_EVERY_MS));
const STATUS_JITTER_MS = Math.max(0, Number(process.env.STATUS_JITTER_MS || STATUS_INTERVAL_MS));
const MAX_CHURCH_CONNECT_FAIL_RATE = Math.max(0, Number(process.env.MAX_CHURCH_CONNECT_FAIL_RATE || 0.01));
const MAX_CONTROLLER_CONNECT_FAIL_RATE = Math.max(0, Number(process.env.MAX_CONTROLLER_CONNECT_FAIL_RATE || MAX_CHURCH_CONNECT_FAIL_RATE));
const MAX_STATUS_FAIL_RATE = Math.max(0, Number(process.env.MAX_STATUS_FAIL_RATE || 0.01));
const MAX_CHURCH_CONNECT_P95_MS = Math.max(1, Number(process.env.MAX_CHURCH_CONNECT_P95_MS || 5000));
const MAX_STATUS_LAG_P95_MS = Math.max(1, Number(process.env.MAX_STATUS_LAG_P95_MS || 1000));
const MAX_HEALTH_EVENT_LOOP_P95_MS = Math.max(0, Number(process.env.MAX_HEALTH_EVENT_LOOP_P95_MS || 0));
const MAX_HEALTH_QUEUE_MESSAGES = Math.max(0, Number(process.env.MAX_HEALTH_QUEUE_MESSAGES || 0));
const CONTROLLER_API_KEY = String(process.env.CONTROLLER_API_KEY || process.env.ADMIN_API_KEY || '').trim();
const DRY_RUN = truthy(process.env.DRY_RUN || process.env.DRYRUN || process.argv.includes('--dry-run'));

const wsOpen = WebSocket.OPEN;

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relayHttpUrl(url) {
  return String(url || BASE_WS)
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/\/+$/, '');
}

function pct(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
  return sorted[idx];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function loadChurchSpecs() {
  if (CHURCH_TOKENS_FILE) {
    const resolved = path.resolve(CHURCH_TOKENS_FILE);
    const raw = fs.readFileSync(resolved, 'utf8').trim();
    if (!raw) return [];

    if (resolved.endsWith('.json')) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('CHURCH_TOKENS_FILE JSON must be an array');
      return parsed.map((entry, index) => normalizeChurchSpec(entry, index));
    }

    return raw.split(/\r?\n/).map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return null;
      const [churchId, token, name = ''] = trimmed.split('|').map((part) => part.trim());
      return normalizeChurchSpec({ churchId, token, name }, index);
    }).filter(Boolean);
  }

  if (CHURCH_TOKEN && CHURCH_ID) {
    return [normalizeChurchSpec({ churchId: CHURCH_ID, token: CHURCH_TOKEN, name: CHURCH_ID }, 0)];
  }

  throw new Error(
    'Provide CHURCH_TOKENS_FILE (recommended) or CHURCH_TOKEN + CHURCH_ID for a single church'
  );
}

function normalizeChurchSpec(entry, index) {
  const churchId = String(entry?.churchId || entry?.id || '').trim();
  const token = String(entry?.token || entry?.jwt || '').trim();
  const name = String(entry?.name || churchId || `church-${index + 1}`).trim();

  if (!churchId) throw new Error(`Missing churchId at index ${index}`);
  if (!token) throw new Error(`Missing token for churchId=${churchId}`);

  return { churchId, token, name };
}

function buildChurchClients(specs) {
  const selected = specs.slice(0, CHURCH_COUNT);
  const clients = [];
  for (let i = 0; i < selected.length; i++) {
    const spec = selected[i];
    for (let instanceIndex = 0; instanceIndex < INSTANCES_PER_CHURCH; instanceIndex++) {
      clients.push({
        kind: 'church',
        churchId: spec.churchId,
        churchName: spec.name,
        token: spec.token,
        churchIndex: i,
        instanceIndex,
        instanceName: `${spec.name || spec.churchId}-perf-${instanceIndex + 1}`,
        roomId: `room-${String((i % 99) + 1).padStart(2, '0')}`,
        sequence: 0,
        ws: null,
        connectedAt: null,
        connectLatencyMs: null,
        statusSent: 0,
        sendErrors: 0,
        closeReason: null,
        timers: [],
      });
    }
  }
  return clients;
}

function buildControllerClients() {
  const clients = [];
  for (let i = 0; i < CONTROLLER_CLIENTS; i++) {
    clients.push({
      kind: i === 0 ? 'metrics' : 'load',
      controllerIndex: i,
      ws: null,
      connectedAt: null,
      connectLatencyMs: null,
      churchListSeen: false,
      statusLagSamples: [],
      messageCount: 0,
      closeReason: null,
    });
  }
  return clients;
}

function buildStatusPayload(client) {
  const now = Date.now();
  const seq = client.sequence++;
  const programInput = (seq % 8) + 1;
  const previewInput = ((seq + 1) % 8) + 1;
  return {
    connected: true,
    system: {
      roomId: client.roomId,
      roomName: `${client.churchName} ${client.instanceIndex + 1}`,
      instanceName: client.instanceName,
      app: 'perf-harness',
      updatedAt: new Date(now).toISOString(),
      sequence: seq,
    },
    atem: {
      connected: true,
      programInput,
      previewInput,
      transitionPreview: seq % 2 === 0,
    },
    obs: {
      connected: seq % 5 !== 0,
      streaming: true,
      recording: seq % 3 === 0,
      scene: `Scene ${seq % 6}`,
    },
    encoder: {
      connected: true,
      streaming: true,
      bitrate: 4500 + ((seq % 5) * 250),
    },
    health: {
      uptimeSec: Math.floor((now - (client.connectedAt || now)) / 1000),
      cpu: 20 + (seq % 30),
      memory: 40 + (seq % 20),
    },
    streamProtection: {
      enabled: true,
      healthy: seq % 11 !== 0,
    },
    metrics: {
      sentAt: now,
      churchId: client.churchId,
      churchName: client.churchName,
      instanceName: client.instanceName,
      sequence: seq,
      clientId: `${client.churchId}:${client.instanceIndex + 1}`,
    },
  };
}

function safeClose(ws, code = 1000, reason = 'done') {
  try {
    if (ws && ws.readyState <= 1) ws.close(code, reason);
  } catch {
    // ignore shutdown errors
  }
}

async function connectWs(url, opts = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS, ...opts });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      safeClose(ws, 1006, 'timeout');
      resolve({ ok: false, error: 'timeout', ws: null, latencyMs: CONNECT_TIMEOUT_MS });
    }, CONNECT_TIMEOUT_MS + 1000);

    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: true, ws, latencyMs: performance.now() - started });
    });

    ws.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, error: err.message, ws: null, latencyMs: performance.now() - started });
    });
  });
}

async function connectChurchClient(client, metrics) {
  const url = `${BASE_WS}/church?token=${encodeURIComponent(client.token)}&instance=${encodeURIComponent(client.instanceName)}`;
  const result = await connectWs(url);
  if (!result.ok) {
    client.closeReason = result.error;
    metrics.churchConnectFailures++;
    return client;
  }

  client.ws = result.ws;
  client.connectedAt = Date.now();
  client.connectLatencyMs = result.latencyMs;
  metrics.churchConnectLatencies.push(result.latencyMs);

  client.ws.on('close', (code, reason) => {
    client.closeReason = `${code || 0}:${String(reason || '').trim() || 'closed'}`;
  });

  client.ws.on('error', (err) => {
    client.closeReason = err.message;
  });

  const phase = (client.churchIndex * 97 + client.instanceIndex * 37) % Math.max(1, STATUS_JITTER_MS || STATUS_INTERVAL_MS);
  const firstSendDelay = WARMUP_MS + phase;

  const sendStatus = () => {
    if (!client.ws || client.ws.readyState !== wsOpen) return;
    const payload = { type: 'status_update', status: buildStatusPayload(client) };
    try {
      client.ws.send(JSON.stringify(payload));
      client.statusSent++;
      metrics.statusSent++;
    } catch (err) {
      client.sendErrors++;
      metrics.statusSendFailures++;
      client.closeReason = err.message;
    }
  };

  const firstTimer = setTimeout(() => {
    sendStatus();
    const interval = setInterval(sendStatus, STATUS_INTERVAL_MS);
    client.timers.push(interval);
  }, firstSendDelay);
  client.timers.push(firstTimer);

  return client;
}

async function connectControllerClient(client, metrics) {
  if (!CONTROLLER_API_KEY) {
    client.closeReason = 'missing api key';
    return client;
  }
  const url = `${BASE_WS}/controller?apikey=${encodeURIComponent(CONTROLLER_API_KEY)}`;
  const result = await connectWs(url);
  if (!result.ok) {
    client.closeReason = result.error;
    metrics.controllerConnectFailures++;
    return client;
  }

  client.ws = result.ws;
  client.connectedAt = Date.now();
  client.connectLatencyMs = result.latencyMs;
  metrics.controllerConnectLatencies.push(result.latencyMs);

  client.ws.on('message', (raw) => {
    client.messageCount++;
    metrics.controllerMessages++;

    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'church_list') {
        client.churchListSeen = true;
        metrics.churchListSeen++;
      }
      if (client.kind === 'metrics' && msg.type === 'status_update') {
        const sentAt = msg?.status?.metrics?.sentAt;
        if (typeof sentAt === 'number' && Number.isFinite(sentAt)) {
          metrics.statusLagSamples.push(Date.now() - sentAt);
          metrics.statusObserved++;
        }
      }
    } catch {
      // Ignore parse errors from unrelated messages
    }
  });

  client.ws.on('close', (code, reason) => {
    client.closeReason = `${code || 0}:${String(reason || '').trim() || 'closed'}`;
  });

  client.ws.on('error', (err) => {
    client.closeReason = err.message;
  });

  return client;
}

async function rampConnect(clients, connectFn, metrics, label) {
  let connected = 0;
  for (let i = 0; i < clients.length; i += CONNECT_BATCH_SIZE) {
    const batch = clients.slice(i, i + CONNECT_BATCH_SIZE);
    await Promise.all(batch.map((client) => connectFn(client, metrics).then((updated) => {
      if (updated.ws) connected++;
      return updated;
    })));
    if (i + CONNECT_BATCH_SIZE < clients.length && CONNECT_BATCH_INTERVAL_MS > 0) {
      await delay(CONNECT_BATCH_INTERVAL_MS);
    }
    if ((i / CONNECT_BATCH_SIZE) % 5 === 0) {
      console.log(`[${label}] connected=${connected}/${clients.length}`);
    }
  }
  return connected;
}

function summarizeLatencies(values) {
  return {
    count: values.length,
    p50: pct(values, 50),
    p95: pct(values, 95),
    avg: mean(values),
    max: values.length ? Math.max(...values) : 0,
  };
}

async function pollHealth(metrics) {
  const baseUrl = HEALTH_BASE_URL || relayHttpUrl(BASE_WS);
  if (!baseUrl) return;

  metrics.healthPolls++;
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      metrics.healthPollFailures++;
      metrics.lastHealth = { error: `HTTP ${response.status}` };
      return;
    }

    const body = await response.json();
    metrics.lastHealth = body;
    const realtime = body?.realtime || {};
    const eventLoop = realtime.eventLoop || {};
    const queues = realtime.queues || {};
    const sockets = realtime.sockets || {};

    if (typeof eventLoop.p95_ms === 'number') metrics.healthEventLoopP95.push(eventLoop.p95_ms);
    if (typeof eventLoop.utilization === 'number') metrics.healthEventLoopUtilization.push(eventLoop.utilization);
    if (typeof queues.queuedMessages === 'number') metrics.healthQueuedMessages.push(queues.queuedMessages);
    if (typeof sockets.previewSubscriptions === 'number') metrics.healthPreviewSubscriptions.push(sockets.previewSubscriptions);
    if (typeof sockets.connectedChurchInstances === 'number') metrics.healthConnectedInstances.push(sockets.connectedChurchInstances);
  } catch (err) {
    metrics.healthPollFailures++;
    metrics.lastHealth = { error: err.message };
  }
}

async function main() {
  const churchSpecs = loadChurchSpecs();
  const churchClients = buildChurchClients(churchSpecs);
  const controllerClients = buildControllerClients();

  console.log(`BASE_WS=${BASE_WS}`);
  console.log(`HEALTH_BASE_URL=${HEALTH_BASE_URL || relayHttpUrl(BASE_WS)}`);
  console.log(`churches=${churchSpecs.length} selected=${Math.min(CHURCH_COUNT, churchSpecs.length)} instancesPerChurch=${INSTANCES_PER_CHURCH}`);
  console.log(`churchClients=${churchClients.length} controllerClients=${controllerClients.length}`);
  console.log(`statusIntervalMs=${STATUS_INTERVAL_MS} warmupMs=${WARMUP_MS} durationMs=${DURATION_MS}`);

  if (DRY_RUN) {
    console.log('DRY_RUN=1 — parsed token file and computed client plan only.');
    console.log('RESULT: PASS');
    return;
  }

  if (CONTROLLER_CLIENTS > 0 && !CONTROLLER_API_KEY) {
    throw new Error('CONTROLLER_API_KEY (or ADMIN_API_KEY) is required when CONTROLLER_CLIENTS > 0');
  }

  const metrics = {
    churchConnectLatencies: [],
    controllerConnectLatencies: [],
    statusLagSamples: [],
    churchConnectFailures: 0,
    controllerConnectFailures: 0,
    statusSent: 0,
    statusObserved: 0,
    statusSendFailures: 0,
    controllerMessages: 0,
    churchListSeen: 0,
    healthPolls: 0,
    healthPollFailures: 0,
    healthEventLoopP95: [],
    healthEventLoopUtilization: [],
    healthQueuedMessages: [],
    healthPreviewSubscriptions: [],
    healthConnectedInstances: [],
    lastHealth: null,
  };

  const startedAt = Date.now();
  let healthTicker = null;
  const ticker = setInterval(() => {
    const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
    const churchConnected = churchClients.filter((client) => client.ws && client.ws.readyState === wsOpen).length;
    const controllerConnected = controllerClients.filter((client) => client.ws && client.ws.readyState === wsOpen).length;
    const healthSummary = metrics.lastHealth?.realtime
      ? ` eventLoopP95=${Number(metrics.lastHealth.realtime.eventLoop?.p95_ms || 0).toFixed(1)}ms queued=${metrics.lastHealth.realtime.queues?.queuedMessages ?? 0}`
      : metrics.lastHealth?.error
        ? ` healthError=${metrics.lastHealth.error}`
        : '';
    console.log(
      `[progress] churchConnected=${churchConnected}/${churchClients.length} ` +
      `controllerConnected=${controllerConnected}/${controllerClients.length} ` +
      `statusSent=${metrics.statusSent} observed=${metrics.statusObserved} ` +
      `sentRate=${(metrics.statusSent / elapsedSec).toFixed(1)}/s ` +
      `lagP95=${pct(metrics.statusLagSamples, 95).toFixed(1)}ms` +
      healthSummary
    );
  }, LOG_EVERY_MS);

  try {
    if (HEALTH_POLL_MS > 0) {
      await pollHealth(metrics);
      healthTicker = setInterval(() => {
        pollHealth(metrics).catch(() => {});
      }, HEALTH_POLL_MS);
    }

    if (controllerClients.length > 0) {
      console.log('Connecting controller clients first...');
      await rampConnect(controllerClients, connectControllerClient, metrics, 'controller');
    }

    console.log('Connecting church clients...');
    await rampConnect(churchClients, connectChurchClient, metrics, 'church');

    console.log(`Running benchmark for ${DURATION_MS}ms...`);
    await delay(DURATION_MS);
  } finally {
    clearInterval(ticker);
    if (healthTicker) clearInterval(healthTicker);
    for (const client of churchClients) {
      for (const timer of client.timers) clearTimeout(timer);
      client.timers.length = 0;
      safeClose(client.ws);
    }
    for (const client of controllerClients) {
      safeClose(client.ws);
    }
    await delay(1000);
  }

  const churchConnectStats = summarizeLatencies(metrics.churchConnectLatencies);
  const controllerConnectStats = summarizeLatencies(metrics.controllerConnectLatencies);
  const lagStats = summarizeLatencies(metrics.statusLagSamples);
  const healthEventLoopStats = summarizeLatencies(metrics.healthEventLoopP95);
  const healthQueuedStats = summarizeLatencies(metrics.healthQueuedMessages);
  const healthPreviewStats = summarizeLatencies(metrics.healthPreviewSubscriptions);
  const benchmarkSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
  const churchConnectAttempts = churchClients.length;
  const controllerConnectAttempts = controllerClients.length;
  const churchConnectFailRate = churchConnectAttempts ? metrics.churchConnectFailures / churchConnectAttempts : 0;
  const controllerConnectFailRate = controllerConnectAttempts ? metrics.controllerConnectFailures / controllerConnectAttempts : 0;
  const statusFailRate = metrics.statusSent ? metrics.statusSendFailures / metrics.statusSent : 0;

  console.log('--- Summary ---');
  console.log(`church_connect: attempts=${churchConnectAttempts} failures=${metrics.churchConnectFailures} fail_rate=${(churchConnectFailRate * 100).toFixed(2)}% p50=${churchConnectStats.p50.toFixed(1)}ms p95=${churchConnectStats.p95.toFixed(1)}ms avg=${churchConnectStats.avg.toFixed(1)}ms`);
  console.log(`controller_connect: attempts=${controllerConnectAttempts} failures=${metrics.controllerConnectFailures} fail_rate=${(controllerConnectFailRate * 100).toFixed(2)}% p50=${controllerConnectStats.p50.toFixed(1)}ms p95=${controllerConnectStats.p95.toFixed(1)}ms avg=${controllerConnectStats.avg.toFixed(1)}ms`);
  console.log(`status_send: sent=${metrics.statusSent} failures=${metrics.statusSendFailures} fail_rate=${(statusFailRate * 100).toFixed(2)}% rate=${(metrics.statusSent / benchmarkSeconds).toFixed(1)}/s`);
  console.log(`status_observed: samples=${metrics.statusObserved} lag_p50=${lagStats.p50.toFixed(1)}ms lag_p95=${lagStats.p95.toFixed(1)}ms lag_avg=${lagStats.avg.toFixed(1)}ms`);
  console.log(`church_list_seen=${metrics.churchListSeen} controller_messages=${metrics.controllerMessages}`);
  if (metrics.healthPolls > 0) {
    console.log(`health: polls=${metrics.healthPolls} failures=${metrics.healthPollFailures} event_loop_p95_p50=${healthEventLoopStats.p50.toFixed(1)}ms event_loop_p95_p95=${healthEventLoopStats.p95.toFixed(1)}ms queue_p95=${healthQueuedStats.p95.toFixed(1)} preview_subscriptions_p95=${healthPreviewStats.p95.toFixed(1)}`);
  }

  const churchOk = churchConnectFailRate <= MAX_CHURCH_CONNECT_FAIL_RATE;
  const controllerOk = controllerConnectFailRate <= MAX_CONTROLLER_CONNECT_FAIL_RATE;
  const statusOk = statusFailRate <= MAX_STATUS_FAIL_RATE;
  const lagOk = lagStats.p95 <= MAX_STATUS_LAG_P95_MS;
  const connectOk = churchConnectStats.p95 <= MAX_CHURCH_CONNECT_P95_MS;
  const healthEventLoopOk = MAX_HEALTH_EVENT_LOOP_P95_MS <= 0 || healthEventLoopStats.p95 <= MAX_HEALTH_EVENT_LOOP_P95_MS;
  const healthQueueOk = MAX_HEALTH_QUEUE_MESSAGES <= 0 || healthQueuedStats.p95 <= MAX_HEALTH_QUEUE_MESSAGES;

  console.log(`thresholds: churchFail<=${(MAX_CHURCH_CONNECT_FAIL_RATE * 100).toFixed(2)}% controllerFail<=${(MAX_CONTROLLER_CONNECT_FAIL_RATE * 100).toFixed(2)}% statusFail<=${(MAX_STATUS_FAIL_RATE * 100).toFixed(2)}% churchP95<=${MAX_CHURCH_CONNECT_P95_MS}ms lagP95<=${MAX_STATUS_LAG_P95_MS}ms`);
  if (MAX_HEALTH_EVENT_LOOP_P95_MS > 0 || MAX_HEALTH_QUEUE_MESSAGES > 0) {
    console.log(`health_thresholds: eventLoopP95<=${MAX_HEALTH_EVENT_LOOP_P95_MS || 'disabled'}ms queueP95<=${MAX_HEALTH_QUEUE_MESSAGES || 'disabled'}`);
  }

  if (!churchOk || !controllerOk || !statusOk || !lagOk || !connectOk || !healthEventLoopOk || !healthQueueOk) {
    console.error('RESULT: FAIL');
    process.exit(1);
  }

  console.log('RESULT: PASS');
}

main().catch((err) => {
  console.error(`RESULT: FAIL (${err.message})`);
  process.exit(1);
});
