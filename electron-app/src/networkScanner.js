/**
 * Network Scanner — Auto-discovers church AV devices on the local subnet.
 * Scans for ATEM, Companion, OBS, HyperDeck, PTZ cameras, mixers, and encoders.
 *
 * Protocol notes:
 *  - ATEM: UDP port 9910 (proprietary Blackmagic protocol)
 *  - Behringer/Midas X32/M32: OSC over UDP port 10023
 *  - Allen & Heath SQ/dLive: OSC over UDP port 51326/51327
 *  - Yamaha CL/QL: OSC over UDP port 8765
 *  - OBS, HyperDeck, Companion, ProPresenter, vMix, TriCaster, BirdDog: TCP/HTTP
 */

const net = require('net');
const os = require('os');
const http = require('http');
const dgram = require('dgram');

// ─── UDP probe packets (pre-computed) ────────────────────────────────────────

// ATEM SYN handshake: flags=SYN(0x02), length=20, session=0x534B
const ATEM_SYN_PACKET = Buffer.from(
  '1014534B0000000000000000000000000000000000', 'hex',
);

// OSC "/info" query (Behringer X32/M32) — 12 bytes
const OSC_INFO_PACKET = Buffer.from('2F696E666F0000002C000000', 'hex');

// OSC "/sq/alive" query (Allen & Heath SQ) — 16 bytes
const OSC_SQ_ALIVE_PACKET = Buffer.from('2F73712F616C6976650000002C000000', 'hex');

// OSC "/ymhss/state" query (Yamaha CL/QL) — 20 bytes
const OSC_YAMAHA_STATE_PACKET = Buffer.from('2F796D6873732F7374617465000000002C000000', 'hex');

// ─── Network helpers ─────────────────────────────────────────────────────────

function listAvailableInterfaces() {
  const ifaces = os.networkInterfaces();
  const out = [];

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push({
          name,
          ip: iface.address,
          netmask: iface.netmask,
        });
      }
    }
  }

  out.sort((a, b) => (a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip)));
  return out;
}

function getLocalSubnet(interfaceName) {
  const interfaces = listAvailableInterfaces();

  const candidate = interfaceName
    ? interfaces.find((i) => i.name === interfaceName)
    : interfaces.find(() => true);

  if (candidate) {
    const parts = candidate.ip.split('.');
    return {
      subnet: `${parts[0]}.${parts[1]}.${parts[2]}`,
      localIp: candidate.ip,
      interfaceName: candidate.name,
    };
  }

  return { subnet: '192.168.1', localIp: '127.0.0.1', interfaceName: null };
}

function tryTcpConnect(ip, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const done = (success) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(success);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.connect(port, ip);
  });
}

/**
 * Send a UDP packet and wait for ANY response.
 * Returns true if a response is received within timeoutMs, false otherwise.
 */
function tryUdpProbe(ip, port, packet, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (success) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve(success);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('message', () => finish(true));
    socket.on('error', () => finish(false));
    socket.send(packet, 0, packet.length, port, ip, (err) => {
      if (err) finish(false);
    });
  });
}

function tryHttpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const trimmed = body.trim();
        const result = { success: true, statusCode: res.statusCode, body: trimmed, data: null };

        if (!trimmed) return resolve(result);

        try {
          result.data = JSON.parse(trimmed);
        } catch {
          result.data = null;
        }

        resolve(result);
      });
    });
    req.on('error', () => resolve({ success: false, body: '', data: null, statusCode: null }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, body: '', data: null, statusCode: null }); });
  });
}

// ─── Device fingerprint helpers ──────────────────────────────────────────────

function isLikelyResolume(data) {
  return data && typeof data === 'object' && typeof (data.name || data.title || data.productName || data.version) === 'string';
}

function isLikelyVmixXml(xml) {
  return typeof xml === 'string' && /<edition>/.test(xml);
}

/**
 * Check whether an HTTP response looks like it came from a BirdDog device.
 * Requires "birddog" in the body OR BirdDog-specific JSON keys.
 * A generic 200 from a random web server on :8080 will NOT match.
 */
function isLikelyBirdDog(resp) {
  if (!resp || !resp.success) return false;

  const data = resp.data && typeof resp.data === 'object' ? resp.data : null;
  if (data) {
    const blob = JSON.stringify(data).toLowerCase();
    if (blob.includes('birddog')) return true;

    // BirdDog decode-status has keys like Ch1Source, DecodeSource, DecodeStatus
    const keys = Object.keys(data);
    if (keys.some((k) => /^ch\d+source$/i.test(k) || /^decode/i.test(k))) return true;
  }

  const body = String(resp.body || '').toLowerCase();
  return body.includes('birddog');
}

function extractBirdDogSource(resp) {
  const data = resp && typeof resp.data === 'object' ? resp.data : null;
  const keys = ['source', 'Source', 'sourceName', 'SourceName', 'Ch1Source', 'ch1_source'];
  if (data) {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  const body = String(resp?.body || '');
  const m = body.match(/\b(?:sourceName|SourceName|source|Ch1Source)\b\s*[:=]\s*([^\r\n&<]+)/i);
  return m ? m[1].trim() : '';
}

// ─── Probe dispatcher ────────────────────────────────────────────────────────

/**
 * Choose the correct network probe for a device type.
 * UDP-based devices (ATEM, OSC mixers) get a proper UDP handshake/query;
 * everything else uses a fast TCP connect probe.
 */
function probeDevice(ip, port, type, timeoutMs) {
  switch (type) {
    case 'atem':
      return tryUdpProbe(ip, port, ATEM_SYN_PACKET, timeoutMs);
    case 'mixer-behringer':
      return tryUdpProbe(ip, port, OSC_INFO_PACKET, timeoutMs);
    case 'mixer-allenheath':
      return tryUdpProbe(ip, port, OSC_SQ_ALIVE_PACKET, timeoutMs);
    case 'mixer-yamaha':
      return tryUdpProbe(ip, port, OSC_YAMAHA_STATE_PACKET, timeoutMs);
    default:
      return tryTcpConnect(ip, port, timeoutMs);
  }
}

/**
 * Discover AV devices on the local network.
 * @param {function} onProgress - callback(percent, message)
 * @returns {Promise<Object>} discovered devices
 */
async function discoverDevices(onProgress = () => {}, options = {}) {
  const results = {
    atem: [], companion: [], obs: [], hyperdeck: [], propresenter: [], nmos: [],
    resolume: [], vmix: [], tricaster: [], birddog: [], mixers: [], encoders: [],
  };
  const { subnet, localIp, interfaceName } = getLocalSubnet(options.interfaceName);

  const ifaceLabel = interfaceName ? ` on ${interfaceName}` : '';
  onProgress(0, `Scanning ${subnet}.x for AV devices${ifaceLabel}...`);

  // Build IP list (1-254)
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${subnet}.${i}`);

  // Also check localhost for common services (important for local mock/testing setups)
  const localhostChecks = [
    { type: 'atem', ip: '127.0.0.1', port: 9910 },
    { type: 'obs', ip: '127.0.0.1', port: 4455 },
    { type: 'companion', ip: '127.0.0.1', port: 8888 },
    { type: 'hyperdeck', ip: '127.0.0.1', port: 9993 },
    { type: 'propresenter', ip: '127.0.0.1', port: 1025 },
    { type: 'resolume', ip: '127.0.0.1', port: 8080 },
    { type: 'vmix', ip: '127.0.0.1', port: 8088 },
    { type: 'tricaster-control', ip: '127.0.0.1', port: 5951 },
    { type: 'tricaster-http', ip: '127.0.0.1', port: 5952 },
    { type: 'birddog', ip: '127.0.0.1', port: 8080 },
    { type: 'mixer-behringer', ip: '127.0.0.1', port: 10023 },
    { type: 'mixer-allenheath', ip: '127.0.0.1', port: 51326 },
    { type: 'mixer-yamaha', ip: '127.0.0.1', port: 8765 },
    { type: 'tally-encoder', ip: '127.0.0.1', port: 7070 },
  ];

  // Check localhost first
  onProgress(2, 'Checking localhost for common AV services...');
  for (const check of localhostChecks) {
    const open = await probeDevice(check.ip, check.port, check.type, 500);
    if (open) {
      if (check.type === 'atem') {
        results.atem.push({ ip: '127.0.0.1', name: 'ATEM Switcher', model: 'Unknown' });
        onProgress(3, 'Found ATEM on localhost ✅');
      } else if (check.type === 'obs') {
        results.obs.push({ ip: '127.0.0.1', port: 4455 });
        onProgress(3, 'Found OBS on localhost ✅');
      } else if (check.type === 'companion') {
        // Companion 4.x: simple HTTP probe — web UI always responds at root
        const resp = await tryHttpGet(`http://127.0.0.1:${check.port}/`, 2000);
        if (resp.success) {
          results.companion.push({ ip: '127.0.0.1', port: check.port, connections: 0 });
          onProgress(4, 'Found Companion on localhost ✅');
        }
      } else if (check.type === 'propresenter') {
        const resp = await tryHttpGet(`http://127.0.0.1:${check.port}/v1/version`, 2000);
        if (resp.success) {
          results.propresenter.push({ ip: '127.0.0.1', port: check.port });
          onProgress(4, 'Found ProPresenter on localhost ✅');
        }
      } else if (check.type === 'vmix') {
        const resp = await tryHttpGet(`http://127.0.0.1:${check.port}/api/?Function=GetShortXML`, 2000);
        const edition = isLikelyVmixXml(resp.body) ? (resp.body.match(/<edition>([^<]+)<\/edition>/i)?.[1] || 'vMix') : null;
        if (edition) {
          results.vmix.push({ ip: '127.0.0.1', port: check.port, edition });
          onProgress(6, `Found vMix ${edition} on localhost ✅`);
        }
      } else if (check.type === 'resolume') {
        const resp = await tryHttpGet(`http://127.0.0.1:${check.port}/api/v1/product`, 2000);
        if (isLikelyResolume(resp.data)) {
          const version = resp.data?.name || 'Resolume Arena';
          results.resolume.push({ ip: '127.0.0.1', port: check.port, version });
          onProgress(5, `Found ${version} on localhost ✅`);
        }
      } else if (check.type === 'tricaster-control' || check.type === 'tricaster-http') {
        const resp = await tryHttpGet(`http://127.0.0.1:${check.port}/v1/version`, 2000);
        const raw = String(resp.body || '');
        const version = (resp.data && (resp.data.version || resp.data.softwareVersion))
          || (raw.match(/<version[^>]*>([^<]+)<\/version>/i)?.[1] || '');
        const existing = results.tricaster.find((d) => d.ip === '127.0.0.1');
        if (existing) {
          if (!existing.version && version) existing.version = version;
          if (check.type === 'tricaster-http') existing.port = check.port;
        } else {
          const entry = {
            ip: '127.0.0.1',
            port: check.port,
            version: version || null,
            mode: resp.success ? 'http' : 'control',
          };
          results.tricaster.push(entry);
        }
        onProgress(6, `Found TriCaster endpoint on localhost:${check.port} ✅`);
      } else if (check.type === 'birddog') {
        const decodeResp = await tryHttpGet(`http://127.0.0.1:${check.port}/decodestatus?ChNum=1`, 2000);
        const aboutResp = !isLikelyBirdDog(decodeResp) ? await tryHttpGet(`http://127.0.0.1:${check.port}/about`, 2000) : null;
        if (isLikelyBirdDog(decodeResp) || isLikelyBirdDog(aboutResp)) {
          const source = extractBirdDogSource(isLikelyBirdDog(decodeResp) ? decodeResp : aboutResp);
          results.birddog.push({ ip: '127.0.0.1', port: check.port, source: source || null });
          onProgress(6, 'Found BirdDog endpoint on localhost ✅');
        }
      } else if (check.type === 'hyperdeck') {
        results.hyperdeck.push({ ip: '127.0.0.1' });
        onProgress(5, 'Found HyperDeck on localhost ✅');
      } else if (check.type === 'mixer-behringer') {
        results.mixers.push({ ip: '127.0.0.1', port: check.port, type: 'behringer/midas (X32/M32)' });
        onProgress(5, 'Found possible Behringer/Midas console on localhost ✅');
      } else if (check.type === 'mixer-allenheath') {
        results.mixers.push({ ip: '127.0.0.1', port: check.port, type: 'allenheath (SQ/dLive)' });
        onProgress(5, 'Found possible Allen & Heath console on localhost ✅');
      } else if (check.type === 'mixer-yamaha') {
        results.mixers.push({ ip: '127.0.0.1', port: check.port, type: 'yamaha (CL/QL)' });
        onProgress(5, 'Found possible Yamaha console on localhost ✅');
      } else if (check.type === 'tally-encoder') {
        const resp = await tryHttpGet(`http://127.0.0.1:${check.port}/health`, 2000);
        if (resp.success) {
          results.encoders.push({ ip: '127.0.0.1', port: check.port, type: 'tally-encoder', label: 'Tally Encoder' });
          onProgress(5, 'Found Tally Encoder on localhost ✅');
        }
      }
    }
  }

  // Scan subnet in batches of 50 to avoid overwhelming the network
  const BATCH_SIZE = 50;
  const ports = [
    { port: 9910,  type: 'atem' },                // UDP — Blackmagic ATEM protocol
    { port: 8888,  type: 'companion' },            // TCP — Bitfocus Companion HTTP
    { port: 4455,  type: 'obs' },                  // TCP — OBS WebSocket
    { port: 9993,  type: 'hyperdeck' },            // TCP — HyperDeck telnet
    { port: 1025,  type: 'propresenter' },         // TCP — ProPresenter HTTP
    { port: 8080,  type: 'resolume' },             // TCP — Resolume Arena REST
    { port: 8080,  type: 'birddog' },              // TCP — BirdDog HTTP
    { port: 8088,  type: 'vmix' },                 // TCP — vMix HTTP API
    { port: 5951,  type: 'tricaster-control' },    // TCP — TriCaster control
    { port: 5952,  type: 'tricaster-http' },       // TCP — TriCaster HTTP
    { port: 10023, type: 'mixer-behringer' },      // UDP — Behringer X32 / Midas M32 OSC
    { port: 51326, type: 'mixer-allenheath' },     // UDP — Allen & Heath SQ OSC
    { port: 8765,  type: 'mixer-yamaha' },         // UDP — Yamaha CL/QL OSC
    { port: 7070,  type: 'tally-encoder' },        // TCP — Tally Encoder HTTP
  ];

  let scanned = 0;
  const totalScans = ips.length;

  for (let batchStart = 0; batchStart < ips.length; batchStart += BATCH_SIZE) {
    const batch = ips.slice(batchStart, batchStart + BATCH_SIZE);
    const promises = [];

    for (const ip of batch) {
      // Skip our own IP for non-localhost services
      for (const { port, type } of ports) {
        // Skip if already found on localhost
        if (ip === '127.0.0.1') continue;
        if (ip === localIp && (type === 'obs' || type === 'companion')) continue;

        promises.push(
          probeDevice(ip, port, type, 500).then(async (open) => {
            if (!open) return;

            if (type === 'atem' && !results.atem.find((d) => d.ip === ip)) {
              results.atem.push({ ip, name: 'ATEM Switcher', model: 'Unknown' });
              onProgress(null, `Found ATEM at ${ip} ✅`);
            } else if (type === 'companion' && !results.companion.find((d) => d.ip === ip)) {
              // Companion 4.x: simple HTTP probe — web UI always responds at root
              const resp = await tryHttpGet(`http://${ip}:${port}/`, 2000);
              if (resp.success) {
                results.companion.push({ ip, port, connections: 0 });
                onProgress(null, `Found Companion at ${ip} ✅`);
              }
            } else if (type === 'obs' && !results.obs.find((d) => d.ip === ip)) {
              results.obs.push({ ip, port: 4455 });
              onProgress(null, `Found OBS at ${ip} ✅`);
            } else if (type === 'hyperdeck' && !results.hyperdeck.find((d) => d.ip === ip)) {
              results.hyperdeck.push({ ip });
              onProgress(null, `Found HyperDeck at ${ip} ✅`);
            } else if (type === 'propresenter' && !results.propresenter.find((d) => d.ip === ip)) {
              const vResp = await tryHttpGet(`http://${ip}:${port}/v1/version`, 2000);
              if (vResp.success && vResp.data && vResp.data.version) {
                results.propresenter.push({ ip, port });
                onProgress(null, `Found ProPresenter at ${ip} ✅`);
              }
            } else if (type === 'vmix' && !results.vmix.find((d) => d.ip === ip)) {
              const vResp = await tryHttpGet(`http://${ip}:${port}/api/?Function=GetShortXML`, 2000);
              const edition = isLikelyVmixXml(vResp.body) ? (vResp.body.match(/<edition>([^<]+)<\/edition>/i)?.[1] || 'vMix') : null;
              if (edition) {
                results.vmix.push({ ip, port, edition });
                onProgress(null, `Found vMix ${edition} at ${ip} ✅`);
              }
            } else if (type === 'resolume' && !results.resolume.find((d) => d.ip === ip)) {
              const rResp = await tryHttpGet(`http://${ip}:${port}/api/v1/product`, 2000);
              if (isLikelyResolume(rResp.data)) {
                const version = rResp.data?.name || 'Resolume Arena';
                results.resolume.push({ ip, port, version });
                onProgress(null, `Found ${version} at ${ip} ✅`);
              }
            } else if (type === 'birddog' && !results.birddog.find((d) => d.ip === ip)) {
              // BirdDog: require positive fingerprint — port 8080 alone is too common
              const decodeResp = await tryHttpGet(`http://${ip}:${port}/decodestatus?ChNum=1`, 2000);
              const aboutResp = !isLikelyBirdDog(decodeResp)
                ? await tryHttpGet(`http://${ip}:${port}/about`, 2000)
                : null;
              const versionResp = (!isLikelyBirdDog(decodeResp) && !isLikelyBirdDog(aboutResp))
                ? await tryHttpGet(`http://${ip}:${port}/version`, 2000)
                : null;
              const listResp = (!isLikelyBirdDog(decodeResp) && !isLikelyBirdDog(aboutResp) && !isLikelyBirdDog(versionResp))
                ? await tryHttpGet(`http://${ip}:${port}/List`, 2000)
                : null;
              const matched = isLikelyBirdDog(decodeResp)
                || isLikelyBirdDog(aboutResp)
                || isLikelyBirdDog(versionResp)
                || isLikelyBirdDog(listResp);
              if (matched) {
                const bestResp = isLikelyBirdDog(decodeResp) ? decodeResp : (aboutResp || versionResp || listResp);
                const source = extractBirdDogSource(bestResp);
                results.birddog.push({ ip, port, source: source || null });
                onProgress(null, `Found BirdDog endpoint at ${ip}:${port} ✅`);
              }
            } else if ((type === 'tricaster-control' || type === 'tricaster-http') && !results.tricaster.find((d) => d.ip === ip && d.port === port)) {
              const vResp = await tryHttpGet(`http://${ip}:${port}/v1/version`, 2000);
              const raw = String(vResp.body || '');
              const version = (vResp.data && (vResp.data.version || vResp.data.softwareVersion))
                || (raw.match(/<version[^>]*>([^<]+)<\/version>/i)?.[1] || null);

              const existing = results.tricaster.find((d) => d.ip === ip);
              if (existing) {
                if (!existing.version && version) existing.version = version;
                if (type === 'tricaster-http') existing.port = port;
              } else {
                results.tricaster.push({
                  ip,
                  port,
                  version: version || null,
                  mode: vResp.success ? 'http' : 'control',
                });
              }
              onProgress(null, `Found TriCaster endpoint at ${ip}:${port} ✅`);
            } else if (type === 'mixer-behringer' && !results.mixers.find((d) => d.ip === ip && d.port === port)) {
              results.mixers.push({ ip, port, type: 'behringer/midas (X32/M32)' });
              onProgress(null, `Found possible Behringer/Midas console at ${ip}:${port} ✅`);
            } else if (type === 'mixer-allenheath' && !results.mixers.find((d) => d.ip === ip && d.port === port)) {
              results.mixers.push({ ip, port, type: 'allenheath (SQ/dLive)' });
              onProgress(null, `Found possible Allen & Heath console at ${ip}:${port} ✅`);
            } else if (type === 'mixer-yamaha' && !results.mixers.find((d) => d.ip === ip && d.port === port)) {
              results.mixers.push({ ip, port, type: 'yamaha (CL/QL)' });
              onProgress(null, `Found possible Yamaha console at ${ip}:${port} ✅`);
            } else if (type === 'tally-encoder' && !results.encoders.find((d) => d.ip === ip)) {
              const eResp = await tryHttpGet(`http://${ip}:${port}/health`, 2000);
              if (eResp.success) {
                results.encoders.push({ ip, port, type: 'tally-encoder', label: 'Tally Encoder' });
                onProgress(null, `Found Tally Encoder at ${ip}:${port} ✅`);
              }
            }
          })
        );
      }
    }

    await Promise.all(promises);
    scanned += batch.length;
    const pct = Math.round(5 + (scanned / totalScans) * 95);
    onProgress(pct, `Scanned ${scanned}/${totalScans} IPs...`);
  }

  onProgress(100, `Scan complete: ${results.atem.length + results.companion.length + results.obs.length + results.hyperdeck.length + results.propresenter.length + results.resolume.length + results.vmix.length + results.tricaster.length + results.birddog.length + results.encoders.length} devices found`);
  return results;
}

module.exports = {
  discoverDevices,
  tryTcpConnect,
  tryUdpProbe,
  tryHttpGet,
  getLocalSubnet,
  listAvailableInterfaces,
  // Expose packets for equipment-tester
  ATEM_SYN_PACKET,
  OSC_INFO_PACKET,
  OSC_SQ_ALIVE_PACKET,
  OSC_YAMAHA_STATE_PACKET,
};
