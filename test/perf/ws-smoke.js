import ws from 'k6/ws';
import { check } from 'k6';

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '60s',
};

const BASE_WS = (__ENV.BASE_WS || 'wss://api.tallyconnect.app').replace(/\/$/, '');
const ADMIN_API_KEY = __ENV.ADMIN_API_KEY || '';

if (!ADMIN_API_KEY) {
  throw new Error('ADMIN_API_KEY is required for ws-smoke.js');
}

export default function () {
  const url = `${BASE_WS}/controller?apikey=${encodeURIComponent(ADMIN_API_KEY)}`;
  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.setTimeout(function () {
        socket.close();
      }, 1000);
    });

    socket.on('message', function (msg) {
      const data = JSON.parse(msg);
      if (data.type === 'church_list') {
        socket.close();
      }
    });
  });

  check(res, {
    'ws connected': (r) => r && r.status === 101,
  });
}
