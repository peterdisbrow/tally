/**
 * ARP-based device discovery.
 * Reads the OS ARP cache (arp -a) and optionally pings the subnet first
 * to populate it. Works on macOS and Linux.
 */

const { execFile } = require('child_process');
const os = require('os');

// Known OUI prefixes for common AV vendors (first 3 bytes of MAC)
const OUI_VENDORS = {
  '7C:2E:0D': 'Blackmagic Design',
  '00:0F:84': 'Blackmagic Design',
  '94:E6:F7': 'Blackmagic Design',
  '28:B2:BD': 'Blackmagic Design',
  'B8:D7:AF': 'Blackmagic Design',
  'A0:BD:CD': 'Blackmagic Design',
  'DC:A6:32': 'Raspberry Pi',      // Often used in Companion
  'B8:27:EB': 'Raspberry Pi',
  'E4:5F:01': 'Raspberry Pi',
  '2C:CF:67': 'Raspberry Pi',
  '00:04:A5': 'QSC Audio',
  '00:1A:2B': 'Audinate (Dante)',
  '00:1D:C1': 'Audinate (Dante)',
  'D8:80:39': 'Shure',
  '00:0E:DD': 'Shure',
  '00:60:52': 'Allen & Heath',
  '00:0A:1B': 'Allen & Heath',
  '00:90:56': 'Behringer/Music Tribe',
  'BC:F2:AF': 'Apple',
  'AC:DE:48': 'Apple',
  '3C:22:FB': 'Apple',
  '00:50:C2': 'IEEE (sACN/Art-Net)',
  '00:0B:78': 'NewTek (NDI/TriCaster)',
  'D4:E0:8E': 'NETGEAR',
  '00:1B:21': 'NETGEAR',
  '00:40:96': 'Cisco',
  '00:1E:7D': 'Cisco/Linksys',
  'AC:17:02': 'Cisco/Meraki',
  '00:18:0A': 'Cisco/Meraki',
  '78:72:5D': 'Cisco/Meraki',
  '00:23:04': 'Cisco',
  'F0:9F:C2': 'Ubiquiti',
  '24:5A:4C': 'Ubiquiti',
  '80:2A:A8': 'Ubiquiti',
  'DC:9F:DB': 'Ubiquiti',
  '68:D7:9A': 'Ubiquiti',
  '74:83:C2': 'Ubiquiti',
  '18:E8:29': 'Ubiquiti',
  '44:D9:E7': 'Ubiquiti',
  '00:04:4B': 'Nvidia (NDI)',
  '00:11:22': 'CIMSYS (BirdDog)',
  '00:30:53': 'Basler (cameras)',
  'EC:46:70': 'China Dragon (PTZ)',
  '00:12:4B': 'Texas Instruments',
  '00:E0:4C': 'Realtek',
  '00:1C:C0': 'Intel',
  '70:85:C2': 'AJA Video',
  '00:0D:4B': 'Roku',
  '00:17:88': 'Philips Hue',
  'EC:B5:FA': 'Philips Hue',
  '00:0C:43': 'Yamaha',
  '04:0E:C2': 'ViewSonic',
};

/**
 * Normalize a MAC address to XX:XX:XX:XX:XX:XX format.
 * macOS arp -a outputs shortened MACs like "4:17:b6:4a:d6:e5".
 */
function normalizeMac(mac) {
  if (!mac) return null;
  return mac.replace(/-/g, ':').split(':')
    .map(b => b.padStart(2, '0'))
    .join(':')
    .toUpperCase();
}

function lookupVendor(mac) {
  if (!mac) return null;
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  const prefix = normalized.substring(0, 8);
  return OUI_VENDORS[prefix] || null;
}

/**
 * Parse output of `arp -a` on macOS/Linux.
 * macOS format: hostname (ip) at mac on iface [ethernet]
 * Linux format: hostname (ip) at mac [ether] on iface
 */
function parseArpOutput(stdout) {
  const entries = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    // Match: optional_hostname (ip) at mac ...
    const m = line.match(/(?:(\S+)\s+)?\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([\da-fA-F:]+)/);
    if (!m) continue;
    const rawMac = m[3];
    if (rawMac === '(incomplete)') continue;
    const mac = normalizeMac(rawMac);
    if (!mac || mac === 'FF:FF:FF:FF:FF:FF') continue;
    const hostname = (m[1] && m[1] !== '?') ? m[1] : null;
    const ip = m[2];
    entries.push({
      ip,
      mac,
      hostname,
      vendor: lookupVendor(mac),
    });
  }
  return entries;
}

function runCmd(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
    child.on('error', () => resolve(''));
  });
}

/**
 * Ping-sweep a /24 subnet to populate the ARP cache.
 * Uses a burst of concurrent pings with 1-packet, short timeout.
 */
async function pingSweep(subnet) {
  const promises = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}.${i}`;
    // -c 1: one packet, -W 200ms timeout (macOS uses -W in ms on some versions, -t on others)
    const args = process.platform === 'darwin'
      ? ['-c', '1', '-t', '1', '-q', ip]
      : ['-c', '1', '-W', '1', '-q', ip];
    promises.push(runCmd('ping', args, 2000));
  }
  await Promise.all(promises);
}

/**
 * Discover devices via ARP table.
 * Optionally pings subnet first to populate the cache.
 */
async function discover(interfaceName, options = {}) {
  // Get subnet for optional ping sweep
  const ifaces = os.networkInterfaces();
  let subnet = null;
  for (const name of Object.keys(ifaces)) {
    if (interfaceName && name !== interfaceName) continue;
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
        break;
      }
    }
    if (subnet) break;
  }

  // Ping sweep to populate ARP cache (runs in ~2s due to concurrency)
  if (subnet && options.pingSweep !== false) {
    await pingSweep(subnet);
  }

  // Read ARP table
  const stdout = await runCmd('arp', ['-a'], 5000);
  return parseArpOutput(stdout);
}

module.exports = { discover, parseArpOutput, lookupVendor, normalizeMac, OUI_VENDORS };
