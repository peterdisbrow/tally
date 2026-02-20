/**
 * Network Scanner — Auto-discovers church AV devices on the local subnet.
 * Scans for ATEM, Companion, OBS, HyperDeck, and PTZ cameras.
 */

const net = require('net');
const os = require('os');
const http = require('http');

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

function companionConnectionCount(resp) {
  if (!resp || !resp.success || !resp.data) return null;
  if (Array.isArray(resp.data)) return resp.data.length;
  if (Array.isArray(resp.data.connections)) return resp.data.connections.length;
  return null;
}

function isLikelyResolume(data) {
  return data && typeof data === 'object' && typeof (data.name || data.title || data.productName || data.version) === 'string';
}

function isLikelyVmixXml(xml) {
  return typeof xml === 'string' && /<edition>/.test(xml);
}

/**
 * Discover AV devices on the local network.
 * @param {function} onProgress - callback(percent, message)
 * @returns {Promise<Object>} discovered devices
 */
async function discoverDevices(onProgress = () => {}, options = {}) {
  const results = { atem: [], companion: [], obs: [], hyperdeck: [], propresenter: [], nmos: [], resolume: [], vmix: [], mixers: [] };
  const { subnet, localIp, interfaceName } = getLocalSubnet(options.interfaceName);

  const ifaceLabel = interfaceName ? ` on ${interfaceName}` : '';
  onProgress(0, `Scanning ${subnet}.x for AV devices${ifaceLabel}...`);

  // Build IP list (1-254)
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${subnet}.${i}`);

  // Also check localhost for OBS, Companion, and ProPresenter
  const localhostChecks = [
    { type: 'obs', ip: '127.0.0.1', port: 4455 },
    { type: 'companion', ip: '127.0.0.1', port: 8888 },
    { type: 'propresenter', ip: '127.0.0.1', port: 1025 },
    { type: 'resolume', ip: '127.0.0.1', port: 8080 },
    { type: 'vmix', ip: '127.0.0.1', port: 8088 },
  ];

  // Check localhost first
  onProgress(2, 'Checking localhost for OBS, Companion, and ProPresenter...');
  for (const check of localhostChecks) {
    const open = await tryTcpConnect(check.ip, check.port, 500);
    if (open) {
      if (check.type === 'obs') {
        results.obs.push({ ip: '127.0.0.1', port: 4455 });
        onProgress(3, 'Found OBS on localhost ✅');
      } else if (check.type === 'companion') {
        const resp = await tryHttpGet(`http://127.0.0.1:${check.port}/api/connections`, 2000);
        const connCount = companionConnectionCount(resp);
        if (connCount !== null) {
          results.companion.push({ ip: '127.0.0.1', port: check.port, connections: connCount });
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
      }
    }
  }

  // Scan subnet in batches of 50 to avoid overwhelming the network
  const BATCH_SIZE = 50;
  const ports = [
    { port: 9910,  type: 'atem' },
    { port: 8888,  type: 'companion' },
    { port: 4455,  type: 'obs' },
    { port: 9993,  type: 'hyperdeck' },
    { port: 1025,  type: 'propresenter' },
    { port: 8080,  type: 'resolume' },
    { port: 8088,  type: 'vmix' },
    // Audio consoles — TCP probe on OSC/control ports
    { port: 10023, type: 'mixer-behringer' },  // Behringer X32 / Midas M32
    { port: 51326, type: 'mixer-allenheath' }, // Allen & Heath SQ
    { port: 8765,  type: 'mixer-yamaha' },     // Yamaha CL/QL
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
          tryTcpConnect(ip, port, 300).then(async (open) => {
            if (!open) return;

            if (type === 'atem' && !results.atem.find((d) => d.ip === ip)) {
              results.atem.push({ ip, name: 'ATEM Switcher', model: 'Unknown' });
              onProgress(null, `Found ATEM at ${ip} ✅`);
            } else if (type === 'companion' && !results.companion.find((d) => d.ip === ip)) {
              const resp = await tryHttpGet(`http://${ip}:${port}/api/connections`, 2000);
              const connCount = companionConnectionCount(resp);
              if (connCount !== null) {
                results.companion.push({ ip, port, connections: connCount });
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
            } else if (type === 'mixer-behringer' && !results.mixers.find((d) => d.ip === ip && d.port === port)) {
              results.mixers.push({ ip, port, type: 'behringer/midas (X32/M32)' });
              onProgress(null, `Found possible Behringer/Midas console at ${ip}:${port} ✅`);
            } else if (type === 'mixer-allenheath' && !results.mixers.find((d) => d.ip === ip && d.port === port)) {
              results.mixers.push({ ip, port, type: 'allenheath (SQ/dLive)' });
              onProgress(null, `Found possible Allen & Heath console at ${ip}:${port} ✅`);
            } else if (type === 'mixer-yamaha' && !results.mixers.find((d) => d.ip === ip && d.port === port)) {
              results.mixers.push({ ip, port, type: 'yamaha (CL/QL)' });
              onProgress(null, `Found possible Yamaha console at ${ip}:${port} ✅`);
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

  onProgress(100, `Scan complete: ${results.atem.length + results.companion.length + results.obs.length + results.hyperdeck.length + results.propresenter.length + results.resolume.length + results.vmix.length} devices found`);
  return results;
}

module.exports = { discoverDevices, tryTcpConnect, tryHttpGet, getLocalSubnet, listAvailableInterfaces };
