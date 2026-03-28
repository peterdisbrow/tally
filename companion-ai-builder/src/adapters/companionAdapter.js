'use strict';

const http = require('http');
const https = require('https');

class CompanionAdapter {
  constructor({ baseUrl = 'http://localhost:8888', timeoutMs = 5000 } = {}) {
    this.baseUrl = String(baseUrl || 'http://localhost:8888').replace(/\/$/, '');
    this.timeoutMs = Number(timeoutMs) || 5000;
  }

  async health() {
    try {
      const response = await this.request('GET', '/api/location/1/0/0');
      return {
        ok: response.status >= 200 && response.status < 500,
        status: response.status
      };
    } catch (error) {
      return { ok: false, status: 0, error: error.message || 'health check failed' };
    }
  }

  async getConnections() {
    const endpoints = ['/api/connections', '/api/modules', '/api/instances'];
    for (const endpoint of endpoints) {
      try {
        const response = await this.request('GET', endpoint);
        if (response.status < 200 || response.status >= 300) continue;

        const rows = extractConnections(response.body);
        if (!rows.length) continue;
        return rows.map((row, index) => normalizeConnection(row, index));
      } catch {
        // try next endpoint
      }
    }

    return [];
  }

  async getLocation(page, row, col) {
    const safePage = toInt(page, 'page');
    const safeRow = toInt(row, 'row');
    const safeCol = toInt(col, 'col');
    return await this.request('GET', `/api/location/${safePage}/${safeRow}/${safeCol}`);
  }

  async request(method, path, body) {
    return await new Promise((resolve, reject) => {
      const target = new URL(path, this.baseUrl);
      const client = target.protocol === 'https:' ? https : http;

      const options = {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout: this.timeoutMs
      };

      const req = client.request(options, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: parseBody(raw)
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

function extractConnections(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.connections)) return body.connections;
  if (Array.isArray(body.modules)) return body.modules;
  if (Array.isArray(body.instances)) return body.instances;

  if (typeof body === 'object') {
    return Object.entries(body)
      .filter(([, value]) => value && typeof value === 'object')
      .map(([id, value]) => ({ id, ...value }));
  }

  return [];
}

function normalizeConnection(raw, index) {
  const id = String(raw?.id || raw?.connectionId || raw?.instanceId || `conn-${index + 1}`);
  const label = String(raw?.label || raw?.name || raw?.friendlyName || id);
  const moduleId = String(raw?.moduleId || raw?.type || raw?.instance_type || 'unknown').toLowerCase().trim();
  const status = String(raw?.status || (raw?.connected === false ? 'offline' : 'ok')).toLowerCase();
  return { id, label, moduleId, status };
}

function parseBody(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field} must be a non-negative integer`);
  return n;
}

module.exports = { CompanionAdapter };
