import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import { api } from '../src/api/client';
import { colors } from '../src/theme/colors';
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

  useEffect(() => {
    api<AnalyticsData>('/api/church/analytics?days=30')
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Last 30 Days</Text>
      <View style={styles.grid}>
        {stats.map((s) => (
          <View key={s.label} style={styles.statCard}>
            <Text style={styles.statLabel}>{s.label}</Text>
            <Text style={[styles.statValue, s.color ? { color: s.color } : {}]}>
              {s.value}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function gradeColor(grade?: string): string | undefined {
  if (!grade) return undefined;
  if (grade.startsWith('A')) return colors.online;
  if (grade.startsWith('B')) return colors.accentLight;
  if (grade.startsWith('C')) return colors.warning;
  return colors.critical;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.xxl,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  statCard: {
    width: '47%',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  statValue: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.text,
  },
});
