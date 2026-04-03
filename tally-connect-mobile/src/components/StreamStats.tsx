import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, borderRadius, fontSize } from '../theme/spacing';
import { GlassCard } from './GlassCard';
import type { DeviceStatus } from '../ws/types';

interface StreamStatsProps {
  status: DeviceStatus;
}

export function StreamStats({ status }: StreamStatsProps) {
  const encoder = status.encoder || status.obs;
  const isStreaming = encoder?.streaming || status.atem?.streaming;
  const bitrate = encoder?.bitrate;
  const fps = encoder?.fps;

  const ytViewers = status.streamHealth?.youtube?.viewers;
  const fbViewers = status.streamHealth?.facebook?.viewers;
  const totalViewers = (ytViewers || 0) + (fbViewers || 0);

  return (
    <GlassCard glowColor={isStreaming ? colors.live : undefined}>
      <View style={styles.header}>
        <Text style={styles.title}>STREAM</Text>
        <View style={[styles.liveTag, { backgroundColor: isStreaming ? colors.live : colors.surface }]}>
          <Text style={styles.liveText}>{isStreaming ? 'LIVE' : 'OFFLINE'}</Text>
        </View>
      </View>

      {isStreaming && (
        <>
          <View style={styles.statsRow}>
            {bitrate != null && (
              <View style={styles.stat}>
                <Text style={styles.statValue}>{(bitrate / 1000).toFixed(1)}</Text>
                <Text style={styles.statLabel}>BITRATE</Text>
              </View>
            )}
            {fps != null && (
              <View style={styles.stat}>
                <Text style={styles.statValue}>{Math.round(fps)}</Text>
                <Text style={styles.statLabel}>FPS</Text>
              </View>
            )}
            {totalViewers > 0 && (
              <View style={styles.stat}>
                <Text style={styles.statValue}>{totalViewers.toLocaleString()}</Text>
                <Text style={styles.statLabel}>VIEWERS</Text>
              </View>
            )}
          </View>

          {(ytViewers != null || fbViewers != null) && (
            <View style={styles.platforms}>
              {ytViewers != null && (
                <View style={[styles.platformTag, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
                  <Text style={[styles.platformTagText, { color: '#ef4444' }]}>YT: {ytViewers.toLocaleString()}</Text>
                </View>
              )}
              {fbViewers != null && (
                <View style={[styles.platformTag, { backgroundColor: 'rgba(59,130,246,0.15)' }]}>
                  <Text style={[styles.platformTagText, { color: '#3b82f6' }]}>FB: {fbViewers.toLocaleString()}</Text>
                </View>
              )}
            </View>
          )}
        </>
      )}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  title: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  liveTag: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: borderRadius.sm,
  },
  liveText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.white,
    letterSpacing: 1,
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.xl,
  },
  stat: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
  },
  statLabel: {
    fontSize: 9,
    color: colors.textSecondary,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  platforms: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  platformTag: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: borderRadius.sm,
  },
  platformTagText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
});
