'use strict';

const { inferGearFromId, getModuleHintsForGear } = require('./capabilities');

function analyzeCompanionCompatibility(layout, connections = []) {
  const requirements = extractRequirements(layout);
  const normalizedConnections = normalizeConnections(connections);
  const installedModuleIds = normalizedConnections.map((c) => c.moduleId);
  const checks = [];
  const missingModules = [];

  for (const req of requirements.byGear.values()) {
    const matched = findModuleMatch(installedModuleIds, req.moduleHints);
    const row = {
      gearType: req.gearType,
      requiredBy: req.requiredBy,
      moduleHints: req.moduleHints,
      matchedModule: matched || null,
      installed: !!matched
    };
    checks.push(row);
    if (!row.installed) missingModules.push(row);
  }

  const unresolved = [];
  for (const action of requirements.actions) {
    if (!action.gearType) continue;
    const check = checks.find((c) => c.gearType === action.gearType);
    if (check && !check.installed) {
      unresolved.push({
        kind: action.kind,
        id: action.id,
        label: action.label,
        reason: `Missing Companion module for ${action.gearType}`
      });
    }
  }

  return {
    ok: missingModules.length === 0 && unresolved.length === 0,
    installedModules: installedModuleIds,
    moduleChecks: checks,
    missingModules,
    unresolved,
    summary: {
      requiredGearCount: checks.length,
      missingModuleCount: missingModules.length,
      unresolvedCount: unresolved.length
    }
  };
}

function extractRequirements(layout) {
  const byGear = new Map();
  const actions = [];

  for (const page of layout?.pages || []) {
    for (const button of page.buttons || []) {
      addRequirement(byGear, actions, {
        kind: 'action',
        id: button.action?.id,
        label: button.label
      });

      for (const feedback of button.feedback || []) {
        addRequirement(byGear, actions, {
          kind: 'feedback',
          id: feedback.id,
          label: button.label
        });
      }
    }
  }

  return { byGear, actions };
}

function addRequirement(byGear, actions, req) {
  const id = String(req.id || '').trim();
  if (!id) return;
  if (id.startsWith('builder.') || id.startsWith('custom.')) return;

  const gearType = inferGearFromId(id);
  const row = { ...req, id, gearType };
  actions.push(row);

  if (!gearType) return;

  const existing = byGear.get(gearType);
  if (existing) {
    existing.requiredBy.add(id);
    return;
  }

  byGear.set(gearType, {
    gearType,
    requiredBy: new Set([id]),
    moduleHints: getModuleHintsForGear(gearType)
  });
}

function normalizeConnections(connections) {
  if (!Array.isArray(connections)) return [];
  return connections
    .map((c, idx) => {
      const id = String(c?.id || `conn-${idx + 1}`);
      const moduleId = String(c?.moduleId || c?.type || '').trim().toLowerCase();
      const label = String(c?.label || c?.name || id);
      if (!moduleId) return null;
      return { id, moduleId, label };
    })
    .filter(Boolean);
}

function findModuleMatch(installedModuleIds, hints) {
  const normalized = installedModuleIds.map((id) => String(id || '').toLowerCase());
  for (const hint of hints || []) {
    const needle = String(hint || '').toLowerCase();
    if (!needle) continue;

    const exact = normalized.find((mod) => mod === needle);
    if (exact) return exact;

    const includes = normalized.find((mod) => mod.includes(needle));
    if (includes) return includes;
  }

  return null;
}

function toSerializableCompatibility(result) {
  return {
    ...result,
    moduleChecks: result.moduleChecks.map((check) => ({
      ...check,
      requiredBy: Array.from(check.requiredBy)
    })),
    missingModules: result.missingModules.map((check) => ({
      ...check,
      requiredBy: Array.from(check.requiredBy)
    }))
  };
}

module.exports = {
  analyzeCompanionCompatibility,
  extractRequirements,
  normalizeConnections,
  findModuleMatch,
  toSerializableCompatibility
};
