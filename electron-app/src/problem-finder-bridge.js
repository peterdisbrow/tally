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

function buildLiveSnapshot() {
  const status = _getAgentStatus();
  const config = _getConfig();
  const logs = _getRecentLogs();
  const equipResults = _getEquipmentResults();

  // Normalize atem — in the Electron app, status.atem can be { connected: true, model: '...' }
  const atemConnected = status.atem === true || (status.atem && status.atem.connected === true);
  const atemModel = (status.atem && typeof status.atem === 'object' && status.atem.model) || '';

  return {
    scenario: 'live',
    timestamp: new Date().toISOString(),
    agentStatus: {
      relay: status.relay === true,
      atem: atemConnected,
      atemModel: atemModel,
      obs: status.obs === true,
      companion: status.companion === true,
      encoder: status.encoder === true,
      encoderType: status.encoderType || '',
      streaming: status.streaming || false,
      fps: status.fps || 0,
      cameraInputs: [],
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

    return { report, goNoGo, runEntry };
  } catch (err) {
    _appendAppLog('SYSTEM', `Problem Finder analysis error: ${err.message}`);
    return { error: err.message, report: null, goNoGo: null };
  }
}

async function runGoNoGo(opts = {}) {
  return runAnalysis({ ...opts, triggerType: opts.triggerType || 'preflight' });
}

async function simulateFix(simulationId) {
  if (!engine) return { error: 'Problem Finder engine not available' };

  try {
    const snapshot = buildLiveSnapshot();
    const beforeReport = await engine.analyzeFromSnapshot(snapshot, { useAi: false });
    const simulatedSnapshot = engine.applySimulation(snapshot, simulationId);
    const afterReport = await engine.analyzeFromSnapshot(simulatedSnapshot, { useAi: false });

    const beforeIds = new Set((beforeReport.diagnostics?.issues || []).map((i) => i.id));
    const afterIds = new Set((afterReport.diagnostics?.issues || []).map((i) => i.id));

    return {
      simulationId,
      before: { issues: beforeReport.diagnostics?.issues || [], coverageScore: beforeReport.coverage?.score || 0 },
      after: { issues: afterReport.diagnostics?.issues || [], coverageScore: afterReport.coverage?.score || 0 },
      diff: {
        issueDelta: (afterReport.diagnostics?.issues?.length || 0) - (beforeReport.diagnostics?.issues?.length || 0),
        coverageDelta: (afterReport.coverage?.score || 0) - (beforeReport.coverage?.score || 0),
        resolvedIssueIds: Array.from(beforeIds).filter((id) => !afterIds.has(id)).sort(),
        newIssueIds: Array.from(afterIds).filter((id) => !beforeIds.has(id)).sort(),
      },
    };
  } catch (err) {
    return { error: err.message };
  }
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
      runAnalysis({ triggerType: 'event', triggerReason: trigger.reason }).catch(() => {});
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

    runAnalysis({ triggerType: 'schedule', triggerReason: 'scheduled-sweep' }).catch(() => {});

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
        }).catch(() => {});
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

// ─── MODULE EXPORTS ──────────────────────────────────────────────────────────

module.exports = {
  init,
  isAvailable,
  buildLiveSnapshot,
  runAnalysis,
  runGoNoGo,
  simulateFix,
  recordFeedback,
  onAgentEvent,
  startScheduledSweeps,
  stopScheduledSweeps,
  schedulePreflight,
  clearPreflightTimers,
  getRunHistory,
  getFeatureFlags,
};
