/**
 * @tallyconnect/network-scanner
 *
 * Reusable AV network discovery engine. Finds all devices on local subnets
 * via ARP table + mDNS/Bonjour service browsing + protocol-specific port
 * probes for church AV gear (ATEM, Dante, NDI, sACN, Art-Net, HyperDeck,
 * OBS, ProPresenter, etc.).
 *
 * Designed to run in Electron main process (Node.js). Decoupled from any
 * UI framework so both TallyConnect and Site Ops can consume it.
 */

const arp = require('./arp');
const mdns = require('./mdns');
const portScanner = require('./port-scanner');
const classifier = require('./classifier');
const os = require('os');

// ─── Network helpers ────────────────────────────────────────────────────────

function listInterfaces() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push({ name, ip: iface.address, netmask: iface.netmask, mac: iface.mac });
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip));
  return out;
}

function netmaskToPrefix(netmask) {
  if (!netmask) return 24;
  let bits = 0;
  for (const p of netmask.split('.').map(Number)) {
    let n = p;
    while (n) { bits += (n & 1); n >>= 1; }
  }
  return bits;
}

function expandSubnet(ip, prefixLen) {
  const clamped = Math.max(16, Math.min(30, prefixLen));
  const parts = ip.split('.').map(Number);
  const ipNum = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const mask = ~((1 << (32 - clamped)) - 1) >>> 0;
  const network = (ipNum & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = [];
  for (let h = network + 1; h < broadcast; h++) {
    hosts.push([(h >>> 24) & 0xFF, (h >>> 16) & 0xFF, (h >>> 8) & 0xFF, h & 0xFF].join('.'));
  }
  return hosts;
}

// ─── Main scanner class ─────────────────────────────────────────────────────

class NetworkScanner {
  constructor(options = {}) {
    this.onProgress = options.onProgress || (() => {});
    this.onDeviceFound = options.onDeviceFound || (() => {});
    this.timeout = options.timeout || 500;
    this.batchSize = options.batchSize || 60;
    this._aborted = false;
    this._devices = new Map(); // ip -> device object
  }

  abort() {
    this._aborted = true;
  }

  _mergeDevice(ip, fields) {
    const existing = this._devices.get(ip) || {
      ip,
      mac: null,
      hostname: null,
      vendor: null,
      deviceType: 'unknown',
      protocols: [],
      services: [],
      openPorts: [],
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    if (fields.mac && !existing.mac) existing.mac = fields.mac;
    if (fields.hostname && !existing.hostname) existing.hostname = fields.hostname;
    if (fields.vendor && !existing.vendor) existing.vendor = fields.vendor;
    if (fields.deviceType && fields.deviceType !== 'unknown') existing.deviceType = fields.deviceType;
    if (fields.protocols) {
      for (const p of fields.protocols) {
        if (!existing.protocols.includes(p)) existing.protocols.push(p);
      }
    }
    if (fields.services) {
      for (const s of fields.services) {
        if (!existing.services.find(e => e.name === s.name && e.port === s.port)) {
          existing.services.push(s);
        }
      }
    }
    if (fields.openPorts) {
      for (const p of fields.openPorts) {
        if (!existing.openPorts.includes(p)) existing.openPorts.push(p);
      }
    }
    if (fields.model) existing.model = fields.model;
    if (fields.details) existing.details = { ...(existing.details || {}), ...fields.details };
    existing.lastSeen = new Date().toISOString();

    this._devices.set(ip, existing);
    this.onDeviceFound(existing);
    return existing;
  }

  /**
   * Run a full network scan. Returns an array of discovered devices.
   */
  async scan(options = {}) {
    this._aborted = false;
    this._devices.clear();

    const ifaces = listInterfaces();
    const localIps = new Set(ifaces.map(i => i.ip));
    const startTime = Date.now();

    // Phase 1: ARP discovery (fast — reads OS ARP cache + pings subnet)
    this.onProgress({ phase: 'arp', percent: 0, message: 'Discovering devices via ARP...' });
    let arpEntries = [];
    try {
      arpEntries = await arp.discover(options.interfaceName);
      for (const entry of arpEntries) {
        if (localIps.has(entry.ip)) continue;
        this._mergeDevice(entry.ip, {
          mac: entry.mac,
          hostname: entry.hostname || null,
          vendor: entry.vendor || null,
        });
      }
    } catch (e) {
      // ARP may fail on some systems — continue with port scanning
    }
    if (this._aborted) return this._results();
    this.onProgress({ phase: 'arp', percent: 15, message: `ARP: found ${arpEntries.length} hosts` });

    // Phase 2: mDNS/Bonjour service discovery
    this.onProgress({ phase: 'mdns', percent: 15, message: 'Browsing mDNS/Bonjour services...' });
    let mdnsServices = [];
    try {
      mdnsServices = await mdns.browse({ timeout: options.mdnsTimeout || 4000 });
      for (const svc of mdnsServices) {
        if (!svc.ip || localIps.has(svc.ip)) continue;
        const classified = classifier.classifyMdnsService(svc);
        this._mergeDevice(svc.ip, {
          hostname: svc.hostname || null,
          protocols: classified.protocols,
          services: [{ name: svc.service, port: svc.port, txt: svc.txt || {} }],
          deviceType: classified.deviceType,
        });
      }
    } catch (e) {
      // mDNS may not be available
    }
    if (this._aborted) return this._results();
    this.onProgress({ phase: 'mdns', percent: 30, message: `mDNS: found ${mdnsServices.length} services` });

    // Phase 3: Protocol-specific port scanning
    this.onProgress({ phase: 'ports', percent: 30, message: 'Scanning AV protocol ports...' });

    // Build target IPs: combine ARP-discovered IPs with full subnet expansion
    const targetIfaces = options.interfaceName
      ? ifaces.filter(i => i.name === options.interfaceName)
      : ifaces;

    const ipSet = new Set();
    for (const iface of targetIfaces) {
      const hosts = expandSubnet(iface.ip, netmaskToPrefix(iface.netmask));
      for (const h of hosts) ipSet.add(h);
    }
    // Add extra subnets/IPs
    if (Array.isArray(options.extraSubnets)) {
      for (const s of options.extraSubnets) {
        const trimmed = String(s).trim().replace(/\.+$/, '');
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
          for (let i = 1; i <= 254; i++) ipSet.add(`${trimmed}.${i}`);
        }
      }
    }
    if (Array.isArray(options.extraIps)) {
      for (const ip of options.extraIps) {
        const trimmed = String(ip).trim();
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) ipSet.add(trimmed);
      }
    }

    const allIps = Array.from(ipSet).filter(ip => !localIps.has(ip));
    const total = allIps.length;
    let scanned = 0;

    for (let i = 0; i < allIps.length && !this._aborted; i += this.batchSize) {
      const batch = allIps.slice(i, i + this.batchSize);
      const promises = batch.map(ip => this._scanHost(ip));
      await Promise.all(promises);
      scanned += batch.length;
      const pct = 30 + Math.round((scanned / total) * 65);
      this.onProgress({
        phase: 'ports',
        percent: pct,
        message: `Port scan: ${scanned}/${total} hosts (${this._devices.size} devices found)`,
      });
    }

    // Phase 4: Classify all devices
    this.onProgress({ phase: 'classify', percent: 95, message: 'Classifying devices...' });
    for (const [ip, device] of this._devices) {
      const classified = classifier.classify(device);
      Object.assign(device, classified);
      this._devices.set(ip, device);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.onProgress({
      phase: 'done',
      percent: 100,
      message: `Scan complete: ${this._devices.size} devices found in ${elapsed}s`,
    });

    return this._results();
  }

  async _scanHost(ip) {
    const hits = await portScanner.scanHost(ip, this.timeout);
    if (hits.length === 0) return;

    const protocols = [];
    const openPorts = [];
    let deviceType = 'unknown';
    let model = null;
    const details = {};

    for (const hit of hits) {
      openPorts.push(hit.port);
      if (hit.protocol) protocols.push(hit.protocol);
      if (hit.deviceType && hit.deviceType !== 'unknown') deviceType = hit.deviceType;
      if (hit.model) model = hit.model;
      if (hit.details) Object.assign(details, hit.details);
    }

    this._mergeDevice(ip, { protocols, openPorts, deviceType, model, details });
  }

  _results() {
    return {
      devices: Array.from(this._devices.values()),
      scanTime: new Date().toISOString(),
      deviceCount: this._devices.size,
    };
  }
}

module.exports = { NetworkScanner, listInterfaces, expandSubnet, netmaskToPrefix };
