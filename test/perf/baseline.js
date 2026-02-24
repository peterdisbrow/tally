import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '2m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE_URL = (__ENV.BASE_URL || 'https://tally-production-cde2.up.railway.app').replace(/\/$/, '');
const LOGIN_EMAIL = __ENV.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = __ENV.LOGIN_PASSWORD || '';

export default function () {
  const health = http.get(`${BASE_URL}/api/health`);
  check(health, {
    'health status 200': (r) => r.status === 200,
    'health has version': (r) => r.json('version') !== undefined,
  });

  const components = http.get(`${BASE_URL}/api/status/components`);
  check(components, {
    'components status 200': (r) => r.status === 200,
    'components has list': (r) => Array.isArray(r.json('components')),
  });

  if (LOGIN_EMAIL && LOGIN_PASSWORD) {
    const login = http.post(
      `${BASE_URL}/api/church/app/login`,
      JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    check(login, {
      'login success': (r) => r.status === 200,
      'login token returned': (r) => !!r.json('token'),
    });
  }

  sleep(1);
}
