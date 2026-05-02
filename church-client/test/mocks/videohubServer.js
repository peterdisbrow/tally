/**
 * Mock Blackmagic Videohub TCP server (port 9990).
 *
 * Speaks the Videohub text protocol — newline-terminated blocks separated by
 * a blank line. Sends the standard preamble + label/routing dump on connect,
 * then accepts INPUT LABELS / OUTPUT LABELS / VIDEO OUTPUT ROUTING write
 * blocks and broadcasts updates to all connected clients (so reads after a
 * write see the new state, just like real Videohub firmware).
 *
 * Reference: church-client/src/videohub.js _handleBlock() for the parser.
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setRoute", args: { output, input } }
 *   POST /action { action: "renameInput", args: { index, label } }
 *   POST /action { action: "renameOutput", args: { index, label } }
 *   POST /action { action: "setSize", args: { inputs, outputs } }
 */

'use strict';

const net = require('node:net');
const { createControlServer } = require('./_lib/control');

function buildDefaults({ inputs = 12, outputs = 12 } = {}) {
  const inputLabels = {};
  const outputLabels = {};
  const routes = {};
  for (let i = 0; i < inputs; i++) inputLabels[i] = `Input ${i + 1}`;
  for (let i = 0; i < outputs; i++) {
    outputLabels[i] = `Output ${i + 1}`;
    routes[i] = i % inputs; // identity routing by default
  }
  return {
    deviceName: 'Mock Videohub 12x12',
    modelName: 'Smart Videohub 12x12',
    inputCount: inputs,
    outputCount: outputs,
    inputLabels,
    outputLabels,
    routes,
  };
}

function snapshotBlocks(state) {
  const lines = [];
  lines.push('PROTOCOL PREAMBLE:', 'Version: 2.7', '');
  lines.push(
    'VIDEOHUB DEVICE:',
    `Device present: true`,
    `Model name: ${state.modelName}`,
    `Friendly name: ${state.deviceName}`,
    `Unique ID: 7c2e0d1c0001`,
    `Video inputs: ${state.inputCount}`,
    `Video outputs: ${state.outputCount}`,
    '',
  );
  lines.push('INPUT LABELS:');
  for (let i = 0; i < state.inputCount; i++) lines.push(`${i} ${state.inputLabels[i] ?? `Input ${i + 1}`}`);
  lines.push('');
  lines.push('OUTPUT LABELS:');
  for (let i = 0; i < state.outputCount; i++) lines.push(`${i} ${state.outputLabels[i] ?? `Output ${i + 1}`}`);
  lines.push('');
  lines.push('VIDEO OUTPUT ROUTING:');
  for (let i = 0; i < state.outputCount; i++) lines.push(`${i} ${state.routes[i] ?? 0}`);
  lines.push('');
  return lines.join('\n');
}

function parseBlock(block) {
  // Each write block is "HEADER:\n<index> <value>\n..."
  const lines = block.trim().split('\n');
  const header = lines[0].replace(/:$/, '').trim();
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+)\s+(.+)$/);
    if (m) rows.push({ index: Number(m[1]), value: m[2] });
  }
  return { header, rows };
}

async function start({ port = 9990, controlPort = 0, inputs, outputs } = {}) {
  const state = buildDefaults({ inputs, outputs });
  const initialSnapshot = JSON.parse(JSON.stringify(state));
  const sockets = new Set();

  function broadcast(text) {
    for (const sock of sockets) {
      if (!sock.destroyed) sock.write(text);
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';

    // Send the initial state dump on connect.
    socket.write(snapshotBlocks(state));

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end === -1) break;
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!block.trim()) continue;
        const parsed = parseBlock(block);
        let echo = `${parsed.header}:\n`;
        switch (parsed.header) {
          case 'INPUT LABELS':
            for (const r of parsed.rows) state.inputLabels[r.index] = r.value;
            for (const r of parsed.rows) echo += `${r.index} ${state.inputLabels[r.index]}\n`;
            break;
          case 'OUTPUT LABELS':
            for (const r of parsed.rows) state.outputLabels[r.index] = r.value;
            for (const r of parsed.rows) echo += `${r.index} ${state.outputLabels[r.index]}\n`;
            break;
          case 'VIDEO OUTPUT ROUTING':
            for (const r of parsed.rows) state.routes[r.index] = Number(r.value);
            for (const r of parsed.rows) echo += `${r.index} ${state.routes[r.index]}\n`;
            break;
          default:
            // Unknown — ACK with empty echo
            break;
        }
        echo += '\n'; // double-newline terminator
        broadcast(`ACK\n\n${echo}`);
      }
    });

    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* ignore client errors */ });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  const control = await createControlServer({
    device: 'videohub',
    port: controlPort,
    state,
    initialState: initialSnapshot,
    actions: {
      setRoute: ({ output, input }) => {
        state.routes[output] = Number(input);
        broadcast(`VIDEO OUTPUT ROUTING:\n${output} ${input}\n\n`);
      },
      renameInput: ({ index, label }) => {
        state.inputLabels[index] = String(label);
        broadcast(`INPUT LABELS:\n${index} ${label}\n\n`);
      },
      renameOutput: ({ index, label }) => {
        state.outputLabels[index] = String(label);
        broadcast(`OUTPUT LABELS:\n${index} ${label}\n\n`);
      },
      setSize: ({ inputs: iCount, outputs: oCount }) => {
        const next = buildDefaults({ inputs: iCount, outputs: oCount });
        Object.assign(state, next);
        for (const sock of sockets) sock.write(snapshotBlocks(state));
      },
    },
  });

  return {
    device: 'videohub',
    port: actualPort,
    url: `tcp://127.0.0.1:${actualPort}`,
    control,
    state,
    stop: async () => {
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      await new Promise((r) => server.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 9990, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-videohub] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
