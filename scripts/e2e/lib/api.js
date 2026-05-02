/**
 * Thin fetch wrapper for the relay REST surface.
 *
 * Conventions:
 *   - All paths are relative to RELAY_URL.
 *   - apiAdmin() injects x-api-key (admin endpoints).
 *   - apiBearer(token) injects Authorization: Bearer (church_app endpoints).
 *   - Throws on !res.ok with the response body included so test failures
 *     surface real error messages instead of generic "fetch failed".
 */

'use strict';

class HttpError extends Error {
  constructor(status, body, method, url) {
    super(`${method} ${url} → HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
    this.method = method;
    this.url = url;
  }
}

async function request(baseUrl, method, path, { body, headers = {}, expectStatus } = {}) {
  const url = `${baseUrl}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    signal: AbortSignal.timeout(15_000),
  };
  if (body !== undefined && body !== null) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text().catch(() => '');
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  const expected = expectStatus ?? (res.status >= 200 && res.status < 300);
  const ok = expectStatus === undefined ? res.ok : res.status === expectStatus;
  if (!ok) throw new HttpError(res.status, parsed, method, url);
  return { status: res.status, body: parsed, raw: text, headers: res.headers };
}

function apiAdmin(baseUrl, adminApiKey) {
  return {
    get:    (p, opts) => request(baseUrl, 'GET',    p, { ...opts, headers: { ...(opts?.headers||{}), 'x-api-key': adminApiKey } }),
    post:   (p, opts) => request(baseUrl, 'POST',   p, { ...opts, headers: { ...(opts?.headers||{}), 'x-api-key': adminApiKey } }),
    put:    (p, opts) => request(baseUrl, 'PUT',    p, { ...opts, headers: { ...(opts?.headers||{}), 'x-api-key': adminApiKey } }),
    delete: (p, opts) => request(baseUrl, 'DELETE', p, { ...opts, headers: { ...(opts?.headers||{}), 'x-api-key': adminApiKey } }),
  };
}

function apiBearer(baseUrl, token) {
  const auth = `Bearer ${token}`;
  return {
    get:    (p, opts) => request(baseUrl, 'GET',    p, { ...opts, headers: { ...(opts?.headers||{}), Authorization: auth } }),
    post:   (p, opts) => request(baseUrl, 'POST',   p, { ...opts, headers: { ...(opts?.headers||{}), Authorization: auth } }),
    put:    (p, opts) => request(baseUrl, 'PUT',    p, { ...opts, headers: { ...(opts?.headers||{}), Authorization: auth } }),
    delete: (p, opts) => request(baseUrl, 'DELETE', p, { ...opts, headers: { ...(opts?.headers||{}), Authorization: auth } }),
  };
}

module.exports = { apiAdmin, apiBearer, request, HttpError };
