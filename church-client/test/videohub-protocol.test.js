/**
 * Tests for VideoHub protocol parsing.
 * Uses internal state manipulation to exercise _parseBuffer, _handleBlock,
 * and toStatus without real TCP connections.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { VideoHub } = require('../src/videohub');

// ─── toStatus() — fresh instance ─────────────────────────────────────────────

describe('VideoHub.toStatus() — fresh instance', () => {
  it('returns all expected fields with zero counts', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    const s = hub.toStatus();
    assert.equal(s.ip, '10.0.0.1');
    assert.equal(s.name, '10.0.0.1'); // defaults to IP
    assert.equal(s.connected, false);
    assert.equal(s.routeCount, 0);
    assert.equal(s.inputCount, 0);
    assert.equal(s.outputCount, 0);
    assert.deepEqual(s.routes, {});
    assert.deepEqual(s.inputLabels, {});
    assert.deepEqual(s.outputLabels, {});
  });

  it('uses name from config when provided', () => {
    const hub = new VideoHub({ ip: '10.0.0.2', name: 'Main Hub' });
    assert.equal(hub.toStatus().name, 'Main Hub');
  });

  it('reflects connected state', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    assert.equal(hub.toStatus().connected, true);
  });

  it('serializes routes map correctly', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub._routes.set(0, 2);
    hub._routes.set(1, 5);
    const s = hub.toStatus();
    assert.equal(s.routes['0'], 2);
    assert.equal(s.routes['1'], 5);
    assert.equal(s.routeCount, 2);
  });

  it('serializes input/output labels maps correctly', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub._inputLabels.set(0, 'Camera 1');
    hub._outputLabels.set(0, 'Monitor A');
    const s = hub.toStatus();
    assert.equal(s.inputLabels['0'], 'Camera 1');
    assert.equal(s.outputLabels['0'], 'Monitor A');
    assert.equal(s.inputCount, 1);
    assert.equal(s.outputCount, 1);
  });
});

// ─── _parseBuffer() — protocol parsing ────────────────────────────────────────

describe('VideoHub._parseBuffer() — INPUT LABELS block', () => {
  it('populates _inputLabels from an INPUT LABELS block', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    // Simulate the connected state so _send doesn't throw
    hub.connected = true;
    hub.socket = { write: () => {} };

    hub._buffer = 'INPUT LABELS:\n0 Camera 1\n1 Camera 2\n\n';
    hub._parseBuffer();
    assert.equal(hub._inputLabels.get(0), 'Camera 1');
    assert.equal(hub._inputLabels.get(1), 'Camera 2');
  });

  it('handles input labels with spaces in name', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };

    hub._buffer = 'INPUT LABELS:\n0 Main Stage Camera\n\n';
    hub._parseBuffer();
    assert.equal(hub._inputLabels.get(0), 'Main Stage Camera');
  });
});

describe('VideoHub._parseBuffer() — OUTPUT LABELS block', () => {
  it('populates _outputLabels from an OUTPUT LABELS block', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };

    hub._buffer = 'OUTPUT LABELS:\n0 Monitor A\n1 Projector\n\n';
    hub._parseBuffer();
    assert.equal(hub._outputLabels.get(0), 'Monitor A');
    assert.equal(hub._outputLabels.get(1), 'Projector');
  });
});

describe('VideoHub._parseBuffer() — VIDEO OUTPUT ROUTING block', () => {
  it('populates _routes from routing block', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };

    hub._buffer = 'VIDEO OUTPUT ROUTING:\n0 2\n1 3\n\n';
    hub._parseBuffer();
    assert.equal(hub._routes.get(0), 2);
    assert.equal(hub._routes.get(1), 3);
  });

  it('emits routeChanged when an existing route changes', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };

    // Establish initial route
    hub._routes.set(0, 1);
    hub._inputLabels.set(2, 'Camera 2');
    hub._outputLabels.set(0, 'Monitor');

    let emitted = null;
    hub.on('routeChanged', (e) => { emitted = e; });

    hub._buffer = 'VIDEO OUTPUT ROUTING:\n0 2\n\n';
    hub._parseBuffer();

    assert.ok(emitted !== null, 'routeChanged should have been emitted');
    assert.equal(emitted.output, 0);
    assert.equal(emitted.input, 2);
    assert.equal(emitted.outputLabel, 'Monitor');
    assert.equal(emitted.inputLabel, 'Camera 2');
  });

  it('does not emit routeChanged when route stays the same', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };

    hub._routes.set(0, 1); // already routes to input 1

    let emitted = false;
    hub.on('routeChanged', () => { emitted = true; });

    hub._buffer = 'VIDEO OUTPUT ROUTING:\n0 1\n\n';
    hub._parseBuffer();

    assert.equal(emitted, false, 'routeChanged should NOT emit when route is unchanged');
  });
});

describe('VideoHub._parseBuffer() — ACK and NAK', () => {
  it('resolves pending callbacks on ACK', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    let resolved = false;
    hub._pendingCallbacks.push({
      blockType: 'ACK',
      resolve: () => { resolved = true; },
      reject: () => {},
    });
    hub._buffer = 'ACK\n\n';
    hub._parseBuffer();
    assert.equal(resolved, true);
  });

  it('rejects pending callbacks on NAK', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    let rejected = false;
    hub._pendingCallbacks.push({
      blockType: 'ACK',
      resolve: () => {},
      reject: () => { rejected = true; },
    });
    hub._buffer = 'NAK\n\n';
    hub._parseBuffer();
    assert.equal(rejected, true);
  });
});

describe('VideoHub._parseBuffer() — PROTOCOL PREAMBLE', () => {
  it('sends initial state requests when PROTOCOL PREAMBLE received', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    const written = [];
    hub.socket = { write: (data) => written.push(data) };

    hub._buffer = 'PROTOCOL PREAMBLE:\nVersion: 2.8\n\n';
    hub._parseBuffer();

    assert.ok(written.some(d => d.includes('INPUT LABELS')));
    assert.ok(written.some(d => d.includes('OUTPUT LABELS')));
    assert.ok(written.some(d => d.includes('VIDEO OUTPUT ROUTING')));
  });
});

describe('VideoHub._parseBuffer() — multiple blocks in buffer', () => {
  it('processes multiple blocks in sequence', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };

    hub._buffer = 'INPUT LABELS:\n0 Cam1\n\nOUTPUT LABELS:\n0 Mon1\n\n';
    hub._parseBuffer();

    assert.equal(hub._inputLabels.get(0), 'Cam1');
    assert.equal(hub._outputLabels.get(0), 'Mon1');
  });

  it('leaves incomplete block in buffer until double-newline arrives', () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };

    // Only partial block — no double newline
    hub._buffer = 'INPUT LABELS:\n0 Cam1\n';
    hub._parseBuffer();

    // Should not have processed yet
    assert.equal(hub._inputLabels.size, 0);
    // Buffer still contains the partial block
    assert.ok(hub._buffer.includes('INPUT LABELS'));
  });
});

// ─── disconnect() ─────────────────────────────────────────────────────────────

describe('VideoHub.disconnect()', () => {
  it('sets _destroyed and clears connected', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    let destroyed = false;
    hub.socket = { destroy: () => { destroyed = true; } };

    await hub.disconnect();

    assert.equal(hub._destroyed, true);
    assert.equal(hub.connected, false);
    assert.equal(hub.socket, null);
    assert.equal(destroyed, true);
  });

  it('safe to call when no socket exists', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    await assert.doesNotReject(() => hub.disconnect());
    assert.equal(hub._destroyed, true);
  });
});

// ─── Public API when not connected ─────────────────────────────────────────────

describe('VideoHub public API — throws when not connected', () => {
  it('getRoutes throws when not connected', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1', name: 'Test' });
    await assert.rejects(
      () => hub.getRoutes(),
      /not connected/
    );
  });

  it('getInputLabels throws when not connected', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1', name: 'Test' });
    await assert.rejects(
      () => hub.getInputLabels(),
      /not connected/
    );
  });

  it('getOutputLabels throws when not connected', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1', name: 'Test' });
    await assert.rejects(
      () => hub.getOutputLabels(),
      /not connected/
    );
  });

  it('setRoute throws when not connected', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1', name: 'Test' });
    await assert.rejects(
      () => hub.setRoute(0, 1),
      /not connected/
    );
  });

  it('setInputLabel throws when not connected', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1', name: 'Test' });
    await assert.rejects(
      () => hub.setInputLabel(0, 'Cam'),
      /not connected/
    );
  });

  it('setOutputLabel throws when not connected', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1', name: 'Test' });
    await assert.rejects(
      () => hub.setOutputLabel(0, 'Mon'),
      /not connected/
    );
  });
});

// ─── getRoutes / getInputLabels / getOutputLabels — with fake connected state ─

describe('VideoHub.getRoutes() — with mocked connected state', () => {
  it('returns sorted routes with fallback labels', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };

    hub._routes.set(1, 3);
    hub._routes.set(0, 2);
    hub._inputLabels.set(2, 'Cam A');
    hub._outputLabels.set(0, 'Mon X');

    // Fake _sendAndWait to resolve immediately
    hub._sendAndWait = async () => {};

    const routes = await hub.getRoutes();
    assert.equal(routes.length, 2);
    assert.equal(routes[0].output, 0);
    assert.equal(routes[0].input, 2);
    assert.equal(routes[0].inputLabel, 'Cam A');
    assert.equal(routes[0].outputLabel, 'Mon X');
    assert.equal(routes[1].output, 1);
    assert.equal(routes[1].inputLabel, 'Input 3'); // no label → fallback
  });
});

describe('VideoHub.getInputLabels() — with mocked connected state', () => {
  it('returns sorted labels', async () => {
    const hub = new VideoHub({ ip: '10.0.0.1' });
    hub.connected = true;
    hub.socket = { write: () => {} };
    hub._sendAndWait = async () => {};

    hub._inputLabels.set(2, 'Cam C');
    hub._inputLabels.set(0, 'Cam A');

    const labels = await hub.getInputLabels();
    assert.equal(labels.length, 2);
    assert.equal(labels[0].index, 0);
    assert.equal(labels[0].label, 'Cam A');
    assert.equal(labels[1].index, 2);
  });
});
