import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, ActivityIndicator,
} from 'react-native';
import { api } from '../src/api/client';
import { colors } from '../src/theme/colors';
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

  useEffect(() => {
    api<{ reports: ServiceReport[] }>('/api/church/service-reports')
      .then((d) => setReports(d.reports || []))
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

  return (
    <FlatList
      style={styles.container}
      data={reports}
      keyExtractor={(r) => r.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.date}>
              {new Date(item.date).toLocaleDateString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
              })}
            </Text>
            <Text style={[styles.grade, { color: gradeColor(item.grade) }]}>
              {item.grade || '--'}
            </Text>
          </View>
          <Text style={styles.name}>{item.name || 'Service'}</Text>
          <View style={styles.meta}>
            {item.duration != null && (
              <Text style={styles.metaText}>
                {Math.floor(item.duration / 3600)}h {Math.floor((item.duration % 3600) / 60)}m
              </Text>
            )}
            {item.incidents != null && (
              <Text style={[styles.metaText, item.incidents > 0 && { color: colors.warning }]}>
                {item.incidents} incident{item.incidents !== 1 ? 's' : ''}
              </Text>
            )}
          </View>
        </View>
      )}
      ListEmptyComponent={
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No service reports yet</Text>
        </View>
      }
    />
  );
}

function gradeColor(grade?: string): string {
  if (!grade) return colors.textMuted;
  if (grade.startsWith('A')) return colors.online;
  if (grade.startsWith('B')) return colors.accentLight;
  if (grade.startsWith('C')) return colors.warning;
  return colors.critical;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  list: { padding: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  date: { fontSize: fontSize.sm, color: colors.textSecondary },
  grade: { fontSize: fontSize.xl, fontWeight: '800' },
  name: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  meta: { flexDirection: 'row', gap: spacing.lg },
  metaText: { fontSize: fontSize.sm, color: colors.textSecondary },
  emptyContainer: { paddingVertical: 60, alignItems: 'center' },
  emptyText: { fontSize: fontSize.md, color: colors.textMuted },
});
