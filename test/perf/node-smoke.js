#!/usr/bin/env node
'use strict';

const path = require('path');
const { performance } = require('perf_hooks');

let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  WebSocket = require(path.join(__dirname, '../../relay-server/node_modules/ws'));
}

const BASE_URL = String(process.env.BASE_URL || 'https://api.tallyconnect.app').replace(/\/+$/, '');
const BASE_WS = String(process.env.BASE_WS || BASE_URL.replace(/^http/i, 'ws')).replace(/\/+$/, '');
const REQUESTS = Math.max(1, Number(process.env.REQUESTS || 60));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 10));
const TIMEOUT_MS = Math.max(1000, Number(process.env.TIMEOUT_MS || 8000));
const MAX_FAIL_RATE = Math.max(0, Number(process.env.MAX_FAIL_RATE || 0.01));
const MAX_P95_MS = Math.max(1, Number(process.env.MAX_P95_MS || 500));
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';

function pct(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
  return sorted[idx];
}

async function fetchWithTiming(url, options = {}) {
  const started = performance.now();
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const elapsed = performance.now() - started;
  return { response, elapsed };
}

async function runApiLoad() {
  let sent = 0;
  let failed = 0;
  const latencies = [];

  async function worker() {
    while (true) {
      const id = sent++;
      if (id >= REQUESTS) break;
      try {
        const { response, elapsed } = await fetchWithTiming(`${BASE_URL}/api/health`);
        latencies.push(elapsed);
        if (!response.ok) failed++;
      } catch {
        failed++;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  const failRate = failed / REQUESTS;
  return {
    total: REQUESTS,
    failed,
    failRate,
    p50: pct(latencies, 50),
    p95: pct(latencies, 95),
  };
}

async function runAdminProbe() {
  if (!ADMIN_API_KEY) return { skipped: true };
  const { response, elapsed } = await fetchWithTiming(`${BASE_URL}/api/admin/me`, {
    headers: { 'x-api-key': ADMIN_API_KEY },
  });
  return { skipped: false, status: response.status, elapsed };
}

async function runLoginProbe() {
  if (!LOGIN_EMAIL || !LOGIN_PASSWORD) return { skipped: true };
  const { response, elapsed } = await fetchWithTiming(`${BASE_URL}/api/church/app/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  return { skipped: false, status: response.status, elapsed };
}

async function runWebSocketProbe() {
  if (!ADMIN_API_KEY) return { skipped: true };
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE_WS}/controller?apikey=${encodeURIComponent(ADMIN_API_KEY)}`);
    const started = performance.now();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ skipped: false, ok: false, detail: 'timeout' });
    }, TIMEOUT_MS);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'church_list') {
          clearTimeout(timer);
          const elapsed = performance.now() - started;
          try { ws.close(); } catch {}
          resolve({ skipped: false, ok: true, elapsed });
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      resolve({ skipped: false, ok: false, detail: err.message });
    });
  });
}

async function main() {
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`BASE_WS=${BASE_WS}`);
  console.log(`REQUESTS=${REQUESTS} CONCURRENCY=${CONCURRENCY}`);

  const api = await runApiLoad();
  console.log(`API: total=${api.total} failed=${api.failed} fail_rate=${(api.failRate * 100).toFixed(2)}% p50=${api.p50.toFixed(1)}ms p95=${api.p95.toFixed(1)}ms`);

  const admin = await runAdminProbe();
  if (admin.skipped) {
    console.log('ADMIN: skipped (set ADMIN_API_KEY to enable)');
  } else {
    console.log(`ADMIN: status=${admin.status} latency=${admin.elapsed.toFixed(1)}ms`);
  }

  const login = await runLoginProbe();
  if (login.skipped) {
    console.log('LOGIN: skipped (set LOGIN_EMAIL and LOGIN_PASSWORD to enable)');
  } else {
    console.log(`LOGIN: status=${login.status} latency=${login.elapsed.toFixed(1)}ms`);
  }

  const ws = await runWebSocketProbe();
  if (ws.skipped) {
    console.log('WS: skipped (set ADMIN_API_KEY to enable)');
  } else if (ws.ok) {
    console.log(`WS: ok latency=${ws.elapsed.toFixed(1)}ms`);
  } else {
    console.log(`WS: failed (${ws.detail})`);
  }

  let ok = true;
  if (api.failRate > MAX_FAIL_RATE) ok = false;
  if (api.p95 > MAX_P95_MS) ok = false;
  if (!admin.skipped && admin.status !== 200) ok = false;
  if (!login.skipped && !(login.status >= 200 && login.status < 300)) ok = false;
  if (!ws.skipped && !ws.ok) ok = false;

  if (!ok) {
    console.error('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: PASS');
}

main().catch((err) => {
  console.error(`RESULT: FAIL (${err.message})`);
  process.exit(1);
});
