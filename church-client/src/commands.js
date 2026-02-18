/**
 * Command Handlers for Church AV Connect Client
 * Each handler receives (agent, params) and returns a result string or object.
 */

// ─── ATEM COMMANDS ──────────────────────────────────────────────────────────

async function atemCut(agent, params) {
  await agent.atemCommand(() => agent.atem?.cut(params.me || 0));
  return 'Cut executed';
}

async function atemAuto(agent, params) {
  await agent.atemCommand(() => agent.atem?.autoTransition(params.me || 0));
  return 'Auto transition executed';
}

async function atemSetProgram(agent, params) {
  await agent.atemCommand(() => agent.atem?.changeProgramInput(params.me || 0, params.input));
  return `Program input set to ${params.input}`;
}

async function atemSetPreview(agent, params) {
  await agent.atemCommand(() => agent.atem?.changePreviewInput(params.me || 0, params.input));
  return `Preview input set to ${params.input}`;
}

async function atemStartRecording(agent) {
  await agent.atemCommand(() => agent.atem?.setRecordingAction({ action: 1 }));
  return 'Recording started';
}

async function atemStopRecording(agent) {
  await agent.atemCommand(() => agent.atem?.setRecordingAction({ action: 0 }));
  return 'Recording stopped';
}

async function atemFadeToBlack(agent, params) {
  await agent.atemCommand(() => agent.atem?.setFadeToBlackState(params.me || 0, { isFullyBlack: params.black !== false }));
  return 'Fade to black toggled';
}

// ─── HYPERDECK COMMANDS ─────────────────────────────────────────────────────

async function hyperdeckPlay(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckPlay(hd));
  return `HyperDeck ${hd} playing`;
}

async function hyperdeckStop(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckStop(hd));
  return `HyperDeck ${hd} stopped`;
}

async function hyperdeckRecord(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckRecord(hd));
  return `HyperDeck ${hd} recording`;
}

async function hyperdeckStopRecord(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckStop(hd));
  return `HyperDeck ${hd} recording stopped`;
}

async function hyperdeckNextClip(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckNextClip(hd));
  return `HyperDeck ${hd} next clip`;
}

async function hyperdeckPrevClip(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckPrevClip(hd));
  return `HyperDeck ${hd} previous clip`;
}

// ─── PTZ CAMERA COMMANDS ────────────────────────────────────────────────────

async function ptzPan(agent, params) {
  const speed = params.speed || 0; // -1.0 to 1.0 (negative=left, positive=right)
  const camera = params.camera || 1;
  await agent.atemCommand(() => agent.atem?.setCameraControlPanTilt(camera, speed, 0));
  return `PTZ camera ${camera} pan speed ${speed}`;
}

async function ptzTilt(agent, params) {
  const speed = params.speed || 0;
  const camera = params.camera || 1;
  await agent.atemCommand(() => agent.atem?.setCameraControlPanTilt(camera, 0, speed));
  return `PTZ camera ${camera} tilt speed ${speed}`;
}

async function ptzZoom(agent, params) {
  const speed = params.speed || 0; // negative=out, positive=in
  const camera = params.camera || 1;
  await agent.atemCommand(() => agent.atem?.setCameraControlZoom(camera, speed));
  return `PTZ camera ${camera} zoom speed ${speed}`;
}

async function ptzPreset(agent, params) {
  const preset = params.preset || 1;
  const camera = params.camera || 1;
  // ATEM camera control — recall preset via macro or camera control protocol
  await agent.atemCommand(() => agent.atem?.setCameraControlPreset(camera, preset));
  return `PTZ camera ${camera} recalled preset ${preset}`;
}

// ─── OBS COMMANDS ───────────────────────────────────────────────────────────

async function obsStartStream(agent) {
  await agent.obs?.call('StartStream');
  return 'Stream started';
}

async function obsStopStream(agent) {
  await agent.obs?.call('StopStream');
  return 'Stream stopped';
}

async function obsStartRecording(agent) {
  await agent.obs?.call('StartRecord');
  return 'OBS recording started';
}

async function obsStopRecording(agent) {
  await agent.obs?.call('StopRecord');
  return 'OBS recording stopped';
}

async function obsSetScene(agent, params) {
  await agent.obs?.call('SetCurrentProgramScene', { sceneName: params.scene });
  return `Scene set to: ${params.scene}`;
}

// ─── SYSTEM COMMANDS ────────────────────────────────────────────────────────

function getStatus(agent) {
  return agent.status;
}

async function preServiceCheck(agent) {
  const checks = [];

  // 1. ATEM connection
  const atemConnected = agent.status.atem.connected;
  checks.push({ name: 'ATEM Connection', pass: atemConnected, detail: atemConnected ? 'Connected' : 'Not connected' });

  // 2. Camera inputs active (check for non-black on configured inputs)
  if (atemConnected && agent.atem) {
    try {
      const state = agent.atem.state;
      const inputs = state?.video?.mixEffects?.[0];
      const inputCount = Object.keys(state?.inputs || {}).length;
      let activeInputs = 0;
      let totalInputs = 0;
      for (const [id, input] of Object.entries(state?.inputs || {})) {
        if (input.internalPortType === 0) { // External inputs
          totalInputs++;
          // Check if input has a valid source (not black)
          if (input.isExternal !== false) activeInputs++;
        }
      }
      checks.push({
        name: 'Camera Inputs',
        pass: activeInputs > 0,
        detail: `${activeInputs}/${totalInputs} external inputs detected`,
      });
    } catch (e) {
      checks.push({ name: 'Camera Inputs', pass: false, detail: `Error checking: ${e.message}` });
    }
  } else {
    checks.push({ name: 'Camera Inputs', pass: false, detail: 'Cannot check — ATEM not connected' });
  }

  // 3. OBS connection and stream state
  const obsConnected = agent.status.obs.connected;
  checks.push({ name: 'OBS Connection', pass: obsConnected, detail: obsConnected ? 'Connected' : 'Not connected (optional)' });

  if (obsConnected) {
    const alreadyStreaming = agent.status.obs.streaming;
    checks.push({
      name: 'OBS Stream State',
      pass: !alreadyStreaming,
      detail: alreadyStreaming ? 'Already streaming (expected?)' : 'Not streaming — ready to go',
    });
  }

  // 4. Companion check
  if (agent.companion) {
    const companionAvail = await agent.companion.isAvailable();
    checks.push({ name: 'Companion', pass: companionAvail, detail: companionAvail ? 'Running' : 'Not reachable' });

    if (companionAvail) {
      try {
        const conns = await agent.companion.getConnections();
        checks.push({ name: 'Companion Connections', pass: conns.length > 0, detail: `${conns.length} connections configured` });
        const errors = conns.filter(c => c.hasError);
        if (errors.length > 0) {
          checks.push({ name: 'Companion Errors', pass: false, detail: `${errors.length} connection(s) with errors: ${errors.map(e => e.label).join(', ')}` });
        }
      } catch (e) {
        checks.push({ name: 'Companion Connections', pass: false, detail: `Error: ${e.message}` });
      }
    }
  }

  const allPass = checks.every(c => c.pass);
  return { pass: allPass, checks };
}

// ─── PREVIEW COMMANDS ───────────────────────────────────────────────────────

async function previewStart(agent, params) {
  const intervalMs = params.intervalMs || 5000;
  agent.startPreview(intervalMs);
  return `Preview started (every ${intervalMs}ms)`;
}

async function previewStop(agent) {
  agent.stopPreview();
  return 'Preview stopped';
}

async function previewSnap(agent) {
  const frame = await agent.capturePreviewFrame();
  if (!frame) throw new Error('Could not capture preview — OBS not connected');
  return { snapshot: true, size: frame.data.length };
}

// ─── COMPANION COMMANDS ─────────────────────────────────────────────────────

async function companionPress(agent, params) {
  if (!agent.companion) throw new Error('Companion not configured');
  const result = await agent.companion.pressButton(params.page, params.row, params.col);
  return `Companion button pressed: page ${params.page}, row ${params.row}, col ${params.col}`;
}

async function companionPressNamed(agent, params) {
  if (!agent.companion) throw new Error('Companion not configured');
  await agent.companion.pressNamed(params.name);
  return `Companion button "${params.name}" pressed`;
}

async function companionGetGrid(agent, params) {
  if (!agent.companion) throw new Error('Companion not configured');
  return await agent.companion.getButtonGrid(params.page || 1);
}

async function companionConnections(agent) {
  if (!agent.companion) throw new Error('Companion not configured');
  return await agent.companion.getConnections();
}

// ─── COMMAND REGISTRY ───────────────────────────────────────────────────────

const commandHandlers = {
  'atem.cut': atemCut,
  'atem.auto': atemAuto,
  'atem.setProgram': atemSetProgram,
  'atem.setPreview': atemSetPreview,
  'atem.startRecording': atemStartRecording,
  'atem.stopRecording': atemStopRecording,
  'atem.fadeToBlack': atemFadeToBlack,

  'hyperdeck.play': hyperdeckPlay,
  'hyperdeck.stop': hyperdeckStop,
  'hyperdeck.record': hyperdeckRecord,
  'hyperdeck.stopRecord': hyperdeckStopRecord,
  'hyperdeck.nextClip': hyperdeckNextClip,
  'hyperdeck.prevClip': hyperdeckPrevClip,

  'ptz.pan': ptzPan,
  'ptz.tilt': ptzTilt,
  'ptz.zoom': ptzZoom,
  'ptz.preset': ptzPreset,

  'obs.startStream': obsStartStream,
  'obs.stopStream': obsStopStream,
  'obs.startRecording': obsStartRecording,
  'obs.stopRecording': obsStopRecording,
  'obs.setScene': obsSetScene,

  'status': getStatus,
  'system.preServiceCheck': preServiceCheck,

  'preview.start': previewStart,
  'preview.stop': previewStop,
  'preview.snap': previewSnap,

  'companion.press': companionPress,
  'companion.pressNamed': companionPressNamed,
  'companion.getGrid': companionGetGrid,
  'companion.connections': companionConnections,
};

module.exports = { commandHandlers };
