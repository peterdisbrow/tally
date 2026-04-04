/**
 * Device classification engine.
 * Takes raw scan data (open ports, mDNS services, MAC vendor) and
 * determines what kind of AV device it is.
 */

// ─── Device type icons (SVG path references for the UI) ─────────────────────

const DEVICE_TYPES = {
  'switcher':       { label: 'Video Switcher',     category: 'video',   icon: 'switcher' },
  'recorder':       { label: 'Recorder',           category: 'video',   icon: 'recorder' },
  'router':         { label: 'Video Router',       category: 'video',   icon: 'router' },
  'camera':         { label: 'Camera',             category: 'video',   icon: 'camera' },
  'encoder':        { label: 'Encoder',            category: 'video',   icon: 'encoder' },
  'ndi-source':     { label: 'NDI Source',         category: 'video',   icon: 'ndi' },
  'ndi-converter':  { label: 'NDI Converter',      category: 'video',   icon: 'ndi' },
  'presentation':   { label: 'Presentation',       category: 'video',   icon: 'presentation' },
  'audio-mixer':    { label: 'Audio Mixer',        category: 'audio',   icon: 'mixer' },
  'audio-network':  { label: 'Dante/Audio Network', category: 'audio',  icon: 'dante' },
  'lighting':       { label: 'Lighting',           category: 'lighting', icon: 'lighting' },
  'controller':     { label: 'Controller',         category: 'control', icon: 'controller' },
  'software':       { label: 'Software',           category: 'control', icon: 'software' },
  'smart-plug':     { label: 'Smart Plug',         category: 'power',   icon: 'plug' },
  'infrastructure': { label: 'Network Device',     category: 'network', icon: 'network' },
  'computer':       { label: 'Computer',           category: 'network', icon: 'computer' },
  'mobile':         { label: 'Mobile Device',      category: 'network', icon: 'mobile' },
  'printer':        { label: 'Printer',            category: 'network', icon: 'printer' },
  'unknown':        { label: 'Unknown Device',     category: 'other',   icon: 'unknown' },
};

// ─── Vendor-based classification ────────────────────────────────────────────

const VENDOR_DEVICE_TYPES = {
  'Blackmagic Design': 'switcher',
  'Audinate (Dante)':  'audio-network',
  'Shure':             'audio-network',
  'Allen & Heath':     'audio-mixer',
  'QSC Audio':         'audio-mixer',
  'Behringer/Music Tribe': 'audio-mixer',
  'NewTek (NDI/TriCaster)': 'switcher',
  'Apple':             'computer',
  'Raspberry Pi':      'controller',
  'NETGEAR':           'infrastructure',
  'Cisco':             'infrastructure',
  'Cisco/Linksys':     'infrastructure',
  'Cisco/Meraki':      'infrastructure',
  'Ubiquiti':          'infrastructure',
  'Yamaha':            'audio-mixer',
  'AJA Video':         'encoder',
  'Philips Hue':       'lighting',
};

// ─── mDNS service classification ────────────────────────────────────────────

function classifyMdnsService(svc) {
  const name = (svc.service || '').toLowerCase();
  const instance = (svc.instance || '').toLowerCase();

  if (name.includes('_ndi.')) {
    return { protocols: ['NDI'], deviceType: 'ndi-source' };
  }
  if (name.includes('_dante.') || name.includes('_sub._dante')) {
    return { protocols: ['Dante'], deviceType: 'audio-network' };
  }
  if (name.includes('_airplay.') || name.includes('_raop.')) {
    return { protocols: ['AirPlay'], deviceType: 'computer' };
  }
  if (name.includes('_obs-websocket.')) {
    return { protocols: ['OBS WebSocket'], deviceType: 'software' };
  }
  if (name.includes('_companion.')) {
    return { protocols: ['Companion'], deviceType: 'controller' };
  }
  if (name.includes('_sacn.')) {
    return { protocols: ['sACN'], deviceType: 'lighting' };
  }
  if (name.includes('_artnet.')) {
    return { protocols: ['Art-Net'], deviceType: 'lighting' };
  }
  if (name.includes('_osc.')) {
    return { protocols: ['OSC'], deviceType: 'audio-mixer' };
  }
  if (name.includes('_googlecast.')) {
    return { protocols: ['Chromecast'], deviceType: 'computer' };
  }
  if (name.includes('_hap.')) {
    return { protocols: ['HomeKit'], deviceType: 'smart-plug' };
  }
  if (name.includes('_pdl-datastream.') || name.includes('_ipp.')) {
    return { protocols: ['Printer'], deviceType: 'printer' };
  }
  if (name.includes('_smb.')) {
    return { protocols: ['SMB'], deviceType: 'computer' };
  }
  if (name.includes('_ssh.')) {
    return { protocols: ['SSH'], deviceType: instance.includes('rasp') ? 'controller' : 'computer' };
  }
  if (name.includes('_http.')) {
    return { protocols: ['HTTP'], deviceType: 'unknown' };
  }

  return { protocols: [], deviceType: 'unknown' };
}

// ─── Main classifier ────────────────────────────────────────────────────────

/**
 * Classify a device based on all available data.
 * Returns { deviceType, label, category, icon, confidence }.
 */
function classify(device) {
  const { protocols = [], vendor, openPorts = [], mac } = device;

  // Priority 1: Protocol-specific identification (most reliable)
  if (protocols.includes('ATEM')) {
    return { ...DEVICE_TYPES['switcher'], deviceType: 'switcher', confidence: 'high' };
  }
  if (protocols.includes('HyperDeck')) {
    return { ...DEVICE_TYPES['recorder'], deviceType: 'recorder', confidence: 'high' };
  }
  if (protocols.includes('Videohub')) {
    return { ...DEVICE_TYPES['router'], deviceType: 'router', confidence: 'high' };
  }
  if (protocols.includes('ProPresenter')) {
    return { ...DEVICE_TYPES['presentation'], deviceType: 'presentation', confidence: 'high' };
  }
  if (protocols.includes('Companion')) {
    return { ...DEVICE_TYPES['controller'], deviceType: 'controller', confidence: 'high' };
  }
  if (protocols.includes('OBS WebSocket')) {
    return { ...DEVICE_TYPES['software'], deviceType: 'software', confidence: 'high' };
  }
  if (protocols.includes('vMix')) {
    return { ...DEVICE_TYPES['software'], deviceType: 'software', confidence: 'high' };
  }
  if (protocols.includes('TriCaster')) {
    return { ...DEVICE_TYPES['switcher'], deviceType: 'switcher', confidence: 'high' };
  }
  if (protocols.includes('NDI')) {
    return { ...DEVICE_TYPES['ndi-source'], deviceType: 'ndi-source', confidence: 'high' };
  }
  if (protocols.includes('BirdDog NDI')) {
    return { ...DEVICE_TYPES['ndi-converter'], deviceType: 'ndi-converter', confidence: 'high' };
  }
  if (protocols.includes('Dante') || protocols.includes('Dante Audio')) {
    return { ...DEVICE_TYPES['audio-network'], deviceType: 'audio-network', confidence: 'high' };
  }
  if (protocols.includes('Behringer X32/M32') || protocols.includes('Allen & Heath') || protocols.includes('Yamaha CL/QL')) {
    return { ...DEVICE_TYPES['audio-mixer'], deviceType: 'audio-mixer', confidence: 'high' };
  }
  if (protocols.includes('sACN (E1.31)') || protocols.includes('Art-Net')) {
    return { ...DEVICE_TYPES['lighting'], deviceType: 'lighting', confidence: 'high' };
  }
  if (protocols.includes('Blackmagic REST')) {
    return { ...DEVICE_TYPES['encoder'], deviceType: 'encoder', confidence: 'high' };
  }
  if (protocols.includes('Shelly')) {
    return { ...DEVICE_TYPES['smart-plug'], deviceType: 'smart-plug', confidence: 'high' };
  }
  if (protocols.includes('Tally Encoder')) {
    return { ...DEVICE_TYPES['encoder'], deviceType: 'encoder', confidence: 'high' };
  }

  // Priority 2: Vendor-based (medium confidence)
  if (vendor && VENDOR_DEVICE_TYPES[vendor]) {
    const dt = VENDOR_DEVICE_TYPES[vendor];
    return { ...DEVICE_TYPES[dt], deviceType: dt, confidence: 'medium' };
  }

  // Priority 3: Port-based heuristics (low confidence)
  if (openPorts.includes(22) && openPorts.length <= 3) {
    return { ...DEVICE_TYPES['infrastructure'], deviceType: 'infrastructure', confidence: 'low' };
  }
  if (protocols.includes('Printer') || protocols.includes('Printer (IPP)')) {
    return { ...DEVICE_TYPES['printer'], deviceType: 'printer', confidence: 'medium' };
  }

  // Priority 4: mDNS service-based
  if (protocols.includes('AirPlay')) {
    return { ...DEVICE_TYPES['computer'], deviceType: 'computer', confidence: 'medium' };
  }
  if (protocols.includes('Chromecast')) {
    return { ...DEVICE_TYPES['computer'], deviceType: 'computer', confidence: 'medium' };
  }

  // Fallback
  const dt = device.deviceType || 'unknown';
  const typeInfo = DEVICE_TYPES[dt] || DEVICE_TYPES['unknown'];
  return { ...typeInfo, deviceType: dt, confidence: 'low' };
}

module.exports = { classify, classifyMdnsService, DEVICE_TYPES, VENDOR_DEVICE_TYPES };
