import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api } from '../src/api/client';
import { useThemeColors } from '../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';

interface AnalyticsData {
  totalServices?: number;
  avgGrade?: string;
  avgHealthScore?: number;
  totalAlerts?: number;
  totalIncidents?: number;
  uptimePercent?: number;
  streamHours?: number;
}

type DateRange = 7 | 30 | 90;

const DATE_RANGE_LABELS: { value: DateRange; label: string }[] = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

/** Returns an up/down/neutral trend icon based on a simple threshold. */
function trendIcon(value: number | undefined, good: 'high' | 'low', threshold: number): { name: 'trending-up' | 'trending-down' | 'remove'; color: 'online' | 'critical' | 'textMuted' } {
  if (value == null) return { name: 'remove', color: 'textMuted' };
  const isGood = good === 'high' ? value >= threshold : value <= threshold;
  return isGood
    ? { name: 'trending-up', color: 'online' }
    : { name: 'trending-down', color: 'critical' };
}

export default function AnalyticsScreen() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [days, setDays] = useState<DateRange>(30);
  const colors = useThemeColors();

  const load = (signal?: AbortSignal, selectedDays = days) => {
    setLoading(true);
    setError(false);
    api<AnalyticsData>(`/api/church/analytics?days=${selectedDays}`, { signal })
      .then(setData)
      .catch((err) => {
        if (err.name === 'AbortError') return;
        console.error('Failed to load analytics:', err);
        setError(true);
      })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  };

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal, days);
    return () => controller.abort();
  }, [days]);

  function gradeColor(grade?: string): string | undefined {
    if (!grade) return undefined;
    if (grade.startsWith('A')) return colors.online;
    if (grade.startsWith('B')) return colors.accentLight;
    if (grade.startsWith('C')) return colors.warning;
    return colors.critical;
  }

  const DateRangePicker = () => (
    <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xxl }}>
      {DATE_RANGE_LABELS.map(({ value, label }) => {
        const active = days === value;
        return (
          <Pressable
            key={label}
            onPress={() => {
              Haptics.selectionAsync();
              setDays(value);
            }}
            style={{
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              minHeight: 44,
              justifyContent: 'center',
              borderRadius: borderRadius.full,
              borderWidth: 1,
              borderColor: active ? colors.accent : colors.border,
              backgroundColor: active ? `${colors.accent}20` : colors.surface,
            }}
          >
            <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: active ? colors.accent : colors.textSecondary }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, marginTop: 12 }}>Loading analytics...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: spacing.lg }}>
        <DateRangePicker />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxxl }}>
          <Ionicons name="cloud-offline-outline" size={48} color={colors.critical} />
          <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: spacing.lg, marginBottom: spacing.sm }}>
            Failed to Load Analytics
          </Text>
          <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xxl }}>
            Could not fetch analytics data. Check your connection and try again.
          </Text>
          <Pressable
            onPress={() => load(undefined, days)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: colors.accent,
              borderRadius: borderRadius.md,
              paddingHorizontal: spacing.xxl,
              paddingVertical: spacing.md,
              gap: spacing.sm,
            }}
          >
            <Ionicons name="refresh" size={18} color="#ffffff" />
            <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: '#ffffff' }}>Try Again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (!data?.totalServices) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: spacing.lg }}>
        <DateRangePicker />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxxl }}>
          <Ionicons name="bar-chart-outline" size={48} color={colors.textMuted} />
          <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: spacing.lg, marginBottom: spacing.sm }}>
            No Analytics Data Yet
          </Text>
          <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center' }}>
            Service stats will appear here after your first service is logged.
          </Text>
        </View>
      </View>
    );
  }

  const healthTrend = trendIcon(data?.avgHealthScore, 'high', 80);
  const uptimeTrend = trendIcon(data?.uptimePercent, 'high', 95);
  const incidentTrend = trendIcon(data?.totalIncidents, 'low', 1);

  const stats: { label: string; value: string; color?: string; trendName?: 'trending-up' | 'trending-down' | 'remove'; trendColor?: string }[] = [
    { label: 'Total Services', value: `${data?.totalServices ?? 0}` },
    { label: 'Average Grade', value: data?.avgGrade || '--', color: gradeColor(data?.avgGrade) },
    {
      label: 'Health Score',
      value: data?.avgHealthScore != null ? `${Math.round(data.avgHealthScore)}%` : '--',
      trendName: healthTrend.name,
      trendColor: (colors as any)[healthTrend.color],
    },
    { label: 'Total Alerts', value: `${data?.totalAlerts ?? 0}` },
    {
      label: 'Incidents',
      value: `${data?.totalIncidents ?? 0}`,
      color: (data?.totalIncidents ?? 0) > 0 ? colors.warning : undefined,
      trendName: incidentTrend.name,
      trendColor: (colors as any)[incidentTrend.color],
    },
    {
      label: 'Uptime',
      value: data?.uptimePercent != null ? `${Math.round(data.uptimePercent)}%` : '--',
      trendName: uptimeTrend.name,
      trendColor: (colors as any)[uptimeTrend.color],
    },
    { label: 'Stream Hours', value: data?.streamHours != null ? `${Math.round(data.streamHours)}h` : '--' },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg }}>
      <DateRangePicker />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
        {stats.map((s) => (
          <View key={s.label} style={{
            width: '47%',
            backgroundColor: colors.surface,
            borderRadius: borderRadius.md,
            padding: spacing.lg,
            borderWidth: 1,
            borderColor: colors.border,
          }}>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.sm }}>{s.label}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Text style={[{ fontSize: fontSize.xxl, fontWeight: '800', color: colors.text }, s.color ? { color: s.color } : {}]}>
                {s.value}
              </Text>
              {s.trendName && s.trendColor && (
                <Ionicons name={s.trendName} size={18} color={s.trendColor} />
              )}
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
