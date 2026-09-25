#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { MockLabManager, DEFAULT_ADDRESSES } = require('/workspace/tally/electron-app/src/mockLabManager');

const lab = new MockLabManager((msg) => console.log(String(msg)));
const addresses = {
  atem: { ip: '127.0.0.1', port: 9910 },
  obs: { ip: '127.0.0.1', port: 4455 },
  x32: { ip: '127.0.0.1', port: 10023 },
  encoder: { ip: '127.0.0.1', port: 1935 },
  hyperdeck: { ip: '127.0.0.1', port: 9993 },
  propresenter: { ip: '127.0.0.1', port: 1025 },
  controlApi: { ip: '127.0.0.1', port: 9911 },
};

lab.start({ addresses, allowFallback: true, requireUniqueIps: false })
  .then((addrs) => {
    console.log('[mocklab] ready', JSON.stringify(addrs));
    fs.writeFileSync('/workspace/tally-linux/data/mocklab-addresses.json', JSON.stringify(addrs, null, 2));
  })
  .catch((err) => {
    console.error('[mocklab] failed', err && err.stack || err);
    process.exit(1);
  });

function shutdown() {
  lab.stop().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
