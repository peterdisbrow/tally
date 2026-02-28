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

  el.innerHTML = displayIssues.slice(0, 8).map((issue) => `
    <div class="pf-issue-card">
      <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
        <span class="pf-severity-pill" style="background:${PF_SEVERITY_COLORS[issue.severity] || 'var(--dim)'};">
          ${PF_SEVERITY_LABELS[issue.severity] || issue.severity}
        </span>
        <span style="font-size:12px; font-weight:600; color:var(--white);">${escHtml(issue.title)}</span>
      </div>
      <div style="font-size:11px; color:var(--muted); margin-bottom:3px;">${escHtml(issue.symptom)}</div>
      ${issue.fixSteps && issue.fixSteps.length > 0 ? `
        <div style="font-size:11px; color:var(--dim);">💡 ${escHtml(issue.fixSteps[0])}</div>
      ` : ''}
      ${issue.simulation ? `
        <button class="btn-tiny" onclick="pfSimulateFix('${escAttr(issue.simulation.id)}')">
          Simulate Fix: ${escHtml(issue.simulation.label)}
        </button>
      ` : ''}
    </div>
  `).join('');
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
