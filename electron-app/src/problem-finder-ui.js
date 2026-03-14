/**
 * problem-finder-ui.js — Renderer-side module for the Problems tab.
 *
 * Provides all UI logic for the lightweight Problem Finder desktop surface:
 * KPI cards, issue list, Go/No-Go badge, action plan, run history.
 */

/* global electronAPI */

// ─── STATE ───────────────────────────────────────────────────────────────────
let _pfLastReport = null;
let _pfLastGoNoGo = null;
let _pfLoading = false;
let _activeTroubleshoot = null; // { flowKey, stepIndex }

// Named handler for backdrop click (avoids listener leak when reopening)
function _troubleshootBackdropClick(e) {
  const overlay = document.getElementById('troubleshoot-overlay');
  if (e.target === overlay) closeTroubleshooter();
}

// ─── GUIDED TROUBLESHOOTER FLOWS ─────────────────────────────────────────────

const TROUBLESHOOT_FLOWS = {
  'obs_disconnected': {
    title: 'OBS Not Connected',
    steps: [
      { question: 'Is OBS Studio open on this computer?', options: ['Yes', 'No'],
        onNo: { action: 'Please open OBS Studio, then click Retry.', retry: true },
        onYes: 'next' },
      { question: 'Check OBS \u2192 Tools \u2192 WebSocket Server Settings. Is the server enabled?', options: ['Yes', 'No'],
        onNo: { action: 'Enable it, set port to 4455, click OK. Then click Retry.', retry: true },
        onYes: 'next' },
      { question: 'Is the port set to 4455 and password matches your Tally config?', options: ['Yes', 'Not Sure'],
        onNotSure: { action: 'Set port to 4455. If you have a password set, make sure it matches what\'s in Tally Equipment settings.', retry: true },
        onYes: 'next' },
      { instruction: 'Tally is attempting to reconnect...', autoCheck: 'obs', timeout: 10000 },
    ],
    fallback: 'Could not resolve automatically. A diagnostic report has been sent to support.'
  },
  'atem_disconnected': {
    title: 'ATEM Switcher Not Connected',
    steps: [
      { question: 'Is the ATEM switcher powered on?', options: ['Yes', 'No'],
        onNo: { action: 'Power on the ATEM and wait 30 seconds for it to boot. Then click Retry.', retry: true },
        onYes: 'next' },
      { question: 'Is the ATEM connected to the same network as this computer?', options: ['Yes', 'Not Sure'],
        onNotSure: { action: 'Check the ethernet cable from the ATEM to your network switch. The link light should be on.', retry: true },
        onYes: 'next' },
      { question: 'Can you open ATEM Software Control and connect?', options: ['Yes', 'No'],
        onNo: { action: 'The ATEM may have a different IP. Check ATEM Setup utility or the LCD on the front panel. Update the IP in Tally Equipment settings.', retry: true },
        onYes: 'next' },
      { instruction: 'Tally is attempting to reconnect...', autoCheck: 'atem', timeout: 15000 },
    ],
    fallback: 'ATEM connection failed after troubleshooting. Diagnostic report sent to support.'
  },
  'stream_stopped': {
    title: 'Stream Has Stopped',
    steps: [
      { question: 'Did you intentionally stop the stream?', options: ['Yes', 'No'],
        onYes: { action: 'No action needed. Close this wizard.', done: true },
        onNo: 'next' },
      { question: 'Is your internet connection working? Can you load a website?', options: ['Yes', 'No'],
        onNo: { action: 'Check your network connection. The stream cannot run without internet. Contact your IT team if the network is down.', retry: true },
        onYes: 'next' },
      { instruction: 'Attempting to restart the stream...', autoAction: 'restart_stream', timeout: 15000 },
      { question: 'Is the stream back online?', options: ['Yes', 'No'],
        onNo: 'next', onYes: { action: 'Stream recovered!', done: true } },
      { instruction: 'Checking stream key and platform status...', autoCheck: 'stream_health', timeout: 10000 },
    ],
    fallback: 'Stream could not be restarted. Check your stream key in OBS/encoder settings. Diagnostic report sent.'
  },
  'audio_silence': {
    title: 'No Audio Detected',
    steps: [
      { question: 'Is the audio mixer/console powered on?', options: ['Yes', 'No'],
        onNo: { action: 'Power on the audio console and wait for it to boot.', retry: true },
        onYes: 'next' },
      { question: 'Are the channel faders up on the mixer?', options: ['Yes', 'Not Sure'],
        onNotSure: { action: 'Check that the main output and relevant channel faders are up (not muted).', retry: true },
        onYes: 'next' },
      { question: 'Is audio routed to the stream? (USB out, Dante, or aux send to encoder)', options: ['Yes', 'Not Sure'],
        onNotSure: { action: 'Check that the audio output going to your stream encoder is active. This is usually a USB output, Dante route, or aux send.', retry: true },
        onYes: 'next' },
      { question: 'Check OBS/encoder \u2014 is the audio meter showing any signal?', options: ['Yes', 'No'],
        onYes: { action: 'Audio is reaching the encoder. The issue may have been temporary. Monitor it.', done: true },
        onNo: 'next' },
    ],
    fallback: 'Audio path issue could not be identified. Check physical connections from mixer to encoder. Diagnostic report sent.'
  },
  'encoder_disconnected': {
    title: 'Encoder Not Connected',
    steps: [
      { question: 'Is the encoder hardware powered on and showing activity lights?', options: ['Yes', 'No'],
        onNo: { action: 'Power on the encoder. Wait 60 seconds for it to fully boot. Then click Retry.', retry: true },
        onYes: 'next' },
      { question: 'Is the encoder connected to the same network as this computer?', options: ['Yes', 'Not Sure'],
        onNotSure: { action: 'Check the ethernet cable from the encoder to your network switch.', retry: true },
        onYes: 'next' },
      { instruction: 'Attempting to reconnect to encoder...', autoCheck: 'encoder', timeout: 15000 },
    ],
    fallback: 'Encoder connection failed. Check the encoder IP address in Tally Equipment settings. Diagnostic report sent.'
  },
  'recording_not_started': {
    title: 'Recording Not Running',
    steps: [
      { question: 'Should recording be running right now?', options: ['Yes', 'No'],
        onNo: { action: 'No action needed.', done: true },
        onYes: 'next' },
      { question: 'Is there enough disk space? (Check the recording drive)', options: ['Yes', 'Not Sure'],
        onNotSure: { action: 'Check that the recording drive has at least 50GB free.', retry: true },
        onYes: 'next' },
      { instruction: 'Attempting to start recording...', autoAction: 'start_recording', timeout: 10000 },
    ],
    fallback: 'Recording could not be started. Check disk space and recording path in OBS/HyperDeck settings. Diagnostic report sent.'
  },
  'companion_disconnected': {
    title: 'Companion Not Connected',
    steps: [
      { question: 'Is Bitfocus Companion running on this computer or another machine?', options: ['This computer', 'Another machine', 'Not Sure'],
        onNotSure: { action: 'Check if Companion is open. It usually runs at http://localhost:8000', retry: true },
        onThisComputer: 'next', onAnotherMachine: 'next' },
      { question: 'Can you open the Companion web UI in a browser?', options: ['Yes', 'No'],
        onNo: { action: 'Companion may not be running. Open the Bitfocus Companion application.', retry: true },
        onYes: 'next' },
      { instruction: 'Attempting to reconnect...', autoCheck: 'companion', timeout: 10000 },
    ],
    fallback: 'Companion connection failed. Verify the Companion host/port in Tally Equipment settings.'
  },
  'fps_low': {
    title: 'Low Frame Rate',
    steps: [
      { question: 'Is the computer running other heavy applications? (games, video editing, etc.)', options: ['Yes', 'No'],
        onYes: { action: 'Close unnecessary applications to free up CPU/GPU resources. Then click Retry.', retry: true },
        onNo: 'next' },
      { question: 'Is CPU usage above 80%?', options: ['Yes', 'No', 'Not Sure'],
        onYes: { action: 'Reduce OBS output resolution or switch to a less demanding encoder preset (e.g., "veryfast").', retry: true },
        onNo: 'next', onNotSure: 'next' },
      { instruction: 'Monitoring frame rate for improvement...', autoCheck: 'fps', timeout: 15000 },
    ],
    fallback: 'Frame rate remains low. Consider reducing resolution, bitrate, or closing other applications.'
  },
};

// ─── SEVERITY HELPERS ────────────────────────────────────────────────────────

const PF_SEVERITY_COLORS = {
  critical: 'var(--danger)',
  high:     'var(--warn)',
  medium:   'var(--green)',
  low:      'var(--muted)',
  info:     'var(--dim)',
};

const PF_SEVERITY_LABELS = {
  critical: 'CRITICAL',
  high:     'HIGH',
  medium:   'MEDIUM',
  low:      'LOW',
  info:     'INFO',
};

// ─── LOAD / INIT ─────────────────────────────────────────────────────────────

async function loadProblemFinder() {
  const api = window.electronAPI;
  if (!api) return;

  const available = await api.pfAvailable();
  const unavailableEl = document.getElementById('pf-unavailable');
  const contentEl = document.getElementById('pf-content');

  if (!available) {
    if (unavailableEl) unavailableEl.style.display = 'block';
    if (contentEl) contentEl.style.display = 'none';
    return;
  }

  if (unavailableEl) unavailableEl.style.display = 'none';
  if (contentEl) contentEl.style.display = 'block';

  // Restore cameras-verified checkbox state
  try {
    const verified = await api.pfGetCamerasVerified();
    const cb = document.getElementById('pf-cameras-verified-cb');
    if (cb) cb.checked = !!verified;
  } catch { /* ignore */ }

  // Load run history
  try {
    const history = await api.pfRunHistory();
    renderPfRunHistory(history);
  } catch { /* ignore */ }

  // If we have cached report, render it; otherwise show default state
  if (_pfLastReport) {
    renderPfReport(_pfLastReport, _pfLastGoNoGo);
  }
}

async function pfToggleCamerasVerified(checked) {
  const api = window.electronAPI;
  if (!api || !api.pfSetCamerasVerified) return;
  await api.pfSetCamerasVerified(checked);
}

// ─── AUTO-REFRESH FROM MAIN PROCESS ──────────────────────────────────────────

function initProblemFinderListener() {
  const api = window.electronAPI;
  if (!api || !api.onPfUpdate) return;

  api.onPfUpdate((data) => {
    if (data.report) {
      _pfLastReport = data.report;
      _pfLastGoNoGo = data.goNoGo || null;
      // Only render if Tally Engineer tab is active
      const tab = document.getElementById('tab-engineer');
      if (tab && tab.classList.contains('active')) {
        renderPfReport(data.report, data.goNoGo);
      }
      // Update issue badge on Status tab (from renderer.js globals)
      if (typeof _pfAutoRunIssueCount !== 'undefined' && typeof updatePfBadge === 'function') {
        const issues = data.report.diagnostics?.issues || [];
        const realIssues = issues.filter(i => i.id !== 'no_issues_detected');
        _pfAutoRunIssueCount = realIssues.length;
        // Only show badge when Status tab is active (not engineer tab)
        const statusTab = document.getElementById('tab-status');
        if (statusTab && statusTab.classList.contains('active')) {
          // User is already viewing status — don't show badge
        } else {
          updatePfBadge();
        }
      }
    }
    if (data.runEntry) {
      const history = document.getElementById('pf-run-history');
      if (history) {
        prependRunEntry(data.runEntry);
      }
    }
  });
}

// ─── USER ACTIONS ────────────────────────────────────────────────────────────

async function pfRunVerify() {
  if (_pfLoading) return;
  _pfLoading = true;

  const btn = document.getElementById('pf-run-verify');
  if (btn) { btn.textContent = '⏳ Running…'; btn.disabled = true; }

  try {
    const api = window.electronAPI;
    const result = await api.pfAnalyze();
    if (result.report) {
      _pfLastReport = result.report;
      _pfLastGoNoGo = result.goNoGo || null;
      renderPfReport(result.report, result.goNoGo);
    } else if (result.error) {
      showPfError(result.error);
    }
    // Refresh run history
    const history = await api.pfRunHistory();
    renderPfRunHistory(history);
  } catch (err) {
    showPfError(err.message || 'Analysis failed');
  } finally {
    _pfLoading = false;
    if (btn) { btn.textContent = '▶ Check System'; btn.disabled = false; }
  }
}

async function pfRunPreflight() {
  if (_pfLoading) return;
  _pfLoading = true;

  const btn = document.getElementById('pf-run-preflight');
  if (btn) { btn.textContent = '⏳ Running…'; btn.disabled = true; }

  try {
    const api = window.electronAPI;
    const result = await api.pfGoNoGo({ triggerType: 'preflight' });
    if (result.report) {
      _pfLastReport = result.report;
      _pfLastGoNoGo = result.goNoGo || null;
      renderPfReport(result.report, result.goNoGo);
    } else if (result.error) {
      showPfError(result.error);
    }
    const history = await api.pfRunHistory();
    renderPfRunHistory(history);
  } catch (err) {
    showPfError(err.message || 'Preflight failed');
  } finally {
    _pfLoading = false;
    if (btn) { btn.textContent = '🛫 Pre-Service Check'; btn.disabled = false; }
  }
}

// ─── RENDERING ───────────────────────────────────────────────────────────────

function renderPfReport(report, goNoGo) {
  renderPfKpis(report);
  renderPfIssues(report.diagnostics?.issues || []);
  renderPfActionPlan(report.actionPlan?.steps || []);
  if (goNoGo) renderPfGoStatus(goNoGo);
}

function renderPfKpis(report) {
  const issues = report.diagnostics?.issues || [];
  const counts = report.diagnostics?.counts || {};
  const critHigh = (counts.critical || 0) + (counts.high || 0);
  const coverage = report.coverage?.score ?? '--';
  const total = issues.filter((i) => i.id !== 'no_issues_detected').length;

  setText('pf-critical-count', critHigh);
  setText('pf-coverage', typeof coverage === 'number' ? `${coverage}%` : coverage);
  setText('pf-issue-count', total);
  setText('pf-last-run', formatTime(report.generatedAt));

  // Color-code critical/high count
  const critEl = document.getElementById('pf-critical-count');
  if (critEl) {
    critEl.style.color = critHigh > 0 ? 'var(--danger)' : 'var(--green)';
  }
}

function renderPfGoStatus(goNoGo) {
  const el = document.getElementById('pf-go-badge');
  if (!el) return;

  const isGo = goNoGo.status === 'GO';
  el.style.display = 'block';
  el.style.background = isGo ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';
  el.style.border = `1px solid ${isGo ? 'var(--green)' : 'var(--danger)'}`;
  el.style.borderRadius = '8px';
  el.style.padding = '10px 14px';
  el.style.marginBottom = '12px';

  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px;">
      <span style="font-size:18px; font-weight:800; color:${isGo ? 'var(--green)' : 'var(--danger)'};">
        ${isGo ? '✅ GO' : '🚫 NO-GO'}
      </span>
      <span style="color:var(--muted); font-size:11px;">
        ${goNoGo.triggerType} • ${formatTime(goNoGo.decisionAt)}
      </span>
    </div>
    ${!isGo && goNoGo.blockerCount > 0 ? `
      <div style="margin-top:6px; font-size:11px; color:var(--muted);">
        ${goNoGo.blockerCount} blocker(s): ${goNoGo.blockers.map((b) => b.title).join(', ')}
      </div>
    ` : ''}
    <div style="margin-top:4px; font-size:11px; color:var(--dim);">${escHtml(goNoGo.notes)}</div>
  `;
}

function renderPfIssues(issues) {
  const el = document.getElementById('pf-issues-list');
  if (!el) return;

  // Filter out the "no issues" info entry for display
  const displayIssues = issues.filter((i) => i.id !== 'no_issues_detected');

  if (displayIssues.length === 0) {
    el.innerHTML = '<p style="color:var(--green); font-size:12px;">✅ No issues detected — system looks healthy.</p>';
    return;
  }

  el.innerHTML = displayIssues.slice(0, 8).map((issue) => {
    const hasFlow = !!TROUBLESHOOT_FLOWS[issue.id];
    return `
    <div class="pf-issue-card">
      <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
        <span class="pf-severity-pill" style="background:${PF_SEVERITY_COLORS[issue.severity] || 'var(--dim)'};">
          ${PF_SEVERITY_LABELS[issue.severity] || issue.severity}
        </span>
        <span style="font-size:12px; font-weight:600; color:var(--white);">${escHtml(issue.title)}</span>
      </div>
      <div style="font-size:11px; color:var(--muted); margin-bottom:3px;">${escHtml(issue.symptom)}</div>
      ${hasFlow ? `
        <button class="btn-tiny troubleshoot-fix-btn" onclick="launchTroubleshooter('${escAttr(issue.id)}')">
          Fix This
        </button>
      ` : `
        ${issue.fixSteps && issue.fixSteps.length > 0 ? `
          <div style="font-size:11px; color:var(--dim);">\u{1F4A1} ${escHtml(issue.fixSteps[0])}</div>
        ` : ''}
      `}
      ${issue.simulation ? `
        <button class="btn-tiny" onclick="pfSimulateFix('${escAttr(issue.simulation.id)}')">
          Simulate Fix: ${escHtml(issue.simulation.label)}
        </button>
      ` : ''}
    </div>
  `;
  }).join('');
}

function renderPfActionPlan(steps) {
  const el = document.getElementById('pf-action-plan');
  if (!el) return;

  if (!steps || steps.length === 0) {
    el.innerHTML = '<p style="color:var(--green); font-size:12px;">No action items — all clear.</p>';
    return;
  }

  el.innerHTML = `<ol style="margin:0; padding-left:18px; font-size:12px; color:var(--muted);">
    ${steps.map((s) => `<li style="margin-bottom:4px;">
      <span style="color:var(--white);">${escHtml(s.step)}</span>
      <span style="color:var(--dim); font-size:10px;"> — ${escHtml(s.why || '')}</span>
    </li>`).join('')}
  </ol>`;
}

function renderPfRunHistory(runs) {
  const el = document.getElementById('pf-run-history');
  if (!el) return;

  if (!runs || runs.length === 0) {
    el.innerHTML = '<p style="color:var(--muted); font-size:12px;">No runs yet.</p>';
    return;
  }

  // Show last 10, newest first
  const recent = runs.slice(-10).reverse();
  el.innerHTML = recent.map((run) => {
    const goColor = run.goNoGoStatus === 'GO' ? 'var(--green)' : run.goNoGoStatus === 'NO_GO' ? 'var(--danger)' : 'var(--muted)';
    return `
    <div class="pf-run-entry">
      <span style="color:${goColor}; font-weight:700; font-size:10px; width:42px; display:inline-block;">${run.goNoGoStatus || '—'}</span>
      <span style="color:var(--muted); font-size:11px;">${formatTime(run.startedAt)}</span>
      <span style="color:var(--dim); font-size:10px;">${run.triggerType}${run.triggerReason ? '/' + run.triggerReason : ''}</span>
      <span style="color:var(--white); font-size:11px;">${run.issueCount} issues</span>
      <span style="color:var(--dim); font-size:10px;">${run.durationMs}ms</span>
    </div>
    `;
  }).join('');
}

function prependRunEntry(run) {
  const el = document.getElementById('pf-run-history');
  if (!el) return;
  // Remove the "no runs" message if present
  const noRuns = el.querySelector('p');
  if (noRuns) noRuns.remove();

  const goColor = run.goNoGoStatus === 'GO' ? 'var(--green)' : run.goNoGoStatus === 'NO_GO' ? 'var(--danger)' : 'var(--muted)';
  const div = document.createElement('div');
  div.className = 'pf-run-entry';
  div.innerHTML = `
    <span style="color:${goColor}; font-weight:700; font-size:10px; width:42px; display:inline-block;">${run.goNoGoStatus || '—'}</span>
    <span style="color:var(--muted); font-size:11px;">${formatTime(run.startedAt)}</span>
    <span style="color:var(--dim); font-size:10px;">${run.triggerType}${run.triggerReason ? '/' + run.triggerReason : ''}</span>
    <span style="color:var(--white); font-size:11px;">${run.issueCount} issues</span>
    <span style="color:var(--dim); font-size:10px;">${run.durationMs}ms</span>
  `;
  el.prepend(div);

  // Keep max 10 visible
  const entries = el.querySelectorAll('.pf-run-entry');
  if (entries.length > 10) entries[entries.length - 1].remove();
}

async function pfSimulateFix(simId) {
  try {
    const api = window.electronAPI;
    const result = await api.pfSimulateFix(simId);
    if (result.error) {
      showPfError(result.error);
      return;
    }
    const diff = result.diff;
    // Show simulation result in a non-blocking dialog
    const msg = `Simulation: ${simId}\n\nIssues: ${diff.issueDelta >= 0 ? '+' : ''}${diff.issueDelta}\nCoverage: ${diff.coverageDelta >= 0 ? '+' : ''}${diff.coverageDelta}\nResolved: ${diff.resolvedIssueIds.join(', ') || 'none'}\nNew: ${diff.newIssueIds.join(', ') || 'none'}`;
    if (typeof asyncConfirm === 'function') {
      await asyncConfirm(msg);
    }
  } catch (err) {
    showPfError(err.message);
  }
}

// ─── GUIDED TROUBLESHOOTER ────────────────────────────────────────────────────

/**
 * Launch the interactive troubleshooter modal for a given issue type.
 */
function launchTroubleshooter(issueType) {
  const flow = TROUBLESHOOT_FLOWS[issueType];
  if (!flow) return;

  _activeTroubleshoot = { flowKey: issueType, stepIndex: 0 };

  // Create overlay if it doesn't exist
  let overlay = document.getElementById('troubleshoot-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'troubleshoot-overlay';
    overlay.className = 'troubleshoot-overlay';
    document.body.appendChild(overlay);
  }

  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="troubleshoot-modal">
      <div class="troubleshoot-modal-header">
        <span class="troubleshoot-modal-title">${escHtml(flow.title)}</span>
        <button class="troubleshoot-close-btn" onclick="closeTroubleshooter()">&times;</button>
      </div>
      <div id="troubleshoot-progress" class="troubleshoot-progress"></div>
      <div id="troubleshoot-body" class="troubleshoot-body"></div>
    </div>
  `;

  // Close on backdrop click (use named function to prevent listener leak)
  overlay.removeEventListener('click', _troubleshootBackdropClick);
  overlay.addEventListener('click', _troubleshootBackdropClick);

  renderTroubleshootStep(flow, 0);
}

/**
 * Close the troubleshooter modal.
 */
function closeTroubleshooter() {
  _activeTroubleshoot = null;
  const overlay = document.getElementById('troubleshoot-overlay');
  if (overlay) overlay.style.display = 'none';
}

/**
 * Render a single step in the troubleshooter wizard.
 */
function renderTroubleshootStep(flow, stepIndex) {
  const body = document.getElementById('troubleshoot-body');
  const progress = document.getElementById('troubleshoot-progress');
  if (!body || !progress) return;

  const totalSteps = flow.steps.length;

  // Update progress indicator
  progress.innerHTML = `<span class="troubleshoot-progress-text">Step ${stepIndex + 1} of ${totalSteps}</span>
    <div class="troubleshoot-progress-bar">
      <div class="troubleshoot-progress-fill" style="width: ${((stepIndex + 1) / totalSteps) * 100}%"></div>
    </div>`;

  // Past the last step — show fallback
  if (stepIndex >= totalSteps) {
    showTroubleshootFallback(flow);
    return;
  }

  const step = flow.steps[stepIndex];

  // Instruction step with autoCheck or autoAction
  if (step.instruction) {
    body.innerHTML = `
      <div class="troubleshoot-step">
        <p class="troubleshoot-instruction">${escHtml(step.instruction)}</p>
        <div class="troubleshoot-spinner">
          <div class="troubleshoot-spinner-ring"></div>
          <span>Please wait...</span>
        </div>
      </div>
    `;
    handleAutoStep(flow, stepIndex, step);
    return;
  }

  // Question step
  if (step.question) {
    const optionsHtml = (step.options || []).map((opt) => {
      const safeOpt = escAttr(opt);
      const flowKey = escAttr(_activeTroubleshoot.flowKey);
      return `<button class="troubleshoot-option-btn" onclick="advanceTroubleshoot('${flowKey}', ${stepIndex}, '${safeOpt}')">${escHtml(opt)}</button>`;
    }).join('');

    body.innerHTML = `
      <div class="troubleshoot-step">
        <p class="troubleshoot-question">${escHtml(step.question)}</p>
        <div class="troubleshoot-options">${optionsHtml}</div>
      </div>
    `;
    return;
  }
}

/**
 * Handle auto-check or auto-action steps with timeout.
 */
async function handleAutoStep(flow, stepIndex, step) {
  const timeout = step.timeout || 10000;
  const checkType = step.autoCheck || null;
  const actionType = step.autoAction || null;

  let resolved = false;

  // Start a timeout
  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      // Auto step failed — move to next step or fallback
      const nextIndex = stepIndex + 1;
      if (nextIndex < flow.steps.length) {
        renderTroubleshootStep(flow, nextIndex);
      } else {
        showTroubleshootFallback(flow);
      }
    }
  }, timeout);

  try {
    const api = window.electronAPI;

    if (actionType && api && api.sendCommand) {
      // Fire the recovery action command
      await api.sendCommand(actionType);
    }

    if (checkType && api) {
      // Poll for device status improvement
      const pollInterval = 2000;
      const maxPolls = Math.floor(timeout / pollInterval);
      for (let i = 0; i < maxPolls && !resolved; i++) {
        await new Promise((r) => setTimeout(r, pollInterval));
        if (resolved) break;

        // Re-run analysis to check if issue is resolved
        try {
          const result = await api.pfAnalyze();
          if (result.report) {
            const issues = result.report.diagnostics?.issues || [];
            const stillPresent = issues.some((iss) => iss.id === _activeTroubleshoot?.flowKey);
            if (!stillPresent) {
              resolved = true;
              clearTimeout(timer);
              showTroubleshootSuccess(flow);
              return;
            }
          }
        } catch { /* continue polling */ }
      }
    } else if (actionType) {
      // Wait a moment after action, then check
      await new Promise((r) => setTimeout(r, 3000));
      if (!resolved && api) {
        try {
          const result = await api.pfAnalyze();
          if (result.report) {
            const issues = result.report.diagnostics?.issues || [];
            const stillPresent = issues.some((iss) => iss.id === _activeTroubleshoot?.flowKey);
            if (!stillPresent) {
              resolved = true;
              clearTimeout(timer);
              showTroubleshootSuccess(flow);
              return;
            }
          }
        } catch { /* ignore */ }
      }
    }
  } catch {
    // On error, let timeout handle fallback
  }

  if (!resolved) {
    resolved = true;
    clearTimeout(timer);
    const nextIndex = stepIndex + 1;
    if (nextIndex < flow.steps.length) {
      renderTroubleshootStep(flow, nextIndex);
    } else {
      showTroubleshootFallback(flow);
    }
  }
}

/**
 * Process the user's choice on a question step and advance.
 */
function advanceTroubleshoot(flowKey, stepIndex, choice) {
  const flow = TROUBLESHOOT_FLOWS[flowKey];
  if (!flow) return;

  const step = flow.steps[stepIndex];
  if (!step) return;

  // Build the handler key from the choice (e.g., "Yes" -> "onYes", "This computer" -> "onThisComputer")
  const key = 'on' + choice.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  const handlerKey = key;

  let handler = step[handlerKey];

  // If no specific handler, try to fall through to next
  if (handler === undefined) {
    // Default: advance to next step
    handler = 'next';
  }

  if (handler === 'next') {
    const nextIndex = stepIndex + 1;
    if (nextIndex < flow.steps.length) {
      _activeTroubleshoot.stepIndex = nextIndex;
      renderTroubleshootStep(flow, nextIndex);
    } else {
      showTroubleshootFallback(flow);
    }
    return;
  }

  if (typeof handler === 'object') {
    if (handler.done) {
      showTroubleshootSuccess(flow, handler.action);
      return;
    }

    if (handler.retry) {
      showTroubleshootAction(flow, stepIndex, handler.action);
      return;
    }

    if (handler.action) {
      showTroubleshootAction(flow, stepIndex, handler.action);
      return;
    }
  }

  // Fallback: advance
  const nextIndex = stepIndex + 1;
  if (nextIndex < flow.steps.length) {
    _activeTroubleshoot.stepIndex = nextIndex;
    renderTroubleshootStep(flow, nextIndex);
  } else {
    showTroubleshootFallback(flow);
  }
}

/**
 * Show an action instruction with a Retry button.
 */
function showTroubleshootAction(flow, stepIndex, actionText) {
  const body = document.getElementById('troubleshoot-body');
  if (!body) return;

  const flowKey = escAttr(_activeTroubleshoot.flowKey);

  body.innerHTML = `
    <div class="troubleshoot-step">
      <div class="troubleshoot-action">
        <p>${escHtml(actionText)}</p>
      </div>
      <div class="troubleshoot-action-buttons">
        <button class="troubleshoot-option-btn" onclick="troubleshootRetry('${flowKey}', ${stepIndex})">Retry</button>
        <button class="troubleshoot-option-btn troubleshoot-skip-btn" onclick="troubleshootSkip('${flowKey}', ${stepIndex})">Skip</button>
      </div>
    </div>
  `;
}

/**
 * Retry: re-run analysis to check if issue resolved, then re-show step or advance.
 */
async function troubleshootRetry(flowKey, stepIndex) {
  const flow = TROUBLESHOOT_FLOWS[flowKey];
  if (!flow) return;

  const body = document.getElementById('troubleshoot-body');
  if (body) {
    body.innerHTML = `
      <div class="troubleshoot-step">
        <div class="troubleshoot-spinner">
          <div class="troubleshoot-spinner-ring"></div>
          <span>Checking...</span>
        </div>
      </div>
    `;
  }

  try {
    const api = window.electronAPI;
    if (api) {
      const result = await api.pfAnalyze();
      if (result.report) {
        _pfLastReport = result.report;
        _pfLastGoNoGo = result.goNoGo || null;
        renderPfReport(result.report, result.goNoGo);

        const issues = result.report.diagnostics?.issues || [];
        const stillPresent = issues.some((iss) => iss.id === flowKey);
        if (!stillPresent) {
          showTroubleshootSuccess(flow);
          return;
        }
      }
    }
  } catch { /* ignore */ }

  // Issue still present — advance to next step
  const nextIndex = stepIndex + 1;
  if (nextIndex < flow.steps.length) {
    _activeTroubleshoot.stepIndex = nextIndex;
    renderTroubleshootStep(flow, nextIndex);
  } else {
    showTroubleshootFallback(flow);
  }
}

/**
 * Skip the current step and move on.
 */
function troubleshootSkip(flowKey, stepIndex) {
  const flow = TROUBLESHOOT_FLOWS[flowKey];
  if (!flow) return;

  const nextIndex = stepIndex + 1;
  if (nextIndex < flow.steps.length) {
    _activeTroubleshoot.stepIndex = nextIndex;
    renderTroubleshootStep(flow, nextIndex);
  } else {
    showTroubleshootFallback(flow);
  }
}

/**
 * Show success state — issue resolved.
 */
function showTroubleshootSuccess(flow, message) {
  const body = document.getElementById('troubleshoot-body');
  const progress = document.getElementById('troubleshoot-progress');
  if (!body) return;

  if (progress) {
    progress.innerHTML = `<span class="troubleshoot-progress-text">Complete</span>
      <div class="troubleshoot-progress-bar">
        <div class="troubleshoot-progress-fill" style="width: 100%"></div>
      </div>`;
  }

  const displayMsg = message || (flow.title + ' has been resolved.');

  body.innerHTML = `
    <div class="troubleshoot-step troubleshoot-success">
      <div class="troubleshoot-success-icon">\u2713</div>
      <p class="troubleshoot-success-text">${escHtml(displayMsg)}</p>
      <button class="troubleshoot-option-btn" onclick="closeTroubleshooter()">Close</button>
    </div>
  `;
}

/**
 * Show fallback state — self-service failed, offer to send diagnostic report.
 */
function showTroubleshootFallback(flow) {
  const body = document.getElementById('troubleshoot-body');
  const progress = document.getElementById('troubleshoot-progress');
  if (!body) return;

  if (progress) {
    progress.innerHTML = `<span class="troubleshoot-progress-text">Escalation needed</span>
      <div class="troubleshoot-progress-bar">
        <div class="troubleshoot-progress-fill troubleshoot-progress-fill-warn" style="width: 100%"></div>
      </div>`;
  }

  body.innerHTML = `
    <div class="troubleshoot-step troubleshoot-fallback">
      <div class="troubleshoot-fallback-icon">!</div>
      <p class="troubleshoot-fallback-text">${escHtml(flow.fallback)}</p>
      <div class="troubleshoot-fallback-buttons">
        <button class="troubleshoot-option-btn troubleshoot-report-btn" onclick="troubleshootSendReport()">Send Diagnostic Report</button>
        <button class="troubleshoot-option-btn" onclick="closeTroubleshooter()">Close</button>
      </div>
    </div>
  `;
}

/**
 * Send a diagnostic report to support (via the existing relay push mechanism).
 */
async function troubleshootSendReport() {
  const btn = document.querySelector('.troubleshoot-report-btn');
  if (btn) { btn.textContent = 'Sending...'; btn.disabled = true; }

  try {
    const api = window.electronAPI;
    if (api && api.sendDiagnosticBundle) {
      const result = await api.sendDiagnosticBundle();
      if (result?.error) {
        if (btn) { btn.textContent = 'Send Failed - Try Again'; btn.disabled = false; }
        return;
      }
    }
    if (btn) { btn.textContent = 'Diagnostic Report Sent'; }
  } catch {
    if (btn) { btn.textContent = 'Send Failed - Try Again'; btn.disabled = false; }
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

function formatTime(iso) {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return '--'; }
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escAttr(str) {
  return String(str || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

function showPfError(msg) {
  const el = document.getElementById('pf-issues-list');
  if (el) {
    el.innerHTML = `<p style="color:var(--danger); font-size:12px;">Error: ${escHtml(msg)}</p>`;
  }
}
