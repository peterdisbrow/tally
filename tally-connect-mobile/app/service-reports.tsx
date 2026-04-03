import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, ActivityIndicator,
} from 'react-native';
import { api } from '../src/api/client';
import { useThemeColors } from '../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';

interface ServiceReport {
  id: string;
  date: string;
  name?: string;
  grade?: string;
  duration?: number;
  incidents?: number;
}

export default function ServiceReportsScreen() {
  const [reports, setReports] = useState<ServiceReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const colors = useThemeColors();

  const load = () => {
    setLoading(true);
    setError(false);
    api<{ reports: ServiceReport[] }>('/api/church/service-reports')
      .then((d) => setReports(d.reports || []))
      .catch((err) => {
        console.error('Failed to load service reports:', err);
        setError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  function gradeColor(grade?: string): string {
    if (!grade) return colors.textMuted;
    if (grade.startsWith('A')) return colors.online;
    if (grade.startsWith('B')) return colors.accentLight;
    if (grade.startsWith('C')) return colors.warning;
    return colors.critical;
  }

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, marginTop: 12 }}>Loading service reports...</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      data={reports}
      keyExtractor={(r) => r.id}
      contentContainerStyle={{ padding: spacing.lg }}
      renderItem={({ item }) => (
        <View style={{
          backgroundColor: colors.surface,
          borderRadius: borderRadius.md,
          padding: spacing.lg,
          marginBottom: spacing.md,
          borderWidth: 1,
          borderColor: colors.border,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm }}>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>
              {new Date(item.date).toLocaleDateString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
              })}
            </Text>
            <Text style={{ fontSize: fontSize.xl, fontWeight: '800', color: gradeColor(item.grade) }}>
              {item.grade || '--'}
            </Text>
          </View>
          <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, marginBottom: spacing.sm }}>{item.name || 'Service'}</Text>
          <View style={{ flexDirection: 'row', gap: spacing.lg }}>
            {item.duration != null && (
              <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>
                {Math.floor(item.duration / 3600)}h {Math.floor((item.duration % 3600) / 60)}m
              </Text>
            )}
            {item.incidents != null && (
              <Text style={[{ fontSize: fontSize.sm, color: colors.textSecondary }, item.incidents > 0 && { color: colors.warning }]}>
                {item.incidents} incident{item.incidents !== 1 ? 's' : ''}
              </Text>
            )}
          </View>
        </View>
      )}
      ListEmptyComponent={
        <View style={{ paddingVertical: 60, alignItems: 'center', paddingHorizontal: 32 }}>
          {error ? (
            <>
              <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 8 }}>Failed to Load Reports</Text>
              <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center', marginBottom: 16 }}>Could not fetch service reports.</Text>
              <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.accent }} onPress={load}>Try Again</Text>
            </>
          ) : (
            <Text style={{ fontSize: fontSize.md, color: colors.textMuted }}>No service reports yet</Text>
          )}
        </View>
      }
    />
  );
}
