/**
 * Shelly Smart Plug Manager
 *
 * Discovers Shelly smart plugs on the local network via mDNS and exposes
 * power control (on/off/toggle/power-cycle) via Shelly's local HTTP API.
 *
 * Shelly Gen2+ devices use the /rpc/ endpoint; Gen1 devices use /relay/0.
 * We attempt Gen2 first and fall back to Gen1.
 *
 * Discovery: Shelly devices advertise `_shelly._tcp` over mDNS.  We use
 * Node's built-in `dns` module with a lightweight mDNS multicast query.
 */

const { EventEmitter } = require('events');
const dgram = require('dgram');
const dns = require('dns-packet');

// mDNS constants
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SHELLY_SERVICE = '_shelly._tcp.local';

class ShellyPlug {
  constructor({ ip, name, id, gen = 2 }) {
    this.ip = ip;
    this.name = name || `Shelly ${ip}`;
    this.id = id || ip;
    this.gen = gen;        // 1 or 2
    this.connected = false;
    this.powerOn = false;
    this.powerWatts = null;
    this.voltage = null;
    this.firmware = null;
    this._lastSeen = null;
  }

  get baseUrl() { return `http://${this.ip}`; }

  async _fetch(path, timeoutMs = 5000) {
    const url = `${this.baseUrl}${path}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) return null;
      const text = await resp.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }

  /** Probe the device and determine gen version. Returns true if reachable. */
  async probe() {
    // Try Gen2 first
    const gen2 = await this._fetch('/rpc/Shelly.GetDeviceInfo', 3000);
    if (gen2) {
      this.gen = 2;
      this.connected = true;
      this.id = gen2.id || this.id;
      this.name = gen2.name || this.name;
      this.firmware = gen2.fw_id || gen2.ver || null;
      this._lastSeen = Date.now();
      return true;
    }
    // Try Gen1 fallback
    const gen1 = await this._fetch('/settings', 3000);
    if (gen1) {
      this.gen = 1;
      this.connected = true;
      this.id = gen1.device?.hostname || this.id;
      this.name = gen1.name || gen1.device?.hostname || this.name;
      this.firmware = gen1.fw || null;
      this._lastSeen = Date.now();
      return true;
    }
    this.connected = false;
    return false;
  }

  /** Fetch current relay/power status. */
  async getStatus() {
    if (this.gen === 2) {
      const data = await this._fetch('/rpc/Switch.GetStatus?id=0');
      if (data) {
        this.connected = true;
        this.powerOn = !!data.output;
        this.powerWatts = typeof data.apower === 'number' ? Math.round(data.apower * 10) / 10 : null;
        this.voltage = typeof data.voltage === 'number' ? Math.round(data.voltage * 10) / 10 : null;
        this._lastSeen = Date.now();
        return true;
      }
    } else {
      const data = await this._fetch('/relay/0');
      if (data) {
        this.connected = true;
        this.powerOn = data.ison === true;
        this.powerWatts = typeof data.power === 'number' ? Math.round(data.power * 10) / 10 : null;
        this._lastSeen = Date.now();
        return true;
      }
    }
    this.connected = false;
    return false;
  }

  async setPower(on) {
    if (this.gen === 2) {
      const data = await this._fetch(`/rpc/Switch.Set?id=0&on=${on}`);
      if (data) { this.powerOn = on; return true; }
    } else {
      const data = await this._fetch(`/relay/0?turn=${on ? 'on' : 'off'}`);
      if (data) { this.powerOn = data.ison === true; return true; }
    }
    return false;
  }

  async toggle() {
    if (this.gen === 2) {
      const data = await this._fetch('/rpc/Switch.Toggle?id=0');
      if (data) { this.powerOn = !this.powerOn; return true; }
    } else {
      const data = await this._fetch('/relay/0?turn=toggle');
      if (data) { this.powerOn = data.ison === true; return true; }
    }
    return false;
  }

  toStatus() {
    return {
      id: this.id,
      ip: this.ip,
      name: this.name,
      connected: this.connected,
      powerOn: this.powerOn,
      powerWatts: this.powerWatts,
      voltage: this.voltage,
      firmware: this.firmware,
    };
  }
}

class ShellyManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, ShellyPlug>} keyed by IP */
    this.plugs = new Map();
    this._pollInterval = null;
    this._discoveryInterval = null;
    this._mdnsSocket = null;
    this._stopping = false;
  }

  /** Start mDNS discovery and status polling. */
  start() {
    this._stopping = false;
    this._startDiscovery();
    // Poll all known plugs every 10s
    this._pollInterval = setInterval(() => this._pollAll(), 10_000);
    // Re-discover every 60s
    this._discoveryInterval = setInterval(() => this._sendMdnsQuery(), 60_000);
  }

  stop() {
    this._stopping = true;
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    if (this._discoveryInterval) { clearInterval(this._discoveryInterval); this._discoveryInterval = null; }
    if (this._mdnsSocket) {
      try { this._mdnsSocket.close(); } catch { /* ignore */ }
      this._mdnsSocket = null;
    }
  }

  /** Manually add a plug by IP (used for config-based plugs). */
  async addPlug(ip, name) {
    if (this.plugs.has(ip)) return this.plugs.get(ip);
    const plug = new ShellyPlug({ ip, name });
    this.plugs.set(ip, plug);
    const ok = await plug.probe();
    if (ok) {
      await plug.getStatus();
      this.emit('plugDiscovered', plug);
      this.emit('change');
    }
    return plug;
  }

  /** Get a plug by IP or ID. */
  getPlug(ipOrId) {
    if (this.plugs.has(ipOrId)) return this.plugs.get(ipOrId);
    for (const plug of this.plugs.values()) {
      if (plug.id === ipOrId) return plug;
    }
    return null;
  }

  /** Power cycle a plug: turn off, wait delayMs, turn on. */
  async powerCycle(ipOrId, delayMs = 5000) {
    const plug = this.getPlug(ipOrId);
    if (!plug) throw new Error(`Plug not found: ${ipOrId}`);
    if (!plug.connected) throw new Error(`Plug not reachable: ${plug.name}`);

    await plug.setPower(false);
    this.emit('change');
    await new Promise(r => setTimeout(r, delayMs));
    await plug.setPower(true);
    this.emit('change');
    return true;
  }

  /** Turn a plug on. */
  async turnOn(ipOrId) {
    const plug = this.getPlug(ipOrId);
    if (!plug) throw new Error(`Plug not found: ${ipOrId}`);
    await plug.setPower(true);
    this.emit('change');
    return true;
  }

  /** Turn a plug off. */
  async turnOff(ipOrId) {
    const plug = this.getPlug(ipOrId);
    if (!plug) throw new Error(`Plug not found: ${ipOrId}`);
    await plug.setPower(false);
    this.emit('change');
    return true;
  }

  /** Toggle a plug. */
  async togglePlug(ipOrId) {
    const plug = this.getPlug(ipOrId);
    if (!plug) throw new Error(`Plug not found: ${ipOrId}`);
    await plug.toggle();
    this.emit('change');
    return plug.powerOn;
  }

  /** Return status array for all known plugs. */
  toStatus() {
    return Array.from(this.plugs.values()).map(p => p.toStatus());
  }

  // ── mDNS discovery ───────────────────────────────────────────────────────

  _startDiscovery() {
    try {
      this._mdnsSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this._mdnsSocket.on('error', () => { /* ignore mDNS errors */ });

      this._mdnsSocket.on('message', (msg) => {
        try {
          this._handleMdnsResponse(msg);
        } catch { /* malformed packet */ }
      });

      this._mdnsSocket.bind(MDNS_PORT, () => {
        try {
          this._mdnsSocket.addMembership(MDNS_ADDR);
        } catch { /* may fail on some networks */ }
        this._sendMdnsQuery();
      });
    } catch {
      // mDNS not available — rely on manual/config-based plugs
      console.log('🔌 Shelly mDNS discovery not available — using configured plugs only');
    }
  }

  _sendMdnsQuery() {
    if (!this._mdnsSocket) return;
    try {
      const query = dns.encode({
        type: 'query',
        id: 0,
        flags: 0,
        questions: [{ type: 'PTR', name: SHELLY_SERVICE }],
      });
      this._mdnsSocket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDR);
    } catch { /* ignore */ }
  }

  _handleMdnsResponse(msg) {
    const packet = dns.decode(msg);
    if (!packet || !packet.answers) return;

    // Look for A records that belong to shelly devices
    const shellyNames = new Set();
    for (const ans of [...(packet.answers || []), ...(packet.additionals || [])]) {
      if (ans.type === 'PTR' && ans.name === SHELLY_SERVICE) {
        shellyNames.add(ans.data);
      }
    }

    // Extract IPs from A records for discovered shelly names
    for (const ans of [...(packet.answers || []), ...(packet.additionals || [])]) {
      if (ans.type === 'A' && ans.data) {
        const ip = ans.data;
        // If we got shelly PTR records, only add if the A record matches
        // Otherwise, check if the name looks like a shelly device
        const isShelly = shellyNames.size > 0
          ? [...shellyNames].some(n => ans.name && n.includes(ans.name.replace('.local', '')))
          : (ans.name && ans.name.toLowerCase().includes('shelly'));

        if (isShelly && !this.plugs.has(ip)) {
          const plug = new ShellyPlug({ ip, name: ans.name?.replace('.local', '') || `Shelly ${ip}` });
          this.plugs.set(ip, plug);
          plug.probe().then(ok => {
            if (ok) {
              plug.getStatus().then(() => {
                console.log(`🔌 Discovered Shelly plug: ${plug.name} (${ip})`);
                this.emit('plugDiscovered', plug);
                this.emit('change');
              });
            }
          }).catch(() => {});
        }
      }
    }
  }

  async _pollAll() {
    if (this._stopping) return;
    for (const plug of this.plugs.values()) {
      const wasConnected = plug.connected;
      const wasPowerOn = plug.powerOn;
      const wasWatts = plug.powerWatts;
      await plug.getStatus();

      if (plug.connected !== wasConnected || plug.powerOn !== wasPowerOn || plug.powerWatts !== wasWatts) {
        this.emit('change');
      }

      // Retry probe if disconnected
      if (!plug.connected) {
        await plug.probe();
      }
    }
  }
}

module.exports = { ShellyManager, ShellyPlug };
