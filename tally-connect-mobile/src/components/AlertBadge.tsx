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
  EMERGENCY: { color: colors.emergency, bg: 'rgba(220, 38, 38, 0.15)', emoji: '🚨' },
  CRITICAL: { color: colors.critical, bg: 'rgba(239, 68, 68, 0.12)', emoji: '⚠️' },
  WARNING: { color: colors.warningAlert, bg: 'rgba(245, 158, 11, 0.10)', emoji: '⚡' },
  INFO: { color: colors.infoAlert, bg: 'rgba(59, 130, 246, 0.10)', emoji: 'ℹ️' },
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
      <View style={[
        styles.container,
        {
          backgroundColor: config.bg,
          borderLeftColor: config.color,
          shadowColor: config.color,
          shadowOpacity: 0.15,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        },
      ]}>
        <View style={styles.header}>
          <View style={styles.badgeRow}>
            <Text style={styles.emoji}>{config.emoji}</Text>
            <View style={[styles.badge, { backgroundColor: config.color }]}>
              <Text style={styles.badgeText}>{alert.severity}</Text>
            </View>
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
    borderTopLeftRadius: 4,
    borderTopRightRadius: borderRadius.lg,
    borderBottomRightRadius: borderRadius.lg,
    borderBottomLeftRadius: 4,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderLeftWidth: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  emoji: {
    fontSize: 14,
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
