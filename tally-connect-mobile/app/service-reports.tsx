import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, FlatList, ActivityIndicator, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

type SortField = 'date' | 'grade';
type SortDir = 'asc' | 'desc';
type DateRange = 30 | 90 | 365 | 0; // 0 = all time

const GRADE_ORDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];

function gradeScore(grade?: string): number {
  if (!grade) return GRADE_ORDER.length;
  const idx = GRADE_ORDER.indexOf(grade);
  return idx === -1 ? GRADE_ORDER.length : idx;
}

export default function ServiceReportsScreen() {
  const [reports, setReports] = useState<ServiceReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [dateRange, setDateRange] = useState<DateRange>(30);
  const colors = useThemeColors();

  const load = (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    api<{ reports: ServiceReport[] }>('/api/church/service-reports', { signal })
      .then((d) => setReports(d.reports || []))
      .catch((err) => {
        if (err.name === 'AbortError') return;
        console.error('Failed to load service reports:', err);
        setError(true);
      })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  };

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, []);

  function gradeColor(grade?: string): string {
    if (!grade) return colors.textMuted;
    if (grade.startsWith('A')) return colors.online;
    if (grade.startsWith('B')) return colors.accentLight;
    if (grade.startsWith('C')) return colors.warning;
    return colors.critical;
  }

  const filtered = useMemo(() => {
    let result = reports;
    if (dateRange > 0) {
      const cutoff = Date.now() - dateRange * 24 * 60 * 60 * 1000;
      result = result.filter((r) => new Date(r.date).getTime() >= cutoff);
    }
    return [...result].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'date') {
        cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
      } else {
        cmp = gradeScore(a.grade) - gradeScore(b.grade);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [reports, sortField, sortDir, dateRange]);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'date' ? 'desc' : 'asc');
    }
  }

  const DATE_RANGE_LABELS: { value: DateRange; label: string }[] = [
    { value: 30, label: '30d' },
    { value: 90, label: '90d' },
    { value: 365, label: '1yr' },
    { value: 0, label: 'All' },
  ];

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, marginTop: 12 }}>Loading service reports...</Text>
      </View>
    );
  }

  function SortButton({ field, label }: { field: SortField; label: string }) {
    const active = sortField === field;
    return (
      <Pressable
        onPress={() => toggleSort(field)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          minHeight: 44,
          justifyContent: 'center',
          borderRadius: borderRadius.full,
          borderWidth: 1,
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active ? `${colors.accent}20` : colors.surface,
          gap: 4,
        }}
      >
        <Text style={{ fontSize: fontSize.xs, fontWeight: '600', color: active ? colors.accent : colors.textSecondary }}>
          {label}
        </Text>
        {active && (
          <Ionicons
            name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'}
            size={12}
            color={colors.accent}
          />
        )}
      </Pressable>
    );
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      data={filtered}
      keyExtractor={(r) => r.id}
      contentContainerStyle={{ padding: spacing.lg }}
      ListHeaderComponent={(
        <View style={{ marginBottom: spacing.lg }}>
          {/* Date range filter */}
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm }}>
            {DATE_RANGE_LABELS.map(({ value, label }) => {
              const active = dateRange === value;
              return (
                <Pressable
                  key={label}
                  onPress={() => setDateRange(value)}
                  style={{
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                    minHeight: 44,
                    justifyContent: 'center',
                    borderRadius: borderRadius.full,
                    borderWidth: 1,
                    borderColor: active ? colors.accent : colors.border,
                    backgroundColor: active ? `${colors.accent}20` : colors.surface,
                  }}
                >
                  <Text style={{ fontSize: fontSize.xs, fontWeight: '600', color: active ? colors.accent : colors.textSecondary }}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Sort controls */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, marginRight: 2 }}>Sort:</Text>
            <SortButton field="date" label="Date" />
            <SortButton field="grade" label="Grade" />
          </View>
        </View>
      )}
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
              <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.accent }} onPress={() => load()}>Try Again</Text>
            </>
          ) : (
            <Text style={{ fontSize: fontSize.md, color: colors.textMuted }}>
              {dateRange > 0 ? `No reports in the last ${dateRange} days` : 'No service reports yet'}
            </Text>
          )}
        </View>
      }
    />
  );
}
