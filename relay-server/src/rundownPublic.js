'use strict';

const DEFAULT_PUBLIC_RUNDOWN_START_TIME = '09:00';

function parseHHMMToMinutes(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(String(hhmm))) return null;
  const parts = String(hhmm).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function addTime(hhmm, seconds) {
  const totalMinutes = parseHHMMToMinutes(hhmm);
  if (totalMinutes == null) return hhmm || DEFAULT_PUBLIC_RUNDOWN_START_TIME;
  const next = totalMinutes + ((Number(seconds) || 0) / 60);
  const hours = ((Math.floor(next / 60) % 24) + 24) % 24;
  const minutes = ((Math.floor(next % 60) % 60) + 60) % 60;
  return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeManualPlanTiming(items = [], startTime = DEFAULT_PUBLIC_RUNDOWN_START_TIME) {
  const timing = [];
  let currentTime = startTime || DEFAULT_PUBLIC_RUNDOWN_START_TIME;
  for (const item of items) {
    const duration = Number(item?.lengthSeconds) || 0;
    let gapSeconds = 0;
    let overlapSeconds = 0;
    if (item?.startType === 'hard' && item?.hardStartTime) {
      const currentMinutes = parseHHMMToMinutes(currentTime);
      const hardMinutes = parseHHMMToMinutes(item.hardStartTime);
      if (currentMinutes != null && hardMinutes != null) {
        const deltaMinutes = hardMinutes - currentMinutes;
        if (deltaMinutes > 0) gapSeconds = deltaMinutes * 60;
        if (deltaMinutes < 0) overlapSeconds = Math.abs(deltaMinutes) * 60;
      }
      currentTime = item.hardStartTime;
    }
    const start = currentTime;
    const end = addTime(start, duration);
    timing.push({
      start,
      end,
      isHard: item?.startType === 'hard' && !!item?.hardStartTime,
      gapSeconds,
      overlapSeconds,
    });
    currentTime = end;
  }
  return timing;
}

function findNextCueIndex(items = [], currentCueIndex) {
  for (let i = Number(currentCueIndex) + 1; i < items.length; i += 1) {
    if (items[i]?.itemType !== 'section') return i;
  }
  return -1;
}

function findNextCue(items = [], currentCueIndex) {
  const nextIndex = findNextCueIndex(items, currentCueIndex);
  return nextIndex >= 0 ? items[nextIndex] : null;
}

function buildManualPlanTimerState(plan, liveState, now = Date.now()) {
  if (!plan) return null;
  if (!liveState || !liveState.isLive) {
    return {
      is_live: false,
      plan_id: plan.id,
      plan_title: plan.title,
    };
  }

  const items = Array.isArray(plan.items) ? plan.items : [];
  const currentIndex = Number(liveState.currentCueIndex) || 0;
  const currentItem = items[currentIndex] || null;
  const nextIndex = findNextCueIndex(items, currentIndex);
  const nextItem = nextIndex >= 0 ? items[nextIndex] : null;
  const duration = Number(currentItem?.lengthSeconds) || 0;
  const startedAt = Number(liveState.currentCueStartedAt || liveState.startedAt || now);
  const elapsedOnCue = Math.max(0, (now - startedAt) / 1000);
  const isOvertime = duration > 0 && elapsedOnCue > duration;
  const remaining = duration > 0 ? Math.max(0, duration - elapsedOnCue) : null;

  return {
    plan_id: plan.id,
    plan_title: plan.title,
    cue_title: currentItem?.title || '',
    cue_index: currentIndex,
    total_cues: items.filter((item) => item?.itemType !== 'section').length || items.length,
    cue_duration_seconds: duration,
    elapsed_seconds: Math.round(elapsedOnCue),
    remaining_seconds: remaining != null ? Math.round(remaining) : null,
    overtime_seconds: isOvertime ? Math.round(elapsedOnCue - duration) : 0,
    is_overtime: isOvertime,
    is_warning: duration > 0 && remaining != null && remaining <= 30 && remaining > 0,
    is_live: true,
    next_cue_title: nextItem?.title || null,
    next_cue_index: nextIndex >= 0 ? nextIndex : null,
    next_cue_duration: Number(nextItem?.lengthSeconds) || null,
    started_at: Number(liveState.startedAt || now),
    timestamp: now,
  };
}

function buildPublicRundownPayload({
  plan,
  share,
  liveState = null,
  columns = [],
  values = [],
  attachments = [],
  startTime = DEFAULT_PUBLIC_RUNDOWN_START_TIME,
  attachmentUrlBuilder = null,
  now = Date.now(),
} = {}) {
  if (!plan) return null;
  const items = Array.isArray(plan.items) ? plan.items : [];
  const timing = computeManualPlanTiming(items, startTime);
  const live = liveState && liveState.isLive ? liveState : null;
  const activeIndex = live ? Number(live.currentCueIndex) : -1;
  const valueMap = {};
  for (const value of values || []) {
    valueMap[`${value.itemId}_${value.columnId}`] = value.value || '';
  }
  const attachmentsByItem = {};
  for (const attachment of attachments || []) {
    const publicAttachment = {
      id: attachment.id,
      itemId: attachment.itemId,
      filename: attachment.filename,
      mimetype: attachment.mimetype,
      size: attachment.size,
      createdAt: attachment.createdAt,
      url: typeof attachmentUrlBuilder === 'function' ? attachmentUrlBuilder(attachment) : null,
    };
    if (!attachmentsByItem[attachment.itemId]) attachmentsByItem[attachment.itemId] = [];
    attachmentsByItem[attachment.itemId].push(publicAttachment);
  }
  const liveTimer = buildManualPlanTimerState(plan, live, now);

  let displaySequence = 0;
  const publicItems = items.map((item, index) => {
    const isSection = item?.itemType === 'section';
    if (!isSection) displaySequence += 1;
    const cells = {};
    const columnEntries = (columns || []).map((column) => {
      const value = valueMap[`${item.id}_${column.id}`] || '';
      cells[column.id] = value;
      return {
        columnId: column.id,
        name: column.name,
        type: column.type || 'text',
        equipmentBinding: column.equipmentBinding || null,
        value,
      };
    });
    return {
      id: item.id,
      itemType: item.itemType,
      title: item.title,
      assignee: item.assignee || '',
      notes: stripHtml(item.notes || ''),
      notesHtml: item.notes || '',
      notesText: stripHtml(item.notes || ''),
      lengthSeconds: Number(item.lengthSeconds) || 0,
      startType: item.startType || 'soft',
      hardStartTime: item.hardStartTime || null,
      autoAdvance: !!item.autoAdvance,
      sortOrder: item.sortOrder,
      sequence: isSection ? null : displaySequence,
      timing: timing[index] || null,
      liveStatus: {
        isCurrent: activeIndex === index,
        isCompleted: activeIndex > index,
        isUpcoming: activeIndex >= 0 && activeIndex < index,
      },
      customCells: columnEntries,
      columns: columnEntries.map((entry) => ({ columnId: entry.columnId, value: entry.value })),
      cells,
      attachments: attachmentsByItem[item.id] || [],
    };
  });

  const totalDurationSeconds = items.reduce((sum, item) => (
    sum + (item?.itemType === 'section' ? 0 : (Number(item?.lengthSeconds) || 0))
  ), 0);

  return {
    id: plan.id,
    title: plan.title,
    serviceDate: plan.serviceDate,
    status: plan.status || 'draft',
    updatedAt: plan.updatedAt,
    expiresAt: share?.expiresAt || null,
    columns: (columns || []).map((column) => ({
      id: column.id,
      name: column.name,
      type: column.type || 'text',
      options: Array.isArray(column.options) ? column.options : [],
      equipmentBinding: column.equipmentBinding || null,
    })),
    values: (values || []).map((value) => ({
      id: value.id,
      itemId: value.itemId,
      columnId: value.columnId,
      value: value.value || '',
      updatedAt: value.updatedAt,
    })),
    attachments: (attachments || []).map((attachment) => ({
      id: attachment.id,
      itemId: attachment.itemId,
      filename: attachment.filename,
      mimetype: attachment.mimetype,
      size: attachment.size,
      createdAt: attachment.createdAt,
      url: typeof attachmentUrlBuilder === 'function' ? attachmentUrlBuilder(attachment) : null,
    })),
    items: publicItems,
    totals: {
      durationSeconds: totalDurationSeconds,
    },
    liveState: live ? {
      isLive: true,
      currentCueIndex: activeIndex,
      startedAt: live.startedAt,
      currentCueStartedAt: live.currentCueStartedAt,
      elapsedSeconds: liveTimer?.elapsed_seconds ?? null,
      remainingSeconds: liveTimer?.remaining_seconds ?? null,
      overtimeSeconds: liveTimer?.overtime_seconds ?? 0,
      nextCueTitle: liveTimer?.next_cue_title || null,
      nextCueIndex: liveTimer?.next_cue_index ?? null,
      nextCueDuration: liveTimer?.next_cue_duration ?? null,
      timer: liveTimer,
    } : {
      isLive: false,
      currentCueIndex: -1,
      timer: liveTimer,
    },
  };
}

module.exports = {
  DEFAULT_PUBLIC_RUNDOWN_START_TIME,
  buildManualPlanTimerState,
  buildPublicRundownPayload,
  computeManualPlanTiming,
  stripHtml,
};
