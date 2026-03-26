/**
 * config-manager.js — Config load/save with encryption and mock-stripping.
 *
 * Extracted from main.js — pure refactoring, no behaviour changes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { encryptConfig, decryptConfig } = require('./secureStorage');

const CONFIG_PATH = path.join(os.homedir(), '.church-av', 'config.json');
const CONFIG_DIR  = path.dirname(CONFIG_PATH);

// Injected dependency — set via init()
let _enforceRelayPolicy = (url) => url; // identity fallback until wired

/**
 * Wire the relay-policy function so loadConfig / saveConfig can normalise
 * the relay URL.  Call once from main.js after both modules are loaded.
 */
function init({ enforceRelayPolicy }) {
  if (typeof enforceRelayPolicy === 'function') {
    _enforceRelayPolicy = enforceRelayPolicy;
  }
}

// ─── Schema version & migrations ──────────────────────────────────────────────

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Migrate a loaded config object from an older schemaVersion to the current one.
 * Add a new `case` block here whenever a breaking field rename/restructure lands.
 *
 * @param {object} config — decrypted, mock-stripped config from disk
 * @returns {object} — migrated config (may be same reference if no migration needed)
 */
function migrateConfig(config) {
  let version = config.schemaVersion || 0;

  // v0 → v1: nothing structural changed yet; just stamp the version field.
  // Future migrations go here as:
  //   case 1: config = { ...config, newField: config.oldField }; delete config.oldField; // fall through
  if (version < 1) {
    version = 1;
  }

  return { ...config, schemaVersion: version };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isMockValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'mock' || v === 'fake' || v === 'sim' || v === 'simulate' || v.startsWith('mock://') || v.includes('mock-hyperdeck');
}

function stripMockConfig(config = {}) {
  const cleaned = { ...(config || {}) };

  if (isMockValue(cleaned.atemIp)) cleaned.atemIp = '';
  if (isMockValue(cleaned.obsUrl)) {
    cleaned.obsUrl = '';
    cleaned.obsPassword = '';
  }
  if (cleaned.proPresenter && isMockValue(cleaned.proPresenter.host)) cleaned.proPresenter = null;
  if (cleaned.mixer && isMockValue(cleaned.mixer.host)) cleaned.mixer = null;
  if (Array.isArray(cleaned.hyperdecks)) {
    cleaned.hyperdecks = cleaned.hyperdecks.filter((entry) => !isMockValue(entry));
  }
  delete cleaned.mockProduction;
  delete cleaned.fakeAtemApiPort;
  delete cleaned._preMock;
  return cleaned;
}

// ─── config cache ────────────────────────────────────────────────────────────
let _configCache = null;
let _configMtime = 0;

function _isCacheValid() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    return _configCache !== null && stat.mtimeMs === _configMtime;
  } catch { return false; }
}

// ─── public API ───────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) return {};
  // Return cached config if file hasn't changed (skips disk read + decrypt + PBKDF2)
  if (_isCacheValid()) return { ..._configCache };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const decrypted = stripMockConfig(decryptConfig(raw)); // decrypt secure fields on load
    const config = migrateConfig(decrypted); // upgrade schema if needed
    config.relay = _enforceRelayPolicy(config.relay);
    // Cache the result
    _configCache = { ...config };
    try { _configMtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch { /* ignore */ }
    return config;
  } catch (err) {
    // Config file is corrupted — save backup and start fresh
    const backupPath = CONFIG_PATH + '.corrupt.' + Date.now();
    try { fs.copyFileSync(CONFIG_PATH, backupPath); } catch { /* best effort */ }
    console.error(`Config corrupted (backed up to ${backupPath}): ${err.message}`);
    _configCache = null;
    return {};
  }
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Merge partial UI updates into existing config so token/relay are not lost.
  const merged = { ...loadConfig(), ...(config || {}) };
  // Only persist defined values; undefined means "leave existing as-is" before merge.
  const toSave = stripMockConfig(Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)));
  toSave.relay = _enforceRelayPolicy(toSave.relay);
  // Atomic write: write to temp file then rename (crash-safe)
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(encryptConfig(toSave), null, 2));
  fs.renameSync(tmpPath, CONFIG_PATH);
  // Invalidate cache so next loadConfig() reads fresh data
  _configCache = null;
  _configMtime = 0;
}

// Return config with flags instead of actual key values for the UI
// (never send streaming keys to the renderer process)
function loadConfigForUI() {
  const config = loadConfig();
  const ui = { ...config };
  const SENSITIVE = ['youtubeApiKey', 'facebookAccessToken', 'vimeoAccessToken', 'rtmpStreamKey', 'twitchStreamKey', 'obsPassword', 'churchToken'];
  for (const field of SENSITIVE) {
    ui[`${field.replace(/([A-Z])/g, m => m[0].toLowerCase())}Set`] = !!(config[field]);
    delete ui[field]; // never expose to renderer
  }
  // Convenience flags for the UI
  ui.youtubeKeySet = !!(config.youtubeApiKey);
  ui.facebookTokenSet = !!(config.facebookAccessToken);
  ui.vimeoTokenSet = !!(config.vimeoAccessToken);
  ui.rtmpKeySet = !!(config.rtmpStreamKey);
  // OAuth connection flags
  ui.youtubeOAuthConnected = !!(config.youtubeOAuthAccessToken || config.youtubeStreamKey);
  ui.facebookOAuthConnected = !!(config.facebookOAuthAccessToken || config.facebookStreamKey);
  ui.facebookPageName = config.facebookPageName || '';
  // Remove OAuth tokens from UI payload
  delete ui.youtubeOAuthAccessToken;
  delete ui.youtubeOAuthRefreshToken;
  delete ui.facebookOAuthAccessToken;
  delete ui.youtubeStreamKey;
  delete ui.facebookStreamKey;
  delete ui.youtubeStreamUrl;
  delete ui.facebookStreamUrl;
  return ui;
}

function getSanitizedConfigForExport() {
  const config = loadConfig();
  const sanitized = { ...config };
  const redactFields = [
    'token',
    'churchToken',
    'obsPassword',
    'youtubeApiKey',
    'facebookAccessToken',
    'vimeoAccessToken',
    'rtmpStreamKey',
    'twitchStreamKey',
    'adminApiKey',
  ];

  for (const field of redactFields) {
    if (sanitized[field] !== undefined && sanitized[field] !== null && sanitized[field] !== '') {
      sanitized[field] = '[redacted]';
    }
  }

  // Also redact passwords inside nested encoder/PTZ objects
  if (Array.isArray(sanitized.encoders)) {
    sanitized.encoders = sanitized.encoders.map(e => {
      if (e && e.password) return { ...e, password: '[redacted]' };
      return e;
    });
  }
  if (sanitized.encoder && sanitized.encoder.password) {
    sanitized.encoder = { ...sanitized.encoder, password: '[redacted]' };
  }
  if (Array.isArray(sanitized.ptz)) {
    sanitized.ptz = sanitized.ptz.map(p => {
      const cleaned = { ...p };
      if (cleaned.password) cleaned.password = '[redacted]';
      if (cleaned.username) cleaned.username = '[redacted]';
      return cleaned;
    });
  }
  // Redact OAuth tokens
  const oauthFields = ['youtubeOAuthAccessToken', 'youtubeOAuthRefreshToken', 'facebookOAuthAccessToken'];
  for (const field of oauthFields) {
    if (sanitized[field]) sanitized[field] = '[redacted]';
  }

  return sanitized;
}

/**
 * Export config as a portable, non-encrypted JSON blob.
 * Credentials that are machine-encrypted are written in plaintext so the
 * export can be imported on another machine where safeStorage would differ.
 *
 * Sensitive auth fields (token, churchToken) are ALWAYS omitted — those must
 * be re-entered after import.  Equipment IPs, ports, labels, and passwords
 * are included so the equipment layout is fully portable.
 */
function exportPortableConfig() {
  const config = loadConfig(); // decrypted in memory
  const portable = { ...config };

  // Drop auth tokens — not portable (machine-scoped JWTs)
  const AUTH_FIELDS = ['token', 'churchToken', 'youtubeOAuthAccessToken', 'youtubeOAuthRefreshToken', 'facebookOAuthAccessToken'];
  for (const f of AUTH_FIELDS) delete portable[f];

  // Tag the export so the importer knows this is portable (not a diagnostic redacted copy)
  portable._portableExport = true;
  portable._exportedAt = new Date().toISOString();
  portable._exportVersion = 1;

  return portable;
}

/**
 * Import a portable config blob.  Re-encrypts sensitive fields via
 * encryptConfig / saveConfig so they are stored safely on the new machine.
 *
 * @param {object} portableBlob — the parsed JSON from exportPortableConfig()
 * @returns {{ ok: boolean, warning?: string }}
 */
function importPortableConfig(portableBlob) {
  if (!portableBlob || typeof portableBlob !== 'object') {
    return { ok: false, error: 'Invalid config file — expected a JSON object.' };
  }
  if (!portableBlob._portableExport) {
    return { ok: false, error: 'This file does not appear to be a Tally portable config export.' };
  }

  // Strip the export metadata before merging
  const { _portableExport, _exportedAt, _exportVersion, ...incoming } = portableBlob;

  // Auth tokens are never imported — the user must sign in on the new machine
  const AUTH_FIELDS = ['token', 'churchToken', 'youtubeOAuthAccessToken', 'youtubeOAuthRefreshToken', 'facebookOAuthAccessToken'];
  for (const f of AUTH_FIELDS) delete incoming[f];

  // Merge over current config (keeps any local token if already signed in)
  const current = loadConfig();
  const merged = { ...current, ...incoming };

  saveConfig(merged);
  return { ok: true };
}

module.exports = {
  init,
  isMockValue,
  stripMockConfig,
  migrateConfig,
  CURRENT_SCHEMA_VERSION,
  loadConfig,
  saveConfig,
  loadConfigForUI,
  getSanitizedConfigForExport,
  exportPortableConfig,
  importPortableConfig,
  CONFIG_PATH,
  CONFIG_DIR,
};
