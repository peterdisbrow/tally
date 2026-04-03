import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, getChurchId } from '../src/api/client';
import { useThemeColors, ThemeColors } from '../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';

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

  const loadData = useCallback(async () => {
    try {
      const churchId = await getChurchId();
      if (!churchId) {
        setState('no_connection');
        return;
      }

      // Check PCO connection status first
      const status = await api<{ connected: boolean }>(
        `/api/churches/${churchId}/planning-center`
      );

      if (!status.connected) {
        setState('no_connection');
        return;
      }

      // Fetch next service
      const data = await api<{ plan: ServicePlan | null }>(
        `/api/churches/${churchId}/planning-center/next-service`
      );

      if (!data.plan) {
        setState('no_service');
        return;
      }

      setPlan(data.plan);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  if (state === 'loading') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.accent} />
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

  const serviceTime = plan!.times.find((t) => t.timeType === 'service') || plan!.times[0];
  const serviceItems = plan!.items.filter((i) => i.servicePosition === 'during');
  const preServiceItems = plan!.items.filter((i) => i.servicePosition === 'before');
  const postServiceItems = plan!.items.filter((i) => i.servicePosition === 'after');

  // Group team by teamName
  const teamGroups: Record<string, TeamMember[]> = {};
  for (const member of plan!.team) {
    const group = member.teamName || 'Other';
    if (!teamGroups[group]) teamGroups[group] = [];
    teamGroups[group].push(member);
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
    >
      {/* Service Header */}
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
      </View>

      {/* Pre-Service Items */}
      {preServiceItems.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>PRE-SERVICE</Text>
          {preServiceItems.map((item, i) => (
            <RundownItem key={item.id} item={item} isLast={i === preServiceItems.length - 1} colors={colors} />
          ))}
        </View>
      )}

      {/* Service Rundown */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>SERVICE RUNDOWN</Text>
        {serviceItems.length === 0 && plan!.items.length > 0 && (
          // If no items have servicePosition='during', show all items
          plan!.items.map((item, i) => (
            <RundownItem key={item.id} item={item} isLast={i === plan!.items.length - 1} colors={colors} />
          ))
        )}
        {serviceItems.length > 0 && serviceItems.map((item, i) => (
          <RundownItem key={item.id} item={item} isLast={i === serviceItems.length - 1} colors={colors} />
        ))}
        {plan!.items.length === 0 && (
          <View style={[styles.emptyCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.emptyCardText, { color: colors.textMuted }]}>No items in this service plan</Text>
          </View>
        )}
      </View>

      {/* Post-Service Items */}
      {postServiceItems.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>POST-SERVICE</Text>
          {postServiceItems.map((item, i) => (
            <RundownItem key={item.id} item={item} isLast={i === postServiceItems.length - 1} colors={colors} />
          ))}
        </View>
      )}

      {/* Service Team */}
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
    </ScrollView>
  );
}

function RundownItem({ item, isLast, colors }: { item: PlanItem; isLast: boolean; colors: ThemeColors }) {
  const isHeader = item.itemType === 'header';

  if (isHeader) {
    return (
      <View style={[styles.headerItem, !isLast && styles.itemBorder]}>
        <Text style={[styles.headerItemText, { color: colors.accent }]}>{item.title}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.rundownItem, { backgroundColor: colors.surface, borderColor: colors.border }, !isLast && styles.itemBorder]}>
      <View style={styles.itemLeft}>
        <ItemTypeIcon type={item.itemType} colors={colors} />
      </View>
      <View style={styles.itemContent}>
        <Text style={[styles.itemTitle, { color: colors.text }]}>{item.title}</Text>
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
    </View>
  );
}

function ItemTypeIcon({ type, colors }: { type: string; colors: ThemeColors }) {
  let icon: string;
  let iconColor = colors.textSecondary;

  switch (type) {
    case 'song':
      icon = 'musical-notes-outline';
      iconColor = colors.accent;
      break;
    case 'media':
      icon = 'videocam-outline';
      iconColor = colors.info;
      break;
    case 'item':
      icon = 'document-text-outline';
      break;
    default:
      icon = 'ellipse-outline';
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
  },
  itemKey: {
    fontSize: fontSize.xs,
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
