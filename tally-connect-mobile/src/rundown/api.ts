import { api } from '../api/client';
import type { RundownState } from '../ws/types';

export type RundownSource = 'manual' | 'pco';

export interface RundownPlanSummary {
  id: string;
  title: string;
  serviceDate: string | null;
  source: RundownSource;
  itemCount: number;
  isTemplate?: boolean;
  status?: string;
  roomId?: string;
  totalDuration?: number;
  updatedAt?: number;
  activeEditors?: number;
}

export interface ManualRundownItem {
  id: string;
  planId?: string;
  title: string;
  itemType: string;
  lengthSeconds: number | null;
  notes?: string;
  assignee?: string;
  sortOrder?: number;
  startType?: 'soft' | 'hard' | string;
  hardStartTime?: string | null;
  autoAdvance?: boolean;
}

export interface ManualRundownPlan {
  id: string;
  churchId?: string;
  title: string;
  serviceDate: string | null;
  isTemplate?: boolean;
  templateName?: string | null;
  status?: string;
  roomId?: string;
  source: 'manual';
  items: ManualRundownItem[];
  updatedAt?: number;
  createdAt?: number;
  shareToken?: string | null;
}

export interface PcoRundownItem {
  id: string;
  sequence?: number;
  itemType?: string;
  title?: string;
  servicePosition?: string;
  lengthSeconds?: number | null;
  description?: string | null;
  songTitle?: string | null;
  author?: string | null;
  arrangementKey?: string | null;
  status?: 'completed' | 'current' | 'upcoming';
}

export interface PcoRundownPlan {
  id: string;
  title: string;
  sortDate?: string | null;
  serviceDate?: string | null;
  source: 'pco';
  items: PcoRundownItem[];
  team?: Array<{
    id: string;
    name: string;
    teamName: string;
    position: string;
    status: string;
    statusLabel: string;
  }>;
  times?: Array<{
    id: string;
    name: string;
    timeType: string;
    startsAt: string | null;
    endsAt: string | null;
  }>;
}

export type RundownPlanDetail = ManualRundownPlan | PcoRundownPlan;

export interface ManualRundownLiveState {
  isLive: true;
  planId: string;
  churchId?: string;
  currentCueIndex: number;
  startedAt: number;
  currentCueStartedAt?: number;
  updatedAt?: number;
}

export type LegacyRundownState = RundownState & {
  active?: boolean;
};

export interface ManualPlaybackState {
  currentIndex: number;
  currentItem: ManualRundownItem | null;
  nextIndex: number;
  nextItem: ManualRundownItem | null;
  totalCueCount: number;
  totalDurationSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  overtimeSeconds: number;
  isOvertime: boolean;
  isWarning: boolean;
}

export interface ManualTimingEntry {
  start: string;
  end: string;
  isHard: boolean;
  gapSeconds: number;
  overlapSeconds: number;
}

const DEFAULT_MANUAL_START_TIME = '09:00';

export async function fetchRundownPlanSummaries(churchId: string, signal?: AbortSignal): Promise<RundownPlanSummary[]> {
  const payload = await api<{ plans?: unknown[] }>(`/api/churches/${churchId}/rundown-plans`, { signal });
  return (payload.plans || []).map(normalizePlanSummary).filter(Boolean) as RundownPlanSummary[];
}

export async function fetchManualPlanDetail(churchId: string, planId: string, signal?: AbortSignal): Promise<ManualRundownPlan> {
  return api<ManualRundownPlan>(`/api/churches/${churchId}/rundown-plans/${planId}`, { signal });
}

export async function fetchPcoPlanDetail(churchId: string, planId: string, signal?: AbortSignal): Promise<PcoRundownPlan> {
  return api<PcoRundownPlan>(`/api/churches/${churchId}/planning-center/plans/${planId}`, { signal });
}

export async function fetchPlanningCenterNextService(churchId: string, signal?: AbortSignal): Promise<PcoRundownPlan | null> {
  const payload = await api<{ plan: PcoRundownPlan | null }>(`/api/churches/${churchId}/planning-center/next-service`, { signal });
  return payload.plan || null;
}

export async function fetchManualLiveState(churchId: string, planId: string, signal?: AbortSignal): Promise<ManualRundownLiveState | null> {
  try {
    const payload = await api<ManualRundownLiveState & { plan?: ManualRundownPlan }>(
      `/api/churches/${churchId}/rundown-plans/${planId}/live/state`,
      { signal }
    );
    return payload?.isLive ? payload : null;
  } catch {
    return null;
  }
}

export async function fetchLegacyLiveState(churchId: string, signal?: AbortSignal): Promise<LegacyRundownState | null> {
  try {
    const payload = await api<LegacyRundownState & { active?: boolean }>(
      `/api/churches/${churchId}/live-rundown/state`,
      { signal }
    );
    return payload?.active || payload?.state === 'active' ? payload : null;
  } catch {
    return null;
  }
}

export async function startManualLive(churchId: string, planId: string): Promise<ManualRundownLiveState & { plan?: ManualRundownPlan }> {
  return api(`/api/churches/${churchId}/rundown-plans/${planId}/live/start`, { method: 'POST' });
}

export async function stopManualLive(churchId: string, planId: string): Promise<{ ok: boolean }> {
  return api(`/api/churches/${churchId}/rundown-plans/${planId}/live/stop`, { method: 'POST' });
}

export async function advanceManualLive(churchId: string, planId: string): Promise<ManualRundownLiveState & { plan?: ManualRundownPlan }> {
  return api(`/api/churches/${churchId}/rundown-plans/${planId}/live/go`, { method: 'POST' });
}

export async function backManualLive(churchId: string, planId: string): Promise<ManualRundownLiveState & { plan?: ManualRundownPlan }> {
  return api(`/api/churches/${churchId}/rundown-plans/${planId}/live/back`, { method: 'POST' });
}

export async function gotoManualLive(churchId: string, planId: string, index: number): Promise<ManualRundownLiveState & { plan?: ManualRundownPlan }> {
  return api(`/api/churches/${churchId}/rundown-plans/${planId}/live/goto/${index}`, { method: 'POST' });
}

export interface ManualRundownItemInput {
  title: string;
  itemType?: string;
  lengthSeconds?: number;
  notes?: string;
  assignee?: string;
  startType?: 'soft' | 'hard';
  hardStartTime?: string | null;
}

export async function createManualRundownItem(
  churchId: string,
  planId: string,
  input: ManualRundownItemInput,
): Promise<ManualRundownItem> {
  return api<ManualRundownItem>(`/api/churches/${churchId}/rundown-plans/${planId}/items`, {
    method: 'POST',
    body: input,
  });
}

export async function updateManualRundownItem(
  churchId: string,
  planId: string,
  itemId: string,
  input: Partial<ManualRundownItemInput>,
): Promise<ManualRundownPlan> {
  return api<ManualRundownPlan>(`/api/churches/${churchId}/rundown-plans/${planId}/items/${itemId}`, {
    method: 'PUT',
    body: input,
  });
}

export async function deleteManualRundownItem(
  churchId: string,
  planId: string,
  itemId: string,
): Promise<ManualRundownPlan> {
  return api<ManualRundownPlan>(`/api/churches/${churchId}/rundown-plans/${planId}/items/${itemId}`, {
    method: 'DELETE',
  });
}

export async function reorderManualRundownItems(
  churchId: string,
  planId: string,
  itemIds: string[],
): Promise<ManualRundownPlan> {
  return api<ManualRundownPlan>(`/api/churches/${churchId}/rundown-plans/${planId}/reorder`, {
    method: 'PUT',
    body: { itemIds },
  });
}

export function computeManualTimings(items: ManualRundownItem[] = [], startTime = DEFAULT_MANUAL_START_TIME): ManualTimingEntry[] {
  const timing: ManualTimingEntry[] = [];
  let currentTime = startTime || DEFAULT_MANUAL_START_TIME;

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

export function findNextPlayableIndex(items: ManualRundownItem[] = [], currentCueIndex: number): number {
  for (let i = Number(currentCueIndex) + 1; i < items.length; i += 1) {
    if (items[i]?.itemType !== 'section') return i;
  }
  return -1;
}

export function computeManualPlaybackState(
  items: ManualRundownItem[] = [],
  liveState: ManualRundownLiveState | null,
  now = Date.now()
): ManualPlaybackState | null {
  if (!liveState || !liveState.isLive) return null;

  const currentIndex = Number(liveState.currentCueIndex) || 0;
  const currentItem = items[currentIndex] || null;
  const nextIndex = findNextPlayableIndex(items, currentIndex);
  const nextItem = nextIndex >= 0 ? items[nextIndex] : null;
  const duration = Number(currentItem?.lengthSeconds) || 0;
  const startedAt = Number(liveState.currentCueStartedAt || liveState.startedAt || now);
  const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const remainingSeconds = duration > 0 ? Math.max(0, duration - elapsedSeconds) : null;
  const isOvertime = duration > 0 && elapsedSeconds > duration;

  return {
    currentIndex,
    currentItem,
    nextIndex,
    nextItem,
    totalCueCount: items.filter((item) => item?.itemType !== 'section').length || items.length,
    totalDurationSeconds: items.reduce((sum, item) => (
      sum + (item?.itemType === 'section' ? 0 : (Number(item?.lengthSeconds) || 0))
    ), 0),
    elapsedSeconds,
    remainingSeconds,
    overtimeSeconds: isOvertime ? elapsedSeconds - duration : 0,
    isOvertime,
    isWarning: duration > 0 && remainingSeconds != null && remainingSeconds <= 30 && remainingSeconds > 0,
  };
}

export function normalizePlanSummary(summary: unknown): RundownPlanSummary | null {
  if (!summary || typeof summary !== 'object') return null;
  const raw = summary as Record<string, unknown>;
  const source = raw.source === 'manual' || raw.source === 'pco' ? raw.source : null;
  const id = String(raw.id || '');
  const title = String(raw.title || '');
  if (!source || !id || !title) return null;
  return {
    id,
    title,
    serviceDate: raw.serviceDate ? String(raw.serviceDate) : null,
    source,
    itemCount: Number(raw.itemCount) || 0,
    isTemplate: !!raw.isTemplate,
    status: raw.status ? String(raw.status) : undefined,
    roomId: raw.roomId ? String(raw.roomId) : undefined,
    totalDuration: raw.totalDuration != null ? Number(raw.totalDuration) : undefined,
    updatedAt: raw.updatedAt != null ? Number(raw.updatedAt) : undefined,
    activeEditors: raw.activeEditors != null ? Number(raw.activeEditors) : undefined,
  };
}

function parseHHMMToMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(String(hhmm))) return null;
  const [hours, minutes] = String(hhmm).split(':').map((part) => parseInt(part, 10));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function addTime(hhmm: string, seconds: number): string {
  const totalMinutes = parseHHMMToMinutes(hhmm);
  if (totalMinutes == null) return hhmm || DEFAULT_MANUAL_START_TIME;
  const next = totalMinutes + ((Number(seconds) || 0) / 60);
  const hours = ((Math.floor(next / 60) % 24) + 24) % 24;
  const minutes = ((Math.floor(next % 60) % 60) + 60) % 60;
  return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}
