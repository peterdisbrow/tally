import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getChurchId } from '../src/api/client';
import { tallySocket } from '../src/ws/TallySocket';
import { useThemeColors, ThemeColors } from '../src/theme/ThemeContext';
import { borderRadius, fontSize, spacing } from '../src/theme/spacing';
import type { RundownState, RundownTick } from '../src/ws/types';
import type {
  LegacyRundownState,
  ManualPlaybackState,
  ManualRundownItem,
  ManualRundownLiveState,
  ManualRundownPlan,
  ManualTimingEntry,
  PcoRundownItem,
  PcoRundownPlan,
  RundownPlanDetail,
  RundownPlanSummary,
  RundownSource,
} from '../src/rundown/api';
import {
  advanceManualLive,
  backManualLive,
  computeManualPlaybackState,
  computeManualTimings,
  fetchLegacyLiveState,
  fetchManualLiveState,
  fetchManualPlanDetail,
  fetchPlanningCenterNextService,
  fetchPcoPlanDetail,
  fetchRundownPlanSummaries,
  gotoManualLive,
  startManualLive,
  stopManualLive,
} from '../src/rundown/api';

type ScreenState = 'loading' | 'ready' | 'empty' | 'no_connection' | 'error';

type DisplayRow =
  | {
      kind: 'section';
      key: string;
      label: string;
      index: number;
    }
  | {
      kind: 'cue';
      key: string;
      item: ManualRundownItem | PcoRundownItem;
      index: number;
      groupLabel?: string;
    };

type SelectionCache = {
  detail: RundownPlanDetail;
  manualLiveState?: ManualRundownLiveState | null;
  legacyLiveState?: LegacyRundownState | null;
};

const PCO_GROUP_ORDER = [
  { label: 'PRE-SERVICE', positions: ['before'] },
  { label: 'SERVICE', positions: ['during', '', 'main'] },
  { label: 'POST-SERVICE', positions: ['after'] },
];

export default function RundownScreen() {
  const colors = useThemeColors();
  const listRef = useRef<FlatList<DisplayRow>>(null);
  const cacheRef = useRef<Map<string, SelectionCache>>(new Map());
  const loadTokenRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);

  const [state, setState] = useState<ScreenState>('loading');
  const [churchId, setChurchId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<RundownPlanSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSummary, setSelectedSummary] = useState<RundownPlanSummary | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<RundownPlanDetail | null>(null);
  const [manualLiveState, setManualLiveState] = useState<ManualRundownLiveState | null>(null);
  const [legacyLiveState, setLegacyLiveState] = useState<LegacyRundownState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const manualPlayback = useMemo<ManualPlaybackState | null>(() => {
    if (!selectedDetail || selectedDetail.source !== 'manual') return null;
    return computeManualPlaybackState(selectedDetail.items, manualLiveState);
  }, [selectedDetail, manualLiveState]);

  const manualTimings = useMemo<ManualTimingEntry[]>(() => {
    if (!selectedDetail || selectedDetail.source !== 'manual') return [];
    return computeManualTimings(selectedDetail.items);
  }, [selectedDetail]);

  const displayRows = useMemo(() => buildDisplayRows(selectedDetail), [selectedDetail]);

  const currentLiveState = useMemo(() => {
    if (!selectedSummary || !selectedDetail) return null;
    if (selectedSummary.source === 'manual') return manualLiveState;
    if (selectedSummary.source === 'pco' && legacyLiveState?.planId === selectedSummary.id) {
      return legacyLiveState;
    }
    return null;
  }, [selectedSummary, selectedDetail, manualLiveState, legacyLiveState]);

  const isManualLive = !!manualPlayback;
  const isLegacyLive = !!selectedSummary
    && selectedSummary.source === 'pco'
    && !!legacyLiveState
    && legacyLiveState.planId === selectedSummary.id
    && (legacyLiveState.active ?? legacyLiveState.state === 'active');
  const isLive = isManualLive || isLegacyLive;

  const selectedRows = displayRows;

  const loadSelectedPlan = useCallback(async (
    summary: RundownPlanSummary,
    hint?: Partial<SelectionCache> | null,
    options: { scrollToTop?: boolean; churchIdOverride?: string } = {}
  ) => {
    const resolvedChurchId = options.churchIdOverride || churchId;
    if (!resolvedChurchId) return;
    const loadId = ++loadTokenRef.current;
    setLoadingPlanId(summary.id);
    setErrorMessage(null);

    try {
      const cacheKey = `${summary.source}:${summary.id}`;
      const cached = cacheRef.current.get(cacheKey);
      if (cached?.detail) {
        setSelectedSummary(summary);
        setSelectedDetail(cached.detail);
        setManualLiveState(summary.source === 'manual' ? (hint?.manualLiveState ?? cached.manualLiveState ?? null) : null);
        setLegacyLiveState(summary.source === 'pco' ? (hint?.legacyLiveState ?? cached.legacyLiveState ?? null) : null);
        selectedIdRef.current = summary.id;
        if (options.scrollToTop) {
          requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
        }
        return;
      }

      let detail: RundownPlanDetail;
      let manualState: ManualRundownLiveState | null = summary.source === 'manual' ? (hint?.manualLiveState ?? null) : null;
      let legacyState: LegacyRundownState | null = summary.source === 'pco' ? (hint?.legacyLiveState ?? null) : null;

      if (summary.source === 'manual') {
        detail = await fetchManualPlanDetail(resolvedChurchId, summary.id);
        manualState = manualState || await fetchManualLiveState(resolvedChurchId, summary.id);
      } else {
        detail = await fetchPcoPlanDetail(resolvedChurchId, summary.id);
        legacyState = legacyState || await fetchLegacyLiveState(resolvedChurchId);
        if (legacyState && legacyState.planId !== summary.id) {
          legacyState = null;
        }
      }

      cacheRef.current.set(cacheKey, {
        detail,
        manualLiveState: manualState,
        legacyLiveState: legacyState,
      });

      if (loadTokenRef.current !== loadId) return;

      setSelectedId(summary.id);
      setSelectedSummary(summary);
      setSelectedDetail(detail);
      setManualLiveState(summary.source === 'manual' ? manualState : null);
      setLegacyLiveState(summary.source === 'pco' ? legacyState : null);
      selectedIdRef.current = summary.id;

      if (options.scrollToTop) {
        requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
      }
    } catch (err) {
      if (loadTokenRef.current !== loadId) return;
      console.error('[rundown] failed to load plan', err);
      setErrorMessage(err instanceof Error ? err.message : 'Unable to load rundown plan');
      setSelectedDetail(null);
      setManualLiveState(null);
      setLegacyLiveState(null);
    } finally {
      if (loadTokenRef.current === loadId) {
        setLoadingPlanId(null);
      }
    }
  }, [churchId]);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    const myLoad = ++loadTokenRef.current;
    setErrorMessage(null);
    try {
      const currentChurchId = await getChurchId();
      if (!currentChurchId) {
        if (loadTokenRef.current === myLoad) {
          setState('no_connection');
        }
        return;
      }

      if (loadTokenRef.current === myLoad) {
        setChurchId(currentChurchId);
      }

      let planSummaries = await fetchRundownPlanSummaries(currentChurchId, signal);
      planSummaries = sortSummaries(planSummaries);

      const manualSummaries = planSummaries.filter((plan) => plan.source === 'manual' && !plan.isTemplate);
      const manualStates = await Promise.all(
        manualSummaries.map(async (summary) => ({
          summary,
          state: await fetchManualLiveState(currentChurchId, summary.id, signal),
        }))
      );

      const liveManual = manualStates.find((entry) => entry.state?.isLive);
      const legacyState = await fetchLegacyLiveState(currentChurchId, signal);
      const liveLegacySummary = legacyState?.planId
        ? planSummaries.find((plan) => plan.source === 'pco' && plan.id === legacyState.planId)
        : null;

      if (loadTokenRef.current !== myLoad) return;

      setSummaries(planSummaries);

      if (selectedIdRef.current) {
        const stillThere = planSummaries.find((plan) => plan.id === selectedIdRef.current);
        if (stillThere) {
          const manualHint = stillThere.source === 'manual'
            ? manualStates.find((entry) => entry.summary.id === stillThere.id)?.state || null
            : null;
          const legacyHint = stillThere.source === 'pco' && legacyState?.planId === stillThere.id
            ? legacyState
            : null;
          await loadSelectedPlan(
            stillThere,
            stillThere.source === 'manual' ? { manualLiveState: manualHint } : { legacyLiveState: legacyHint },
            { scrollToTop: false, churchIdOverride: currentChurchId }
          );
          setState('ready');
          return;
        }
      }

      const initialSummary = liveManual?.summary
        || liveLegacySummary
        || pickMostRelevantManual(manualSummaries)
        || pickMostRelevantPco(planSummaries.filter((plan) => plan.source === 'pco'));

      if (initialSummary) {
        const liveHint = initialSummary.source === 'manual'
          ? manualStates.find((entry) => entry.summary.id === initialSummary.id)?.state || null
          : legacyState && legacyState.planId === initialSummary.id
            ? legacyState
            : null;
        await loadSelectedPlan(initialSummary, initialSummary.source === 'manual'
          ? { manualLiveState: liveHint as ManualRundownLiveState | null }
          : { legacyLiveState: liveHint as LegacyRundownState | null }, { scrollToTop: false, churchIdOverride: currentChurchId });
        setState('ready');
        return;
      }

      const nextService = await fetchPlanningCenterNextService(currentChurchId, signal);
      if (nextService) {
        const fallbackSummary: RundownPlanSummary = {
          id: nextService.id,
          title: nextService.title,
          serviceDate: nextService.sortDate || nextService.serviceDate || null,
          source: 'pco',
          itemCount: nextService.items?.length || 0,
        };
        setSummaries([fallbackSummary]);
        await loadSelectedPlan(fallbackSummary, { legacyLiveState: null }, { scrollToTop: false, churchIdOverride: currentChurchId });
        setState('ready');
        return;
      }

      setSelectedId(null);
      setSelectedSummary(null);
      setSelectedDetail(null);
      setManualLiveState(null);
      setLegacyLiveState(null);
      setState('empty');
    } catch (err) {
      if (loadTokenRef.current !== myLoad) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('[rundown] failed to load rundown data', err);
      setErrorMessage(err instanceof Error ? err.message : 'Unable to load rundown data');
      setState('error');
    }
  }, [loadSelectedPlan]);

  useEffect(() => {
    const controller = new AbortController();
    loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  useEffect(() => {
    const unsub = tallySocket.onMessage((msg) => {
      if (!selectedSummary) return;

      if (msg.type === 'rundown_state' || msg.type === 'rundown_position' || msg.type === 'rundown_tick') {
        const stateMsg = msg as RundownState;
        if (selectedSummary.source === 'pco' && stateMsg.planId === selectedSummary.id) {
          setLegacyLiveState(stateMsg as LegacyRundownState);
          setErrorMessage(null);
        }
      } else if (msg.type === 'rundown_ended') {
        const ended = msg as { planId?: string };
        if (selectedSummary.source === 'pco' && ended.planId === selectedSummary.id) {
          setLegacyLiveState(null);
        }
      } else if (msg.type === 'rundown_error') {
        const err = msg as { error?: string };
        setErrorMessage(err.error || 'Unable to update rundown state');
      }
    });
    return unsub;
  }, [selectedSummary]);

  useEffect(() => {
    if (!selectedSummary || !churchId) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        if (selectedSummary.source === 'manual') {
          const state = await fetchManualLiveState(churchId, selectedSummary.id);
          if (cancelled) return;
          setManualLiveState(state);
        } else {
          const state = await fetchLegacyLiveState(churchId);
          if (cancelled) return;
          if (state && state.planId === selectedSummary.id) {
            setLegacyLiveState(state);
          } else {
            setLegacyLiveState(null);
          }
        }
      } catch {
        if (!cancelled) return;
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedSummary, churchId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const selectPlan = useCallback(async (summary: RundownPlanSummary) => {
    if (summary.id === selectedIdRef.current && selectedDetail) return;
    await loadSelectedPlan(summary, null, { scrollToTop: true });
  }, [loadSelectedPlan, selectedDetail]);

  const performManualAction = useCallback(async (action: 'start' | 'stop' | 'back' | 'next' | 'goto', index?: number) => {
    if (!churchId || !selectedSummary || selectedSummary.source !== 'manual') return;
    const planId = selectedSummary.id;
    setActionBusy(action);
    setErrorMessage(null);
    try {
      if (action === 'start') {
        const result = await startManualLive(churchId, planId);
        setManualLiveState(result as ManualRundownLiveState);
      } else if (action === 'stop') {
        await stopManualLive(churchId, planId);
        setManualLiveState(null);
      } else if (action === 'back') {
        const result = await backManualLive(churchId, planId);
        if (result) {
          const live = await fetchManualLiveState(churchId, planId);
          setManualLiveState(live);
        }
      } else if (action === 'next') {
        const result = await advanceManualLive(churchId, planId);
        if (result) {
          const live = await fetchManualLiveState(churchId, planId);
          setManualLiveState(live);
        }
      } else if (action === 'goto' && typeof index === 'number') {
        const result = await gotoManualLive(churchId, planId, index);
        if (result) {
          const live = await fetchManualLiveState(churchId, planId);
          setManualLiveState(live);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to control rundown';
      setErrorMessage(message);
      Alert.alert('Rundown action failed', message);
    } finally {
      setActionBusy(null);
    }
  }, [churchId, selectedSummary]);

  const performLegacyAction = useCallback((action: 'start' | 'stop' | 'back' | 'next' | 'goto', index?: number) => {
    if (!selectedSummary || selectedSummary.source !== 'pco') return;
    const messageId = `rundown-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setActionBusy(action);
    setErrorMessage(null);

    try {
      if (action === 'start') {
        tallySocket.send({
          type: 'rundown_start',
          planId: selectedSummary.id,
          callerName: 'Mobile TD',
          messageId,
        });
      } else if (action === 'stop') {
        tallySocket.send({
          type: 'rundown_end',
          messageId,
        });
      } else if (action === 'back') {
        tallySocket.send({
          type: 'rundown_back',
          messageId,
        });
      } else if (action === 'next') {
        tallySocket.send({
          type: 'rundown_advance',
          messageId,
        });
      } else if (action === 'goto' && typeof index === 'number') {
        tallySocket.send({
          type: 'rundown_goto',
          index,
          messageId,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to control legacy rundown';
      setErrorMessage(message);
      Alert.alert('Rundown action failed', message);
    } finally {
      setTimeout(() => setActionBusy((current) => (current === action ? null : current)), 400);
    }
  }, [selectedSummary]);

  const isLoading = state === 'loading';
  const isEmpty = state === 'empty';
  const selectedTime = useMemo(() => {
    if (!selectedDetail) return null;
    if (selectedDetail.source === 'manual') {
      const plan = selectedDetail as ManualRundownPlan;
      return {
        label: plan.serviceDate ? formatDateOnly(plan.serviceDate) : null,
        subtitle: plan.status || 'draft',
      };
    }
    const plan = selectedDetail as PcoRundownPlan;
    const serviceTime = plan.times?.find((time) => time.timeType === 'service') || plan.times?.[0] || null;
    return {
      label: serviceTime?.startsAt ? formatDateTime(serviceTime.startsAt) : (plan.sortDate ? formatDateOnly(plan.sortDate) : null),
      subtitle: serviceTime?.name || 'Planning Center service',
    };
  }, [selectedDetail]);

  const selectedPlanTotals = useMemo(() => {
    if (!selectedDetail) return { cues: 0, duration: 0 };
    if (selectedDetail.source === 'manual') {
      const items = selectedDetail.items || [];
      return {
        cues: items.filter((item) => item.itemType !== 'section').length || items.length,
        duration: items.reduce((sum, item) => sum + (item.itemType === 'section' ? 0 : (Number(item.lengthSeconds) || 0)), 0),
      };
    }
    const items = selectedDetail.items || [];
    return {
      cues: items.length,
      duration: items.reduce((sum, item) => sum + (Number(item.lengthSeconds) || 0), 0),
    };
  }, [selectedDetail]);

  const selectedCurrentCue = useMemo(() => {
    if (!selectedDetail) return null;
    if (selectedDetail.source === 'manual') {
      if (!manualPlayback) return null;
      return manualPlayback.currentItem;
    }
    if (!isLegacyLive || !legacyLiveState) return null;
    if (legacyLiveState.currentItem) return legacyLiveState.currentItem;
    const index = Number(legacyLiveState.currentIndex ?? -1);
    return legacyLiveState.items?.[index] || null;
  }, [selectedDetail, manualPlayback, isLegacyLive, legacyLiveState]);

  const selectedNextCue = useMemo(() => {
    if (!selectedDetail) return null;
    if (selectedDetail.source === 'manual') {
      if (!manualPlayback) return null;
      return manualPlayback.nextItem;
    }
    if (!isLegacyLive || !legacyLiveState) return null;
    const nextIndex = Math.min(Number(legacyLiveState.currentIndex ?? -1) + 1, Math.max((legacyLiveState.items?.length || 1) - 1, 0));
    return legacyLiveState.items?.[nextIndex] || null;
  }, [selectedDetail, manualPlayback, isLegacyLive, legacyLiveState]);

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.centerText, { color: colors.textSecondary }]}>Loading rundown plans...</Text>
      </View>
    );
  }

  if (state === 'no_connection') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bg }]}>
        <Ionicons name="cloud-offline-outline" size={48} color={colors.textMuted} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No church connected</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          Sign in to a church account to view and control rundowns.
        </Text>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bg }]}>
        <Ionicons name="warning-outline" size={48} color={colors.warning} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>Could not load rundown</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          {errorMessage || 'Pull down to try again.'}
        </Text>
        <TouchableOpacity style={[styles.primaryAction, { backgroundColor: colors.accent }]} onPress={onRefresh}>
          <Text style={styles.primaryActionText}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isEmpty || !selectedDetail) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bg }]}>
        <Ionicons name="document-outline" size={48} color={colors.textMuted} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No rundown plans yet</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          Create a manual rundown in the portal to start using this screen, or sync Planning Center for a fallback service order.
        </Text>
        <TouchableOpacity style={[styles.primaryAction, { backgroundColor: colors.accent }]} onPress={onRefresh}>
          <Text style={styles.primaryActionText}>Refresh</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const header = (
    <View>
      <View style={styles.screenHeader}>
        <View style={styles.screenHeaderTopRow}>
          <View>
            <Text style={[styles.screenKicker, { color: colors.textSecondary }]}>RUNDOWN</Text>
            <Text style={[styles.screenTitle, { color: colors.text }]}>
              {selectedSummary?.source === 'manual' ? 'Manual First' : 'Planning Center Fallback'}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.iconButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={onRefresh}
          >
            <Ionicons name="refresh" size={18} color={colors.text} />
          </TouchableOpacity>
        </View>

        {errorMessage && (
          <View style={[styles.inlineError, { borderColor: colors.warning, backgroundColor: colors.surface }]}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
            <Text style={[styles.inlineErrorText, { color: colors.textSecondary }]}>{errorMessage}</Text>
          </View>
        )}
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.planStrip}>
          {summaries.map((summary) => (
            <PlanChip
              key={`${summary.source}:${summary.id}`}
              summary={summary}
              selected={selectedSummary?.id === summary.id && selectedSummary?.source === summary.source}
              loading={loadingPlanId === summary.id}
              live={isSummaryLive(summary, selectedSummary, manualLiveState, legacyLiveState)}
              colors={colors}
              onPress={() => selectPlan(summary)}
            />
          ))}
        </ScrollView>

        <View style={styles.heroRow}>
          <View style={styles.heroContent}>
            <View style={styles.pillRow}>
              <Pill tone="accent" label={selectedSummary?.source === 'manual' ? 'Manual' : 'PCO'} colors={colors} />
              {selectedSummary?.status && selectedSummary.source === 'manual' && (
                <Pill tone="muted" label={selectedSummary.status} colors={colors} />
              )}
              {selectedSummary?.activeEditors ? (
                <Pill tone="muted" label={`${selectedSummary.activeEditors} editors`} colors={colors} />
              ) : null}
              {isLive ? <Pill tone="live" label="LIVE" colors={colors} /> : <Pill tone="muted" label="Ready" colors={colors} />}
            </View>

            <Text style={[styles.heroTitle, { color: colors.text }]}>
              {selectedSummary?.title || 'Untitled rundown'}
            </Text>

            {selectedTime?.label ? (
              <Text style={[styles.heroSubtitle, { color: colors.textSecondary }]}>
                {selectedTime.label}
                {selectedTime.subtitle ? ` · ${selectedTime.subtitle}` : ''}
              </Text>
            ) : (
              <Text style={[styles.heroSubtitle, { color: colors.textSecondary }]}>
                {selectedSummary?.source === 'manual'
                  ? 'Manual rundown with cue timing and live control'
                  : 'Planning Center service plan'}
              </Text>
            )}

            <View style={styles.metricsRow}>
              <Metric label="Cues" value={`${selectedPlanTotals.cues}`} colors={colors} />
              <Metric label="Duration" value={formatDuration(selectedPlanTotals.duration)} colors={colors} />
              {selectedSummary?.roomId ? <Metric label="Room" value={selectedSummary.roomId} colors={colors} /> : null}
            </View>
          </View>

          <View style={styles.heroStatusColumn}>
            <LiveSummaryCard
              colors={colors}
              isLive={isLive}
              currentCue={selectedCurrentCue}
              nextCue={selectedNextCue}
              manualPlayback={manualPlayback}
              legacyLiveState={isLegacyLive ? legacyLiveState : null}
            />
          </View>
        </View>

        {selectedSummary?.source === 'manual' ? (
          <View style={styles.actionGrid}>
            {!isLive ? (
              <ActionButton
                label={actionBusy === 'start' ? 'Starting...' : 'Start live'}
                icon="play"
                tone="primary"
                colors={colors}
                loading={actionBusy === 'start'}
                onPress={() => performManualAction('start')}
              />
            ) : (
              <ActionButton
                label={actionBusy === 'stop' ? 'Stopping...' : 'Stop live'}
                icon="stop"
                tone="danger"
                colors={colors}
                loading={actionBusy === 'stop'}
                onPress={() => performManualAction('stop')}
              />
            )}
            <ActionButton
              label="Back"
              icon="chevron-back"
              tone="ghost"
              colors={colors}
              disabled={!isLive || actionBusy != null}
              onPress={() => performManualAction('back')}
            />
            <ActionButton
              label="Next"
              icon="chevron-forward"
              tone="ghost"
              colors={colors}
              disabled={!isLive || actionBusy != null}
              onPress={() => performManualAction('next')}
            />
            <ActionButton
              label={manualPlayback?.nextIndex != null && manualPlayback.nextIndex >= 0 ? 'Go to next cue' : 'Jump to cue'}
              icon="locate"
              tone="ghost"
              colors={colors}
              disabled={!isLive || actionBusy != null}
              onPress={() => {
                const target = manualPlayback?.nextIndex;
                if (typeof target === 'number' && target >= 0) {
                  performManualAction('goto', target);
                }
              }}
            />
          </View>
        ) : (
          <View style={styles.actionGrid}>
            {!isLive ? (
              <ActionButton
                label={actionBusy === 'start' ? 'Starting...' : 'Start legacy live'}
                icon="play"
                tone="primary"
                colors={colors}
                loading={actionBusy === 'start'}
                onPress={() => performLegacyAction('start')}
              />
            ) : (
              <ActionButton
                label={actionBusy === 'stop' ? 'Stopping...' : 'Stop live'}
                icon="stop"
                tone="danger"
                colors={colors}
                loading={actionBusy === 'stop'}
                onPress={() => performLegacyAction('stop')}
              />
            )}
            <ActionButton
              label="Back"
              icon="chevron-back"
              tone="ghost"
              colors={colors}
              disabled={!isLive || actionBusy != null}
              onPress={() => performLegacyAction('back')}
            />
            <ActionButton
              label="Next"
              icon="chevron-forward"
              tone="ghost"
              colors={colors}
              disabled={!isLive || actionBusy != null}
              onPress={() => performLegacyAction('next')}
            />
            <ActionButton
              label="Refresh state"
              icon="refresh"
              tone="ghost"
              colors={colors}
              disabled={actionBusy != null}
              onPress={() => onRefresh()}
            />
          </View>
        )}
      </View>

      {selectedSummary?.source === 'manual' && manualPlayback ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.sectionHead}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>LIVE TIMING</Text>
            <Pill tone={manualPlayback.isOvertime ? 'danger' : manualPlayback.isWarning ? 'warning' : 'accent'} label={manualPlayback.isOvertime ? 'Overtime' : manualPlayback.isWarning ? 'Almost out' : 'On pace'} colors={colors} />
          </View>
          <View style={styles.timingGrid}>
            <TimingStat label="Current" value={manualPlayback.currentItem?.title || 'No cue'} colors={colors} />
            <TimingStat label="Next" value={manualPlayback.nextItem?.title || 'None'} colors={colors} />
            <TimingStat label="Elapsed" value={formatTimer(manualPlayback.elapsedSeconds)} colors={colors} />
            <TimingStat
              label="Remaining"
              value={manualPlayback.remainingSeconds != null ? formatTimer(manualPlayback.remainingSeconds) : '—'}
              colors={colors}
            />
          </View>
        </View>
      ) : null}

      {selectedSummary?.source === 'pco' && isLegacyLive && legacyLiveState ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.sectionHead}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>LIVE STATE</Text>
            <Pill tone="live" label={legacyLiveState.scheduleDelta?.label || 'Live'} colors={colors} />
          </View>
          <View style={styles.timingGrid}>
            <TimingStat label="Current" value={legacyLiveState.currentItem?.title || 'No cue'} colors={colors} />
            <TimingStat label="Next" value={legacyLiveState.items?.[legacyLiveState.currentIndex + 1]?.title || 'None'} colors={colors} />
            <TimingStat label="Elapsed" value={formatTimer(legacyLiveState.totalElapsed || 0)} colors={colors} />
            <TimingStat
              label="Progress"
              value={`${legacyLiveState.currentIndex + 1} / ${legacyLiveState.totalItems}`}
              colors={colors}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>CUES</Text>
        <Text style={[styles.sectionCaption, { color: colors.textMuted }]}>
          Tap a cue to jump live, or use the controls above.
        </Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <FlatList
        ref={listRef}
        data={selectedRows}
        keyExtractor={(item) => item.key}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No cues yet</Text>
            <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
              This plan does not have any cues to display.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          item.kind === 'section'
            ? <SectionRow label={item.label} colors={colors} />
            : (
              <CueRow
                item={item.item}
                colors={colors}
                isLive={isLive}
                isCurrent={isCurrentCue(selectedSummary, currentLiveState, item.index, item.item)}
                isNext={isNextCue(selectedSummary, currentLiveState, item.index)}
                manualTiming={selectedSummary?.source === 'manual' ? manualTimings[item.index] || null : null}
                onGoTo={() => {
                  if (!isLive || actionBusy != null) return;
                  if (selectedSummary?.source === 'manual') {
                    performManualAction('goto', item.index);
                  } else {
                    performLegacyAction('goto', item.index);
                  }
                }}
              />
            )
        )}
      />
    </View>
  );
}

function PlanChip({
  summary,
  selected,
  loading,
  live,
  colors,
  onPress,
}: {
  summary: RundownPlanSummary;
  selected: boolean;
  loading: boolean;
  live: boolean;
  colors: ThemeColors;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.planChip,
        {
          borderColor: selected ? colors.accent : colors.border,
          backgroundColor: selected ? 'rgba(0,230,118,0.08)' : colors.bg,
        },
      ]}
      onPress={onPress}
      disabled={loading}
    >
      <View style={styles.planChipTopRow}>
        <Text style={[styles.planChipLabel, { color: colors.text }]} numberOfLines={1}>{summary.title}</Text>
        {loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
      </View>
      <View style={styles.planChipMetaRow}>
        <Pill tone={summary.source === 'manual' ? 'accent' : 'info'} label={summary.source === 'manual' ? 'Manual' : 'PCO'} colors={colors} />
        {live ? <Pill tone="live" label="Live" colors={colors} /> : null}
      </View>
      <Text style={[styles.planChipMeta, { color: colors.textSecondary }]} numberOfLines={1}>
        {summary.serviceDate ? formatDateOnly(summary.serviceDate) : `${summary.itemCount} cues`}
      </Text>
    </TouchableOpacity>
  );
}

function CueRow({
  item,
  colors,
  isLive,
  isCurrent,
  isNext,
  manualTiming,
  onGoTo,
}: {
  item: ManualRundownItem | PcoRundownItem;
  colors: ThemeColors;
  isLive: boolean;
  isCurrent: boolean;
  isNext: boolean;
  manualTiming: ManualTimingEntry | null;
  onGoTo: () => void;
}) {
  const isSection = item.itemType === 'section';

  if (isSection) {
    return <SectionRow label={item.title || 'Section'} colors={colors} />;
  }

  const cue = item as ManualRundownItem & PcoRundownItem;
  const accent = isCurrent ? colors.accent : isNext ? colors.info : colors.border;

  return (
    <TouchableOpacity
      activeOpacity={isLive ? 0.88 : 1}
      style={[
        styles.cueCard,
        {
          backgroundColor: isCurrent ? 'rgba(0,230,118,0.08)' : colors.surface,
          borderColor: accent,
          opacity: isCurrent ? 1 : 0.98,
        },
        isCurrent ? styles.currentCueCard : null,
      ]}
      onPress={isLive ? onGoTo : undefined}
    >
      {isCurrent ? <View style={[styles.currentRail, { backgroundColor: colors.accent }]} /> : null}

      <View style={styles.cueMain}>
        <View style={styles.cueTopRow}>
          <View style={styles.cueTitleWrap}>
            <Text style={[styles.cueTitle, { color: colors.text }]} numberOfLines={2}>
              {cue.title || 'Untitled cue'}
            </Text>
            {isCurrent ? <Pill tone="live" label="Current" colors={colors} /> : null}
            {!isCurrent && isNext ? <Pill tone="info" label="Next" colors={colors} /> : null}
          </View>
          {isLive ? (
            <TouchableOpacity
              style={[styles.goButton, { borderColor: colors.accent, backgroundColor: 'rgba(0,230,118,0.08)' }]}
              onPress={onGoTo}
            >
              <Text style={[styles.goButtonText, { color: colors.accent }]}>Go</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {cue.songTitle && cue.songTitle !== cue.title ? (
          <Text style={[styles.cueSubtext, { color: colors.textSecondary }]} numberOfLines={2}>
            {cue.songTitle}
          </Text>
        ) : null}
        {cue.description ? (
          <Text style={[styles.cueSubtext, { color: colors.textSecondary }]} numberOfLines={2}>
            {cue.description}
          </Text>
        ) : null}
        {cue.notes ? (
          <Text style={[styles.cueNotes, { color: colors.textMuted }]} numberOfLines={3}>
            {stripTags(cue.notes)}
          </Text>
        ) : null}

        <View style={styles.cueMetaRow}>
          <Pill tone="muted" label={formatCueType(cue.itemType)} colors={colors} />
          {cue.startType ? <Pill tone={cue.startType === 'hard' ? 'warning' : 'accent'} label={cue.startType === 'hard' ? 'Hard start' : 'Soft start'} colors={colors} /> : null}
          {cue.autoAdvance ? <Pill tone="info" label="Auto" colors={colors} /> : null}
          {cue.servicePosition ? <Pill tone="muted" label={formatServicePosition(cue.servicePosition)} colors={colors} /> : null}
        </View>

        <View style={styles.cueFooter}>
          <Text style={[styles.cueDuration, { color: colors.textSecondary }]}>
            {cue.lengthSeconds != null && cue.lengthSeconds > 0 ? formatDuration(Number(cue.lengthSeconds)) : 'No duration'}
          </Text>
          {cue.assignee ? <Text style={[styles.cueAssignee, { color: colors.textMuted }]} numberOfLines={1}>{cue.assignee}</Text> : null}
        </View>

        {manualTiming ? (
          <View style={styles.timingRow}>
            <Text style={[styles.timingText, { color: colors.textSecondary }]}>
              {manualTiming.isHard ? `Hard ${manualTiming.start}` : `Soft ${manualTiming.start}`}
            </Text>
            {manualTiming.gapSeconds > 0 ? (
              <Text style={[styles.timingGap, { color: colors.info }]}>Gap {formatDuration(manualTiming.gapSeconds)}</Text>
            ) : null}
            {manualTiming.overlapSeconds > 0 ? (
              <Text style={[styles.timingOverlap, { color: colors.warning }]}>Overlap {formatDuration(manualTiming.overlapSeconds)}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function SectionRow({ label, colors }: { label: string; colors: ThemeColors }) {
  return (
    <View style={[styles.sectionRow, { borderColor: colors.border }]}>
      <Text style={[styles.sectionRowText, { color: colors.accent }]}>{label}</Text>
    </View>
  );
}

function LiveSummaryCard({
  colors,
  isLive,
  currentCue,
  nextCue,
  manualPlayback,
  legacyLiveState,
}: {
  colors: ThemeColors;
  isLive: boolean;
  currentCue: ManualRundownItem | PcoRundownItem | null;
  nextCue: ManualRundownItem | PcoRundownItem | null;
  manualPlayback: ManualPlaybackState | null;
  legacyLiveState: LegacyRundownState | null;
}) {
  const [pulse] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!isLive) return undefined;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.12, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [isLive, pulse]);

  const liveLabel = manualPlayback
    ? (manualPlayback.isOvertime ? `+${formatTimer(manualPlayback.overtimeSeconds)}` : manualPlayback.remainingSeconds != null ? formatTimer(manualPlayback.remainingSeconds) : formatTimer(manualPlayback.elapsedSeconds))
    : isLive
      ? (legacyLiveState?.currentItem?.isOvertime ? `+${formatTimer(legacyLiveState.currentItem.overtimeSeconds || 0)}` : legacyLiveState?.currentItem?.remainingSeconds != null ? formatTimer(legacyLiveState.currentItem.remainingSeconds || 0) : formatTimer(legacyLiveState?.totalElapsed || 0))
      : '--:--';

  return (
    <View style={[styles.liveCard, { borderColor: isLive ? colors.accent : colors.border, backgroundColor: colors.bg }]}>
      <View style={styles.liveHeaderRow}>
        <Animated.View style={[styles.livePulse, { backgroundColor: isLive ? colors.accent : colors.textMuted, transform: [{ scale: pulse }] }]} />
        <Text style={[styles.liveHeaderText, { color: colors.textSecondary }]}>
          {isLive ? 'LIVE NOW' : 'Standby'}
        </Text>
      </View>

      <Text style={[styles.liveTimer, { color: isLive ? colors.accent : colors.textMuted }]}>
        {liveLabel}
      </Text>

      <Text style={[styles.liveCueTitle, { color: colors.text }]} numberOfLines={2}>
        {currentCue?.title || 'No live cue'}
      </Text>

      <Text style={[styles.liveCueMeta, { color: colors.textSecondary }]} numberOfLines={2}>
        {nextCue ? `Next: ${nextCue.title}` : 'No next cue'}
      </Text>

      {legacyLiveState?.scheduleDelta ? (
        <Pill
          tone={legacyLiveState.scheduleDelta.isBehind ? 'danger' : legacyLiveState.scheduleDelta.isAhead ? 'info' : 'accent'}
          label={legacyLiveState.scheduleDelta.label}
          colors={colors}
        />
      ) : manualPlayback ? (
        <Pill
          tone={manualPlayback.isOvertime ? 'danger' : manualPlayback.isWarning ? 'warning' : 'accent'}
          label={manualPlayback.isOvertime ? 'Overtime' : manualPlayback.isWarning ? 'Warning' : 'On pace'}
          colors={colors}
        />
      ) : null}
    </View>
  );
}

function ActionButton({
  label,
  icon,
  tone,
  colors,
  onPress,
  disabled,
  loading,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: 'primary' | 'ghost' | 'danger';
  colors: ThemeColors;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const isGhost = tone === 'ghost';
  const backgroundColor = tone === 'primary'
    ? colors.accent
    : tone === 'danger'
      ? 'rgba(239,68,68,0.12)'
      : colors.surface;
  const borderColor = tone === 'danger' ? 'rgba(239,68,68,0.4)' : colors.border;
  const textColor = tone === 'primary' ? '#000' : tone === 'danger' ? '#ff6b6b' : colors.text;
  return (
    <TouchableOpacity
      style={[
        styles.actionButton,
        {
          backgroundColor,
          borderColor,
          opacity: disabled ? 0.45 : 1,
        },
        isGhost ? styles.ghostActionButton : null,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.82}
    >
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <>
          <Ionicons name={icon} size={16} color={textColor} />
          <Text style={[styles.actionButtonText, { color: textColor }]}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

type PillTone = 'accent' | 'muted' | 'info' | 'warning' | 'danger' | 'live';

function Pill({
  label,
  tone,
  colors,
}: {
  label: string;
  tone: PillTone;
  colors: ThemeColors;
}) {
  const toneMap: Record<PillTone, { bg: string; fg: string; border: string }> = {
    accent: { bg: 'rgba(0,230,118,0.12)', fg: colors.accent, border: 'rgba(0,230,118,0.28)' },
    muted: { bg: colors.isDark ? colors.surfaceElevated : '#eef2f7', fg: colors.textSecondary, border: colors.border },
    info: { bg: 'rgba(59,130,246,0.12)', fg: '#60a5fa', border: 'rgba(59,130,246,0.28)' },
    warning: { bg: 'rgba(245,158,11,0.14)', fg: colors.warning, border: 'rgba(245,158,11,0.35)' },
    danger: { bg: 'rgba(239,68,68,0.14)', fg: '#ff6b6b', border: 'rgba(239,68,68,0.35)' },
    live: { bg: 'rgba(0,230,118,0.16)', fg: colors.accent, border: 'rgba(0,230,118,0.35)' },
  };
  const pill = toneMap[tone];

  return (
    <View style={[styles.pill, { backgroundColor: pill.bg, borderColor: pill.border }]}>
      <Text style={[styles.pillText, { color: pill.fg }]}>{label}</Text>
    </View>
  );
}

function Metric({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ThemeColors;
}) {
  return (
    <View style={[styles.metricCard, { backgroundColor: colors.isDark ? colors.surfaceElevated : '#f3f4f6', borderColor: colors.border }]}>
      <Text style={[styles.metricLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: colors.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function TimingStat({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ThemeColors;
}) {
  return (
    <View style={[styles.timingStat, { backgroundColor: colors.isDark ? colors.surfaceElevated : '#f3f4f6', borderColor: colors.border }]}>
      <Text style={[styles.timingStatLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[styles.timingStatValue, { color: colors.text }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function buildDisplayRows(detail: RundownPlanDetail | null): DisplayRow[] {
  if (!detail) return [];
  const rows: DisplayRow[] = [];

  if (detail.source === 'manual') {
    detail.items.forEach((item, index) => {
      if (item.itemType === 'section') {
        rows.push({
          kind: 'section',
          key: `section-${item.id}`,
          label: item.title || 'Section',
          index,
        });
        return;
      }
      rows.push({
        kind: 'cue',
        key: item.id,
        item,
        index,
      });
    });
    return rows;
  }

  const items = [...(detail.items || [])].sort((a, b) => {
    const aSeq = Number(a.sequence ?? 0);
    const bSeq = Number(b.sequence ?? 0);
    return aSeq - bSeq;
  });

  const hasPositions = items.some((item) => !!item.servicePosition);
  if (!hasPositions) {
    items.forEach((item, index) => {
      rows.push({
        kind: 'cue',
        key: item.id,
        item,
        index,
      });
    });
    return rows;
  }

  for (const group of PCO_GROUP_ORDER) {
    const grouped = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => group.positions.includes(String(item.servicePosition || '').trim()));

    if (grouped.length === 0) continue;
    rows.push({
      kind: 'section',
      key: `group-${group.label}`,
      label: group.label,
      index: grouped[0].index,
    });
    grouped.forEach(({ item, index }) => {
      rows.push({
        kind: 'cue',
        key: item.id,
        item,
        index,
        groupLabel: group.label,
      });
    });
  }

  return rows;
}

function sortSummaries(summaries: RundownPlanSummary[]): RundownPlanSummary[] {
  const now = Date.now();
  const sourceRank = (source: RundownSource) => (source === 'manual' ? 0 : 1);
  const distance = (summary: RundownPlanSummary) => {
    if (!summary.serviceDate) return Number.MAX_SAFE_INTEGER;
    const date = new Date(summary.serviceDate);
    if (Number.isNaN(date.getTime())) return Number.MAX_SAFE_INTEGER;
    return Math.abs(date.getTime() - now);
  };

  return [...summaries].sort((a, b) => {
    const sourceDiff = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDiff !== 0) return sourceDiff;
    const distanceDiff = distance(a) - distance(b);
    if (distanceDiff !== 0) return distanceDiff;
    const updatedDiff = (Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    if (updatedDiff !== 0) return updatedDiff;
    return a.title.localeCompare(b.title);
  });
}

function pickMostRelevantManual(summaries: RundownPlanSummary[]): RundownPlanSummary | null {
  if (summaries.length === 0) return null;
  return sortSummaries(summaries).find(Boolean) || null;
}

function pickMostRelevantPco(summaries: RundownPlanSummary[]): RundownPlanSummary | null {
  if (summaries.length === 0) return null;
  return sortSummaries(summaries).find(Boolean) || null;
}

function isSummaryLive(
  summary: RundownPlanSummary,
  selectedSummary: RundownPlanSummary | null,
  manualLiveState: ManualRundownLiveState | null,
  legacyLiveState: LegacyRundownState | null,
): boolean {
  if (!selectedSummary || selectedSummary.id !== summary.id || selectedSummary.source !== summary.source) return false;
  if (summary.source === 'manual') return !!manualLiveState?.isLive;
  return !!legacyLiveState && legacyLiveState.planId === summary.id && (legacyLiveState.active ?? legacyLiveState.state === 'active');
}

function isCurrentCue(
  selectedSummary: RundownPlanSummary | null,
  liveState: LegacyRundownState | ManualRundownLiveState | null,
  index: number,
  item: ManualRundownItem | PcoRundownItem,
): boolean {
  if (!selectedSummary || !liveState) return false;
  if (selectedSummary.source === 'manual') {
    return !!(liveState as ManualRundownLiveState).isLive && (liveState as ManualRundownLiveState).currentCueIndex === index;
  }
  const legacy = liveState as LegacyRundownState;
  if (!(legacy.active ?? legacy.state === 'active')) return false;
  if (legacy.currentIndex === index) return true;
  return legacy.currentItem?.id === item.id;
}

function isNextCue(
  selectedSummary: RundownPlanSummary | null,
  liveState: LegacyRundownState | ManualRundownLiveState | null,
  index: number,
): boolean {
  if (!selectedSummary || !liveState) return false;
  if (selectedSummary.source === 'manual') {
    return !!(liveState as ManualRundownLiveState).isLive
      && (liveState as ManualRundownLiveState).currentCueIndex >= 0
      && index === (liveState as ManualRundownLiveState).currentCueIndex + 1;
  }
  const legacy = liveState as LegacyRundownState;
  if (!(legacy.active ?? legacy.state === 'active')) return false;
  return index === (legacy.currentIndex + 1);
}

function stripTags(text: string): string {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDateOnly(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })} at ${date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  if (minutes > 0) {
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  return `${secs}s`;
}

function formatTimer(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatCueType(type: string): string {
  if (!type) return 'Cue';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatServicePosition(position: string): string {
  if (position === 'before') return 'Pre';
  if (position === 'during') return 'Service';
  if (position === 'after') return 'Post';
  return position;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxxl,
  },
  centerText: {
    marginTop: spacing.md,
    fontSize: fontSize.md,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    marginTop: spacing.lg,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: fontSize.md,
    marginTop: spacing.sm,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 320,
  },
  primaryAction: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  primaryActionText: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: '#000',
  },
  screenHeader: {
    marginBottom: spacing.lg,
  },
  screenHeaderTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  screenKicker: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  screenTitle: {
    fontSize: fontSize.xxl,
    fontWeight: '900',
    marginTop: 2,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineError: {
    marginTop: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  inlineErrorText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  card: {
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    borderWidth: 1,
    marginBottom: spacing.lg,
  },
  planStrip: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  planChip: {
    width: 182,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginRight: spacing.sm,
  },
  planChipTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  planChipLabel: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '800',
  },
  planChipMetaRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  planChipMeta: {
    marginTop: spacing.sm,
    fontSize: fontSize.xs,
  },
  heroRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  heroContent: {
    flex: 1,
  },
  heroStatusColumn: {
    width: 138,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  pill: {
    borderRadius: borderRadius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  pillText: {
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  heroTitle: {
    fontSize: fontSize.xl,
    fontWeight: '900',
    lineHeight: 28,
  },
  heroSubtitle: {
    marginTop: spacing.xs,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  metricsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  metricCard: {
    minWidth: 94,
    borderWidth: 1,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexGrow: 1,
  },
  metricLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metricValue: {
    marginTop: 4,
    fontSize: fontSize.md,
    fontWeight: '800',
  },
  liveCard: {
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    padding: spacing.md,
    minHeight: 176,
    justifyContent: 'space-between',
  },
  liveHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  livePulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  liveHeaderText: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  liveTimer: {
    fontSize: 34,
    fontWeight: '900',
    marginTop: spacing.sm,
  },
  liveCueTitle: {
    fontSize: fontSize.md,
    fontWeight: '800',
    marginTop: spacing.sm,
    lineHeight: 22,
  },
  liveCueMeta: {
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    lineHeight: 20,
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  actionButton: {
    minWidth: '48%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  ghostActionButton: {
    // no-op placeholder to keep styles grouped
  },
  actionButtonText: {
    fontSize: fontSize.sm,
    fontWeight: '800',
  },
  sectionHead: {
    marginBottom: spacing.sm,
    marginTop: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionCaption: {
    flex: 1,
    fontSize: fontSize.xs,
    textAlign: 'right',
  },
  timingGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  timingStat: {
    flexBasis: '48%',
    flexGrow: 1,
    minHeight: 74,
    borderWidth: 1,
    borderRadius: borderRadius.md,
    padding: spacing.md,
  },
  timingStatLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  timingStatValue: {
    marginTop: 6,
    fontSize: fontSize.sm,
    fontWeight: '800',
    lineHeight: 18,
  },
  sectionRow: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    marginBottom: spacing.sm,
  },
  sectionRowText: {
    fontSize: fontSize.sm,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  cueCard: {
    borderWidth: 1,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    gap: spacing.md,
  },
  currentCueCard: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },
  currentRail: {
    width: 4,
    borderRadius: 2,
    marginRight: -spacing.sm,
  },
  cueMain: {
    flex: 1,
  },
  cueTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cueTitleWrap: {
    flex: 1,
    gap: spacing.xs,
  },
  cueTitle: {
    fontSize: fontSize.md,
    fontWeight: '900',
    lineHeight: 22,
  },
  goButton: {
    borderWidth: 1,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  goButtonText: {
    fontSize: fontSize.xs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  cueSubtext: {
    fontSize: fontSize.sm,
    marginTop: 4,
    lineHeight: 19,
  },
  cueNotes: {
    fontSize: fontSize.sm,
    marginTop: 4,
    lineHeight: 19,
    fontStyle: 'italic',
  },
  cueMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  cueFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  cueDuration: {
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  cueAssignee: {
    fontSize: fontSize.xs,
    flexShrink: 1,
    textAlign: 'right',
  },
  timingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  timingText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  timingGap: {
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  timingOverlap: {
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
});
