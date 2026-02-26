/**
 * equipment-tester.js — Equipment connection testing (TCP, UDP, HTTP, NDI probes).
 *
 * Extracted from main.js — pure refactoring, no behaviour changes.
 */

const { spawn } = require('child_process');

// Injected dependencies — set via init()
let _tryTcpConnect = async () => false;
let _tryHttpGet = async () => ({ success: false });

function init({ tryTcpConnect, tryHttpGet }) {
  if (typeof tryTcpConnect === 'function') _tryTcpConnect = tryTcpConnect;
  if (typeof tryHttpGet === 'function') _tryHttpGet = tryHttpGet;
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

function tryUdpSendLocal(host, port, payloadHex = '', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const dgram = require('dgram');
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

function parseProbeRate(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.includes('/')) {
    const [numRaw, denRaw] = raw.split('/');
    const num = Number(numRaw);
    const den = Number(denRaw);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(2));
    }
    return null;
  }
  const asNum = Number(raw);
  return Number.isFinite(asNum) ? Number(asNum.toFixed(2)) : null;
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

async function probeNdiSourceLocal(source, timeoutMs = 5000) {
  const ndiSource = String(source || '').trim();
  if (!ndiSource) {
    return { success: false, details: 'Enter NDI source name' };
  }

  const args = [
    '-v', 'error',
    '-f', 'libndi_newtek',
    '-i', ndiSource,
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate',
    '-of', 'json',
    '-read_intervals', '%+1',
  ];

  const result = await runLocalCommand('ffprobe', args, timeoutMs);
  if (result.error && result.error.code === 'ENOENT') {
    return { success: false, details: 'ffprobe not installed (required for NDI monitoring)' };
  }
  if (result.timedOut) {
    return { success: false, details: `NDI probe timed out for "${ndiSource}"` };
  }
  if (!result.ok) {
    const errText = `${result.stderr || ''} ${result.stdout || ''}`.toLowerCase();
    const pluginMissing = errText.includes('unknown input format') || errText.includes('libndi_newtek');
    if (pluginMissing) return { success: false, details: 'ffprobe lacks libndi_newtek support' };
    return { success: false, details: `NDI source "${ndiSource}" not reachable` };
  }

  let stream = null;
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  } catch {
    stream = null;
  }

  const width = stream && Number.isFinite(Number(stream.width)) ? Number(stream.width) : null;
  const height = stream && Number.isFinite(Number(stream.height)) ? Number(stream.height) : null;
  const fps = parseProbeRate(stream?.avg_frame_rate || stream?.r_frame_rate || '');
  const resolution = width && height ? `${width}x${height}` : null;
  const fpsText = Number.isFinite(fps) ? `${fps} fps` : null;

  return {
    success: true,
    details: `NDI source reachable (${ndiSource})${resolution ? ` · ${resolution}` : ''}${fpsText ? ` @ ${fpsText}` : ''}`,
  };
}

// ─── Main test dispatcher ─────────────────────────────────────────────────────

async function testEquipmentConnection(params) {
  const { type, ip, port, password, url } = params;
  try {
    switch (type) {
      case 'atem': {
        const ok = await _tryTcpConnect(ip, port || 9910, 2000);
        return { success: ok, details: ok ? 'ATEM reachable' : 'Cannot reach ATEM' };
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
      case 'dante': {
        const resp = await _tryHttpGet(`http://${ip}:${port || 8080}/x-nmos/node/v1.2/self`, 3000);
        return { success: resp.success, details: resp.success ? 'NMOS registry reachable' : 'Cannot reach NMOS registry' };
      }
      case 'vmix': {
        const resp = await _tryHttpGet(`http://${ip}:${port || 8088}/api/?Function=GetShortXML`, 3000);
        if (resp.success && resp.data) {
          const editionM = resp.data.match ? resp.data.match(/<edition>([^<]+)<\/edition>/i) : null;
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
        const defaultPort = mixerType === 'allenheath' ? 51326
          : mixerType === 'yamaha' ? 8765
          : 10023; // behringer / midas
        const targetPort = port || defaultPort;
        // Yamaha TF uses TCP on 49280 — try TCP connect; for OSC consoles, TCP probe is a good enough check
        const resp = await tryTcpConnectLocal(ip, targetPort, 3000);
        return {
          success: resp.success,
          details: resp.success
            ? `${mixerType} console reachable at ${ip}:${targetPort}`
            : `Cannot reach ${mixerType} console at ${ip}:${targetPort}`,
        };
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
        if (et === 'ndi') {
          return probeNdiSourceLocal(source || params.ip, 5000);
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
  parseProbeRate,
  runLocalCommand,
  probeNdiSourceLocal,
};
