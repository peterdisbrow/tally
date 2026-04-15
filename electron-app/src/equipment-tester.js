/**
 * equipment-tester.js — Equipment connection testing (TCP, UDP, HTTP probes).
 *
 * Protocol notes:
 *  - ATEM: UDP port 9910 (Blackmagic proprietary protocol)
 *  - Behringer/Midas X32/M32: OSC over UDP port 10023
 *  - Allen & Heath SQ/dLive: OSC over UDP port 51326
 *  - Yamaha CL/QL: OSC over UDP port 8765
 *  - OBS, HyperDeck, Companion, ProPresenter, vMix, TriCaster, BirdDog: TCP/HTTP
 */

const { spawn } = require('child_process');
const dgram = require('dgram');

// Injected dependencies — set via init()
let _tryTcpConnect = async () => false;
let _tryHttpGet = async () => ({ success: false });
let _tryUdpProbe = async () => false;

// Pre-computed UDP probe packets
let ATEM_SYN_PACKET = Buffer.from('101453AB00000000003A00000100000000000000', 'hex');
let OSC_INFO_PACKET = Buffer.from('2F696E666F0000002C000000', 'hex');
let OSC_SQ_ALIVE_PACKET = Buffer.from('2F73712F616C6976650000002C000000', 'hex');
let OSC_YAMAHA_STATE_PACKET = Buffer.from('2F796D6873732F7374617465000000002C000000', 'hex');

function init({ tryTcpConnect, tryHttpGet, tryUdpProbe, packets }) {
  if (typeof tryTcpConnect === 'function') _tryTcpConnect = tryTcpConnect;
  if (typeof tryHttpGet === 'function') _tryHttpGet = tryHttpGet;
  if (typeof tryUdpProbe === 'function') _tryUdpProbe = tryUdpProbe;
  if (packets) {
    if (packets.ATEM_SYN_PACKET) ATEM_SYN_PACKET = packets.ATEM_SYN_PACKET;
    if (packets.OSC_INFO_PACKET) OSC_INFO_PACKET = packets.OSC_INFO_PACKET;
    if (packets.OSC_SQ_ALIVE_PACKET) OSC_SQ_ALIVE_PACKET = packets.OSC_SQ_ALIVE_PACKET;
    if (packets.OSC_YAMAHA_STATE_PACKET) OSC_YAMAHA_STATE_PACKET = packets.OSC_YAMAHA_STATE_PACKET;
  }
}

// ─── Local helpers ────────────────────────────────────────────────────────────

function tryTcpConnectLocal(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => { socket.destroy(); resolve({ success: true }); });
    socket.on('error', () => { socket.destroy(); resolve({ success: false }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ success: false }); });
  });
}

/**
 * Send a UDP packet and wait for ANY response (fire-and-forget fallback).
 * Used for VISCA-UDP cameras where no response is expected.
 */
function tryUdpSendLocal(host, port, payloadHex = '', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const payload = payloadHex ? Buffer.from(payloadHex.replace(/\s+/g, ''), 'hex') : Buffer.from([0x81, 0x09, 0x04, 0x00, 0xff]);
    let done = false;
    const finish = (success) => {
      if (done) return;
      done = true;
      try { socket.close(); } catch { /* ignore */ }
      resolve({ success });
    };
    const timer = setTimeout(() => finish(true), timeoutMs); // UDP is fire-and-forget; no error => likely routable
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.send(payload, port, host, (err) => {
      clearTimeout(timer);
      finish(!err);
    });
  });
}

/**
 * Send a UDP packet and wait for a RESPONSE.
 * Returns true if any UDP response arrives within timeoutMs.
 * Used for ATEM handshake and OSC mixer queries.
 */
function tryUdpProbeLocal(host, port, packet, timeoutMs = 2000) {
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
    socket.send(packet, 0, packet.length, port, host, (err) => {
      if (err) finish(false);
    });
  });
}


function runLocalCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, timedOut, error });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, error: null });
    });
  });
}

// ─── Main test dispatcher ─────────────────────────────────────────────────────

/**
 * Normalize a host string for probing.
 *
 * `localhost` goes through Node's DNS resolver, which on modern Windows
 * (and sometimes macOS) returns `::1` (IPv6) first. Most AV apps — vMix,
 * OBS, ProPresenter, Companion, Resolume — bind to IPv4 only, so probing
 * via `localhost` fails with ECONNREFUSED even though the service is running.
 *
 * Forcing `127.0.0.1` bypasses DNS and eliminates the false "cannot reach".
 */
function normalizeHost(host) {
  if (!host) return host;
  const h = String(host).trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return '127.0.0.1';
  return host;
}

async function testEquipmentConnection(params) {
  const { type, port, password, url } = params;
  const ip = normalizeHost(params.ip);
  try {
    switch (type) {
      case 'atem': {
        // ATEM uses UDP on port 9910 — send SYN handshake and wait for response
        const ok = await tryUdpProbeLocal(ip, port || 9910, ATEM_SYN_PACKET, 2000);
        return { success: ok, details: ok ? 'ATEM reachable (UDP handshake OK)' : 'Cannot reach ATEM — check IP and that it is powered on' };
      }
      case 'companion': {
        const target = url || `http://${ip}:${port || 8888}`;
        // Companion 4.x: probe a location slot — any HTTP response means it's running
        const resp = await _tryHttpGet(`${target}/api/location/1/0/0`, 2000);
        return { success: resp.success, details: resp.success ? 'Companion connected' : 'Cannot reach Companion' };
      }
      case 'obs': {
        const ok = await _tryTcpConnect(ip || '127.0.0.1', port || 4455, 2000);
        return { success: ok, details: ok ? 'OBS reachable' : 'Cannot reach OBS' };
      }
      case 'hyperdeck': {
        const ok = await _tryTcpConnect(ip, port || 9993, 2000);
        return { success: ok, details: ok ? 'HyperDeck reachable' : 'Cannot reach HyperDeck' };
      }
      case 'videohub': {
        const ok = await _tryTcpConnect(ip, port || 9990, 3000);
        return { success: ok, details: ok ? 'VideoHub reachable (TCP 9990)' : 'Cannot reach VideoHub — check IP and power' };
      }
      case 'ptz': {
        const protocol = String(params.protocol || 'auto').toLowerCase();
        const normalizedProtocol = protocol === 'ptzoptics-visca'
          ? 'visca-tcp'
          : protocol === 'ptzoptics-onvif'
            ? 'onvif'
            : protocol;
        const explicitPort = Number(port) || 0;
        const ptzPort = explicitPort || (
          normalizedProtocol === 'onvif' ? 80
            : normalizedProtocol === 'visca-udp' ? 1259
              : normalizedProtocol === 'sony-visca-udp' ? 52381
                : 5678
        );
        if (normalizedProtocol === 'onvif' || normalizedProtocol === 'auto') {
          const onvifPort = explicitPort || 80;
          const resp = await _tryHttpGet(`http://${ip}:${onvifPort}/onvif/device_service`, 3000);
          const statusCode = Number(resp.statusCode || 0);
          const looksOnvif = resp.success && statusCode > 0 && statusCode !== 404;
          if (looksOnvif) return { success: true, details: `ONVIF endpoint reachable (HTTP ${statusCode})` };
          if (normalizedProtocol === 'onvif') return { success: false, details: 'Cannot reach ONVIF endpoint' };
        }
        if (normalizedProtocol === 'visca-udp' || normalizedProtocol === 'sony-visca-udp') {
          const probe = await tryUdpSendLocal(ip, ptzPort);
          return {
            success: probe.success,
            details: probe.success
              ? `${normalizedProtocol} datagram sent`
              : `Cannot send ${normalizedProtocol} datagram`,
          };
        }
        const ok = await _tryTcpConnect(ip, ptzPort, 2500);
        return { success: ok, details: ok ? 'VISCA TCP reachable' : 'Cannot reach VISCA TCP camera' };
      }
      case 'propresenter': {
        const resp = await _tryHttpGet(`http://${ip}:${port || 1025}/v1/version`, 3000);
        return { success: resp.success, details: resp.success ? 'ProPresenter running' : 'Cannot reach ProPresenter' };
      }
      case 'vmix': {
        const resp = await _tryHttpGet(`http://${ip}:${port || 8088}/api/?Function=GetShortXML`, 3000);
        // vMix returns XML, not JSON — tryHttpGet leaves resp.data null in that
        // case, so check resp.body for the edition tag instead of resp.data.
        const body = resp && resp.success ? String(resp.body || '') : '';
        if (body && /<edition>/i.test(body)) {
          const editionM = body.match(/<edition>([^<]+)<\/edition>/i);
          const edition = editionM ? editionM[1] : 'vMix';
          return { success: true, details: `${edition} is running` };
        }
        return { success: false, details: 'Cannot reach vMix — is HTTP API enabled?' };
      }
      case 'resolume': {
        const resp = await _tryHttpGet(`http://${ip}:${port || 8080}/api/v1/product`, 3000);
        const version = resp.success && resp.data ? (resp.data.name || 'Resolume Arena') : null;
        return { success: resp.success, details: resp.success ? `${version} is running` : 'Cannot reach Resolume Arena' };
      }
      case 'mixer': {
        const mixerType = params.mixerType || 'behringer';
        // Allen & Heath SQ / dLive / Avantis control via TCP MIDI on port 51325.
        // The SQ series does NOT expose native OSC — it only speaks MIDI-over-TCP
        // (same protocol MixPad uses). Probing /sq/alive over UDP/51326 always
        // times out even when the console is perfectly reachable, which is what
        // the real driver at church-client/src/mixers/allenheath.js proves: it
        // connects via TcpMidi on port 51325, not OSC. A plain TCP connect to
        // 51325 matches what the driver will do and reliably confirms reachability.
        if (mixerType === 'allenheath' || mixerType === 'dlive' || mixerType === 'avantis') {
          const targetPort = port || 51325;
          const result = await tryTcpConnectLocal(ip, targetPort, 3000);
          const ok = !!result.success;
          return {
            success: ok,
            details: ok
              ? `${mixerType} console reachable at ${ip}:${targetPort} (TCP MIDI)`
              : `Cannot reach ${mixerType} console at ${ip}:${targetPort} — check IP and power`,
          };
        }
        const defaultPort = mixerType === 'yamaha' ? 8765 : 10023; // behringer / midas
        const targetPort = port || defaultPort;
        // Behringer / Midas / Yamaha use OSC over UDP — send the appropriate query and wait for response
        const packet = mixerType === 'yamaha' ? OSC_YAMAHA_STATE_PACKET : OSC_INFO_PACKET;
        const ok = await tryUdpProbeLocal(ip, targetPort, packet, 3000);
        return {
          success: ok,
          details: ok
            ? `${mixerType} console reachable at ${ip}:${targetPort} (OSC response OK)`
            : `Cannot reach ${mixerType} console at ${ip}:${targetPort} — check IP and power`,
        };
      }
      case 'smart-plug': {
        // Shelly smart plugs expose HTTP APIs — try Gen2 first, then Gen1
        const gen2 = await _tryHttpGet(`http://${ip}:${port || 80}/rpc/Shelly.GetDeviceInfo`, 3000);
        if (gen2.success && gen2.data && gen2.data.id) {
          const name = gen2.data.name || gen2.data.id;
          return { success: true, details: `Shelly reachable (Gen2) — ${name}` };
        }
        const gen1 = await _tryHttpGet(`http://${ip}:${port || 80}/settings`, 3000);
        if (gen1.success && gen1.data && gen1.data.device) {
          const name = gen1.data.name || gen1.data.device.hostname || 'Shelly';
          return { success: true, details: `Shelly reachable (Gen1) — ${name}` };
        }
        return { success: false, details: 'Cannot reach Shelly smart plug — check IP and power' };
      }
      case 'encoder': {
        const et = (params.encoderType || '').toLowerCase();
        const source = String(params.source || '').trim();
        if (et === 'obs') {
          const ok = await _tryTcpConnect(ip || '127.0.0.1', port || 4455, 2000);
          return { success: ok, details: ok ? 'OBS WebSocket reachable' : 'Cannot reach OBS WebSocket' };
        }
        if (et === 'vmix') {
          const resp = await _tryHttpGet(`http://${ip || 'localhost'}:${port || 8088}/api/?Function=GetShortXML`, 3000);
          return { success: resp.success, details: resp.success ? 'vMix API reachable' : 'Cannot reach vMix API' };
        }
        if (et === 'ecamm') {
          const resp = await _tryHttpGet(`http://127.0.0.1:${port || 65194}/getInfo`, 3000);
          return { success: resp.success, details: resp.success ? 'Ecamm Live API connected' : 'Ecamm Live not detected (port 65194)' };
        }
        if (et === 'blackmagic') {
          const resp = await _tryHttpGet(`http://${ip}:${port || 80}/control/api/v1/livestreams/0`, 3000);
          if (resp.success && resp.data) {
            const status = resp.data.status || 'Unknown';
            return { success: true, details: `Blackmagic connected — status: ${status}` };
          }
          return { success: resp.success, details: resp.success ? 'Blackmagic REST API reachable' : 'Cannot reach Blackmagic REST API (requires firmware 3.4+)' };
        }
        if (et === 'aja') {
          const resp = await _tryHttpGet(`http://${ip}:${port || 80}/config?action=get&paramid=eParamID_ReplicatorStreamState`, 3000);
          if (resp.success && resp.data?.value !== undefined) {
            const states = ['Uninitialized', 'Idle', 'Streaming', 'Failing (Idle)', 'Failing (Stream)', 'Shutdown'];
            const state = states[parseInt(resp.data.value)] || 'Unknown';
            return { success: true, details: `AJA HELO connected — stream: ${state}` };
          }
          return { success: resp.success, details: resp.success ? 'AJA HELO reachable' : 'Cannot reach AJA HELO REST API' };
        }
        if (et === 'epiphan') {
          const resp = await _tryHttpGet(`http://${ip}:${port || 80}/api/channels`, 3000);
          if (resp.success && resp.data?.result) {
            const count = resp.data.result.length;
            return { success: true, details: `Epiphan Pearl connected — ${count} channel${count !== 1 ? 's' : ''}` };
          }
          // Try v2 endpoint
          const resp2 = await _tryHttpGet(`http://${ip}:${port || 80}/api/v2.0/channels`, 3000);
          if (resp2.success) return { success: true, details: 'Epiphan Pearl connected (API v2)' };
          return { success: false, details: 'Cannot reach Epiphan Pearl API (check IP and credentials)' };
        }
        if (et === 'teradek') {
          const resp = await _tryHttpGet(`http://${ip}:${port || 80}/cgi-bin/system.cgi?command=status`, 3000);
          if (resp.success && resp.data?.status) {
            const state = resp.data.status['Broadcast-State'] || 'Unknown';
            return { success: true, details: `Teradek connected — broadcast: ${state}` };
          }
          // May need login first — just check if the web UI responds
          const resp2 = await _tryHttpGet(`http://${ip}:${port || 80}/`, 3000);
          return { success: resp2.success, details: resp2.success ? 'Teradek web UI reachable (may need password)' : 'Cannot reach Teradek' };
        }
        if (et === 'tricaster') {
          const targetPort = port || 5951;
          const versionResp = await _tryHttpGet(`http://${ip}:${targetPort}/v1/version`, 3000);
          if (versionResp.success) {
            const raw = typeof versionResp.body === 'string' ? versionResp.body : '';
            const version = (versionResp.data && (versionResp.data.version || versionResp.data.softwareVersion))
              || (raw.match(/<version[^>]*>([^<]+)</i) || [])[1]
              || '';
            return { success: true, details: `TriCaster API reachable${version ? ` (v${version})` : ''}` };
          }
          const shortcutResp = await _tryHttpGet(`http://${ip}:${targetPort}/v1/shortcut?name=record_toggle`, 3000);
          if (shortcutResp.success || shortcutResp.statusCode === 401 || shortcutResp.statusCode === 403) {
            return { success: true, details: 'TriCaster shortcut API reachable' };
          }
          const tcp = await _tryTcpConnect(ip, targetPort, 2500);
          return {
            success: tcp,
            details: tcp
              ? 'TriCaster control port reachable (HTTP API may require different port/auth)'
              : 'Cannot reach TriCaster control/API port',
          };
        }
        if (et === 'birddog') {
          const targetPort = port || 8080;
          const aboutResp = await _tryHttpGet(`http://${ip}:${targetPort}/about`, 3000);
          if (aboutResp.success) {
            return { success: true, details: `BirdDog API reachable${source ? ` · NDI source: ${source}` : ''}` };
          }
          const versionResp = await _tryHttpGet(`http://${ip}:${targetPort}/version`, 3000);
          if (versionResp.success) {
            return { success: true, details: `BirdDog API reachable${source ? ` · NDI source: ${source}` : ''}` };
          }
          const listResp = await _tryHttpGet(`http://${ip}:${targetPort}/List`, 3000);
          if (listResp.success) {
            return { success: true, details: `BirdDog endpoint reachable${source ? ` · NDI source: ${source}` : ''}` };
          }
          return { success: false, details: 'Cannot reach BirdDog API endpoint (default port 8080)' };
        }
        if (et === 'tally-encoder') {
          const resp = await _tryHttpGet(`http://${ip}:${port || 7070}/health`, 3000);
          return { success: resp.success, details: resp.success ? 'Tally Encoder reachable' : 'Cannot reach Tally Encoder' };
        }
        if (et === 'custom') {
          const statusUrl = params.statusUrl || '/status';
          const resp = await _tryHttpGet(`http://${ip}:${port || 80}${statusUrl}`, 3000);
          return { success: resp.success, details: resp.success ? 'Custom encoder reachable' : 'Cannot reach custom encoder' };
        }
        if (et === 'atem-streaming') {
          return { success: true, details: 'ATEM Mini streaming is monitored through the ATEM connection — no separate encoder test needed' };
        }
        // RTMP-push types (YoloBox, etc.) — no official control API.
        // If an IP is provided, do a basic reachability probe for closer integration.
        if (['yolobox', 'custom-rtmp', 'rtmp-generic'].includes(et)) {
          if (!ip) {
            return { success: true, details: 'Device configured — no control API (set optional IP to enable reachability checks)' };
          }
          const resp = await _tryHttpGet(`http://${ip}:${port || 80}/`, 3000);
          return {
            success: resp.success,
            details: resp.success
              ? 'Device reachable (RTMP device has no public control API)'
              : 'Cannot reach device web endpoint',
          };
        }
        return { success: false, details: 'Select an encoder type' };
      }
      default:
        return { success: false, details: 'Unknown device type' };
    }
  } catch (e) {
    return { success: false, details: e.message };
  }
}

module.exports = {
  init,
  testEquipmentConnection,
  tryTcpConnectLocal,
  tryUdpSendLocal,
  tryUdpProbeLocal,
  runLocalCommand,
};
