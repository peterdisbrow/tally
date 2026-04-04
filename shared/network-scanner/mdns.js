/**
 * mDNS/Bonjour service discovery.
 * Browses for AV-relevant services: NDI, Dante, AirPlay, HTTP, etc.
 */

let mDNS;
try {
  mDNS = require('multicast-dns');
} catch {
  mDNS = null;
}

// Service types we care about for church AV
const SERVICE_QUERIES = [
  { name: '_ndi._tcp.local', label: 'NDI' },
  { name: '_http._tcp.local', label: 'HTTP' },
  { name: '_airplay._tcp.local', label: 'AirPlay' },
  { name: '_raop._tcp.local', label: 'AirPlay Audio' },
  { name: '_daap._tcp.local', label: 'DAAP' },
  { name: '_sub._dante._udp.local', label: 'Dante' },
  { name: '_dante._udp.local', label: 'Dante' },
  { name: '_osc._udp.local', label: 'OSC' },
  { name: '_obs-websocket._tcp.local', label: 'OBS WebSocket' },
  { name: '_companion._tcp.local', label: 'Companion' },
  { name: '_sacn._udp.local', label: 'sACN' },
  { name: '_artnet._udp.local', label: 'Art-Net' },
  { name: '_hap._tcp.local', label: 'HomeKit' },
  { name: '_googlecast._tcp.local', label: 'Chromecast' },
  { name: '_smb._tcp.local', label: 'SMB' },
  { name: '_pdl-datastream._tcp.local', label: 'Printer' },
  { name: '_ipp._tcp.local', label: 'Printer (IPP)' },
  { name: '_ssh._tcp.local', label: 'SSH' },
];

/**
 * Parse an mDNS response packet and extract discovered services.
 */
function parseResponse(packet) {
  const services = [];
  const allRecords = [
    ...(packet.answers || []),
    ...(packet.additionals || []),
  ];

  // Collect A/AAAA records for IP lookup
  const ipMap = {};
  for (const r of allRecords) {
    if (r.type === 'A' && r.data) {
      ipMap[r.name] = r.data;
    }
  }

  // Collect SRV records for port/host info
  const srvMap = {};
  for (const r of allRecords) {
    if (r.type === 'SRV' && r.data) {
      srvMap[r.name] = {
        port: r.data.port,
        target: r.data.target,
      };
    }
  }

  // Collect TXT records
  const txtMap = {};
  for (const r of allRecords) {
    if (r.type === 'TXT' && r.data) {
      const obj = {};
      const buffers = Array.isArray(r.data) ? r.data : [r.data];
      for (const buf of buffers) {
        const str = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
        const eq = str.indexOf('=');
        if (eq > 0) {
          obj[str.substring(0, eq)] = str.substring(eq + 1);
        }
      }
      txtMap[r.name] = obj;
    }
  }

  // Extract PTR records (service instances)
  for (const r of allRecords) {
    if (r.type === 'PTR' && r.data) {
      const instanceName = r.data;
      const serviceName = r.name;
      const srv = srvMap[instanceName];
      const txt = txtMap[instanceName] || {};

      let ip = null;
      if (srv && srv.target) {
        ip = ipMap[srv.target] || null;
      }
      // Also check if instanceName resolves directly
      if (!ip) {
        for (const [host, addr] of Object.entries(ipMap)) {
          if (instanceName.includes(host.replace('.local', ''))) {
            ip = addr;
            break;
          }
        }
      }

      services.push({
        service: serviceName,
        instance: instanceName,
        hostname: srv?.target || null,
        port: srv?.port || null,
        ip,
        txt,
      });
    }
  }

  // Also handle direct SRV/A responses without PTR
  for (const r of allRecords) {
    if (r.type === 'SRV' && r.data) {
      const ip = ipMap[r.data.target] || null;
      if (ip && !services.find(s => s.ip === ip && s.port === r.data.port)) {
        services.push({
          service: r.name,
          instance: r.name,
          hostname: r.data.target,
          port: r.data.port,
          ip,
          txt: txtMap[r.name] || {},
        });
      }
    }
  }

  return services;
}

/**
 * Browse mDNS for AV-related services.
 * Returns after `timeout` ms with all discovered services.
 */
function browse(options = {}) {
  return new Promise((resolve) => {
    if (!mDNS) {
      return resolve([]);
    }

    const timeout = options.timeout || 4000;
    const discovered = [];
    const seenKeys = new Set();

    let mdnsInstance;
    try {
      mdnsInstance = mDNS();
    } catch {
      return resolve([]);
    }

    mdnsInstance.on('response', (packet) => {
      const services = parseResponse(packet);
      for (const svc of services) {
        const key = `${svc.ip}:${svc.port}:${svc.service}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          discovered.push(svc);
        }
      }
    });

    mdnsInstance.on('error', () => {
      // Ignore mDNS errors — we'll just return what we found
    });

    // Send queries for all service types
    const questions = SERVICE_QUERIES.map(q => ({ name: q.name, type: 'PTR' }));
    try {
      mdnsInstance.query({ questions });
    } catch {
      // ignore
    }

    // Send a second round of queries after 1s to catch late responders
    const secondQuery = setTimeout(() => {
      try { mdnsInstance.query({ questions }); } catch { /* ignore */ }
    }, 1500);

    setTimeout(() => {
      clearTimeout(secondQuery);
      try { mdnsInstance.destroy(); } catch { /* ignore */ }
      resolve(discovered);
    }, timeout);
  });
}

module.exports = { browse, parseResponse, SERVICE_QUERIES };
