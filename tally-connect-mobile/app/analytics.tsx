import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

export default function AnalyticsScreen() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const colors = useThemeColors();

  const load = (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    api<AnalyticsData>('/api/church/analytics?days=30', { signal })
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
    load(controller.signal);
    return () => controller.abort();
  }, []);

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
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg, padding: 32 }}>
        <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 8 }}>Failed to Load Analytics</Text>
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', marginBottom: 24 }}>Could not fetch analytics data.</Text>
        <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.accent }} onPress={() => load()}>Try Again</Text>
      </View>
    );
  }

  if (!data?.totalServices) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg, padding: 32 }}>
        <Ionicons name="bar-chart-outline" size={48} color={colors.textMuted} />
        <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: 16, marginBottom: 8 }}>
          No Analytics Data Yet
        </Text>
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center' }}>
          Service stats will appear here after your first service is logged.
        </Text>
      </View>
    );
  }

  function gradeColor(grade?: string): string | undefined {
    if (!grade) return undefined;
    if (grade.startsWith('A')) return colors.online;
    if (grade.startsWith('B')) return colors.accentLight;
    if (grade.startsWith('C')) return colors.warning;
    return colors.critical;
  }

  const stats: { label: string; value: string; color?: string }[] = [
    { label: 'Total Services', value: `${data?.totalServices ?? 0}` },
    { label: 'Average Grade', value: data?.avgGrade || '--', color: gradeColor(data?.avgGrade) },
    { label: 'Health Score', value: data?.avgHealthScore != null ? `${Math.round(data.avgHealthScore)}%` : '--' },
    { label: 'Total Alerts', value: `${data?.totalAlerts ?? 0}` },
    { label: 'Incidents', value: `${data?.totalIncidents ?? 0}`, color: (data?.totalIncidents ?? 0) > 0 ? colors.warning : undefined },
    { label: 'Uptime', value: data?.uptimePercent != null ? `${Math.round(data.uptimePercent)}%` : '--' },
    { label: 'Stream Hours', value: data?.streamHours != null ? `${Math.round(data.streamHours)}h` : '--' },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.xxl, fontWeight: '700', color: colors.text, marginBottom: spacing.xxl }}>Last 30 Days</Text>
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
            <Text style={[{ fontSize: fontSize.xxl, fontWeight: '800', color: colors.text }, s.color ? { color: s.color } : {}]}>
              {s.value}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
