'use strict';

const state = {
  latest: null
};

const el = {
  prompt: document.getElementById('prompt'),
  deckModel: document.getElementById('deckModel'),
  layoutName: document.getElementById('layoutName'),
  companionUrl: document.getElementById('companionUrl'),
  generateBtn: document.getElementById('generateBtn'),
  exportBtn: document.getElementById('exportBtn'),
  compatBtn: document.getElementById('compatBtn'),
  deployBtn: document.getElementById('deployBtn'),
  pages: document.getElementById('pages'),
  warnings: document.getElementById('warnings'),
  compatibility: document.getElementById('compatibility'),
  deploy: document.getElementById('deploy'),
  summary: document.getElementById('summary'),
  healthPill: document.getElementById('healthPill')
};

bootstrap();

async function bootstrap() {
  el.prompt.value = 'I have a Stream Deck XL and want to use it as an M/E 2 control surface with status feedback and transitions.';
  el.companionUrl.value = 'http://localhost:8888';
  await checkHealth();

  el.generateBtn.addEventListener('click', generate);
  el.exportBtn.addEventListener('click', exportLayout);
  el.compatBtn.addEventListener('click', checkCompatibility);
  el.deployBtn.addEventListener('click', dryRunDeploy);
}

function selectedGear() {
  return Array.from(document.querySelectorAll('[data-gear]'))
    .filter((input) => input.checked)
    .map((input) => {
      const type = input.getAttribute('data-gear');
      return { type, connectionId: `${type}-1`, name: type.toUpperCase() };
    });
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.ok) {
      el.healthPill.textContent = `Service online • ${new Date(data.ts).toLocaleTimeString()}`;
      el.healthPill.classList.add('ok');
      return;
    }
  } catch {
    // noop
  }
  el.healthPill.textContent = 'Service unavailable';
}

async function generate() {
  setBusy(el.generateBtn, true, 'Generating...');
  disablePostGenerateActions();
  clearOutput();

  try {
    const payload = {
      prompt: el.prompt.value,
      deckModel: el.deckModel.value,
      gear: selectedGear()
    };

    const data = await postJson('/api/generate', payload);
    state.latest = data;
    render(data);
    enablePostGenerateActions();
  } catch (error) {
    renderMessages([], [error.message]);
  } finally {
    setBusy(el.generateBtn, false, 'Generate Layout');
  }
}

async function exportLayout() {
  if (!state.latest?.layout) return;
  setBusy(el.exportBtn, true, 'Exporting...');

  try {
    const data = await postJson('/api/export', {
      name: el.layoutName.value,
      layout: state.latest.layout
    });

    renderInfo(el.deploy, [
      `Exported layout JSON: ${data.files.layoutJson}`,
      `Exported plan markdown: ${data.files.planMarkdown}`
    ]);
  } catch (error) {
    renderInfo(el.deploy, [], [error.message]);
  } finally {
    setBusy(el.exportBtn, false, 'Export Files');
  }
}

async function checkCompatibility() {
  if (!state.latest?.layout) return;
  setBusy(el.compatBtn, true, 'Checking...');

  try {
    const data = await postJson('/api/compatibility', {
      layout: state.latest.layout,
      companionUrl: el.companionUrl.value.trim()
    });
    renderCompatibility(data);
  } catch (error) {
    renderInfo(el.compatibility, [], [error.message]);
  } finally {
    setBusy(el.compatBtn, false, 'Check Compatibility');
  }
}

async function dryRunDeploy() {
  if (!state.latest?.layout) return;
  setBusy(el.deployBtn, true, 'Running Dry-Run...');

  try {
    const data = await postJson('/api/deploy', {
      name: el.layoutName.value,
      layout: state.latest.layout,
      companionUrl: el.companionUrl.value.trim(),
      dryRun: true
    });
    renderDeployResult(data);
  } catch (error) {
    renderInfo(el.deploy, [], [error.message]);
  } finally {
    setBusy(el.deployBtn, false, 'Deploy Dry-Run');
  }
}

function render(data) {
  const { layout, validation, summary } = data;
  el.summary.textContent = `${summary.pageCount} page(s) • ${summary.buttonCount} button(s) • ${summary.warningCount} warning(s)`;

  renderMessages(validation.warnings, validation.errors);
  el.compatibility.innerHTML = '';
  el.deploy.innerHTML = '';

  const pageHtml = layout.pages
    .map((page) => renderPage(page, layout.deck.cols, layout.deck.rows))
    .join('');

  el.pages.innerHTML = pageHtml;
}

function renderCompatibility(data) {
  const moduleRows = data.compatibility.moduleChecks || [];
  const missing = data.compatibility.missingModules || [];
  const unresolved = data.compatibility.unresolved || [];

  const lines = [
    `Companion: ${data.companion.health.ok ? 'reachable' : 'unreachable'} (${data.companion.connectionCount} connection groups found)`,
    `Required module groups: ${data.compatibility.summary.requiredGearCount}`,
    `Missing module groups: ${data.compatibility.summary.missingModuleCount}`,
    `Unresolved controls: ${data.compatibility.summary.unresolvedCount}`
  ];

  if (moduleRows.length) {
    for (const row of moduleRows) {
      const status = row.installed ? 'ok' : 'missing';
      lines.push(`${row.gearType}: ${status} (${row.matchedModule || row.moduleHints.join(', ')})`);
    }
  }

  const warnings = [];
  for (const row of missing) warnings.push(`Missing module for ${row.gearType}: expected one of ${row.moduleHints.join(', ')}`);
  for (const row of unresolved.slice(0, 12)) warnings.push(`${row.id}: ${row.reason}`);
  if (unresolved.length > 12) warnings.push(`+${unresolved.length - 12} additional unresolved controls`);

  renderInfo(el.compatibility, lines, warnings);
}

function renderDeployResult(data) {
  const notes = data.deploy.notes || [];
  const lines = [
    `Mode: ${data.deploy.executedMode}`,
    `Can deploy safely: ${data.deploy.canDeploy ? 'yes' : 'no'}`,
    `Checked targets: ${data.targetCheck.checked}`,
    `Missing slots: ${data.targetCheck.missingTargets.length}`,
    `Occupied slots: ${data.targetCheck.occupiedTargets.length}`,
    `Bundle: ${data.files.companionBundle}`,
    `Deploy report: ${data.files.deployReport}`,
    ...notes
  ];

  const warnings = [];
  for (const slot of data.targetCheck.missingTargets.slice(0, 12)) {
    warnings.push(`Missing target P${slot.page} R${slot.row + 1} C${slot.col + 1} (status ${slot.status})`);
  }
  if (data.targetCheck.missingTargets.length > 12) {
    warnings.push(`+${data.targetCheck.missingTargets.length - 12} additional missing targets`);
  }

  renderInfo(el.deploy, lines, warnings);
}

function renderPage(page, cols, rows) {
  const byPos = new Map();
  for (const b of page.buttons) {
    byPos.set(`${b.row}:${b.col}`, b);
  }

  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const b = byPos.get(`${r}:${c}`);
      if (!b) {
        cells.push(
          '<div class="btn-cell is-empty">' +
            '<div class="btn-keycap">' +
              '<div class="btn-bezel">' +
                '<div class="btn-led"></div>' +
                '<div class="btn-screen">' +
                  '<div class="btn-icon">--</div>' +
                  '<div class="btn-label">EMPTY</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      } else {
        const action = `${b.action?.id || 'n/a'}`;
        const categoryClass = toClassToken(b.category || 'default');
        const displayLabel = displayButtonLabel(b.label, b.category);
        const icon = buttonIcon(displayLabel, action, b.category);
        const screenClass = icon ? 'btn-screen' : 'btn-screen no-icon';
        const iconHtml = icon ? `<div class="btn-icon">${escapeHtml(icon)}</div>` : '';
        cells.push(
          `<div class="btn-cell cat-${categoryClass}">` +
            `<div class="btn-keycap">` +
              `<div class="btn-bezel">` +
                `<div class="btn-led"></div>` +
                `<div class="${screenClass}">` +
                  iconHtml +
                  `<div class="btn-label">${escapeHtml(displayLabel)}</div>` +
                `</div>` +
              `</div>` +
            `</div>` +
          `</div>`
        );
      }
    }
  }

  return `
    <article class="page-card">
      <div class="page-title">Page ${page.page}: ${escapeHtml(page.name)}</div>
      <div class="deck-shell">
        <div class="grid-preview" style="--cols:${cols};">${cells.join('')}</div>
      </div>
    </article>
  `;
}

function renderMessages(warnings, errors) {
  const items = [];
  for (const m of warnings) items.push(`<div class="warning">${escapeHtml(m)}</div>`);
  for (const m of errors) items.push(`<div class="error">${escapeHtml(m)}</div>`);
  el.warnings.innerHTML = items.join('');
}

function renderInfo(target, messages = [], warnings = []) {
  const items = [];
  for (const msg of messages) items.push(`<div class="info">${escapeHtml(msg)}</div>`);
  for (const warn of warnings) items.push(`<div class="warning">${escapeHtml(warn)}</div>`);
  target.innerHTML = items.join('');
}

function clearOutput() {
  el.pages.innerHTML = '';
  el.warnings.innerHTML = '';
  el.compatibility.innerHTML = '';
  el.deploy.innerHTML = '';
  el.summary.textContent = '';
}

function enablePostGenerateActions() {
  el.exportBtn.disabled = false;
  el.compatBtn.disabled = false;
  el.deployBtn.disabled = false;
}

function disablePostGenerateActions() {
  el.exportBtn.disabled = true;
  el.compatBtn.disabled = true;
  el.deployBtn.disabled = true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toClassToken(value) {
  return String(value || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function buttonIcon(label, action, category) {
  const c = String(category || '').toLowerCase();
  const l = String(label || '').toUpperCase();
  const a = String(action || '').toLowerCase();

  if (c === 'preview' || c === 'program') return '';
  if (l.includes('CUT')) return 'CT';
  if (l.includes('AUTO')) return 'AU';
  if (l.includes('MIX')) return 'MX';
  if (l.includes('DIP')) return 'DP';
  if (l.includes('KEY')) return 'KY';
  if (l.includes('FTB')) return 'FB';
  if (l.includes('RATE')) return 'RT';
  if (l.includes('STATUS')) return 'ST';
  if (a.startsWith('atem.')) return 'AT';
  if (a.startsWith('obs.')) return 'OB';
  if (a.startsWith('vmix.')) return 'VM';
  if (a.startsWith('pp.')) return 'PP';
  if (a.startsWith('x32.')) return 'X3';
  if (a.startsWith('wing.')) return 'WG';
  return l.slice(0, 2) || 'BT';
}

function displayButtonLabel(label, category) {
  const c = String(category || '').toLowerCase();
  const raw = String(label || '');

  if (c === 'preview' || c === 'program') {
    const m = raw.match(/(\d+)\s*$/);
    if (m) return m[1];
  }

  return raw;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  if (text) button.textContent = text;
}
