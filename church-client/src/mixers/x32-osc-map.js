/**
 * X32 / M32 OSC Parameter Scaling
 *
 * The Behringer X32 (and Midas M32) use normalised 0.0–1.0 floats for most
 * parameters, mapped to real-world units via logarithmic or stepped scales.
 * This module converts between human-readable values (Hz, dB, ratios) and the
 * floats the console expects.
 *
 * References:
 *   - Patrick-Gilles Maillot's X32 OSC documentation
 *   - Behringer X32 Producers firmware OSC tables
 */

'use strict';

// ─── HELPERS ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── HPF FREQUENCY (20–400 Hz, logarithmic) ────────────────────────────────

/** Hz → 0.0–1.0 */
function hpfFreqToFloat(hz) {
  const f = clamp(hz, 20, 400);
  return Math.log(f / 20) / Math.log(400 / 20); // log20(f/20)
}

/** 0.0–1.0 → Hz */
function hpfFloatToFreq(v) {
  return 20 * Math.pow(400 / 20, clamp(v, 0, 1));
}

// ─── EQ FREQUENCY (20–20 000 Hz, logarithmic) ──────────────────────────────

/** Hz → 0.0–1.0 */
function eqFreqToFloat(hz) {
  const f = clamp(hz, 20, 20000);
  return Math.log(f / 20) / Math.log(20000 / 20); // log1000(f/20)
}

/** 0.0–1.0 → Hz */
function eqFloatToFreq(v) {
  return 20 * Math.pow(1000, clamp(v, 0, 1));
}

// ─── EQ GAIN (-15 … +15 dB, linear) ────────────────────────────────────────

/** dB → 0.0–1.0 */
function eqGainToFloat(dB) {
  return (clamp(dB, -15, 15) + 15) / 30; // -15→0, 0→0.5, +15→1
}

/** 0.0–1.0 → dB */
function eqFloatToGain(v) {
  return clamp(v, 0, 1) * 30 - 15;
}

// ─── EQ Q / BANDWIDTH (10 → 0.3, logarithmic inverted) ─────────────────────
//
// X32 Q range: widest Q=10 at float 0.0, narrowest Q≈0.3 at float 1.0.
// The mapping is approximately: float = 1 - log(Q/0.3) / log(10/0.3)

/** Q → 0.0–1.0 */
function eqQToFloat(q) {
  const clamped = clamp(q, 0.3, 10);
  return 1 - Math.log(clamped / 0.3) / Math.log(10 / 0.3);
}

/** 0.0–1.0 → Q */
function eqFloatToQ(v) {
  return 0.3 * Math.pow(10 / 0.3, 1 - clamp(v, 0, 1));
}

// ─── COMPRESSOR THRESHOLD (-60 … 0 dB, linear) ─────────────────────────────

/** dB → 0.0–1.0 */
function compThreshToFloat(dB) {
  return (clamp(dB, -60, 0) + 60) / 60;
}

// ─── COMPRESSOR RATIO (discrete steps) ──────────────────────────────────────
//
// The X32 uses 12 ratio presets indexed 0–11.

const COMP_RATIOS = [1, 1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20]; // index 11 can also be ∞

/** Ratio (e.g. 4) → int index 0–11.  Picks the nearest match. */
function compRatioToIndex(ratio) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < COMP_RATIOS.length; i++) {
    const d = Math.abs(COMP_RATIOS[i] - ratio);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  // If ratio > 20 (infinity), use the last index
  if (ratio > 20) return 11;
  return best;
}

// ─── COMPRESSOR ATTACK (0–120 ms, linear) ───────────────────────────────────

/** ms → 0.0–1.0 */
function compAttackToFloat(ms) {
  return clamp(ms, 0, 120) / 120;
}

// ─── COMPRESSOR RELEASE (5 ms – 4 s, logarithmic) ──────────────────────────

/** ms → 0.0–1.0 */
function compReleaseToFloat(ms) {
  const clamped = clamp(ms, 5, 4000);
  return Math.log(clamped / 5) / Math.log(4000 / 5);
}

// ─── COMPRESSOR KNEE (0–5, linear) ──────────────────────────────────────────

/** knee value → 0.0–1.0 */
function compKneeToFloat(knee) {
  return clamp(knee, 0, 5) / 5;
}

// ─── GATE THRESHOLD (-80 … 0 dB, linear) ───────────────────────────────────

/** dB → 0.0–1.0 */
function gateThreshToFloat(dB) {
  return (clamp(dB, -80, 0) + 80) / 80;
}

// ─── GATE RANGE (3–80 dB, linear) ──────────────────────────────────────────

/** dB → 0.0–1.0 */
function gateRangeToFloat(dB) {
  return (clamp(dB, 3, 80) - 3) / (80 - 3);
}

// ─── GATE ATTACK (0.02–300 ms, logarithmic) ────────────────────────────────

/** ms → 0.0–1.0 */
function gateAttackToFloat(ms) {
  const clamped = clamp(ms, 0.02, 300);
  return Math.log(clamped / 0.02) / Math.log(300 / 0.02);
}

// ─── GATE HOLD (0.02 ms – 2 s, logarithmic) ────────────────────────────────

/** ms → 0.0–1.0 */
function gateHoldToFloat(ms) {
  const clamped = clamp(ms, 0.02, 2000);
  return Math.log(clamped / 0.02) / Math.log(2000 / 0.02);
}

// ─── GATE RELEASE (5 ms – 4 s, logarithmic) ────────────────────────────────

/** ms → 0.0–1.0 */
function gateReleaseToFloat(ms) {
  const clamped = clamp(ms, 5, 4000);
  return Math.log(clamped / 5) / Math.log(4000 / 5);
}

// ─── FADER (dB → 0.0–1.0, non-linear taper) ────────────────────────────────
//
// The X32 fader uses a non-linear curve.  Key calibration points:
//   0.0   → -∞ dB   (off)
//   0.25  → -30 dB
//   0.50  → -10 dB
//   0.75  →   0 dB   (unity)
//   1.0   → +10 dB
//
// We use a piecewise linear approximation between these known points.

const FADER_TABLE = [
  { f: 0.00, dB: -90 },  // treat -90 as -∞
  { f: 0.25, dB: -30 },
  { f: 0.50, dB: -10 },
  { f: 0.75, dB:   0 },
  { f: 1.00, dB:  10 },
];

/** dB → 0.0–1.0 (piecewise linear interpolation) */
function faderDbToFloat(dB) {
  if (dB <= -90) return 0;
  for (let i = 1; i < FADER_TABLE.length; i++) {
    if (dB <= FADER_TABLE[i].dB) {
      const a = FADER_TABLE[i - 1];
      const b = FADER_TABLE[i];
      const t = (dB - a.dB) / (b.dB - a.dB);
      return a.f + t * (b.f - a.f);
    }
  }
  return 1.0;
}

// ─── EQ BAND TYPES ──────────────────────────────────────────────────────────

const EQ_TYPES = {
  LCUT:   0,  // Low Cut
  LSHELF: 1,  // Low Shelf
  PEQ:    2,  // Parametric EQ
  VEQ:    3,  // Vintage EQ
  HSHELF: 4,  // High Shelf
  HCUT:   5,  // High Cut
};

// ─── GATE MODES ─────────────────────────────────────────────────────────────

const GATE_MODES = {
  EXP2: 0,
  EXP3: 1,
  EXP4: 2,
  GATE: 3,
  DUCK: 4,
};

// ─── PAN (-1.0 … +1.0 → 0.0–1.0, linear) ───────────────────────────────────
//
// X32 pan: 0.0 = hard left, 0.5 = center, 1.0 = hard right.
// We accept -1.0 (L) to +1.0 (R) for a more intuitive API.

/** Pan -1.0 (L) to +1.0 (R) → float 0.0–1.0 */
function panToFloat(pan) {
  return (clamp(pan, -1, 1) + 1) / 2;
}

/** Float 0.0–1.0 → pan -1.0 to +1.0 */
function panFloatToValue(v) {
  return clamp(v, 0, 1) * 2 - 1;
}

// ─── PREAMP TRIM (-18 … +18 dB, linear) ─────────────────────────────────────
//
// Digital trim control on /ch/XX/preamp/trim.

/** dB → 0.0–1.0 */
function trimGainToFloat(dB) {
  return (clamp(dB, -18, 18) + 18) / 36;
}

/** 0.0–1.0 → dB */
function trimFloatToGain(v) {
  return clamp(v, 0, 1) * 36 - 18;
}

// ─── HEADAMP GAIN (-12 … +60 dB, linear) ────────────────────────────────────
//
// Analog preamp gain on /headamp/XXX/gain.

/** dB → 0.0–1.0 */
function headampGainToFloat(dB) {
  return (clamp(dB, -12, 60) + 12) / 72;
}

/** 0.0–1.0 → dB */
function headampFloatToGain(v) {
  return clamp(v, 0, 1) * 72 - 12;
}

// ─── SEND LEVEL (same non-linear taper as main fader) ───────────────────────
//
// Bus send levels use the identical pseudo-log curve as the main fader.

const sendLevelDbToFloat = faderDbToFloat;

// ─── SCRIBBLE STRIP COLORS ──────────────────────────────────────────────────
//
// X32 supports 16 colors (8 normal + 8 inverted) indexed 0–15.

const X32_COLORS = {
  OFF: 0, RD: 1, GN: 2, YE: 3, BL: 4, MG: 5, CY: 6, WH: 7,
  OFFi: 8, RDi: 9, GNi: 10, YEi: 11, BLi: 12, MGi: 13, CYi: 14, WHi: 15,
  // Friendly aliases (lowercase)
  off: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  'off-inv': 8, 'red-inv': 9, 'green-inv': 10, 'yellow-inv': 11,
  'blue-inv': 12, 'magenta-inv': 13, 'cyan-inv': 14, 'white-inv': 15,
  // Lowercase short codes
  rd: 1, gn: 2, ye: 3, bl: 4, mg: 5, cy: 6, wh: 7,
  offi: 8, rdi: 9, gni: 10, yei: 11, bli: 12, mgi: 13, cyi: 14, whi: 15,
};

/**
 * Normalize color input (name string or integer) to int 0–15.
 * @param {string|number} input  Color name or index
 * @returns {number}
 */
function normalizeColor(input) {
  if (typeof input === 'number') return clamp(Math.round(input), 0, 15);
  const key = String(input).toLowerCase().trim();
  if (key in X32_COLORS) return X32_COLORS[key];
  const n = parseInt(key);
  if (!isNaN(n)) return clamp(n, 0, 15);
  throw new Error(`Unknown X32 color: "${input}". Use 0–15, or: off, red, green, yellow, blue, magenta, cyan, white (add -inv for inverted)`);
}

// ─── SCRIBBLE STRIP ICONS ────────────────────────────────────────────────────
//
// X32 supports 74 icons indexed 1–74.

const X32_ICONS = {
  blank: 1, 'kick-back': 2, 'kick-front': 3, 'snare-top': 4, 'snare-bottom': 5,
  'tom-high': 6, 'tom-medium': 7, tom: 8, charley: 9, crash: 10,
  drums: 11, bell: 12, 'congas-1': 13, 'congas-2': 14, tambourine: 15,
  xylophone: 16, 'elec-bass': 17, 'acou-bass-1': 18, 'acou-bass-2': 19,
  'elec-guit-1': 20, 'elec-guit-2': 21, 'elec-guit-3': 22, 'acou-guit': 23,
  'amp-1': 24, 'amp-2': 25, 'amp-3': 26, 'acou-piano': 27, organ: 28,
  'elec-key-1': 29, 'elec-key-2': 30, 'synth-1': 31, 'synth-2': 32,
  'synth-3': 33, 'synth-4': 34, trumpet: 35, trombone: 36, sax: 37,
  clarinette: 38, violin: 39, cello: 40, 'male-singer': 41, 'female-singer': 42,
  choir: 43, 'hand-sign': 44, 'talk-a': 45, 'talk-b': 46, 'mic-1': 47,
  'c-mic-left': 48, 'c-mic-right': 49, 'mic-2': 50, 'wireless-mic': 51,
  'table-mic': 52, 'in-ear': 53, xlr: 54, trs: 55, 'trs-left': 56,
  'trs-right': 57, 'cinch-left': 58, 'cinch-right': 59, 'tape-recorder': 60,
  fx: 61, pc: 62, wedge: 63, 'speaker-right': 64, 'speaker-left': 65,
  'speaker-array': 66, 'speaker-stand': 67, rack: 68, controls: 69,
  faders: 70, 'routing-main': 71, 'routing-bus': 72, 'routing-dispatch': 73, smiley: 74,
  // Common church-AV aliases
  kick: 2, snare: 4, hihat: 9, cymbal: 10, guitar: 23, bass: 17,
  piano: 27, keys: 29, keyboard: 29, synth: 31, mic: 47, vocal: 41,
  vocals: 41, singer: 41, speaker: 64, monitor: 63, di: 55, wireless: 51,
};

/**
 * Normalize icon input (name string or integer) to int 1–74.
 * @param {string|number} input  Icon name or index
 * @returns {number}
 */
function normalizeIcon(input) {
  if (typeof input === 'number') return clamp(Math.round(input), 1, 74);
  const key = String(input).toLowerCase().trim();
  if (key in X32_ICONS) return X32_ICONS[key];
  const n = parseInt(key);
  if (!isNaN(n)) return clamp(n, 1, 74);
  throw new Error(`Unknown X32 icon: "${input}". Use 1–74, or names like: mic, vocal, guitar, bass, piano, drums, kick, snare, etc.`);
}

module.exports = {
  clamp,
  hpfFreqToFloat,
  hpfFloatToFreq,
  eqFreqToFloat,
  eqFloatToFreq,
  eqGainToFloat,
  eqFloatToGain,
  eqQToFloat,
  eqFloatToQ,
  compThreshToFloat,
  compRatioToIndex,
  compAttackToFloat,
  compReleaseToFloat,
  compKneeToFloat,
  gateThreshToFloat,
  gateRangeToFloat,
  gateAttackToFloat,
  gateHoldToFloat,
  gateReleaseToFloat,
  faderDbToFloat,
  panToFloat,
  panFloatToValue,
  trimGainToFloat,
  trimFloatToGain,
  headampGainToFloat,
  headampFloatToGain,
  sendLevelDbToFloat,
  normalizeColor,
  normalizeIcon,
  EQ_TYPES,
  GATE_MODES,
  COMP_RATIOS,
  X32_COLORS,
  X32_ICONS,
};
