/**
 * Test-account lifecycle against the live relay. Creates a church via
 * POST /api/churches/register (admin-key auth), then fetches a Bearer token
 * via POST /api/church/app/login. Returns BOTH:
 *   - `wsToken`   — long-lived 365d token used to open wss://.../church
 *   - `appToken`  — 30d Bearer used for /api/church/app/* REST + SSE
 *
 * Cleanup deletes the church via DELETE /api/churches/:churchId — cascades to
 * rooms, equipment, alerts, etc. per the relay's existing delete handler.
 */

'use strict';

const { apiAdmin, apiBearer } = require('./api');

async function createTestChurch(cfg, { name, email, password, tier = 'pro' }) {
  const admin = apiAdmin(cfg.relayUrl, cfg.adminApiKey);
  // POST /api/churches/register — admin endpoint that creates the church row,
  // assigns a churchId, and returns the long-lived WS token.
  const { body: created } = await admin.post('/api/churches/register', {
    body: {
      name,
      portalEmail: email,
      password,
      billingStatus: 'active', // bypass the production billing gate
      tier,
    },
  });
  if (!created.churchId || !created.token) {
    throw new Error(`[e2e] /api/churches/register returned unexpected shape: ${JSON.stringify(created)}`);
  }

  // POST /api/church/app/login → 30d Bearer for REST + SSE.
  const { body: login } = await apiAdmin(cfg.relayUrl, cfg.adminApiKey).post('/api/church/app/login', {
    body: { email, password },
    // login is rate-limited and doesn't need admin key, but sending it is harmless
  });
  if (!login.token) {
    throw new Error(`[e2e] /api/church/app/login returned unexpected shape: ${JSON.stringify(login)}`);
  }

  return {
    churchId: created.churchId,
    name: created.name || name,
    email,
    password,
    wsToken: created.token,
    appToken: login.token,
  };
}

async function findExistingTestChurch(cfg, { name }) {
  const admin = apiAdmin(cfg.relayUrl, cfg.adminApiKey);
  // GET /api/churches returns the list (admin-only). Find by name to support
  // re-running the harness without leaving rotting test rows behind.
  try {
    const { body } = await admin.get('/api/churches');
    const list = Array.isArray(body) ? body : (body.churches || []);
    return list.find((c) => c.name === name) || null;
  } catch {
    return null;
  }
}

async function loginAsExisting(cfg, { email, password }) {
  // Same login call — extracted so the create-test-account script can reuse it
  // when an existing test church is found and we just need fresh tokens.
  const { body: login } = await apiAdmin(cfg.relayUrl, cfg.adminApiKey).post('/api/church/app/login', {
    body: { email, password },
  });
  return login.token || null;
}

async function deleteTestChurch(cfg, churchId) {
  const admin = apiAdmin(cfg.relayUrl, cfg.adminApiKey);
  try {
    await admin.delete(`/api/churches/${encodeURIComponent(churchId)}`);
    return true;
  } catch (err) {
    // 404 is fine — already gone
    if (err.status === 404) return true;
    throw err;
  }
}

async function createRoom(cfg, appToken, { name = 'E2E Studio' } = {}) {
  const bearer = apiBearer(cfg.relayUrl, appToken);
  const { body } = await bearer.post('/api/church/app/rooms', {
    body: { name },
  });
  if (!body.roomId && !body.id) {
    throw new Error(`[e2e] room create returned unexpected shape: ${JSON.stringify(body)}`);
  }
  return body.roomId || body.id;
}

module.exports = {
  createTestChurch,
  findExistingTestChurch,
  loginAsExisting,
  deleteTestChurch,
  createRoom,
};
