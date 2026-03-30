const { toInt } = require('./helpers');

// ─── BLACKMAGIC CAMERA CONTROL (via ATEM) ───────────────────────────────────

const CAMERA_CTRL = {
  // Blackmagic Camera Control Protocol categories & parameters
  LENS: 0,
  VIDEO: 1,
  COLOR: 8,
  // Lens parameters
  FOCUS: 0,
  AUTO_FOCUS: 1,
  IRIS: 2,
  AUTO_IRIS: 3,
  // Video parameters
  GAIN: 1,
  WHITE_BALANCE: 2,
  AUTO_WB: 3,
  SHUTTER_SPEED: 5,
  SHUTTER_ANGLE: 8,
  ISO: 13,
  // Additional lens parameters
  OIS: 6,
  ZOOM_SPEED: 8,
  // Additional video parameters
  EXPOSURE: 6,
  SHARPENING: 14,
  ND_FILTER: 16,
  // Display category
  DISPLAY: 4,
  COLOR_BARS: 4,
  FOCUS_ASSIST: 0,
  FALSE_COLOR: 6,
  ZEBRA: 7,
  STATUS_OVERLAY: 1,
  // Media category
  MEDIA: 10,
  TRANSPORT_MODE: 0,
  // Color correction parameters
  LIFT: 0,
  GAMMA: 1,
  COLOR_GAIN: 2,
  OFFSET: 3,
  CONTRAST: 4,
  LUM_MIX: 5,
  HUE_SAT: 6,
};

let _atemCommands = null;
function getAtemCommands() {
  if (!_atemCommands) {
    const { Commands } = require('atem-connection');
    _atemCommands = Commands;
  }
  return _atemCommands;
}

function sendCameraControl(agent, source, category, parameter, type, data) {
  const Commands = getAtemCommands();
  const cmd = new Commands.CameraControlCommand(source, category, parameter, {
    type,
    numberData: Array.isArray(data) ? data : [data],
    boolData: [],
    bigintData: [],
    stringData: '',
    relative: false,
  });
  return agent.atemCommand(() => agent.atem.sendCommand(cmd));
}

function sendCameraControlTrigger(agent, source, category, parameter) {
  const Commands = getAtemCommands();
  const cmd = new Commands.CameraControlCommand(source, category, parameter, {
    type: 0, // BOOL / void trigger
    numberData: [],
    boolData: [],
    bigintData: [],
    stringData: '',
    relative: false,
  });
  return agent.atemCommand(() => agent.atem.sendCommand(cmd));
}

function sendCameraControlRelative(agent, source, category, parameter, type, data) {
  const Commands = getAtemCommands();
  const cmd = new Commands.CameraControlCommand(source, category, parameter, {
    type,
    numberData: Array.isArray(data) ? data : [data],
    boolData: [],
    bigintData: [],
    stringData: '',
    relative: true,
  });
  return agent.atemCommand(() => agent.atem.sendCommand(cmd));
}

// Data type constants matching CameraControlDataType enum
const DT_SINT8 = 1;
const DT_SINT16 = 2;
const DT_SINT32 = 3;
const DT_FLOAT = 128;

async function cameraSetIris(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let value = Number(params.value);
  if (!Number.isFinite(value)) throw new Error('iris value is required (0.0–1.0 or 0–100%)');
  if (value > 1 && value <= 100) value = value / 100;
  value = Math.max(0, Math.min(1, value));
  await sendCameraControl(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.IRIS, DT_FLOAT, value);
  return `Camera ${camera} iris set to ${Math.round(value * 100)}%`;
}

async function cameraAutoIris(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControlTrigger(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.AUTO_IRIS);
  return `Camera ${camera} auto iris triggered`;
}

async function cameraSetGain(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const gain = toInt(params.gain, 'gain');
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.GAIN, DT_SINT8, gain);
  return `Camera ${camera} gain set to ${gain} dB`;
}

async function cameraSetISO(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const iso = toInt(params.iso, 'iso');
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.ISO, DT_SINT32, iso);
  return `Camera ${camera} ISO set to ${iso}`;
}

async function cameraSetWhiteBalance(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const kelvin = toInt(params.kelvin, 'kelvin');
  const tint = toInt(params.tint ?? 0, 'tint');
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.WHITE_BALANCE, DT_SINT16, [kelvin, tint]);
  return `Camera ${camera} white balance set to ${kelvin}K${tint !== 0 ? `, tint ${tint}` : ''}`;
}

async function cameraAutoWhiteBalance(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControlTrigger(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.AUTO_WB);
  return `Camera ${camera} auto white balance triggered`;
}

async function cameraSetShutter(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const speed = toInt(params.speed, 'speed');
  // If value looks like an angle (≤360), convert to hundredths of degrees
  if (speed <= 360) {
    const angle = speed * 100;
    await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.SHUTTER_ANGLE, DT_SINT32, angle);
    return `Camera ${camera} shutter angle set to ${speed}°`;
  }
  // Otherwise treat as microseconds (e.g. 20000 = 1/50s)
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.SHUTTER_SPEED, DT_SINT32, speed);
  return `Camera ${camera} shutter speed set to 1/${Math.round(1000000 / speed)}s`;
}

async function cameraSetFocus(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let value = Number(params.value);
  if (!Number.isFinite(value)) throw new Error('focus value is required (0.0–1.0)');
  value = Math.max(0, Math.min(1, value));
  await sendCameraControl(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.FOCUS, DT_FLOAT, value);
  return `Camera ${camera} focus set to ${Math.round(value * 100)}%`;
}

async function cameraAutoFocus(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControlTrigger(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.AUTO_FOCUS);
  return `Camera ${camera} auto focus triggered`;
}

async function cameraSetLift(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const r = Number(params.r ?? 0), g = Number(params.g ?? 0), b = Number(params.b ?? 0), y = Number(params.y ?? 0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.LIFT, DT_FLOAT, [r, g, b, y]);
  return `Camera ${camera} lift set to R:${r} G:${g} B:${b} Y:${y}`;
}

async function cameraSetGamma(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const r = Number(params.r ?? 0), g = Number(params.g ?? 0), b = Number(params.b ?? 0), y = Number(params.y ?? 0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.GAMMA, DT_FLOAT, [r, g, b, y]);
  return `Camera ${camera} gamma set to R:${r} G:${g} B:${b} Y:${y}`;
}

async function cameraSetColorGain(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const r = Number(params.r ?? 1), g = Number(params.g ?? 1), b = Number(params.b ?? 1), y = Number(params.y ?? 1);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.COLOR_GAIN, DT_FLOAT, [r, g, b, y]);
  return `Camera ${camera} color gain set to R:${r} G:${g} B:${b} Y:${y}`;
}

async function cameraSetContrast(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const pivot = Number(params.pivot ?? 0.5);
  const adjust = Number(params.adjust ?? 1.0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.CONTRAST, DT_FLOAT, [pivot, adjust]);
  return `Camera ${camera} contrast set to pivot:${pivot} adjust:${adjust}`;
}

async function cameraSetSaturation(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const saturation = Number(params.saturation ?? 1.0);
  const hue = Number(params.hue ?? 0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.HUE_SAT, DT_FLOAT, [hue, saturation]);
  return `Camera ${camera} saturation set to ${saturation}${hue !== 0 ? `, hue ${hue}` : ''}`;
}

async function cameraResetColorCorrection(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.LIFT, DT_FLOAT, [0, 0, 0, 0]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.GAMMA, DT_FLOAT, [0, 0, 0, 0]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.COLOR_GAIN, DT_FLOAT, [1, 1, 1, 1]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.OFFSET, DT_FLOAT, [0, 0, 0, 0]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.CONTRAST, DT_FLOAT, [0.5, 1]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.HUE_SAT, DT_FLOAT, [0, 1]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.LUM_MIX, DT_FLOAT, 1);
  return `Camera ${camera} color correction reset to defaults`;
}

// ─── LENS: OIS & ZOOM ──────────────────────────────────────────────────────

async function cameraSetOIS(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const enabled = params.enabled !== false;
  await sendCameraControl(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.OIS, DT_SINT8, enabled ? 1 : 0);
  return `Camera ${camera} OIS ${enabled ? 'enabled' : 'disabled'}`;
}

async function cameraSetZoomSpeed(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let value = Number(params.value ?? params.speed ?? 0);
  if (!Number.isFinite(value)) throw new Error('zoom speed value is required (-1.0 to 1.0)');
  value = Math.max(-1, Math.min(1, value));
  await sendCameraControl(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.ZOOM_SPEED, DT_FLOAT, value);
  return value === 0 ? `Camera ${camera} zoom stopped` : `Camera ${camera} zoom speed set to ${value}`;
}

// ─── LENS: RELATIVE IRIS ───────────────────────────────────────────────────

async function cameraIncrementIris(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let delta = Number(params.delta ?? params.value);
  if (!Number.isFinite(delta)) throw new Error('delta value is required (float)');
  await sendCameraControlRelative(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.IRIS, DT_FLOAT, delta);
  return `Camera ${camera} iris incremented by ${delta}`;
}

// ─── VIDEO: EXPOSURE ───────────────────────────────────────────────────────

async function cameraSetExposure(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const us = toInt(params.microseconds ?? params.value, 'microseconds');
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.EXPOSURE, DT_SINT32, us);
  return `Camera ${camera} exposure set to ${us} µs`;
}

async function cameraIncrementExposure(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const delta = toInt(params.delta ?? params.value, 'delta');
  await sendCameraControlRelative(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.EXPOSURE, DT_SINT32, delta);
  return `Camera ${camera} exposure incremented by ${delta} µs`;
}

// ─── VIDEO: SHARPENING & ND ────────────────────────────────────────────────

async function cameraSetSharpening(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let value = Number(params.value);
  if (!Number.isFinite(value)) throw new Error('sharpening value is required (0.0–1.0)');
  value = Math.max(0, Math.min(1, value));
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.SHARPENING, DT_FLOAT, value);
  return `Camera ${camera} sharpening set to ${Math.round(value * 100)}%`;
}

async function cameraSetNDFilter(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let value = Number(params.value ?? params.stop);
  if (!Number.isFinite(value)) throw new Error('ND filter stop value is required (float)');
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.ND_FILTER, DT_FLOAT, value);
  return `Camera ${camera} ND filter set to ${value} stop`;
}

// ─── VIDEO: RELATIVE GAIN & WHITE BALANCE ──────────────────────────────────

async function cameraIncrementGain(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const delta = toInt(params.delta ?? params.value, 'delta');
  await sendCameraControlRelative(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.GAIN, DT_SINT8, delta);
  return `Camera ${camera} gain incremented by ${delta} dB`;
}

async function cameraIncrementWhiteBalance(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const kelvin = toInt(params.kelvin ?? params.delta, 'kelvin');
  const tint = toInt(params.tint ?? 0, 'tint');
  await sendCameraControlRelative(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.WHITE_BALANCE, DT_SINT16, [kelvin, tint]);
  return `Camera ${camera} white balance incremented by ${kelvin}K${tint !== 0 ? `, tint ${tint}` : ''}`;
}

// ─── DISPLAY: COLOR BARS, FOCUS ASSIST, FALSE COLOR, ZEBRA, STATUS ────────

async function cameraSetColorBars(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const seconds = toInt(params.seconds ?? params.value ?? 0, 'seconds');
  await sendCameraControl(agent, camera, CAMERA_CTRL.DISPLAY, CAMERA_CTRL.COLOR_BARS, DT_SINT8, seconds);
  return seconds === 0 ? `Camera ${camera} color bars off` : `Camera ${camera} color bars on for ${seconds}s`;
}

async function cameraSetFocusAssist(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const mode = toInt(params.mode ?? (params.enabled === false ? 0 : 1), 'mode');
  await sendCameraControl(agent, camera, CAMERA_CTRL.DISPLAY, CAMERA_CTRL.FOCUS_ASSIST, DT_SINT8, mode);
  return `Camera ${camera} focus assist set to ${mode === 0 ? 'off' : mode}`;
}

async function cameraSetFalseColor(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const enabled = params.enabled !== false;
  await sendCameraControl(agent, camera, CAMERA_CTRL.DISPLAY, CAMERA_CTRL.FALSE_COLOR, DT_SINT8, enabled ? 1 : 0);
  return `Camera ${camera} false color ${enabled ? 'enabled' : 'disabled'}`;
}

async function cameraSetZebra(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let level = Number(params.level ?? params.value ?? 0);
  if (!Number.isFinite(level)) throw new Error('zebra level is required (0=off, 0–100)');
  level = Math.max(0, Math.min(100, level));
  await sendCameraControl(agent, camera, CAMERA_CTRL.DISPLAY, CAMERA_CTRL.ZEBRA, DT_FLOAT, level);
  return level === 0 ? `Camera ${camera} zebra off` : `Camera ${camera} zebra level set to ${level}%`;
}

async function cameraSetStatusOverlay(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const enabled = params.enabled !== false;
  await sendCameraControl(agent, camera, CAMERA_CTRL.DISPLAY, CAMERA_CTRL.STATUS_OVERLAY, DT_SINT8, enabled ? 1 : 0);
  return `Camera ${camera} status overlay ${enabled ? 'enabled' : 'disabled'}`;
}

// ─── MEDIA: RECORD START / STOP (per camera) ──────────────────────────────

async function cameraRecordStart(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControl(agent, camera, CAMERA_CTRL.MEDIA, CAMERA_CTRL.TRANSPORT_MODE, DT_SINT8, 2);
  return `Camera ${camera} recording started`;
}

async function cameraRecordStop(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControl(agent, camera, CAMERA_CTRL.MEDIA, CAMERA_CTRL.TRANSPORT_MODE, DT_SINT8, 0);
  return `Camera ${camera} recording stopped`;
}

// ─── COLOR: OFFSET & LUMA MIX ─────────────────────────────────────────────

async function cameraSetColorOffset(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const r = Number(params.r ?? 0), g = Number(params.g ?? 0), b = Number(params.b ?? 0), y = Number(params.y ?? 0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.OFFSET, DT_FLOAT, [r, g, b, y]);
  return `Camera ${camera} color offset set to R:${r} G:${g} B:${b} Y:${y}`;
}

async function cameraSetLumaMix(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let value = Number(params.value);
  if (!Number.isFinite(value)) throw new Error('luma mix value is required (0.0–1.0)');
  value = Math.max(0, Math.min(1, value));
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.LUM_MIX, DT_FLOAT, value);
  return `Camera ${camera} luma mix set to ${Math.round(value * 100)}%`;
}

module.exports = {
  'camera.setIris': cameraSetIris,
  'camera.autoIris': cameraAutoIris,
  'camera.setGain': cameraSetGain,
  'camera.setISO': cameraSetISO,
  'camera.setWhiteBalance': cameraSetWhiteBalance,
  'camera.autoWhiteBalance': cameraAutoWhiteBalance,
  'camera.setShutter': cameraSetShutter,
  'camera.setFocus': cameraSetFocus,
  'camera.autoFocus': cameraAutoFocus,
  'camera.setLift': cameraSetLift,
  'camera.setGamma': cameraSetGamma,
  'camera.setColorGain': cameraSetColorGain,
  'camera.setContrast': cameraSetContrast,
  'camera.setSaturation': cameraSetSaturation,
  'camera.resetColorCorrection': cameraResetColorCorrection,
  // Lens: OIS & zoom
  'camera.setOIS': cameraSetOIS,
  'camera.setZoomSpeed': cameraSetZoomSpeed,
  'camera.incrementIris': cameraIncrementIris,
  // Video: exposure, sharpening, ND, relative gain/WB
  'camera.setExposure': cameraSetExposure,
  'camera.incrementExposure': cameraIncrementExposure,
  'camera.setSharpening': cameraSetSharpening,
  'camera.setNDFilter': cameraSetNDFilter,
  'camera.incrementGain': cameraIncrementGain,
  'camera.incrementWhiteBalance': cameraIncrementWhiteBalance,
  // Display overlays
  'camera.setColorBars': cameraSetColorBars,
  'camera.setFocusAssist': cameraSetFocusAssist,
  'camera.setFalseColor': cameraSetFalseColor,
  'camera.setZebra': cameraSetZebra,
  'camera.setStatusOverlay': cameraSetStatusOverlay,
  // Media transport (per camera)
  'camera.recordStart': cameraRecordStart,
  'camera.recordStop': cameraRecordStop,
  // Color correction (additional)
  'camera.setColorOffset': cameraSetColorOffset,
  'camera.setLumaMix': cameraSetLumaMix,
};
