import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, RefreshControl, Pressable, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAlertStore } from '../../src/stores/alertStore';
import { AlertBadge } from '../../src/components/AlertBadge';
import { useThemeColors } from '../../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import type { Alert } from '../../src/ws/types';

type SeverityFilter = 'ALL' | 'EMERGENCY' | 'CRITICAL' | 'WARNING' | 'INFO';

export default function AlertsScreen() {
  const alerts = useAlertStore((s) => s.alerts);
  const isLoading = useAlertStore((s) => s.isLoading);
  const fetchAlerts = useAlertStore((s) => s.fetchAlerts);
  const markAllRead = useAlertStore((s) => s.markAllRead);
  const dismissAlert = useAlertStore((s) => s.dismissAlert);
  const acknowledgeAlert = useAlertStore((s) => s.acknowledgeAlert);
  const [filter, setFilter] = useState<SeverityFilter>('ALL');
  const [error, setError] = useState<string | null>(null);
  const colors = useThemeColors();

  const FILTER_COLORS: Record<SeverityFilter, string> = {
    ALL: colors.accent,
    EMERGENCY: colors.emergency,
    CRITICAL: colors.critical,
    WARNING: colors.warningAlert,
    INFO: colors.infoAlert,
  };

  const loadAlerts = useCallback(() => {
    setError(null);
    fetchAlerts()
      .then(() => {
        setTimeout(() => markAllRead(), 1500);
      })
      .catch(() => {
        setError('Could not load alerts. Tap to retry.');
      });
  }, [fetchAlerts, markAllRead]);

  useEffect(() => {
    loadAlerts();
  }, []);

  useEffect(() => {
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
    <View style={{ marginBottom: spacing.sm }}>
      <AlertBadge
        alert={item}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          acknowledgeAlert(item.id);
        }}
      />
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm, paddingTop: 4, paddingHorizontal: 4 }}>
        {!item.acknowledged && (
          <Pressable
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              minHeight: 44,
              justifyContent: 'center',
              borderRadius: borderRadius.sm,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
            }}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              acknowledgeAlert(item.id);
            }}
          >
            <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '600' }}>Acknowledge</Text>
          </Pressable>
        )}
        {item.acknowledged && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="checkmark-circle" size={14} color={colors.online} />
            <Text style={{ fontSize: fontSize.xs, color: colors.online, fontWeight: '600' }}>Acknowledged</Text>
          </View>
        )}
        <Pressable
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
            justifyContent: 'center',
            alignItems: 'center',
          }}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            dismissAlert(item.id);
          }}
        >
          <Ionicons name="close" size={16} color={colors.textMuted} />
        </Pressable>
      </View>
    </View>
  ), [acknowledgeAlert, dismissAlert, colors]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm }}>
        {filterButtons.map((f) => {
          const isActive = filter === f;
          const filterColor = FILTER_COLORS[f];
          return (
            <Pressable
              key={f}
              style={[
                {
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm,
                  minHeight: 44,
                  justifyContent: 'center',
                  borderRadius: borderRadius.full,
                  backgroundColor: colors.surface,
                  borderWidth: 1,
                  borderColor: colors.border,
                },
                isActive && {
                  backgroundColor: `${filterColor}20`,
                  borderColor: filterColor,
                },
              ]}
              onPress={() => {
                Haptics.selectionAsync();
                setFilter(f);
              }}
            >
              <Text style={[
                { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '600' },
                isActive && { color: filterColor },
              ]}>
                {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error && (
        <Pressable
          onPress={loadAlerts}
          style={{
            marginHorizontal: spacing.lg,
            marginBottom: spacing.sm,
            padding: spacing.md,
            borderRadius: borderRadius.sm,
            backgroundColor: `${colors.critical}20`,
            borderWidth: 1,
            borderColor: colors.critical,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
          }}
        >
          <Ionicons name="alert-circle-outline" size={16} color={colors.critical} />
          <Text style={{ flex: 1, fontSize: fontSize.sm, color: colors.critical }}>{error}</Text>
          <Ionicons name="refresh-outline" size={16} color={colors.critical} />
        </Pressable>
      )}

      <FlatList
        data={filtered}
        keyExtractor={(item, idx) => item.id || `${item.timestamp}-${idx}`}
        renderItem={renderAlert}
        contentContainerStyle={{ padding: spacing.lg }}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={loadAlerts}
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <Ionicons name="notifications-outline" size={36} color={colors.textMuted} style={{ marginBottom: spacing.md }} />
            <Text style={{ fontSize: fontSize.md, color: colors.textMuted }}>
              {isLoading ? 'Loading alerts...' : 'No alerts'}
            </Text>
          </View>
        }
      />
    </View>
  );
}
