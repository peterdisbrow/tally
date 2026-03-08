const { toInt } = require('./helpers');

function resolvePtzRef(params = {}) {
  if (params.cameraName) return String(params.cameraName);
  return Number.parseInt(params.camera || 1, 10) || 1;
}

function hasNetworkPtz(agent) {
  return !!agent.ptzManager?.hasCameras?.();
}

async function ptzPan(agent, params) {
  const speed = params.speed || 0; // -1.0 to 1.0 (negative=left, positive=right)
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.panTilt(camera, speed, 0, { durationMs: params.durationMs || 350 });
    return `PTZ camera ${camera} pan speed ${speed}`;
  }
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setCameraControlPanTilt !== 'function') {
      throw new Error('ATEM PTZ pan/tilt control is not supported in this runtime');
    }
    return agent.atem.setCameraControlPanTilt(camera, speed, 0);
  });
  return `PTZ camera ${camera} pan speed ${speed}`;
}

async function ptzTilt(agent, params) {
  const speed = params.speed || 0;
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.panTilt(camera, 0, speed, { durationMs: params.durationMs || 350 });
    return `PTZ camera ${camera} tilt speed ${speed}`;
  }
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setCameraControlPanTilt !== 'function') {
      throw new Error('ATEM PTZ pan/tilt control is not supported in this runtime');
    }
    return agent.atem.setCameraControlPanTilt(camera, 0, speed);
  });
  return `PTZ camera ${camera} tilt speed ${speed}`;
}

async function ptzZoom(agent, params) {
  const speed = params.speed || 0; // negative=out, positive=in
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.zoom(camera, speed, { durationMs: params.durationMs || 250 });
    return `PTZ camera ${camera} zoom speed ${speed}`;
  }
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setCameraControlZoom !== 'function') {
      throw new Error('ATEM PTZ zoom control is not supported in this runtime');
    }
    return agent.atem.setCameraControlZoom(camera, speed);
  });
  return `PTZ camera ${camera} zoom speed ${speed}`;
}

async function ptzPreset(agent, params) {
  const preset = params.preset || 1;
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.recallPreset(camera, preset, { zeroBasedPreset: !!params.zeroBasedPreset });
    return `PTZ camera ${camera} recalled preset ${preset}`;
  }
  // ATEM camera control — recall preset via macro or camera control protocol
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setCameraControlPreset !== 'function') {
      throw new Error('ATEM PTZ preset recall is not supported in this runtime');
    }
    return agent.atem.setCameraControlPreset(camera, preset);
  });
  return `PTZ camera ${camera} recalled preset ${preset}`;
}

async function ptzStop(agent, params) {
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.stop(camera, {
      panTilt: params.panTilt !== false,
      zoom: params.zoom !== false,
    });
    return `PTZ camera ${camera} stopped`;
  }
  const speed = 0;
  await ptzPan(agent, { ...params, camera, speed });
  await ptzTilt(agent, { ...params, camera, speed });
  await ptzZoom(agent, { ...params, camera, speed });
  return `PTZ camera ${camera} stopped`;
}

async function ptzHome(agent, params) {
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.home(camera);
    return `PTZ camera ${camera} moved to home`;
  }
  throw new Error('PTZ home is only available for network PTZ cameras (ONVIF/VISCA)');
}

async function ptzSetPreset(agent, params) {
  const camera = resolvePtzRef(params);
  const preset = params.preset || 1;
  if (hasNetworkPtz(agent)) {
    const token = await agent.ptzManager.setPreset(camera, preset, params.name || '', {
      zeroBasedPreset: !!params.zeroBasedPreset,
    });
    return `PTZ camera ${camera} saved preset ${preset} (${token})`;
  }
  throw new Error('PTZ set preset is only available for network PTZ cameras (ONVIF/VISCA)');
}

// ─── PTZ EXTENDED COMMANDS (VISCA focus, white balance) ─────────────────────

async function ptzAutoFocus(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.autoFocus(camera);
  return `PTZ camera ${camera}: auto focus enabled`;
}

async function ptzManualFocus(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.manualFocus(camera);
  return `PTZ camera ${camera}: manual focus mode`;
}

async function ptzFocusNear(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  const speed = params.speed != null ? Number(params.speed) : 3;
  await agent.ptzManager.focusNear(camera, speed);
  return `PTZ camera ${camera}: focusing near`;
}

async function ptzFocusFar(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  const speed = params.speed != null ? Number(params.speed) : 3;
  await agent.ptzManager.focusFar(camera, speed);
  return `PTZ camera ${camera}: focusing far`;
}

async function ptzFocusStop(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.focusStop(camera);
  return `PTZ camera ${camera}: focus stopped`;
}

async function ptzAutoWhiteBalance(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ white balance control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.setAutoWhiteBalance(camera);
  return `PTZ camera ${camera}: auto white balance`;
}

async function ptzIndoorWhiteBalance(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ white balance control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.setIndoorWhiteBalance(camera);
  return `PTZ camera ${camera}: indoor white balance`;
}

async function ptzOutdoorWhiteBalance(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ white balance control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.setOutdoorWhiteBalance(camera);
  return `PTZ camera ${camera}: outdoor white balance`;
}

async function ptzOnePushWb(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ white balance control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.setOnePushWhiteBalance(camera);
  return `PTZ camera ${camera}: one-push white balance triggered`;
}

async function ptzBacklightComp(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ backlight compensation requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  const enabled = params.enabled !== false && params.enabled !== 'false';
  await agent.ptzManager.setBacklightComp(camera, enabled);
  return `PTZ camera ${camera}: backlight compensation ${enabled ? 'on' : 'off'}`;
}

module.exports = {
  'ptz.pan': ptzPan,
  'ptz.tilt': ptzTilt,
  'ptz.zoom': ptzZoom,
  'ptz.preset': ptzPreset,
  'ptz.stop': ptzStop,
  'ptz.home': ptzHome,
  'ptz.setPreset': ptzSetPreset,
  'ptz.autoFocus': ptzAutoFocus,
  'ptz.manualFocus': ptzManualFocus,
  'ptz.focusNear': ptzFocusNear,
  'ptz.focusFar': ptzFocusFar,
  'ptz.focusStop': ptzFocusStop,
  'ptz.autoWhiteBalance': ptzAutoWhiteBalance,
  'ptz.indoorWhiteBalance': ptzIndoorWhiteBalance,
  'ptz.outdoorWhiteBalance': ptzOutdoorWhiteBalance,
  'ptz.onePushWb': ptzOnePushWb,
  'ptz.backlightComp': ptzBacklightComp,
};
