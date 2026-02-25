/**
 * Config Manager — encrypted JSON config load/save/sanitize
 *
 * Extracted from main.js. Handles reading, writing, and sanitizing the
 * church-av config file with secure field encryption via secureStorage.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { encryptConfig, decryptConfig } = require('./secureStorage');
const { enforceRelayPolicy } = require('./relay-client');

const CONFIG_PATH = path.join(os.homedir(), '.church-av', 'config.json');
const CONFIG_DIR  = path.dirname(CONFIG_PATH);

// ─── MOCK DETECTION ───────────────────────────────────────────────────────────

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

// ─── LOAD / SAVE ──────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const config = stripMockConfig(decryptConfig(raw)); // decrypt secure fields on load
    config.relay = enforceRelayPolicy(config.relay);
    return config;
  }
  catch { return {}; }
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Merge partial UI updates into existing config so token/relay are not lost.
  const merged = { ...loadConfig(), ...(config || {}) };
  // Only persist defined values; undefined means "leave existing as-is" before merge.
  const toSave = stripMockConfig(Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)));
  toSave.relay = enforceRelayPolicy(toSave.relay);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(encryptConfig(toSave), null, 2));
}

// ─── UI / EXPORT HELPERS ──────────────────────────────────────────────────────

/**
 * Return config with flags instead of actual key values for the UI
 * (never send streaming keys to the renderer process)
 */
function loadConfigForUI() {
  const config = loadConfig();
  const ui = { ...config };
  const SENSITIVE = ['youtubeApiKey', 'facebookAccessToken', 'rtmpStreamKey', 'twitchStreamKey', 'obsPassword', 'churchToken'];
  for (const field of SENSITIVE) {
    ui[`${field.replace(/([A-Z])/g, m => m[0].toLowerCase())}Set`] = !!(config[field]);
    delete ui[field]; // never expose to renderer
  }
  // Convenience flags for the UI
  ui.youtubeKeySet = !!(config.youtubeApiKey);
  ui.facebookTokenSet = !!(config.facebookAccessToken);
  ui.rtmpKeySet = !!(config.rtmpStreamKey);
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
    'rtmpStreamKey',
    'twitchStreamKey',
    'adminApiKey',
  ];

  for (const field of redactFields) {
    if (sanitized[field] !== undefined && sanitized[field] !== null && sanitized[field] !== '') {
      sanitized[field] = '[redacted]';
    }
  }

  return sanitized;
}

module.exports = {
  CONFIG_PATH,
  CONFIG_DIR,
  isMockValue,
  stripMockConfig,
  loadConfig,
  saveConfig,
  loadConfigForUI,
  getSanitizedConfigForExport,
};
