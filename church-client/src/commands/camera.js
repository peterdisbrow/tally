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
};
