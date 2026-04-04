/**
 * Protocol-aware port scanner for AV devices.
 * Uses TCP connect probes and UDP probes for protocol identification.
 */

const net = require('net');
const dgram = require('dgram');
const http = require('http');

// ─── UDP probe packets ──────────────────────────────────────────────────────

const ATEM_SYN = Buffer.from('101453AB00000000003A00000100000000000000', 'hex');
const OSC_INFO = Buffer.from('2F696E666F0000002C000000', 'hex');             // /info (Behringer)
const OSC_SQ_ALIVE = Buffer.from('2F73712F616C6976650000002C000000', 'hex'); // /sq/alive (A&H)
const OSC_YAMAHA = Buffer.from('2F796D6873732F7374617465000000002C000000', 'hex'); // /ymhss/state

// ─── Port definitions ───────────────────────────────────────────────────────

const AV_PORTS = [
  // Blackmagic
  { port: 9910,  proto: 'udp', type: 'atem',        protocol: 'ATEM',          packet: ATEM_SYN,    deviceType: 'switcher' },
  { port: 9993,  proto: 'tcp', type: 'hyperdeck',   protocol: 'HyperDeck',     deviceType: 'recorder' },
  { port: 9990,  proto: 'tcp', type: 'videohub',    protocol: 'Videohub',      deviceType: 'router' },

  // NDI (mDNS on 5353 handled by mdns module; TCP registration on 5960-5969)
  { port: 5960,  proto: 'tcp', type: 'ndi',         protocol: 'NDI',           deviceType: 'ndi-source' },
  { port: 5961,  proto: 'tcp', type: 'ndi',         protocol: 'NDI',           deviceType: 'ndi-source' },
  { port: 5962,  proto: 'tcp', type: 'ndi',         protocol: 'NDI',           deviceType: 'ndi-source' },
  { port: 5963,  proto: 'tcp', type: 'ndi',         protocol: 'NDI',           deviceType: 'ndi-source' },

  // Dante
  { port: 4440,  proto: 'tcp', type: 'dante',       protocol: 'Dante',         deviceType: 'audio-network' },
  { port: 8800,  proto: 'tcp', type: 'dante',       protocol: 'Dante',         deviceType: 'audio-network' },
  { port: 14336, proto: 'udp', type: 'dante-audio',  protocol: 'Dante Audio',  deviceType: 'audio-network' },

  // Lighting
  { port: 5568,  proto: 'udp', type: 'sacn',        protocol: 'sACN (E1.31)', deviceType: 'lighting' },
  { port: 6454,  proto: 'udp', type: 'artnet',      protocol: 'Art-Net',      deviceType: 'lighting' },

  // Software / control
  { port: 4455,  proto: 'tcp', type: 'obs',         protocol: 'OBS WebSocket', deviceType: 'software' },
  { port: 8888,  proto: 'tcp', type: 'companion',   protocol: 'Companion',     deviceType: 'controller' },
  { port: 1025,  proto: 'tcp', type: 'propresenter', protocol: 'ProPresenter', deviceType: 'presentation' },
  { port: 8088,  proto: 'tcp', type: 'vmix',        protocol: 'vMix',         deviceType: 'software' },
  { port: 5951,  proto: 'tcp', type: 'tricaster',   protocol: 'TriCaster',    deviceType: 'switcher' },

  // Audio mixers (UDP/OSC)
  { port: 10023, proto: 'udp', type: 'mixer-behringer', protocol: 'Behringer X32/M32', packet: OSC_INFO,     deviceType: 'audio-mixer' },
  { port: 51326, proto: 'udp', type: 'mixer-ah',        protocol: 'Allen & Heath',     packet: OSC_SQ_ALIVE, deviceType: 'audio-mixer' },
  { port: 8765,  proto: 'udp', type: 'mixer-yamaha',    protocol: 'Yamaha CL/QL',      packet: OSC_YAMAHA,   deviceType: 'audio-mixer' },

  // Other AV
  { port: 8080,  proto: 'tcp', type: 'birddog',     protocol: 'BirdDog NDI',   deviceType: 'ndi-converter' },
  { port: 7070,  proto: 'tcp', type: 'tally-encoder', protocol: 'Tally Encoder', deviceType: 'encoder' },
  { port: 80,    proto: 'tcp', type: 'http',         protocol: 'HTTP',          deviceType: 'unknown' },

  // Network infrastructure
  { port: 22,    proto: 'tcp', type: 'ssh',          protocol: 'SSH',           deviceType: 'infrastructure' },
  { port: 443,   proto: 'tcp', type: 'https',        protocol: 'HTTPS',         deviceType: 'unknown' },
  { port: 53,    proto: 'tcp', type: 'dns',          protocol: 'DNS',           deviceType: 'infrastructure' },
];

// ─── Probe functions ────────────────────────────────────────────────────────

function tcpProbe(ip, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const done = (success) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(success);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.connect(port, ip);
  });
}

function udpProbe(ip, port, packet, timeout) {
  return new Promise((resolve) => {
    if (!packet) {
      // For sACN/Art-Net/Dante audio — just check if we can send without error
      // These are multicast protocols; a "send OK" is the best we can do per-host
      const socket = dgram.createSocket('udp4');
      const dummy = Buffer.alloc(4);
      let done = false;
      const finish = (ok) => { if (done) return; done = true; try { socket.close(); } catch {} resolve(ok); };
      const timer = setTimeout(() => finish(false), timeout);
      socket.send(dummy, port, ip, (err) => { clearTimeout(timer); finish(!err); });
      socket.on('error', () => { clearTimeout(timer); finish(false); });
      return;
    }

    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); try { socket.close(); } catch {} resolve(ok); };
    const timer = setTimeout(() => finish(false), timeout);
    socket.on('message', () => finish(true));
    socket.on('error', () => finish(false));
    socket.send(packet, 0, packet.length, port, ip, (err) => { if (err) finish(false); });
  });
}

/**
 * Fingerprint a HyperDeck by reading its TCP protocol banner.
 */
function hyperdeckBanner(ip, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    let buf = '';
    const done = (result) => { if (resolved) return; resolved = true; socket.destroy(); resolve(result); };
    socket.setTimeout(timeout);
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.includes('500 connection info')) done({ valid: true });
      else if (buf.length > 200) done({ valid: false });
    });
    socket.on('timeout', () => done({ valid: false }));
    socket.on('error', () => done({ valid: false }));
    socket.on('close', () => done({ valid: false }));
    socket.connect(port, ip);
  });
}

/**
 * Fingerprint Videohub by reading TCP banner for model name.
 */
function videohubBanner(ip, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    let buf = '';
    const done = (result) => { if (resolved) return; resolved = true; socket.destroy(); resolve(result); };
    socket.setTimeout(timeout);
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/Model name:\s*(.+)/i);
      if (m) {
        const model = m[1].trim();
        done({ valid: /videohub|video\s*hub/i.test(model), model });
      } else if (buf.length > 2048) {
        done({ valid: false });
      }
    });
    socket.on('timeout', () => done({ valid: false }));
    socket.on('error', () => done({ valid: false }));
    socket.on('close', () => done({ valid: false }));
    socket.connect(port, ip);
  });
}

function httpGet(url, timeout) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(body.trim()); } catch {}
        resolve({ success: true, statusCode: res.statusCode, body: body.trim(), data });
      });
    });
    req.on('error', () => resolve({ success: false }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false }); });
  });
}

// ─── Main scan function ─────────────────────────────────────────────────────

/**
 * Scan a single host for all AV ports.
 * Returns array of hits with protocol identification.
 */
async function scanHost(ip, timeout = 500) {
  const hits = [];

  // Run all probes concurrently
  const probes = AV_PORTS.map(async (def) => {
    let open = false;

    if (def.proto === 'udp') {
      open = await udpProbe(ip, def.port, def.packet || null, timeout);
    } else {
      open = await tcpProbe(ip, def.port, timeout);
    }

    if (!open) return null;

    const hit = {
      port: def.port,
      protocol: def.protocol,
      deviceType: def.deviceType,
      type: def.type,
      model: null,
      details: {},
    };

    // Fingerprint specific devices to reduce false positives
    if (def.type === 'hyperdeck') {
      const fp = await hyperdeckBanner(ip, def.port, 1500);
      if (!fp.valid) return null;
    }

    if (def.type === 'videohub') {
      const fp = await videohubBanner(ip, def.port, 2500);
      if (!fp.valid) return null;
      if (fp.model) hit.model = fp.model;
    }

    // HTTP fingerprinting for ambiguous ports
    if (def.type === 'http') {
      // Port 80 — fingerprint for Blackmagic, Shelly, or generic HTTP
      const bmd = await httpGet(`http://${ip}:${def.port}/control/api/v1/system/product`, 2000);
      if (bmd.success && bmd.data?.productName) {
        hit.protocol = 'Blackmagic REST';
        hit.deviceType = 'encoder';
        hit.model = bmd.data.productName;
        hit.details.productName = bmd.data.productName;
      } else {
        const shelly = await httpGet(`http://${ip}:${def.port}/rpc/Shelly.GetDeviceInfo`, 2000);
        if (shelly.success && shelly.data?.id) {
          hit.protocol = 'Shelly';
          hit.deviceType = 'smart-plug';
          hit.model = shelly.data.name || shelly.data.id;
        } else {
          // Generic HTTP — still record it
          hit.protocol = 'HTTP';
          hit.deviceType = 'unknown';
        }
      }
    }

    if (def.type === 'birddog') {
      // BirdDog fingerprint — port 8080 is very common
      const resp = await httpGet(`http://${ip}:${def.port}/about`, 2000);
      const body = String(resp?.body || '').toLowerCase();
      if (!body.includes('birddog')) return null;
    }

    if (def.type === 'propresenter') {
      const resp = await httpGet(`http://${ip}:${def.port}/v1/version`, 2000);
      if (!resp.success) {
        const alt = await httpGet(`http://${ip}:${def.port}/v1/status/slide`, 2000);
        if (!alt.success) return null;
      }
    }

    if (def.type === 'companion') {
      const resp = await httpGet(`http://${ip}:${def.port}/`, 2000);
      if (!resp.success) return null;
    }

    if (def.type === 'vmix') {
      const resp = await httpGet(`http://${ip}:${def.port}/api/?Function=GetShortXML`, 2000);
      if (!resp.success || !/<edition>/.test(resp.body || '')) return null;
      const m = (resp.body || '').match(/<edition>([^<]+)<\/edition>/i);
      if (m) hit.details.edition = m[1];
    }

    return hit;
  });

  const results = await Promise.all(probes);
  for (const r of results) {
    if (r) hits.push(r);
  }

  return hits;
}

module.exports = { scanHost, AV_PORTS, tcpProbe, udpProbe };
