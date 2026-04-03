import React from 'react';
import { View, Text } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../theme/spacing';
import { GlassCard } from './GlassCard';
import type { DeviceStatus } from '../ws/types';

interface StreamStatsProps {
  status: DeviceStatus;
}

export function StreamStats({ status }: StreamStatsProps) {
  const colors = useThemeColors();
  const encoder = status.encoder || status.obs;
  const isStreaming = encoder?.streaming || status.atem?.streaming;
  const bitrate = encoder?.bitrate;
  const fps = encoder?.fps;

  const ytViewers = status.streamHealth?.youtube?.viewers;
  const fbViewers = status.streamHealth?.facebook?.viewers;
  const totalViewers = (ytViewers || 0) + (fbViewers || 0);

  return (
    <GlassCard glowColor={isStreaming ? colors.live : undefined}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' }}>STREAM</Text>
        <View style={{ paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: borderRadius.sm, backgroundColor: isStreaming ? colors.live : colors.surface }}>
          <Text style={{ fontSize: 10, fontWeight: '800', color: '#ffffff', letterSpacing: 1 }}>{isStreaming ? 'LIVE' : 'OFFLINE'}</Text>
        </View>
      </View>

      {isStreaming && (
        <>
          <View style={{ flexDirection: 'row', gap: spacing.xl }}>
            {bitrate != null && (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: fontSize.xl, fontWeight: '700', color: colors.text }}>{(bitrate / 1000).toFixed(1)}</Text>
                <Text style={{ fontSize: 9, color: colors.textSecondary, fontWeight: '600', letterSpacing: 0.5, marginTop: 2 }}>BITRATE</Text>
              </View>
            )}
            {fps != null && (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: fontSize.xl, fontWeight: '700', color: colors.text }}>{Math.round(fps)}</Text>
                <Text style={{ fontSize: 9, color: colors.textSecondary, fontWeight: '600', letterSpacing: 0.5, marginTop: 2 }}>FPS</Text>
              </View>
            )}
            {totalViewers > 0 && (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: fontSize.xl, fontWeight: '700', color: colors.text }}>{totalViewers.toLocaleString()}</Text>
                <Text style={{ fontSize: 9, color: colors.textSecondary, fontWeight: '600', letterSpacing: 0.5, marginTop: 2 }}>VIEWERS</Text>
              </View>
            )}
          </View>

          {(ytViewers != null || fbViewers != null) && (
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border }}>
              {ytViewers != null && (
                <View style={{ paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: borderRadius.sm, backgroundColor: colors.isDark ? 'rgba(239,68,68,0.15)' : 'rgba(220,38,38,0.1)' }}>
                  <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: colors.isDark ? '#ef4444' : '#dc2626' }}>YT: {ytViewers.toLocaleString()}</Text>
                </View>
              )}
              {fbViewers != null && (
                <View style={{ paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: borderRadius.sm, backgroundColor: colors.isDark ? 'rgba(59,130,246,0.15)' : 'rgba(37,99,235,0.1)' }}>
                  <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: colors.isDark ? '#3b82f6' : '#2563eb' }}>FB: {fbViewers.toLocaleString()}</Text>
                </View>
              )}
            </View>
          )}
        </>
      )}
    </GlassCard>
  );
}
