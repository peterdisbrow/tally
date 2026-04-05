import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const createAuthMiddleware = require('../src/routes/authMiddleware');

const JWT_SECRET = 'query-client-auth-secret';

function makeReq(headers = {}, params = {}) {
  return { headers, params, path: '/api/test', cookies: {} };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
  };
}

async function invoke(middleware, req, res) {
  let nextCalled = false;
  await Promise.resolve(middleware(req, res, () => { nextCalled = true; }));
  return nextCalled;
}

function buildMiddleware(queryOneImpl) {
  return createAuthMiddleware({
    db: null,
    queryClient: {
      queryOne: queryOneImpl,
    },
    JWT_SECRET,
    ADMIN_API_KEY: 'sk-admin',
    safeCompareKey: (a, b) => a === b,
    resolveAdminKey: (req) => req.headers['x-admin-api-key'] || '',
  });
}

describe('authMiddleware queryClient path', () => {
  let mw;

  beforeEach(() => {
    mw = buildMiddleware(async (sql, params) => {
      if (sql.includes('FROM admin_users')) {
        return {
          id: params[0],
          email: 'admin@test.com',
          name: 'Admin User',
          role: 'admin',
          active: 1,
        };
      }
      if (sql.includes('FROM resellers')) {
        return params[0] === 'rk-good'
          ? { id: 'res-1', name: 'Reseller', api_key: 'rk-good', active: 1 }
          : null;
      }
      if (sql.includes('FROM churches')) {
        return params[0] === 'church-1'
          ? { churchId: 'church-1', name: 'Grace Church', billing_status: 'active' }
          : null;
      }
      return null;
    });
  });

  it('allows admin JWT auth through queryClient', async () => {
    const token = jwt.sign({ type: 'admin', userId: 'admin-1' }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const nextCalled = await invoke(mw.requireAdminJwt(), req, res);

    expect(nextCalled).toBe(true);
    expect(req.adminUser).toMatchObject({ id: 'admin-1', role: 'admin' });
  });

  it('allows admin API key auth through requireAdmin without loading a user', async () => {
    const bypassMw = buildMiddleware(async () => {
      throw new Error('requireAdmin API key fallback should not query for a user');
    });
    const req = makeReq({ 'x-admin-api-key': 'sk-admin' });
    const res = makeRes();

    const nextCalled = await invoke(bypassMw.requireAdmin, req, res);

    expect(nextCalled).toBe(true);
  });

  it('allows active reseller keys through queryClient', async () => {
    const req = makeReq({ 'x-reseller-key': 'rk-good' });
    const res = makeRes();

    const nextCalled = await invoke(mw.requireReseller, req, res);

    expect(nextCalled).toBe(true);
    expect(req.reseller).toMatchObject({ id: 'res-1', active: 1 });
  });

  it('loads church_app auth through queryClient', async () => {
    const token = jwt.sign({ type: 'church_app', churchId: 'church-1' }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const nextCalled = await invoke(mw.requireChurchAppAuth, req, res);

    expect(nextCalled).toBe(true);
    expect(req.church).toMatchObject({ churchId: 'church-1', name: 'Grace Church' });
  });

  it('marks readonly church_app tokens when auth loads through queryClient', async () => {
    const token = jwt.sign(
      { type: 'church_app', churchId: 'church-1', readonly: true },
      JWT_SECRET,
      { expiresIn: '1h' },
    );
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();

    const nextCalled = await invoke(mw.requireChurchAppAuth, req, res);

    expect(nextCalled).toBe(true);
    expect(req.churchReadonly).toBe(true);
  });
});
