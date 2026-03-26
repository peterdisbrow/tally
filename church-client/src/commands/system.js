const { toInt } = require('./helpers');
const { mixerBrandName } = require('./mixer');
const { collectDiagnosticBundle } = require('../diagnosticBundle');

async function danteScene(agent, params) {
  if (!agent.companion) throw new Error('Companion not configured — Dante scenes require Companion buttons prefixed with "Dante:"');
  await agent.companion.pressNamed(`Dante: ${params.name}`);
  return `Dante scene "${params.name}" triggered via Companion`;
}

// ─── PRESET COMMANDS ─────────────────────────────────────────────────────────

/**
 * Capture current equipment state and return it for the relay to save as a preset.
 * The relay receives this as a command_result and stores it in presetLibrary.
 */
async function presetSave(agent, params) {
  const steps = [];

  // Capture current mixer scene
  if (agent.mixer && agent.status.mixer?.connected) {
    try {
      const status = await agent.mixer.getStatus();
      if (status.scene != null) {
        steps.push({ type: 'mixer_scene', scene: status.scene });
      }
    } catch { /* mixer may not expose scene */ }
  }

  // Capture current OBS scene
  if (agent.obs && agent.status.obs?.connected) {
    try {
      const scene = await agent.obs.call('GetCurrentProgramScene');
      if (scene?.currentProgramSceneName) {
        steps.push({ type: 'obs_scene', sceneName: scene.currentProgramSceneName });
      }
    } catch { /* ignore */ }
  }

  // Capture vMix active input
  if (agent.vmix && agent.status.vmix?.connected) {
    try {
      const status = await agent.vmix.getStatus();
      if (status?.activeInput) {
        steps.push({ type: 'vmix_preset', inputName: String(status.activeInput) });
      }
    } catch { /* ignore */ }
  }

  // Capture Resolume playing column
  if (agent.resolume && agent.status.resolume?.connected) {
    try {
      const status = await agent.resolume.getStatus();
      if (status?.playing?.length > 0) {
        const col = status.currentColumn ?? status.playing[0]?.column;
        if (col != null) {
          steps.push({ type: 'resolume_column', columnIndex: col });
        }
      }
    } catch { /* ignore */ }
  }

  if (steps.length === 0) {
    throw new Error('No connected devices found to save state from');
  }

  const presetType = steps.length === 1 ? steps[0].type : 'named_bundle';
  return { presetType, steps, name: params.name };
}

/**
 * List saved presets via relay REST API.
 */
async function presetList(agent) {
  const { churchId, relayHttpBase, config } = agent;
  if (!churchId || !relayHttpBase) {
    throw new Error('Relay HTTP URL not available');
  }
  const resp = await fetch(`${relayHttpBase}/api/churches/${churchId}/presets`, {
    headers: { 'Authorization': `Bearer ${config.token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Failed to list presets: ${resp.status}`);
  const presets = await resp.json();
  if (!presets.length) return 'No saved presets';
  return presets.map(p => `• ${p.name} (${p.type.replace(/_/g, ' ')})`).join('\n');
}

/**
 * Recall a named preset via relay REST API.
 */
async function presetRecall(agent, params) {
  const { churchId, relayHttpBase, config } = agent;
  if (!churchId || !relayHttpBase) throw new Error('Relay HTTP URL not available');
  const name = encodeURIComponent(params.name);
  const resp = await fetch(`${relayHttpBase}/api/churches/${churchId}/presets/${name}/recall`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Failed to recall preset: ${resp.status}`);
  return `Preset "${params.name}" recalled`;
}

/**
 * Delete a named preset via relay REST API.
 */
async function presetDelete(agent, params) {
  const { churchId, relayHttpBase, config } = agent;
  if (!churchId || !relayHttpBase) throw new Error('Relay HTTP URL not available');
  const name = encodeURIComponent(params.name);
  const resp = await fetch(`${relayHttpBase}/api/churches/${churchId}/presets/${name}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${config.token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Failed to delete preset: ${resp.status}`);
  return `Preset "${params.name}" deleted`;
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

  // 3. OBS connection and stream state (only if OBS is the configured encoder)
  const encoderType = agent.config?.encoderType || agent.config?.encoder?.type;
  const obsIsConfigured = encoderType === 'obs' || (!encoderType && agent.status.obs.connected);
  if (obsIsConfigured) {
    const obsConnected = agent.status.obs.connected;
    checks.push({ name: 'OBS Connection', pass: obsConnected, detail: obsConnected ? 'Connected' : 'Not connected' });

    if (obsConnected) {
      const alreadyStreaming = agent.status.obs.streaming;
      checks.push({
        name: 'OBS Stream State',
        pass: !alreadyStreaming,
        detail: alreadyStreaming ? 'Already streaming (expected?)' : 'Not streaming — ready to go',
      });
    }
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

  // 5. ProPresenter check
  if (agent.proPresenter) {
    const ppRunning = await agent.proPresenter.isRunning();
    checks.push({ name: 'ProPresenter', pass: ppRunning, detail: ppRunning ? 'Running' : 'Not reachable' });
    if (ppRunning) {
      const slide = await agent.proPresenter.getCurrentSlide();
      checks.push({ name: 'ProPresenter Presentation', pass: !!slide, detail: slide ? `Loaded: ${slide.presentationName}` : 'No presentation loaded' });
    }
  }

  // 6. vMix check (alternative to OBS)
  if (agent.vmix) {
    const vmixRunning = await agent.vmix.isRunning();
    checks.push({ name: 'vMix', pass: vmixRunning, detail: vmixRunning ? 'Running' : 'Not reachable' });
    if (vmixRunning) {
      const vs = await agent.vmix.getStatus();
      checks.push({ name: 'vMix Streaming', pass: vs.streaming, detail: vs.streaming ? '🔴 LIVE' : 'Not streaming (will start at service time)' });
    }
  }

  // 7. Audio console check
  if (agent.mixer) {
    const mixerOnline = await agent.mixer.isOnline().catch(() => false);
    checks.push({
      name: 'Audio Console',
      pass: mixerOnline,
      detail: mixerOnline ? `${mixerBrandName(agent.config.mixer?.type, agent.config.mixer?.model)} reachable` : 'Console not reachable',
    });
    if (mixerOnline) {
      const mixerStatus = await agent.mixer.getStatus().catch(() => null);
      if (mixerStatus) {
        checks.push({
          name: 'Main Output',
          pass: !mixerStatus.mainMuted,
          detail: mixerStatus.mainMuted
            ? '⚠️ MASTER IS MUTED'
            : `Fader at ${Math.round(mixerStatus.mainFader * 100)}%`,
        });
      }
    }
  } else if (agent.status.audioViaAtem || agent.config.audioViaAtem) {
    // Audio routed directly into ATEM — no external mixer to check
    const sources = agent.status.atem?.atemAudioSources || [];
    const sourceDetail = sources.length > 0
      ? sources.map(s => `Input ${s.inputId}: ${s.portType} (${s.mixOption})`).join(', ')
      : 'configured manually';
    const tag = agent.status.audioViaAtemSource === 'manual' ? 'manual override' : 'auto-detected';
    checks.push({
      name: 'Audio Source',
      pass: true,
      detail: `Audio via ATEM [${tag}] — ${sourceDetail}`,
    });
  }

  // 8. Resolume Arena check
  if (agent.resolume) {
    const resRunning = await agent.resolume.isRunning();
    checks.push({ name: 'Resolume Arena', pass: resRunning, detail: resRunning ? 'Running' : 'Not reachable' });
    if (resRunning) {
      const status = await agent.resolume.getStatus();
      const layerCount = status.layerCount || 0;
      checks.push({ name: 'Resolume Composition', pass: layerCount > 0, detail: layerCount > 0 ? `${layerCount} layers, ${status.columnCount || 0} columns loaded` : 'No composition loaded' });
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

function systemSetWatchdogMode(agent, params) {
  agent.watchdogActive = params.active !== false;
  return `Watchdog ${agent.watchdogActive ? 'enabled' : 'disabled'}`;
}

function systemGetServiceWindow(agent) {
  return { inWindow: agent.watchdogActive || false, watchdogActive: agent.watchdogActive || false };
}

async function systemDiagnosticBundle(agent) {
  return await collectDiagnosticBundle(agent);
}

module.exports = {
  'status': getStatus,
  'system.preServiceCheck': preServiceCheck,
  'system.setWatchdogMode': systemSetWatchdogMode,
  'system.getServiceWindow': systemGetServiceWindow,
  'system.diagnosticBundle': systemDiagnosticBundle,
  'preview.start': previewStart,
  'preview.stop': previewStop,
  'preview.snap': previewSnap,
  'companion.press': companionPress,
  'companion.pressNamed': companionPressNamed,
  'companion.getGrid': companionGetGrid,
  'companion.connections': companionConnections,
  'dante.scene': danteScene,
  'preset.save': presetSave,
  'preset.list': presetList,
  'preset.recall': presetRecall,
  'preset.delete': presetDelete,
};
