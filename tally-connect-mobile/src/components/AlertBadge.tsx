import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, borderRadius, fontSize } from '../theme/spacing';
import type { Alert } from '../ws/types';

interface AlertBadgeProps {
  alert: Alert;
  onPress?: () => void;
}

const SEVERITY_CONFIG = {
  EMERGENCY: { color: colors.emergency, icon: '!!!', bg: 'rgba(220, 38, 38, 0.15)' },
  CRITICAL: { color: colors.critical, icon: '!!', bg: 'rgba(239, 68, 68, 0.12)' },
  WARNING: { color: colors.warningAlert, icon: '!', bg: 'rgba(245, 158, 11, 0.10)' },
  INFO: { color: colors.infoAlert, icon: 'i', bg: 'rgba(59, 130, 246, 0.10)' },
};

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
  const config = SEVERITY_CONFIG[alert.severity] || SEVERITY_CONFIG.INFO;

  return (
    <Pressable onPress={onPress}>
      <View style={[styles.container, { backgroundColor: config.bg }]}>
        <View style={styles.header}>
          <View style={[styles.badge, { backgroundColor: config.color }]}>
            <Text style={styles.badgeText}>{alert.severity}</Text>
          </View>
          <Text style={styles.time}>{timeAgo(alert.timestamp)}</Text>
        </View>
        <Text style={styles.message}>{alert.message}</Text>
        {alert.roomName ? (
          <Text style={styles.room}>{alert.roomName}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.white,
    letterSpacing: 0.5,
  },
  time: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  message: {
    fontSize: fontSize.md,
    color: colors.text,
    lineHeight: 20,
  },
  room: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
});
