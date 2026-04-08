/**
 * problem-finder-bridge.js — Electron main-process module for Problem Finder.
 *
 * Imports the lab engine, builds live snapshots from Electron runtime state,
 * runs analysis on demand, implements Go/No-Go preflight logic, manages
 * scheduled sweeps, and tracks run history.
 *
 * Follows the same init({ deps }) pattern as config-manager / relay-client.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Dependencies injected via init() ────────────────────────────────────────
let _getAgentStatus = () => ({});
let _getConfig = () => ({});
let _getRecentLogs = () => [];
let _getEquipmentResults = () => [];
let _getMainWindow = () => null;
let _appendAppLog = () => {};

// ─── Engine (lazy-loaded after init) ─────────────────────────────────────────
let engine = null;
let _labRootDir = null;

// ─── Feature flags ───────────────────────────────────────────────────────────
const DEFAULT_FLAGS = {
  problemFinderDesktopEnabled: true,
  problemFinderPortalEnabled: true,
  problemFinderAiEnabled: false,
};

// ─── Cameras verified toggle (manual confirmation by TD) ────────────────────
let _camerasVerified = false;

// ─── Run history ─────────────────────────────────────────────────────────────
const MAX_RUN_HISTORY = 100;
const runHistory = [];

// ─── Rate limiting for event-driven triggers ─────────────────────────────────
const MIN_EVENT_INTERVAL_MS = 30_000; // 30 seconds
let _lastEventRunAt = 0;

// ─── Scheduled sweep state ───────────────────────────────────────────────────
let _sweepInterval = null;
let _preflightTimers = [];

// ─── Persistence path for run history ────────────────────────────────────────
const RUN_HISTORY_PATH = path.join(os.homedir(), '.church-av', 'problem-finder-runs.json');

// ─── Event trigger patterns ──────────────────────────────────────────────────
const EVENT_TRIGGERS = [
  { pattern: /relay disconnected/i, reason: 'relay-disconnect' },
  { pattern: /1008|invalid token|auth.*reject|authentication failed/i, reason: 'auth-failure' },
  { pattern: /stream stopped/i, reason: 'stream-stop' },
  { pattern: /low stream fps/i, reason: 'low-fps' },
  { pattern: /silence detected/i, reason: 'audio-silence' },
  { pattern: /AUDIO:.*MUTED/i, reason: 'audio-mute' },
  { pattern: /agent exited with code [^0]/i, reason: 'crash-restart' },
  { pattern: /equipment.*test.*fail/i, reason: 'equipment-test-fail' },
];

// ─── INIT ────────────────────────────────────────────────────────────────────

function init(deps) {
  _getAgentStatus = deps.getAgentStatus || _getAgentStatus;
  _getConfig = deps.getConfig || _getConfig;
  _getRecentLogs = deps.getRecentLogs || _getRecentLogs;
  _getEquipmentResults = deps.getEquipmentResults || _getEquipmentResults;
  _getMainWindow = deps.getMainWindow || _getMainWindow;
  _appendAppLog = deps.appendAppLog || _appendAppLog;

  // Resolve lab path
  _labRootDir = resolveLabPath(deps.getLabRootDir);

  if (_labRootDir) {
    try {
      const { createEngine } = require(path.join(_labRootDir, 'src', 'engine.js'));
      // Use separate learning state for the desktop app
      const learningOverride = path.join(os.homedir(), '.church-av', 'problem-finder-learning.json');
      process.env.PF_LAB_LEARNING_PATH = process.env.PF_LAB_LEARNING_PATH || learningOverride;
      engine = createEngine({ rootDir: _labRootDir });
      _appendAppLog('SYSTEM', `Problem Finder engine loaded from ${_labRootDir}`);
    } catch (err) {
      _appendAppLog('SYSTEM', `Problem Finder engine failed to load: ${err.message}`);
      engine = null;
    }
  } else {
    _appendAppLog('SYSTEM', 'Problem Finder: lab directory not found — feature unavailable');
  }

  // Load persisted run history
  loadRunHistory();
}

function resolveLabPath(getLabRootDir) {
  if (typeof getLabRootDir === 'function') {
    const resolved = getLabRootDir();
    if (resolved) return resolved;
  }
  // Fallback: try common dev path
  const devPath = path.resolve(__dirname, '..', '..', '..', '..', 'New project', 'problem-finder-lab');
  if (fs.existsSync(path.join(devPath, 'src', 'engine.js'))) return devPath;
  // Packaged app
  try {
    const pkgPath = path.join(process.resourcesPath || '', 'problem-finder-lab');
    if (fs.existsSync(path.join(pkgPath, 'src', 'engine.js'))) return pkgPath;
  } catch { /* ignore */ }
  return null;
}

// ─── SNAPSHOT BUILDER ────────────────────────────────────────────────────────

function countLogPattern(logs, pattern) {
  let count = 0;
  for (const line of logs) {
    if (pattern.test(line)) count++;
  }
  return count;
}

function extractRecentErrors(logs) {
  const errorPatterns = /error|fail|exception|crash|timeout|reject/i;
  return logs.filter((line) => errorPatterns.test(line)).slice(-20);
}

/**
 * Build cameraInputs array from ATEM state.
 * Uses program/preview inputs as a signal-presence proxy — if an input is on
 * program or preview, it must have a live signal. For other labeled inputs,
 * we mark them as expected but signal unknown (not failed).
 */
function buildCameraInputs(status) {
  const inputs = [];
  const atem = status.atem && typeof status.atem === 'object' ? status.atem : null;
  if (!atem || !atem.connected) return inputs;

  const labels = atem.inputLabels || {};
  const pgm = atem.programInput;
  const pvw = atem.previewInput;

  // Collect all labeled external inputs (IDs 1-20 are camera/source inputs)
  for (const [idStr, name] of Object.entries(labels)) {
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 1 || id > 20) continue; // skip non-camera inputs (MP, color bars, etc.)

    const isOnPgm = pgm === id;
    const isOnPvw = pvw === id;
    // If input is on program or preview, we know it has signal
    const signalConfirmed = isOnPgm || isOnPvw;

    inputs.push({
      inputId: id,
      label: name || `Input ${id}`,
      expected: true,
      signalPresent: signalConfirmed ? true : null,  // null = unknown (not failed)
      locked: signalConfirmed ? true : null,
      format: '',
      connection: isOnPgm ? 'program' : isOnPvw ? 'preview' : '',
    });
  }

  // If no labels, create entries from program/preview at minimum
  if (inputs.length === 0) {
    if (pgm && pgm >= 1 && pgm <= 20) {
      inputs.push({
        inputId: pgm, label: `Cam ${pgm}`, expected: true,
        signalPresent: true, locked: true, format: '', connection: 'program',
      });
    }
    if (pvw && pvw >= 1 && pvw <= 20 && pvw !== pgm) {
      inputs.push({
        inputId: pvw, label: `Cam ${pvw}`, expected: true,
        signalPresent: true, locked: true, format: '', connection: 'preview',
      });
    }
  }

  return inputs;
}

function buildLiveSnapshot() {
  const status = _getAgentStatus();
  const config = _getConfig();
  const logs = _getRecentLogs();
  const equipResults = _getEquipmentResults();

  // Normalize atem — in the Electron app, status.atem can be { connected: true, model: '...' }
  const atemConnected = status.atem === true || (status.atem && status.atem.connected === true);
  const atemModel = (status.atem && typeof status.atem === 'object' && status.atem.model) || '';

  // Build cameraInputs from ATEM state — use program/preview as signal proxy
  const cameraInputs = buildCameraInputs(status);

  return {
    scenario: 'live',
    timestamp: new Date().toISOString(),
    agentStatus: {
      relay: status.relay === true,
      atem: atemConnected,
      atemModel: atemModel,
      obs: status.obs === true,
      companion: status.companion === true || (status.companion && status.companion.connected === true),
      encoder: status.encoder === true || (status.encoder && status.encoder.connected === true),
      encoderType: status.encoderType || '',
      streaming: status.streaming || false,
      fps: status.fps || 0,
      cameraInputs,
      camerasVerified: _camerasVerified,
      audio: {
        silenceDetected: !!(status.audio && status.audio.silenceDetected),
        masterMuted: !!(status.audio && status.audio.masterMuted),
      },
      billingStatus: status.billingStatus || '',
      billingTier: status.billingTier || '',
      trialDaysRemaining: status.trialDaysRemaining != null ? status.trialDaysRemaining : null,
    },
    runtime: {
      authFailuresLastHour: countLogPattern(logs, /1008|invalid token|auth.*reject|authentication failed/i),
      crashCountLastHour: countLogPattern(logs, /agent exited with code [^0]/i),
      restartAttemptsLastHour: countLogPattern(logs, /restarting agent in/i),
      streamStopEventsLastHour: countLogPattern(logs, /stream stopped/i),
      syncFailuresLastHour: countLogPattern(logs, /sync.*fail/i),
      recentErrors: extractRecentErrors(logs),
    },
    equipmentTests: Array.isArray(equipResults) ? equipResults : [],
    config: {
      tokenPresent: !!config.token,
      relayUrl: config.relay || '',
      encoderConfigured: !!(config.encoder && config.encoder.type),
      atemConfigured: !!config.atemIp,
      atemModel: atemModel,
    },
    logs: logs.slice(-200),
  };
}

// ─── ANALYSIS ────────────────────────────────────────────────────────────────

async function runAnalysis(opts = {}) {
  if (!engine) {
    return { error: 'Problem Finder engine not available', report: null, goNoGo: null };
  }

  const triggerType = opts.triggerType || 'manual';
  const triggerReason = opts.triggerReason || '';
  const startedAt = Date.now();

  try {
    const snapshot = buildLiveSnapshot();
    const report = await engine.analyzeFromSnapshot(snapshot, {
      useAi: false, // AI gated separately
    });

    const { evaluateGoNoGo } = require(path.join(_labRootDir, 'src', 'go-no-go.js'));
    const goNoGo = evaluateGoNoGo(report, {
      triggerType,
      scheduledStreamAt: opts.scheduledStreamAt || null,
    });

    const completedAt = Date.now();
    const runEntry = {
      runId: goNoGo.runId,
      triggerType,
      triggerReason,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      issueCount: report.diagnostics?.issues?.length || 0,
      coverageScore: report.coverage?.score || 0,
      goNoGoStatus: goNoGo.status,
      blockerCount: goNoGo.blockerCount,
    };

    // Store in history
    runHistory.push(runEntry);
    if (runHistory.length > MAX_RUN_HISTORY) {
      runHistory.splice(0, runHistory.length - MAX_RUN_HISTORY);
    }
    saveRunHistory();

    // Push update to renderer
    const mainWindow = _getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pf-update', { report, goNoGo, runEntry });
    }

    // Push results to relay server (fire-and-forget)
    pushReportToRelay(report, goNoGo, runEntry).catch(err => console.error('[ProblemFinder] Error:', err));

    return { report, goNoGo, runEntry };
  } catch (err) {
    _appendAppLog('SYSTEM', `Problem Finder analysis error: ${err.message}`);
    return { error: err.message, report: null, goNoGo: null };
  }
}

async function runGoNoGo(opts = {}) {
  return runAnalysis({ ...opts, triggerType: opts.triggerType || 'preflight' });
}

// ─── FEEDBACK ────────────────────────────────────────────────────────────────

function recordFeedback(fb) {
  if (!engine) return { error: 'Problem Finder engine not available' };
  try {
    return engine.recordIssueFeedback(fb);
  } catch (err) {
    return { error: err.message };
  }
}

// ─── EVENT-DRIVEN DETECTION ──────────────────────────────────────────────────

function onAgentEvent(text) {
  if (!engine) return;
  if (!getFeatureFlags().problemFinderDesktopEnabled) return;

  const now = Date.now();
  if (now - _lastEventRunAt < MIN_EVENT_INTERVAL_MS) return;

  for (const trigger of EVENT_TRIGGERS) {
    if (trigger.pattern.test(text)) {
      _lastEventRunAt = now;
      runAnalysis({ triggerType: 'event', triggerReason: trigger.reason }).catch(err => console.error('[ProblemFinder] Error:', err));
      return; // Only trigger once per event batch
    }
  }
}

// ─── SCHEDULED SWEEPS ────────────────────────────────────────────────────────

function startScheduledSweeps(opts = {}) {
  stopScheduledSweeps();

  const liveIntervalMs = opts.liveWindowIntervalMs || 3 * 60_000;   // 3 min default
  const idleIntervalMs = opts.outsideWindowIntervalMs || 20 * 60_000; // 20 min default
  const isInLiveWindow = opts.isInLiveWindow || (() => false);

  function tick() {
    if (!engine) return;
    if (!getFeatureFlags().problemFinderDesktopEnabled) return;

    runAnalysis({ triggerType: 'schedule', triggerReason: 'scheduled-sweep' }).catch(err => console.error('[ProblemFinder] Error:', err));

    // Re-schedule with appropriate interval
    const interval = isInLiveWindow() ? liveIntervalMs : idleIntervalMs;
    _sweepInterval = setTimeout(tick, interval);
  }

  const initialInterval = isInLiveWindow() ? liveIntervalMs : idleIntervalMs;
  _sweepInterval = setTimeout(tick, initialInterval);
}

function stopScheduledSweeps() {
  if (_sweepInterval) {
    clearTimeout(_sweepInterval);
    _sweepInterval = null;
  }
}

// ─── PREFLIGHT SCHEDULING ────────────────────────────────────────────────────

function schedulePreflight(streamAt) {
  clearPreflightTimers();
  if (!streamAt) return;

  const streamTime = new Date(streamAt).getTime();
  if (isNaN(streamTime)) return;

  const now = Date.now();
  const offsets = [45 * 60_000, 30 * 60_000]; // T-45min and T-30min

  for (const offset of offsets) {
    const runAt = streamTime - offset;
    if (runAt > now) {
      const timer = setTimeout(() => {
        runAnalysis({
          triggerType: 'preflight',
          triggerReason: `T-${offset / 60_000}min`,
          scheduledStreamAt: new Date(streamTime).toISOString(),
        }).catch(err => console.error('[ProblemFinder] Error:', err));
      }, runAt - now);
      _preflightTimers.push(timer);
    }
  }
}

function clearPreflightTimers() {
  for (const timer of _preflightTimers) clearTimeout(timer);
  _preflightTimers = [];
}

// ─── RUN HISTORY PERSISTENCE ─────────────────────────────────────────────────

function loadRunHistory() {
  try {
    if (fs.existsSync(RUN_HISTORY_PATH)) {
      const data = JSON.parse(fs.readFileSync(RUN_HISTORY_PATH, 'utf8'));
      if (Array.isArray(data)) {
        runHistory.length = 0;
        runHistory.push(...data.slice(-MAX_RUN_HISTORY));
      }
    }
  } catch { /* ignore */ }
}

function saveRunHistory() {
  try {
    const dir = path.dirname(RUN_HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RUN_HISTORY_PATH, JSON.stringify(runHistory, null, 2));
  } catch { /* ignore write errors */ }
}

function getRunHistory() {
  return runHistory.slice();
}

// ─── FEATURE FLAGS ───────────────────────────────────────────────────────────

function getFeatureFlags() {
  // In future, could read from config-manager. For now, use defaults.
  return { ...DEFAULT_FLAGS };
}

// ─── STATUS ──────────────────────────────────────────────────────────────────

function isAvailable() {
  return engine !== null;
}

function setCamerasVerified(verified) {
  _camerasVerified = !!verified;
}

function getCamerasVerified() {
  return _camerasVerified;
}

// ─── MODULE EXPORTS ──────────────────────────────────────────────────────────

// ─── RELAY REPORT PUSH ──────────────────────────────────────────────────────

/**
 * Push analysis results to the relay server so the church portal can display them.
 * Fire-and-forget — errors are logged but never block analysis.
 */
async function pushReportToRelay(report, goNoGo, runEntry) {
  try {
    const { sendProblemFinderReport } = require('./relay-client');
    const issues = report?.diagnostics?.issues || [];
    const blockers = goNoGo?.blockers || [];

    // Categorise: needs attention = critical or high severity issues
    const needsAttention = issues
      .filter((i) => i.severity === 'critical' || i.severity === 'high')
      .map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        symptom: i.symptom || '',
        fixStep: Array.isArray(i.fixSteps) && i.fixSteps.length > 0 ? i.fixSteps[0] : '',
      }));

    // Auto-fixed = issues tagged with 'auto-recoverable' or matching known auto-fix patterns
    const autoFixed = issues
      .filter((i) => (i.tags || []).includes('auto-recoverable') || (i.tags || []).includes('auto-fixed'))
      .map((i) => ({ id: i.id, title: i.title, severity: i.severity }));

    const payload = {
      runId: goNoGo?.runId || runEntry?.runId,
      status: goNoGo?.status || 'NO_GO',
      triggerType: runEntry?.triggerType || 'manual',
      issueCount: issues.length,
      autoFixedCount: autoFixed.length,
      coverageScore: goNoGo?.coverageScore ?? report?.coverage?.score ?? 0,
      blockerCount: goNoGo?.blockerCount || 0,
      issues: issues.map((i) => ({
        id: i.id, title: i.title, severity: i.severity,
        symptom: i.symptom || '', probableCause: i.probableCause || '',
        fixSteps: i.fixSteps || [],
      })),
      blockers,
      autoFixed,
      needsAttention,
      topActions: goNoGo?.topRecommendedActions || [],
      createdAt: runEntry?.completedAt || new Date().toISOString(),
    };

    const result = await sendProblemFinderReport(payload);
    if (result.success) {
      _appendAppLog('SYSTEM', `Problem Finder report pushed to relay (${goNoGo?.status})`);
    } else {
      _appendAppLog('SYSTEM', `Problem Finder relay push failed: ${result.error || 'unknown'}`);
    }
  } catch (err) {
    _appendAppLog('SYSTEM', `Problem Finder relay push error: ${err.message}`);
  }
}

module.exports = {
  init,
  isAvailable,
  buildLiveSnapshot,
  runAnalysis,
  runGoNoGo,
  recordFeedback,
  onAgentEvent,
  startScheduledSweeps,
  stopScheduledSweeps,
  schedulePreflight,
  clearPreflightTimers,
  getRunHistory,
  getFeatureFlags,
  setCamerasVerified,
  getCamerasVerified,
};
