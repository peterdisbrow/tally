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
  EQ_TYPES,
  GATE_MODES,
  COMP_RATIOS,
};
