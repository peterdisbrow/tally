/**
 * Helper around the mock device control APIs (ports 9100–9110).
 *
 * Each mock exposes /, /state, /action, /reset on its control port. The
 * launcher prints lines like:
 *   [mock-companion] device=http://127.0.0.1:8000  control=http://127.0.0.1:9100
 * so we keep a registry keyed by device name → control URL.
 *
 * For each scenario we want compact helpers like:
 *   await mocks.action('propresenter', 'setSlide', { slideIndex: 5 })
 *   const state = await mocks.state('obs')
 */

'use strict';

// Default port assignments must mirror church-client/test/mocks/launcher.js.
// REGISTRY order there is: companion, propresenter, videohub, obs, atem,
// tricaster, birddog, teradek, resolume, sq, planning-center.
// Control ports start at CONTROL_BASE (9100) and increment by 1.
const DEFAULT_CONTROL_PORTS = {
  'companion':       9100,
  'propresenter':    9101,
  'videohub':        9102,
  'obs':             9103,
  'atem':            9104,
  'tricaster':       9105,
  'birddog':         9106,
  'teradek':         9107,
  'resolume':        9108,
  'sq':              9109,
  'planning-center': 9110,
};

const DEFAULT_DEVICE_PORTS = {
  'companion':       8000,
  'propresenter':    1025,
  'videohub':        9990,
  'obs':             4455,
  'atem':            9910,
  'tricaster':       5951,
  'birddog':         8081,
  'teradek':         8082,
  'resolume':        8080,
  'sq':              51325, // also opens 51326 for OSC
  'planning-center': 8083,
};

class MockControl {
  constructor({ controlPorts = DEFAULT_CONTROL_PORTS, host = '127.0.0.1' } = {}) {
    this.controlPorts = controlPorts;
    this.host = host;
  }

  controlUrl(device) {
    const port = this.controlPorts[device];
    if (!port) throw new Error(`[mock-control] unknown device: ${device}`);
    return `http://${this.host}:${port}`;
  }

  async action(device, action, args = {}) {
    const res = await fetch(`${this.controlUrl(device)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, args }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`[mock-control] ${device}.${action} failed (${res.status}): ${txt}`);
    }
    return res.json();
  }

  async state(device) {
    const res = await fetch(`${this.controlUrl(device)}/state`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`[mock-control] ${device} state read failed: ${res.status}`);
    return res.json();
  }

  async reset(device) {
    const res = await fetch(`${this.controlUrl(device)}/reset`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`[mock-control] ${device} reset failed: ${res.status}`);
    return res.json();
  }

  /** Wait until a mock's control endpoint becomes reachable. */
  async waitReady(device, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        await fetch(`${this.controlUrl(device)}/`, { signal: AbortSignal.timeout(1_000) });
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    throw new Error(`[mock-control] ${device} not ready within ${timeoutMs}ms: ${lastErr?.message}`);
  }
}

module.exports = {
  MockControl,
  DEFAULT_CONTROL_PORTS,
  DEFAULT_DEVICE_PORTS,
};
