const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamHealthMonitor } = require('../src/streamHealthMonitor');

// Helper: create a monitor with mock fetch
function createMonitor() {
  const monitor = new StreamHealthMonitor();
  monitor._alerts = [];
  monitor._sendAlert = (key, msg) => monitor._alerts.push({ key, msg });
  return monitor;
}

test('Vimeo check — alerts when no active live events', async () => {
  const monitor = createMonitor();

  // Mock global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/me/live_events')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: false, status: 404 };
  };

  try {
    await monitor._checkVimeo('fake-token', 'OBS');
    assert.equal(monitor._alerts.length, 1);
    assert.equal(monitor._alerts[0].key, 'vimeo_no_active_event');
    assert.ok(monitor._alerts[0].msg.includes('No active live event'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Vimeo check — alerts when ingest status is waiting', async () => {
  const monitor = createMonitor();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/me/live_events')) {
      return {
        ok: true,
        json: async () => ({
          data: [{ uri: '/live_events/12345', name: 'Sunday Service' }],
        }),
      };
    }
    if (url.includes('/sessions')) {
      return {
        ok: true,
        json: async () => ({
          data: [{
            status: 'started',
            ingest: { status: '1', width: 1920, height: 1080, encoder_type: 'rtmp' },
          }],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    await monitor._checkVimeo('fake-token', 'OBS');
    assert.equal(monitor._alerts.length, 1);
    assert.equal(monitor._alerts[0].key, 'vimeo_ingest_waiting');
    assert.ok(monitor._alerts[0].msg.includes('Sunday Service'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Vimeo check — no alert when stream is healthy', async () => {
  const monitor = createMonitor();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/me/live_events')) {
      return {
        ok: true,
        json: async () => ({
          data: [{ uri: '/live_events/12345', name: 'Sunday Service' }],
        }),
      };
    }
    if (url.includes('/sessions')) {
      return {
        ok: true,
        json: async () => ({
          data: [{
            status: 'started',
            ingest: { status: '3', width: 1920, height: 1080, encoder_type: 'rtmp' },
          }],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    await monitor._checkVimeo('fake-token', 'OBS');
    assert.equal(monitor._alerts.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Vimeo check — handles auth failure gracefully', async () => {
  const monitor = createMonitor();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401 });

  try {
    // Should not throw
    await monitor._checkVimeo('bad-token', 'OBS');
    assert.equal(monitor._alerts.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
