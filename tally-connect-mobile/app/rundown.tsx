import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, SectionList, StyleSheet, ActivityIndicator,
  RefreshControl, TouchableOpacity, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, getChurchId } from '../src/api/client';
import { tallySocket } from '../src/ws/TallySocket';
import { useThemeColors, ThemeColors } from '../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';
import type { RundownState, RundownTick, ScheduleDelta } from '../src/ws/types';

interface PlanItem {
  id: string;
  sequence: number;
  itemType: string;
  title: string;
  servicePosition: string;
  lengthSeconds: number | null;
  description: string | null;
  songId: string | null;
  songTitle: string | null;
  author: string | null;
  arrangementKey: string | null;
}

interface TeamMember {
  id: string;
  name: string;
  teamName: string;
  position: string;
  status: string;
  statusLabel: string;
}

interface ServiceTime {
  id: string;
  name: string;
  timeType: string;
  startsAt: string | null;
  endsAt: string | null;
}

interface ServicePlan {
  id: string;
  title: string;
  sortDate: string;
  items: PlanItem[];
  team: TeamMember[];
  times: ServiceTime[];
}

type ScreenState = 'loading' | 'no_connection' | 'no_service' | 'ready' | 'error';

export default function RundownScreen() {
  const colors = useThemeColors();
  const [state, setState] = useState<ScreenState>('loading');
  const [plan, setPlan] = useState<ServicePlan | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Live rundown state
  const [liveState, setLiveState] = useState<RundownState | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const liveStateRef = useRef<RundownState | null>(null);
  const scrollRef = useRef<SectionList>(null);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    try {
      const churchId = await getChurchId();
      if (!churchId) {
        setState('no_connection');
        return;
      }

      // Check PCO connection status first
      const status = await api<{ connected: boolean }>(
        `/api/churches/${churchId}/planning-center`,
        { signal }
      );

      if (!status.connected) {
        setState('no_connection');
        return;
      }

      // Fetch next service
      const data = await api<{ plan: ServicePlan | null }>(
        `/api/churches/${churchId}/planning-center/next-service`,
        { signal }
      );

      if (!data.plan) {
        setState('no_service');
        return;
      }

      setPlan(data.plan);
      setState('ready');

      // Check if there's already an active live rundown session
      const liveData = await api<RundownState & { active: boolean }>(
        `/api/churches/${churchId}/live-rundown/state`,
        { signal }
      );
      if (liveData.active) {
        setLiveState(liveData);
        liveStateRef.current = liveData;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('Failed to load service rundown:', err);
      setState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  // Listen for WebSocket rundown messages
  useEffect(() => {
    const unsub = tallySocket.onMessage((msg) => {
      if (msg.type === 'rundown_state' || msg.type === 'rundown_position') {
        const rs = msg as RundownState;
        setLiveState(rs);
        liveStateRef.current = rs;
      } else if (msg.type === 'rundown_tick') {
        const tick = msg as RundownTick;
        setLiveState((prev) => {
          if (!prev) return prev;
          const updated = {
            ...prev,
            totalElapsed: tick.totalElapsed,
            scheduleDelta: tick.scheduleDelta,
            currentItem: prev.currentItem ? {
              ...prev.currentItem,
              elapsedSeconds: tick.elapsedSeconds,
              remainingSeconds: tick.remainingSeconds,
              isOvertime: tick.isOvertime,
              overtimeSeconds: tick.overtimeSeconds,
              isWarning: tick.isWarning,
            } : null,
          };
          liveStateRef.current = updated;
          return updated;
        });
      } else if (msg.type === 'rundown_ended') {
        setLiveState(null);
        liveStateRef.current = null;
      }
    });
    return unsub;
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const startService = useCallback(async () => {
    if (!plan) return;
    setIsStarting(true);
    try {
      const churchId = await getChurchId();
      if (!churchId) return;
      const result = await api<RundownState>(
        `/api/churches/${churchId}/live-rundown/start`,
        { method: 'POST', body: { planId: plan.id, callerName: 'Mobile TD' } }
      );
      setLiveState(result);
      liveStateRef.current = result;
    } catch (err) {
      Alert.alert('Error', 'Failed to start rundown session');
    } finally {
      setIsStarting(false);
    }
  }, [plan]);

  const endService = useCallback(async () => {
    Alert.alert('End Service', 'Are you sure you want to end this rundown session?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End',
        style: 'destructive',
        onPress: async () => {
          try {
            const churchId = await getChurchId();
            if (!churchId) return;
            await api(`/api/churches/${churchId}/live-rundown/end`, { method: 'POST' });
            setLiveState(null);
            liveStateRef.current = null;
          } catch {
            Alert.alert('Error', 'Failed to end rundown session');
          }
        },
      },
    ]);
  }, []);

  const advance = useCallback(async () => {
    try {
      const churchId = await getChurchId();
      if (!churchId) return;
      await api(`/api/churches/${churchId}/live-rundown/advance`, { method: 'POST' });
    } catch {}
  }, []);

  const goBack = useCallback(async () => {
    try {
      const churchId = await getChurchId();
      if (!churchId) return;
      await api(`/api/churches/${churchId}/live-rundown/back`, { method: 'POST' });
    } catch {}
  }, []);

  if (state === 'loading') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, marginTop: 12 }}>Loading service plan...</Text>
      </View>
    );
  }

  if (state === 'no_connection') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bg }]}>
        <Ionicons name="cloud-offline-outline" size={48} color={colors.textMuted} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>Planning Center Not Connected</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          Connect your Planning Center account in the admin portal to see your service rundown here.
        </Text>
      </View>
    );
  }

  if (state === 'no_service') {
    return (
      <ScrollView
        style={[styles.container, { backgroundColor: colors.bg }]}
        contentContainerStyle={[styles.centered, { backgroundColor: colors.bg }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <Ionicons name="calendar-outline" size={48} color={colors.textMuted} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No Upcoming Service</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          There are no upcoming service plans found. Pull down to refresh.
        </Text>
      </ScrollView>
    );
  }

  if (state === 'error') {
    return (
      <ScrollView
        style={[styles.container, { backgroundColor: colors.bg }]}
        contentContainerStyle={[styles.centered, { backgroundColor: colors.bg }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <Ionicons name="warning-outline" size={48} color={colors.warning} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>Failed to Load</Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          Could not load service data. Pull down to try again.
        </Text>
      </ScrollView>
    );
  }

  const isLive = liveState != null;
  const serviceTime = plan!.times.find((t) => t.timeType === 'service') || plan!.times[0];

  // Build items list from live state or static plan
  const displayItems = isLive ? liveState!.items : plan!.items;
  const serviceItems = displayItems.filter((i: any) => i.servicePosition === 'during');
  const preServiceItems = displayItems.filter((i: any) => i.servicePosition === 'before');
  const postServiceItems = displayItems.filter((i: any) => i.servicePosition === 'after');

  const mainItems = serviceItems.length > 0 ? serviceItems : displayItems;
  const rundownSections: Array<{ key: string; title: string; data: any[] }> = [];
  if (preServiceItems.length > 0) {
    rundownSections.push({ key: 'pre', title: 'PRE-SERVICE', data: preServiceItems });
  }
  rundownSections.push({ key: 'service', title: 'SERVICE RUNDOWN', data: mainItems });
  if (postServiceItems.length > 0) {
    rundownSections.push({ key: 'post', title: 'POST-SERVICE', data: postServiceItems });
  }

  // Group team by teamName
  const teamGroups: Record<string, TeamMember[]> = {};
  for (const member of plan!.team) {
    const group = member.teamName || 'Other';
    if (!teamGroups[group]) teamGroups[group] = [];
    teamGroups[group].push(member);
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <SectionList
        ref={scrollRef}
        style={[styles.container, { backgroundColor: colors.bg }]}
        contentContainerStyle={styles.content}
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        sections={rundownSections}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{section.title}</Text>
        )}
        renderSectionFooter={({ section }) => {
          if (section.key === 'service' && section.data.length === 0) {
            return (
              <View>
                <View style={[styles.emptyCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <Text style={[styles.emptyCardText, { color: colors.textMuted }]}>No items in this service plan</Text>
                </View>
                <View style={{ marginBottom: spacing.xxl }} />
              </View>
            );
          }
          return <View style={{ marginBottom: spacing.xxl }} />;
        }}
        renderItem={({ item, index, section }) => (
          <RundownItem
            item={item}
            isLast={index === section.data.length - 1}
            colors={colors}
            isLive={isLive}
            isCurrent={isLive && item.status === 'current'}
            isCompleted={isLive && item.status === 'completed'}
          />
        )}
        ListHeaderComponent={
          <View>
            {/* Plan header card */}
            <View style={[styles.headerCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.serviceTitle, { color: colors.text }]}>{plan!.title}</Text>
              {serviceTime?.startsAt && (
                <View style={styles.timeRow}>
                  <Ionicons name="time-outline" size={16} color={colors.accent} />
                  <Text style={[styles.timeText, { color: colors.accent }]}>
                    {formatServiceDate(serviceTime.startsAt)}
                  </Text>
                </View>
              )}
              {!serviceTime?.startsAt && plan!.sortDate && (
                <View style={styles.timeRow}>
                  <Ionicons name="calendar-outline" size={16} color={colors.accent} />
                  <Text style={[styles.timeText, { color: colors.accent }]}>
                    {new Date(plan!.sortDate).toLocaleDateString(undefined, {
                      weekday: 'long', month: 'long', day: 'numeric',
                    })}
                  </Text>
                </View>
              )}
              {/* Start/End Service button */}
              {!isLive ? (
                <TouchableOpacity
                  style={[styles.startButton, { backgroundColor: colors.accent }]}
                  onPress={startService}
                  disabled={isStarting}
                >
                  {isStarting ? (
                    <ActivityIndicator size="small" color="#000" />
                  ) : (
                    <>
                      <Ionicons name="play" size={18} color="#000" />
                      <Text style={styles.startButtonText}>Start Service</Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.endButton]}
                  onPress={endService}
                >
                  <Ionicons name="stop" size={16} color="#FF5252" />
                  <Text style={styles.endButtonText}>End Service</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Live countdown hero */}
            {isLive && liveState!.currentItem && (
              <View style={[styles.countdownHero, {
                backgroundColor: colors.surface,
                borderColor: liveState!.currentItem.isOvertime ? '#FF5252' :
                  liveState!.currentItem.isWarning ? '#FFA726' : colors.accent,
              }]}>
                <Text style={[styles.nowLabel, { color: colors.textSecondary }]}>NOW</Text>
                <Text style={[styles.currentItemTitle, { color: colors.text }]}>{liveState!.currentItem.title}</Text>
                <Text style={[styles.countdownTimer, {
                  color: liveState!.currentItem.isOvertime ? '#FF5252' :
                    liveState!.currentItem.isWarning ? '#FFA726' : colors.accent,
                }]}>
                  {liveState!.currentItem.isOvertime
                    ? `+${formatTimer(liveState!.currentItem.overtimeSeconds || 0)}`
                    : liveState!.currentItem.remainingSeconds != null
                      ? formatTimer(liveState!.currentItem.remainingSeconds)
                      : formatTimer(liveState!.currentItem.elapsedSeconds || 0)}
                </Text>
                <Text style={[styles.timerLabel, { color: colors.textMuted }]}>
                  {liveState!.currentItem.isOvertime ? 'OVERTIME' :
                    liveState!.currentItem.remainingSeconds != null ? 'REMAINING' : 'ELAPSED'}
                </Text>

                {/* Schedule delta */}
                {liveState!.scheduleDelta && (
                  <View style={[styles.deltaBadge, {
                    backgroundColor: liveState!.scheduleDelta.isOnTime ? 'rgba(0,230,118,0.15)' :
                      liveState!.scheduleDelta.isBehind ? 'rgba(239,68,68,0.15)' : 'rgba(33,150,243,0.15)',
                  }]}>
                    <Text style={[styles.deltaText, {
                      color: liveState!.scheduleDelta.isOnTime ? colors.accent :
                        liveState!.scheduleDelta.isBehind ? '#FF5252' : '#42A5F5',
                    }]}>
                      {liveState!.scheduleDelta.label}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Show-caller controls */}
            {isLive && (
              <View style={styles.controlBar}>
                <TouchableOpacity
                  style={[styles.controlButton, styles.backButton, {
                    backgroundColor: colors.surface, borderColor: colors.border,
                    opacity: liveState!.currentIndex === 0 ? 0.4 : 1,
                  }]}
                  onPress={goBack}
                  disabled={liveState!.currentIndex === 0}
                >
                  <Ionicons name="chevron-back" size={24} color={colors.text} />
                  <Text style={[styles.controlLabel, { color: colors.text }]}>Back</Text>
                </TouchableOpacity>

                <View style={styles.progressInfo}>
                  <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                    {liveState!.currentIndex + 1} / {liveState!.totalItems}
                  </Text>
                  <Text style={[styles.elapsedText, { color: colors.textMuted }]}>
                    {formatDuration(liveState!.totalElapsed || 0)} elapsed
                  </Text>
                </View>

                <TouchableOpacity
                  style={[styles.controlButton, styles.nextButton, {
                    backgroundColor: colors.accent,
                    opacity: liveState!.currentIndex >= liveState!.totalItems - 1 ? 0.4 : 1,
                  }]}
                  onPress={advance}
                  disabled={liveState!.currentIndex >= liveState!.totalItems - 1}
                >
                  <Text style={styles.nextLabel}>Next</Text>
                  <Ionicons name="chevron-forward" size={24} color="#000" />
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
        ListFooterComponent={
          <View>
            {plan!.team.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>SERVICE TEAM</Text>
                <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  {Object.entries(teamGroups).map(([groupName, members], gi) => (
                    <View key={groupName}>
                      {gi > 0 && <View style={[styles.teamDivider, { backgroundColor: colors.border }]} />}
                      <Text style={[styles.teamGroupName, { color: colors.accent }]}>{groupName}</Text>
                      {members.map((member) => (
                        <View key={member.id} style={styles.teamRow}>
                          <View style={styles.teamInfo}>
                            <Text style={[styles.teamMemberName, { color: colors.text }]}>{member.name}</Text>
                            <Text style={[styles.teamPosition, { color: colors.textSecondary }]}>{member.position}</Text>
                          </View>
                          <StatusBadge status={member.status} label={member.statusLabel} colors={colors} />
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            )}
            <View style={{ height: spacing.xxxl }} />
          </View>
        }
      />
    </View>
  );
}

function RundownItem({ item, isLast, colors, isLive, isCurrent, isCompleted }: {
  item: any; isLast: boolean; colors: ThemeColors; isLive: boolean; isCurrent: boolean; isCompleted: boolean;
}) {
  const isHeader = item.itemType === 'header';

  if (isHeader) {
    return (
      <View style={[styles.headerItem, !isLast && styles.itemBorder]}>
        <Text style={[styles.headerItemText, { color: colors.accent }]}>{item.title}</Text>
      </View>
    );
  }

  return (
    <View style={[
      styles.rundownItem,
      {
        backgroundColor: isCurrent ? 'rgba(0,230,118,0.08)' : colors.surface,
        borderColor: isCurrent ? 'rgba(0,230,118,0.3)' : colors.border,
        opacity: isCompleted ? 0.5 : 1,
      },
      isCurrent && styles.currentItemHighlight,
      !isLast && styles.itemBorder,
    ]}>
      {isCurrent && <View style={styles.currentBar} />}
      <View style={styles.itemLeft}>
        <ItemTypeIcon type={item.itemType} colors={colors} isCurrent={isCurrent} />
      </View>
      <View style={styles.itemContent}>
        <Text style={[styles.itemTitle, { color: isCurrent ? colors.text : isCompleted ? colors.textMuted : colors.text, fontWeight: isCurrent ? '800' : '700' }]}>{item.title}</Text>
        {item.songTitle && item.songTitle !== item.title && (
          <Text style={[styles.itemSubtitle, { color: colors.textSecondary }]}>{item.songTitle}</Text>
        )}
        {item.author && (
          <Text style={[styles.itemMeta, { color: colors.textMuted }]}>{item.author}</Text>
        )}
        <View style={styles.itemDetails}>
          {item.itemType && (
            <Text style={[styles.itemType, { color: colors.textMuted, backgroundColor: colors.isDark ? colors.surfaceElevated : '#e8e8ed' }]}>{formatItemType(item.itemType)}</Text>
          )}
          {item.lengthSeconds != null && item.lengthSeconds > 0 && (
            <Text style={[styles.itemDuration, { color: colors.textSecondary }]}>{formatDuration(item.lengthSeconds)}</Text>
          )}
          {item.arrangementKey && (
            <Text style={[styles.itemKey, { color: colors.textSecondary }]}>Key: {item.arrangementKey}</Text>
          )}
        </View>
      </View>
      {/* Show actual vs planned delta for completed items */}
      {isCompleted && item.actualDuration != null && item.lengthSeconds > 0 && (
        <View style={styles.deltaColumn}>
          <Text style={[styles.actualDuration, { color: colors.textMuted }]}>{formatDuration(Math.round(item.actualDuration))}</Text>
          {Math.abs(item.actualDuration - item.lengthSeconds) >= 5 && (
            <Text style={[styles.itemDelta, {
              color: item.actualDuration > item.lengthSeconds ? '#FF5252' : '#42A5F5',
            }]}>
              {item.actualDuration > item.lengthSeconds ? '+' : ''}{Math.round(item.actualDuration - item.lengthSeconds)}s
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function ItemTypeIcon({ type, colors, isCurrent }: { type: string; colors: ThemeColors; isCurrent?: boolean }) {
  let icon: string;
  let iconColor = colors.textSecondary;

  switch (type) {
    case 'song':
      icon = 'musical-notes-outline';
      iconColor = isCurrent ? colors.accent : colors.accent;
      break;
    case 'media':
      icon = 'videocam-outline';
      iconColor = isCurrent ? colors.accent : colors.info;
      break;
    case 'item':
      icon = 'document-text-outline';
      if (isCurrent) iconColor = colors.accent;
      break;
    default:
      icon = 'ellipse-outline';
      if (isCurrent) iconColor = colors.accent;
      break;
  }

  return <Ionicons name={icon as any} size={20} color={iconColor} />;
}

function StatusBadge({ status, label, colors }: { status: string; label: string; colors: ThemeColors }) {
  let badgeColor = colors.textMuted;
  if (status === 'C') badgeColor = colors.online;
  else if (status === 'D') badgeColor = colors.critical;
  else if (status === 'U') badgeColor = colors.warning;

  return (
    <View style={[styles.badge, { borderColor: badgeColor }]}>
      <View style={[styles.badgeDot, { backgroundColor: badgeColor }]} />
      <Text style={[styles.badgeText, { color: badgeColor }]}>
        {label || status}
      </Text>
    </View>
  );
}

function formatServiceDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  }) + ' at ' + d.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatItemType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.lg,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxxl,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    marginTop: spacing.lg,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: fontSize.md,
    marginTop: spacing.sm,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Header card
  headerCard: {
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.xxl,
    borderWidth: 1,
  },
  serviceTitle: {
    fontSize: fontSize.xl,
    fontWeight: '800',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  timeText: {
    fontSize: fontSize.md,
    fontWeight: '600',
  },

  // Start/End buttons
  startButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing.lg,
    paddingVertical: 12,
    borderRadius: borderRadius.md,
  },
  startButtonText: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: '#000',
  },
  endButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.lg,
    paddingVertical: 10,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
  },
  endButtonText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: '#FF5252',
  },

  // Countdown hero
  countdownHero: {
    borderRadius: borderRadius.md,
    padding: spacing.xl,
    marginBottom: spacing.lg,
    borderWidth: 2,
    alignItems: 'center',
  },
  nowLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 4,
  },
  currentItemTitle: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  countdownTimer: {
    fontSize: 56,
    fontFamily: 'JetBrainsMono-Bold',
    letterSpacing: -1,
  },
  timerLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  deltaBadge: {
    marginTop: spacing.md,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  deltaText: {
    fontSize: 12,
    fontWeight: '700',
  },

  // Control bar
  controlBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xl,
    gap: spacing.md,
  },
  controlButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: borderRadius.md,
  },
  backButton: {
    borderWidth: 1,
  },
  nextButton: {},
  controlLabel: {
    fontSize: fontSize.md,
    fontWeight: '600',
    marginLeft: 4,
  },
  nextLabel: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: '#000',
    marginRight: 4,
  },
  progressInfo: {
    flex: 1,
    alignItems: 'center',
  },
  progressText: {
    fontSize: fontSize.md,
    fontFamily: 'JetBrainsMono-Bold',
  },
  elapsedText: {
    fontSize: fontSize.xs,
    fontFamily: 'JetBrainsMono-Bold',
    marginTop: 2,
  },

  // Sections
  section: {
    marginBottom: spacing.xxl,
  },
  sectionTitle: {
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
    marginBottom: spacing.md,
  },

  // Card
  card: {
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    borderWidth: 1,
  },
  emptyCard: {
    borderRadius: borderRadius.md,
    padding: spacing.xxl,
    borderWidth: 1,
    alignItems: 'center',
  },
  emptyCardText: {
    fontSize: fontSize.md,
  },

  // Rundown items
  rundownItem: {
    flexDirection: 'row',
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    borderWidth: 1,
    marginBottom: spacing.sm,
  },
  currentItemHighlight: {
    borderWidth: 2,
  },
  currentBar: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    backgroundColor: '#00E676',
  },
  itemBorder: {},
  headerItem: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  headerItemText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  itemLeft: {
    width: 32,
    alignItems: 'center',
    paddingTop: 2,
  },
  itemContent: {
    flex: 1,
  },
  itemTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  itemSubtitle: {
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  itemMeta: {
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  itemDetails: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  itemType: {
    fontSize: fontSize.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  itemDuration: {
    fontSize: fontSize.xs,
    fontFamily: 'JetBrainsMono-Bold',
  },
  itemKey: {
    fontSize: fontSize.xs,
  },

  // Delta column for completed items
  deltaColumn: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  actualDuration: {
    fontSize: fontSize.xs,
    fontFamily: 'JetBrainsMono-Bold',
  },
  itemDelta: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono-Bold',
    marginTop: 1,
  },

  // Team
  teamGroupName: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.sm,
    marginTop: spacing.xs,
  },
  teamRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  teamInfo: {
    flex: 1,
  },
  teamMemberName: {
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  teamPosition: {
    fontSize: fontSize.sm,
    marginTop: 1,
  },
  teamDivider: {
    height: 1,
    marginVertical: spacing.md,
  },

  // Badge
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    gap: 4,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
});
