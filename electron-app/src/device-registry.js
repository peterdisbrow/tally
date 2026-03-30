/**
 * Device Registry — Single source of truth for all equipment types.
 * Pure data, no side effects. Loaded before renderer.js and equipment-ui.js.
 */

/* eslint-disable no-unused-vars */

const DEVICE_CATEGORIES = [
  { id: 'core', name: 'Core' },
  { id: 'recording', name: 'Recording & Playback' },
  { id: 'presentation', name: 'Presentation & Video' },
  { id: 'audio', name: 'Audio' },
];

const DEVICE_REGISTRY = {
  atem: {
    id: 'atem',
    name: 'ATEM Switcher',
    icon: '\u{1F39B}',
    category: 'core',
    description: 'Blackmagic video switcher (UDP 9910)',
    multi: false,
    fields: [
      { key: 'ip', label: 'IP Address', type: 'text', placeholder: '192.168.1.10' },
    ],
    testType: 'atem',
  },

  encoder: {
    id: 'encoder',
    name: 'Streaming Encoder',
    icon: '\u{1F4E1}',
    category: 'core',
    description: 'Default encoder for monitoring and status',
    multi: true,
    maxInstances: 4,
    subtype: true,
    fields: [], // fields are dynamic per encoder subtype
    testType: 'encoder',
  },

  companion: {
    id: 'companion',
    name: 'Bitfocus Companion',
    icon: '\u{1F518}',
    category: 'core',
    description: 'Button control surface (HTTP)',
    multi: false,
    fields: [
      { key: 'host', label: 'IP / Host', type: 'text', placeholder: 'localhost' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '8888', style: 'width:92px' },
    ],
    testType: 'companion',
  },

  'atem-recording': {
    id: 'atem-recording',
    name: 'ATEM Recording',
    icon: '\u23FA',
    category: 'recording',
    description: 'Record to USB/SSD on ATEM switchers with built-in recording',
    multi: false,
    fields: [
      { key: 'autoRecord', label: 'Auto-record when stream starts', type: 'checkbox' },
    ],
  },

  hyperdeck: {
    id: 'hyperdeck',
    name: 'HyperDeck',
    icon: '\u23FA',
    category: 'recording',
    description: 'Blackmagic recording deck (TCP 9993)',
    multi: true,
    maxInstances: 8,
    fields: [
      { key: 'ip', label: 'IP Address', type: 'text', placeholder: '192.168.1.20' },
    ],
    testType: 'hyperdeck',
  },

  ptz: {
    id: 'ptz',
    name: 'PTZ Camera',
    icon: '\u{1F4F7}',
    category: 'core',
    description: 'Supports ONVIF and VISCA over IP (TCP/UDP)',
    multi: true,
    maxInstances: 8,
    fields: [
      { key: 'ip', label: 'IP', type: 'text', placeholder: '192.168.1.30' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Camera name' },
      { key: 'protocol', label: 'Protocol', type: 'select', options: [
        { value: 'auto', label: 'Auto' },
        { value: 'ptzoptics-visca', label: 'PTZOptics VISCA TCP' },
        { value: 'ptzoptics-onvif', label: 'PTZOptics ONVIF' },
        { value: 'onvif', label: 'ONVIF' },
        { value: 'visca-tcp', label: 'VISCA TCP' },
        { value: 'visca-udp', label: 'VISCA UDP' },
        { value: 'sony-visca-udp', label: 'Sony VISCA UDP' },
      ]},
      { key: 'port', label: 'Port', type: 'number', placeholder: 'Port', style: 'width:92px' },
      { key: 'username', label: 'User', type: 'text', placeholder: 'User', style: 'width:120px' },
      { key: 'password', label: 'Pass', type: 'password', placeholder: 'Pass', style: 'width:120px' },
    ],
    testType: 'ptz',
  },

  propresenter: {
    id: 'propresenter',
    name: 'ProPresenter',
    icon: '\u{1F4FA}',
    category: 'presentation',
    description: 'Renewed Vision presentation (HTTP)',
    multi: false,
    fields: [
      { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost' },
      { key: 'port', label: 'Port', type: 'text', placeholder: '1025', style: 'max-width:80px' },
    ],
    testType: 'propresenter',
  },

  vmix: {
    id: 'vmix',
    name: 'vMix',
    icon: '\u{1F3AC}',
    category: 'presentation',
    description: 'Windows live production (HTTP 8088)',
    multi: false,
    fields: [
      { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost or 192.168.1.x' },
      { key: 'port', label: 'Port', type: 'text', placeholder: '8088', style: 'max-width:80px' },
    ],
    testType: 'vmix',
  },

  resolume: {
    id: 'resolume',
    name: 'Resolume Arena',
    icon: '\u{1F4A1}',
    category: 'presentation',
    description: 'LED wall / video display control (HTTP 8080)',
    multi: false,
    fields: [
      { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost or 192.168.1.x' },
      { key: 'port', label: 'Port', type: 'text', placeholder: '8080', style: 'max-width:80px' },
    ],
    testType: 'resolume',
  },

  videohub: {
    id: 'videohub',
    name: 'VideoHub',
    icon: '\u{1F500}',
    category: 'presentation',
    description: 'Blackmagic SDI/HDMI router (TCP 9990)',
    multi: true,
    maxInstances: 4,
    fields: [
      { key: 'ip', label: 'IP', type: 'text', placeholder: '192.168.1.50' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Name (optional)' },
    ],
    testType: 'videohub',
  },

  'smart-plug': {
    id: 'smart-plug',
    name: 'Smart Plug (Shelly)',
    icon: '\u{1F50C}',
    category: 'core',
    description: 'Shelly WiFi smart plug — power monitoring and control (HTTP)',
    multi: true,
    maxInstances: 8,
    fields: [
      { key: 'ip', label: 'IP Address', type: 'text', placeholder: '192.168.1.100' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Projector Power' },
    ],
    testType: 'smart-plug',
  },

  mixer: {
    id: 'mixer',
    name: 'Audio Console',
    icon: '\u{1F39A}',
    category: 'audio',
    description: 'OSC-compatible mixing console',
    multi: false,
    fields: [
      { key: 'type', label: 'Audio Source', type: 'select', options: [
        { value: '', label: '\u2014 Not configured \u2014' },
        { value: 'atem-auto', label: 'Auto-detect from ATEM (recommended)' },
        { value: 'atem-direct', label: 'Force: Audio via ATEM (override)' },
        { value: 'atem-none', label: 'Force: No ATEM audio (override)' },
        { value: 'x32', label: 'X32 (Behringer protocol)' },
        { value: 'behringer', label: 'Behringer X32 / X-Air' },
        { value: 'midas', label: 'Midas M32 / M32R' },
        { value: 'allenheath', label: 'Allen & Heath SQ' },
        { value: 'dlive', label: 'Allen & Heath dLive' },
        { value: 'avantis', label: 'Allen & Heath Avantis' },
        { value: 'yamaha', label: 'Yamaha CL / QL / TF' },
      ]},
      { key: 'host', label: 'IP Address', type: 'text', placeholder: 'Console IP address' },
      { key: 'port', label: 'Port', type: 'text', placeholder: 'Auto', style: 'max-width:80px' },
    ],
    testType: 'mixer',
    detailHint: 'Default ports: X32/M32=10023, A&H SQ=51326, A&H dLive/Avantis=51325, Yamaha CL/QL=8765, TF=49280',
  },
};

/**
 * Encoder subtype definitions — extracted from onEncoderTypeChanged().
 * Keys match the <option value="..."> in the encoder type dropdown.
 */
const ENCODER_OPTIONS = [
  { value: '', label: 'Not configured' },
  { value: 'blackmagic', label: 'Blackmagic Web Presenter / Streaming Encoder' },
  { value: 'obs', label: 'OBS Studio' },
  { value: 'vmix', label: 'vMix' },
  { value: 'atem-streaming', label: 'ATEM Mini (built-in streaming)' },
  { value: 'ecamm', label: 'Ecamm Live (Mac)' },
  { value: 'aja', label: 'AJA HELO' },
  { value: 'epiphan', label: 'Epiphan Pearl' },
  { value: 'teradek', label: 'Teradek Cube / VidiU' },
  { value: 'tricaster', label: 'TriCaster' },
  { value: 'birddog', label: 'BirdDog' },
  { value: 'yolobox', label: 'YoloBox' },
  { value: 'youtube-live', label: 'YouTube Live (CDN destination)' },
  { value: 'facebook-live', label: 'Facebook Live (CDN destination)' },
  { value: 'vimeo-live', label: 'Vimeo Live (CDN destination)' },
  { value: 'tally-encoder', label: 'Tally Encoder' },
  { value: 'custom', label: 'Custom Encoder' },
];

const ENCODER_API_TYPES = ['obs', 'vmix', 'blackmagic', 'aja', 'epiphan', 'teradek', 'tricaster', 'birddog', 'tally-encoder', 'custom'];
const ENCODER_RTMP_TYPES = ['yolobox', 'youtube-live', 'facebook-live', 'vimeo-live', 'rtmp-generic', 'custom-rtmp'];

const ENCODER_DEFAULTS = {
  obs:              { host: 'localhost', port: '4455', pw: true,  note: 'OBS WebSocket v5 \u2014 GetStats, StartStream, StopStream' },
  vmix:             { host: 'localhost', port: '8088',            note: 'vMix HTTP API \u2014 streaming, recording, status' },
  blackmagic:       { host: '',          port: '80',              note: 'REST API v1 \u2014 streaming status, start/stop, platform config, bitrate' },
  aja:              { host: '',          port: '80',  pw: true,   note: 'REST API \u2014 start/stop stream/record, profiles, inputs, temperature' },
  epiphan:          { host: '',          port: '80',  pw: true,   note: 'REST API v2 \u2014 channels, publishers, recorders, layouts, system status' },
  teradek:          { host: '',          port: '80',  pw: true,   note: 'CGI API \u2014 broadcast start/stop, recording, bitrate, battery, video input' },
  tricaster:        { host: '',          port: '5951', pw: true,  note: 'Shortcut API \u2014 stream/record transport and production state' },
  birddog:          { host: '',          port: '8080', source: true, note: 'BirdDog API + optional NDI source monitoring' },
  'tally-encoder':  { host: '',          port: '7070',            note: 'Tally Encoder API \u2014 streams to relay server' },
  custom:           { host: '',          port: '80',  statusUrl: true, note: 'Custom HTTP status endpoint' },
};

/** Mapping from network scan result keys to device registry IDs */
const SCAN_TO_DEVICE = {
  atem: 'atem',
  companion: 'companion',
  obs: 'encoder',
  hyperdeck: 'hyperdeck',
  propresenter: 'propresenter',
  vmix: 'vmix',
  resolume: 'resolume',
  tricaster: 'encoder',
  birddog: 'encoder',
  videohub: 'videohub',
  mixers: 'mixer',
  encoders: 'encoder',
  'smart-plug': 'smart-plug',
};

/** Encoder display names for dashboard labels */
const ENCODER_DISPLAY_NAMES = {
  obs: 'OBS', vmix: 'vMix', ecamm: 'Ecamm', blackmagic: 'Blackmagic',
  aja: 'AJA HELO', epiphan: 'Epiphan', teradek: 'Teradek', tricaster: 'TriCaster', birddog: 'BirdDog',
  yolobox: 'YoloBox', 'youtube-live': 'YouTube Live', 'facebook-live': 'Facebook Live', 'vimeo-live': 'Vimeo Live', 'tally-encoder': 'Tally Encoder', custom: 'Custom',
  'atem-streaming': 'ATEM Mini',
};

// CommonJS export — allows `require()` from Node.js while remaining
// a plain <script> global in the Electron renderer.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEVICE_CATEGORIES,
    DEVICE_REGISTRY,
    ENCODER_OPTIONS,
    ENCODER_API_TYPES,
    ENCODER_RTMP_TYPES,
    ENCODER_DEFAULTS,
    SCAN_TO_DEVICE,
    ENCODER_DISPLAY_NAMES,
  };
}
