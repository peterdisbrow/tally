import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, RefreshControl, Pressable, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAlertStore } from '../../src/stores/alertStore';
import { AlertBadge } from '../../src/components/AlertBadge';
import { colors } from '../../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import type { Alert } from '../../src/ws/types';

type SeverityFilter = 'ALL' | 'EMERGENCY' | 'CRITICAL' | 'WARNING' | 'INFO';

const FILTER_COLORS: Record<SeverityFilter, string> = {
  ALL: colors.accent,
  EMERGENCY: colors.emergency,
  CRITICAL: colors.critical,
  WARNING: colors.warningAlert,
  INFO: colors.infoAlert,
};

export default function AlertsScreen() {
  const alerts = useAlertStore((s) => s.alerts);
  const isLoading = useAlertStore((s) => s.isLoading);
  const fetchAlerts = useAlertStore((s) => s.fetchAlerts);
  const markAllRead = useAlertStore((s) => s.markAllRead);
  const dismissAlert = useAlertStore((s) => s.dismissAlert);
  const acknowledgeAlert = useAlertStore((s) => s.acknowledgeAlert);
  const [filter, setFilter] = useState<SeverityFilter>('ALL');

  useEffect(() => {
    fetchAlerts();
    markAllRead();
  }, []);

  // Mark alerts as read when screen mounts or app returns to foreground
  useEffect(() => {
    markAllRead();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') markAllRead();
    });
    return () => sub.remove();
  }, [markAllRead]);

  const filtered = filter === 'ALL'
    ? alerts
    : alerts.filter((a) => a.severity === filter);

  const filterButtons: SeverityFilter[] = ['ALL', 'EMERGENCY', 'CRITICAL', 'WARNING', 'INFO'];

  const renderAlert = useCallback(({ item }: { item: Alert }) => (
    <View style={alertCardStyles.wrapper}>
      <AlertBadge alert={item} onPress={() => acknowledgeAlert(item.id)} />
      <View style={alertCardStyles.actions}>
        {!item.acknowledged && (
          <Pressable
            style={alertCardStyles.ackButton}
            onPress={() => acknowledgeAlert(item.id)}
          >
            <Text style={alertCardStyles.ackText}>Acknowledge</Text>
          </Pressable>
        )}
        {item.acknowledged && (
          <View style={alertCardStyles.ackedRow}>
            <Ionicons name="checkmark-circle" size={14} color={colors.online} />
            <Text style={alertCardStyles.ackedLabel}>Acknowledged</Text>
          </View>
        )}
        <Pressable
          style={alertCardStyles.dismissButton}
          onPress={() => dismissAlert(item.id)}
        >
          <Ionicons name="close" size={16} color={colors.textMuted} />
        </Pressable>
      </View>
    </View>
  ), [acknowledgeAlert, dismissAlert]);

  return (
    <View style={styles.container}>
      {/* Filter bar */}
      <View style={styles.filterBar}>
        {filterButtons.map((f) => {
          const isActive = filter === f;
          const filterColor = FILTER_COLORS[f];
          return (
            <Pressable
              key={f}
              style={[
                styles.filterButton,
                isActive && {
                  backgroundColor: `${filterColor}20`,
                  borderColor: filterColor,
                },
              ]}
              onPress={() => setFilter(f)}
            >
              <Text style={[
                styles.filterText,
                isActive && { color: filterColor },
              ]}>
                {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item, idx) => item.id || `${item.timestamp}-${idx}`}
        renderItem={renderAlert}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={fetchAlerts}
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="notifications-outline" size={36} color={colors.textMuted} style={{ marginBottom: spacing.md }} />
            <Text style={styles.emptyText}>
              {isLoading ? 'Loading alerts...' : 'No alerts'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  filterButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  list: {
    padding: spacing.lg,
  },
  empty: {
    paddingVertical: 60,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: fontSize.md,
    color: colors.textMuted,
  },
});

const alertCardStyles = StyleSheet.create({
  wrapper: {
    marginBottom: spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: 4,
    paddingHorizontal: 4,
  },
  ackButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ackText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  ackedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ackedLabel: {
    fontSize: fontSize.xs,
    color: colors.online,
    fontWeight: '600',
  },
  dismissButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
