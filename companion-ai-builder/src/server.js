'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { generateLayout } = require('./engine/generator');
const { analyzeCompanionCompatibility, toSerializableCompatibility } = require('./engine/compatibility');
const { CompanionAdapter } = require('./adapters/companionAdapter');

const app = express();
const port = Number(process.env.PORT || 4177);
const staticDir = path.join(__dirname, 'static');
const outputDir = path.join(__dirname, '..', 'output');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(staticDir));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'companion-ai-builder', ts: new Date().toISOString() });
});

app.post('/api/generate', (req, res) => {
  try {
    const { prompt, deckModel, gear } = req.body || {};
    if (!String(prompt || '').trim()) {
      return res.status(400).json({ ok: false, error: 'prompt is required' });
    }

    const result = generateLayout({ prompt, deckModel, gear });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'generation failed' });
  }
});

app.post('/api/export', (req, res) => {
  try {
    const { layout, name } = req.body || {};
    if (!layout || typeof layout !== 'object') {
      return res.status(400).json({ ok: false, error: 'layout object is required' });
    }

    const base = buildOutputBase(name, layout);
    const jsonPath = path.join(outputDir, `${base}.layout.json`);
    const mdPath = path.join(outputDir, `${base}.plan.md`);

    fs.writeFileSync(jsonPath, JSON.stringify(layout, null, 2));
    fs.writeFileSync(mdPath, renderPlanMarkdown(layout));

    return res.json({
      ok: true,
      files: {
        layoutJson: jsonPath,
        planMarkdown: mdPath
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'export failed' });
  }
});

app.post('/api/compatibility', async (req, res) => {
  try {
    const { layout, companionUrl, connections } = req.body || {};
    if (!layout || typeof layout !== 'object') {
      return res.status(400).json({ ok: false, error: 'layout object is required' });
    }

    const companion = await loadCompanionContext(companionUrl, connections);
    const compatibility = toSerializableCompatibility(
      analyzeCompanionCompatibility(layout, companion.connections)
    );

    return res.json({
      ok: true,
      companion: {
        url: companion.url,
        health: companion.health,
        connectionCount: companion.connections.length,
        connections: companion.connections
      },
      compatibility
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'compatibility check failed' });
  }
});

app.post('/api/deploy', async (req, res) => {
  try {
    const { layout, companionUrl, name, dryRun = true, connections } = req.body || {};
    if (!layout || typeof layout !== 'object') {
      return res.status(400).json({ ok: false, error: 'layout object is required' });
    }

    const companion = await loadCompanionContext(companionUrl, connections);
    const compatibility = toSerializableCompatibility(
      analyzeCompanionCompatibility(layout, companion.connections)
    );
    const targetCheck = await runTargetChecks({ layout, companionUrl, companionHealth: companion.health });

    const base = buildOutputBase(name, layout);
    const bundlePath = path.join(outputDir, `${base}.companion-bundle.json`);
    const reportPath = path.join(outputDir, `${base}.deploy.md`);

    const bundle = {
      version: '0.2.0',
      generatedAt: new Date().toISOString(),
      title: layout.title,
      dryRun: !!dryRun,
      companion: {
        url: companion.url,
        health: companion.health,
        connections: companion.connections
      },
      compatibility,
      targetCheck,
      mapping: flattenLayout(layout)
    };

    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
    fs.writeFileSync(reportPath, renderDeployMarkdown(bundle));

    const canDeploy =
      companion.health.ok &&
      compatibility.missingModules.length === 0 &&
      targetCheck.missingTargets.length === 0;

    return res.json({
      ok: true,
      deploy: {
        requestedMode: dryRun ? 'dry-run' : 'live',
        executedMode: dryRun ? 'dry-run' : 'bundle-only',
        canDeploy,
        notes: dryRun
          ? ['Dry-run completed. Review the deploy report before live rollout.']
          : ['Direct Companion write API is not enabled in this build; bundle exported for guided manual apply.']
      },
      companion: {
        url: companion.url,
        health: companion.health,
        connectionCount: companion.connections.length,
        connections: companion.connections
      },
      compatibility,
      targetCheck,
      files: {
        companionBundle: bundlePath,
        deployReport: reportPath
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'deploy failed' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`Companion AI Builder running at http://localhost:${port}`);
});

function buildOutputBase(name, layout) {
  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = String(name || layout.title || 'layout')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'layout';

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${safeName}-${stamp}`;
}

async function loadCompanionContext(companionUrl, providedConnections) {
  const url = String(companionUrl || '').trim();

  if (!url) {
    return {
      url: null,
      health: { ok: false, status: 0, error: 'No companionUrl provided' },
      connections: Array.isArray(providedConnections) ? providedConnections : []
    };
  }

  const adapter = new CompanionAdapter({ baseUrl: url });
  const health = await adapter.health();
  const fetched = health.ok ? await adapter.getConnections() : [];
  const fallback = Array.isArray(providedConnections) ? providedConnections : [];

  return {
    url,
    health,
    connections: fetched.length ? fetched : fallback
  };
}

async function runTargetChecks({ layout, companionUrl, companionHealth }) {
  const out = { checked: 0, missingTargets: [], occupiedTargets: [] };
  if (!companionUrl || !companionHealth?.ok) return out;

  const adapter = new CompanionAdapter({ baseUrl: companionUrl });
  for (const row of flattenLayout(layout)) {
    out.checked += 1;
    try {
      const probe = await adapter.getLocation(row.page, row.row, row.col);
      if (probe.status < 200 || probe.status >= 300) {
        out.missingTargets.push({
          page: row.page,
          row: row.row,
          col: row.col,
          status: probe.status
        });
        continue;
      }

      const currentText = String(probe.body?.text || '').trim();
      if (currentText) {
        out.occupiedTargets.push({
          page: row.page,
          row: row.row,
          col: row.col,
          label: row.label,
          existing: currentText
        });
      }
    } catch (error) {
      out.missingTargets.push({
        page: row.page,
        row: row.row,
        col: row.col,
        status: 0,
        error: error.message || 'probe failed'
      });
    }
  }
  return out;
}

function flattenLayout(layout) {
  const rows = [];
  for (const page of layout.pages || []) {
    for (const button of page.buttons || []) {
      rows.push({
        page: page.page,
        pageName: page.name,
        row: button.row,
        col: button.col,
        label: button.label,
        action: button.action || null,
        feedback: button.feedback || []
      });
    }
  }
  return rows;
}

function renderPlanMarkdown(layout) {
  const lines = [];
  lines.push(`# ${layout.title}`);
  lines.push('');
  lines.push(`- Generated: ${layout.generatedAt}`);
  lines.push(`- Objective: ${layout.objective}`);
  lines.push(`- Deck: ${layout.deck.label} (${layout.deck.cols}x${layout.deck.rows})`);
  lines.push(`- Pages: ${layout.pages.length}`);
  lines.push('');
  lines.push('## Gear');
  if (!layout.gear.length) {
    lines.push('- None provided');
  } else {
    for (const g of layout.gear) {
      lines.push(`- ${g.type}: ${g.name} (${g.connectionId})`);
    }
  }
  lines.push('');

  for (const page of layout.pages) {
    lines.push(`## Page ${page.page}: ${page.name}`);
    lines.push('');
    lines.push('| Pos | Label | Action |');
    lines.push('| --- | ----- | ------ |');
    for (const button of page.buttons) {
      const pos = `R${button.row + 1}C${button.col + 1}`;
      const action = `${button.action?.id || 'n/a'} ${JSON.stringify(button.action?.params || {})}`;
      lines.push(`| ${pos} | ${button.label} | \`${action}\` |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function renderDeployMarkdown(bundle) {
  const lines = [];
  lines.push(`# Deploy Report: ${bundle.title}`);
  lines.push('');
  lines.push(`- Generated: ${bundle.generatedAt}`);
  lines.push(`- Requested mode: ${bundle.dryRun ? 'dry-run' : 'live'}`);
  lines.push(`- Companion URL: ${bundle.companion.url || 'not provided'}`);
  lines.push(`- Companion reachable: ${bundle.companion.health.ok ? 'yes' : 'no'}`);
  lines.push(`- Companion connections: ${bundle.companion.connections.length}`);
  lines.push('');
  lines.push('## Compatibility');
  lines.push(`- Required module groups: ${bundle.compatibility.summary.requiredGearCount}`);
  lines.push(`- Missing module groups: ${bundle.compatibility.summary.missingModuleCount}`);
  lines.push(`- Unresolved controls: ${bundle.compatibility.summary.unresolvedCount}`);
  lines.push('');

  if (bundle.compatibility.moduleChecks.length) {
    lines.push('| Gear | Installed | Matched Module | Hints |');
    lines.push('| ---- | --------- | -------------- | ----- |');
    for (const item of bundle.compatibility.moduleChecks) {
      lines.push(
        `| ${item.gearType} | ${item.installed ? 'yes' : 'no'} | ${item.matchedModule || '—'} | ${item.moduleHints.join(', ')} |`
      );
    }
    lines.push('');
  }

  lines.push('## Target Check');
  lines.push(`- Buttons checked: ${bundle.targetCheck.checked}`);
  lines.push(`- Missing target slots: ${bundle.targetCheck.missingTargets.length}`);
  lines.push(`- Occupied slots: ${bundle.targetCheck.occupiedTargets.length}`);
  lines.push('');

  if (bundle.targetCheck.occupiedTargets.length) {
    lines.push('### Occupied Slots');
    for (const row of bundle.targetCheck.occupiedTargets) {
      lines.push(
        `- Page ${row.page} R${row.row + 1}C${row.col + 1}: existing "${row.existing}" vs new "${row.label}"`
      );
    }
    lines.push('');
  }

  lines.push('## Next Steps');
  lines.push('1. Install any missing Companion module families listed above.');
  lines.push('2. Resolve occupied slots before applying controls.');
  lines.push('3. Use the exported bundle JSON as the source of truth for final mapping/import.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}
