'use strict';

const VALID_SHARE_ROLES = new Set(['display', 'operator']);

function normalizeShareRole(role, fallback = 'operator') {
  const normalized = String(role || '').trim().toLowerCase();
  if (VALID_SHARE_ROLES.has(normalized)) return normalized;
  return fallback;
}

function isOperatorShare(share) {
  return normalizeShareRole(share && share.role, 'operator') === 'operator';
}

function notesToArray(notes) {
  if (Array.isArray(notes)) return notes;
  if (notes) return [notes];
  return [];
}

/**
 * Convert a manual rundown plan into the shape LiveRundownManager.startSession expects.
 * Preserves richer cue metadata (timing, notes, stacks) so public views stay in sync.
 */
function manualPlanToLivePlan(manualPlan) {
  if (!manualPlan) return null;
  return {
    id: manualPlan.id,
    title: manualPlan.title,
    churchId: manualPlan.churchId,
    roomId: manualPlan.roomId || '',
    source: 'manual',
    items: (manualPlan.items || []).map((item, index) => ({
      ...item,
      id: item.id,
      title: item.title,
      itemType: item.itemType,
      servicePosition: item.servicePosition ?? item.sequence ?? item.sortOrder ?? index + 1,
      lengthSeconds: Number(item.lengthSeconds) > 0 ? Number(item.lengthSeconds) : 0,
      description: item.description ?? item.summary ?? '',
      notes: notesToArray(item.notes),
      songTitle: item.songTitle || null,
      author: item.author || null,
      arrangementKey: item.arrangementKey || null,
    })),
    team: manualPlan.team || [],
    times: manualPlan.times || [],
  };
}

/**
 * Map LiveRundownManager state onto the legacy per-plan live-show payload
 * consumed by portal editor, public show, and mobile.
 */
function toLegacyLiveShowState(lrmState, plan) {
  if (!lrmState || lrmState.state === 'ended' || lrmState.active === false) {
    return {
      isLive: false,
      is_live: false,
      plan: plan || null,
      planId: (plan && plan.id) || lrmState?.planId || null,
      roomId: (lrmState && lrmState.roomId) || (plan && plan.roomId) || '',
    };
  }

  const currentCueIndex = lrmState.currentCueIndex ?? lrmState.currentIndex ?? 0;
  const currentCueStartedAt = lrmState.currentItemStartedAt
    || (lrmState.currentItem && Number.isFinite(lrmState.currentItem.elapsedSeconds)
      ? Date.now() - (lrmState.currentItem.elapsedSeconds * 1000)
      : lrmState.startedAt);

  return {
    ...lrmState,
    isLive: true,
    is_live: true,
    currentCueIndex,
    currentIndex: lrmState.currentIndex ?? currentCueIndex,
    startedAt: lrmState.startedAt,
    currentCueStartedAt,
    currentItemStartedAt: currentCueStartedAt,
    isPaused: !!lrmState.isPaused,
    pausedElapsed: (lrmState.currentItem && lrmState.currentItem.elapsedSeconds) || lrmState.pausedElapsed || 0,
    planId: lrmState.planId || (plan && plan.id) || null,
    roomId: lrmState.roomId || (plan && plan.roomId) || '',
    plan: plan || null,
  };
}

function resolveSessionRoom(liveRundown, plan, fallbackRoomId) {
  if (plan && liveRundown && typeof liveRundown.findSessionByPlanId === 'function') {
    const found = liveRundown.findSessionByPlanId(plan.id);
    if (found) return found.roomId || '';
  }
  if (fallbackRoomId != null && fallbackRoomId !== '') return fallbackRoomId;
  return (plan && plan.roomId) || '';
}

const LEGACY_VIEW_MODE_REDIRECTS = {
  clock: 'clock',
  teleprompter: 'prompter',
  confidence: 'confidence',
};

function publicShareUrls(token, baseUrl) {
  const root = String(baseUrl || process.env.PUBLIC_URL || 'https://api.tallyconnect.app').replace(/\/+$/, '');
  return {
    url: `${root}/rundown/view/${token}`,
    timer_url: `${root}/rundown/timer/${token}`,
    clock_url: `${root}/rundown/clock/${token}`,
    prompter_url: `${root}/rundown/prompter/${token}`,
    confidence_url: `${root}/rundown/confidence/${token}`,
    show_url: `${root}/rundown/show/${token}`,
    share_token: token,
  };
}

/**
 * Map historic portal query modes on /rundown/view/:token to dedicated pages.
 * View still implements compact / prompter / large-text itself.
 */
function legacyViewDisplayRedirect(token, query = {}) {
  const mode = String(query && query.mode || '').toLowerCase();
  const dest = LEGACY_VIEW_MODE_REDIRECTS[mode];
  if (!dest || !token) return null;
  const params = new URLSearchParams(query);
  params.delete('mode');
  const qs = params.toString();
  return `/rundown/${dest}/${encodeURIComponent(token)}${qs ? `?${qs}` : ''}`;
}

function decorateShare(share, baseUrl) {
  if (!share) return null;
  return {
    ...share,
    role: normalizeShareRole(share.role, 'operator'),
    ...publicShareUrls(share.token, baseUrl),
  };
}

module.exports = {
  VALID_SHARE_ROLES,
  normalizeShareRole,
  isOperatorShare,
  manualPlanToLivePlan,
  toLegacyLiveShowState,
  resolveSessionRoom,
  publicShareUrls,
  decorateShare,
  legacyViewDisplayRedirect,
  LEGACY_VIEW_MODE_REDIRECTS,
};
