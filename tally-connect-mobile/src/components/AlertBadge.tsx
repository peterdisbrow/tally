import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useThemeColors, type ThemeColors } from '../theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../theme/spacing';
import type { Alert } from '../ws/types';

interface AlertBadgeProps {
  alert: Alert;
  onPress?: () => void;
}

function getSeverityConfig(colors: ThemeColors) {
  return {
    EMERGENCY: { color: colors.emergency, bg: colors.isDark ? 'rgba(220, 38, 38, 0.15)' : 'rgba(220, 38, 38, 0.08)', icon: 'alarm-light-outline' as const, lib: 'mci' as const },
    CRITICAL: { color: colors.critical, bg: colors.isDark ? 'rgba(239, 68, 68, 0.12)' : 'rgba(220, 38, 38, 0.06)', icon: 'warning-outline' as const, lib: 'ion' as const },
    WARNING: { color: colors.warningAlert, bg: colors.isDark ? 'rgba(245, 158, 11, 0.10)' : 'rgba(217, 119, 6, 0.06)', icon: 'flash-outline' as const, lib: 'ion' as const },
    INFO: { color: colors.infoAlert, bg: colors.isDark ? 'rgba(59, 130, 246, 0.10)' : 'rgba(37, 99, 235, 0.06)', icon: 'information-circle-outline' as const, lib: 'ion' as const },
  };
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AlertBadge({ alert, onPress }: AlertBadgeProps) {
  const colors = useThemeColors();
  const severityConfig = getSeverityConfig(colors);
  const config = severityConfig[alert.severity] || severityConfig.INFO;

  return (
    <Pressable onPress={onPress}>
      <View style={[
        {
          borderTopLeftRadius: 4,
          borderTopRightRadius: borderRadius.lg,
          borderBottomRightRadius: borderRadius.lg,
          borderBottomLeftRadius: 4,
          padding: spacing.lg,
          marginBottom: spacing.sm,
          borderLeftWidth: 3,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: config.bg,
          borderLeftColor: config.color,
          shadowColor: config.color,
          shadowOpacity: colors.isDark ? 0.15 : 0.08,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        },
      ]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            {config.lib === 'mci'
              ? <MaterialCommunityIcons name={config.icon as any} size={14} color={config.color} />
              : <Ionicons name={config.icon as any} size={14} color={config.color} />}
            <View style={{ backgroundColor: config.color, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.sm }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: '#ffffff', letterSpacing: 0.5 }}>{alert.severity}</Text>
            </View>
          </View>
          <Text style={{ fontSize: fontSize.xs, color: colors.textMuted }}>{timeAgo(alert.timestamp)}</Text>
        </View>
        <Text style={{ fontSize: fontSize.md, color: colors.text, lineHeight: 20 }}>{alert.message}</Text>
        {alert.roomName ? (
          <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginTop: spacing.xs }}>{alert.roomName}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}
