/**
 * i18n.js — Lightweight internationalisation layer.
 *
 * Usage (main process and renderer):
 *   const { t, setLocale, getLocale } = require('./i18n'); // main
 *   const { t, setLocale }            = window.i18n;       // renderer (after init)
 *
 * Locale detection order:
 *   1. Saved preference in localStorage / prefs.json  (user override)
 *   2. navigator.language / app.getLocale()           (OS locale)
 *   3. 'en'                                           (fallback)
 *
 * Supported locales: en (English), es (Spanish)
 */

'use strict';

// ─── Locale data (bundled — no network fetch required) ───────────────────────

const LOCALES = {};

function _loadLocales() {
  try {
    // Main process: require locale JSON files
    LOCALES['en'] = require('./locales/en.json');
    LOCALES['es'] = require('./locales/es.json');
  } catch {
    // Renderer / bundled context — locales injected via window.TALLY_LOCALES
    if (typeof window !== 'undefined' && window.TALLY_LOCALES) {
      Object.assign(LOCALES, window.TALLY_LOCALES);
    }
  }
}

_loadLocales();

// ─── State ───────────────────────────────────────────────────────────────────

let _locale = 'en';

/**
 * Set the active locale.  Unsupported locales fall back to 'en'.
 */
function setLocale(locale) {
  const normalized = (locale || 'en').toLowerCase().replace(/_/g, '-').split('-')[0];
  _locale = LOCALES[normalized] ? normalized : 'en';
}

function getLocale() { return _locale; }

/**
 * Resolve a dotted key against the active locale, falling back to 'en'.
 * Supports simple {{placeholder}} interpolation.
 *
 * @param {string} key   — e.g. 'signIn.submitButton'
 * @param {object} [vars] — e.g. { name: 'Andrew' }
 * @returns {string}
 */
function t(key, vars) {
  const parts = key.split('.');
  let value = null;

  // Try active locale
  let obj = LOCALES[_locale];
  for (const p of parts) { obj = obj && typeof obj === 'object' ? obj[p] : undefined; }
  if (typeof obj === 'string') value = obj;

  // Fall back to 'en'
  if (value === null && _locale !== 'en') {
    let fb = LOCALES['en'];
    for (const p of parts) { fb = fb && typeof fb === 'object' ? fb[p] : undefined; }
    if (typeof fb === 'string') value = fb;
  }

  if (value === null) return key; // Return key as last resort

  // Interpolate {{var}} placeholders
  if (vars && typeof vars === 'object') {
    value = value.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
  }

  return value;
}

/**
 * Auto-detect locale from OS/browser and apply it.
 * Call once during app init.
 */
function detectAndApplyLocale(savedLocale) {
  if (savedLocale) { setLocale(savedLocale); return; }

  let detected = 'en';
  if (typeof navigator !== 'undefined' && navigator.language) {
    detected = navigator.language;
  } else if (typeof process !== 'undefined') {
    // Main process: try LANG env var
    detected = process.env.LANG || process.env.LANGUAGE || 'en';
  }
  setLocale(detected);
}

module.exports = { t, setLocale, getLocale, detectAndApplyLocale, LOCALES };
