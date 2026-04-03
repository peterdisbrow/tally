import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, RefreshControl,
  TouchableOpacity, Animated, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStatusStore, useActiveRoomStatus } from '../../src/stores/statusStore';
import { useThemeColors, type ThemeColors } from '../../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { api } from '../../src/api/client';
import { usePolling } from '../../src/hooks/usePolling';
import type { DeviceStatus } from '../../src/ws/types';

interface CheckItem {
  name: string;
  pass: boolean;
  detail: string;
}

interface PreServiceResult {
  id?: number;
  church_id?: string;
  pass: number | boolean;
  checks_json: string | CheckItem[];
  trigger_type?: string;
  created_at?: string;
  instance_name?: string;
  room_id?: string;
}

interface RundownStatus {
  active: boolean;
  overall_status?: 'pass' | 'warn' | 'fail';
  checks_json?: string | Record<string, RundownCategory>;
  ai_summary?: string;
  service_time?: string;
  confirmation?: { confirmedAt: string; confirmedBy: string } | null;
  escalation_level?: number;
}

interface RundownCategory {
  status: 'pass' | 'warn' | 'fail';
  items: CheckItem[];
}

type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';

interface DisplayCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  category?: string;
}

const CATEGORY_ORDER = [
  'devices', 'stream', 'presentation', 'audio', 'network', 'companion', 'versions',
] as const;

const CATEGORY_ICONS: Record<string, string> = {
  devices: 'videocam-outline',
  stream: 'cloud-upload-outline',
  presentation: 'easel-outline',
  audio: 'volume-high-outline',
  network: 'wifi-outline',
  companion: 'game-controller-outline',
  versions: 'git-branch-outline',
  general: 'checkmark-circle-outline',
};

const CATEGORY_LABELS: Record<string, string> = {
  devices: 'Devices & Switching',
  stream: 'Streaming & Encoding',
  presentation: 'Presentation',
  audio: 'Audio',
  network: 'Network',
  companion: 'Companion',
  versions: 'Software Versions',
  general: 'General',
};

function statusColor(status: CheckStatus, colors: ThemeColors): string {
  switch (status) {
    case 'pass': return colors.online;
    case 'fail': return colors.offline;
    case 'warn': return colors.warning;
    default: return colors.textMuted;
  }
}

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'pass': return 'checkmark-circle';
    case 'fail': return 'close-circle';
    case 'warn': return 'warning';
    default: return 'help-circle-outline';
  }
}

function overallStatusFromChecks(checks: DisplayCheck[]): CheckStatus {
  if (checks.length === 0) return 'unknown';
  if (checks.some(c => c.status === 'fail')) return 'fail';
  if (checks.some(c => c.status === 'warn')) return 'warn';
  return 'pass';
}

function overallLabel(status: CheckStatus): string {
  switch (status) {
    case 'pass': return 'All Systems Go';
    case 'fail': return 'Issues Detected';
    case 'warn': return 'Warnings';
    default: return 'No Data';
  }
}

function classifyCheck(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('atem') || n.includes('camera') || n.includes('input') || n.includes('switcher')) return 'devices';
  if (n.includes('obs') || n.includes('vmix') || n.includes('stream') || n.includes('encoder')) return 'stream';
  if (n.includes('propresenter') || n.includes('resolume') || n.includes('presentation')) return 'presentation';
  if (n.includes('audio') || n.includes('mixer') || n.includes('mute') || n.includes('console')) return 'audio';
  if (n.includes('companion') || n.includes('button')) return 'companion';
  if (n.includes('network') || n.includes('relay') || n.includes('socket')) return 'network';
  if (n.includes('version') || n.includes('firmware') || n.includes('update')) return 'versions';
  return 'general';
}

function parseChecks(raw: string | CheckItem[]): CheckItem[] {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function parseRundownChecks(raw: string | Record<string, RundownCategory>): Record<string, RundownCategory> | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, RundownCategory>;
  try { return JSON.parse(raw); } catch { return null; }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function buildDisplayChecks(
  checkResult: PreServiceResult | null,
  rundown: RundownStatus | null,
  liveStatus: DeviceStatus | null,
): DisplayCheck[] {
  const items: DisplayCheck[] = [];

  if (rundown?.active && rundown.checks_json) {
    const categories = parseRundownChecks(rundown.checks_json);
    if (categories) {
      for (const [cat, data] of Object.entries(categories)) {
        for (const item of data.items) {
          items.push({
            name: item.name,
            status: item.pass ? 'pass' : (data.status === 'warn' ? 'warn' : 'fail'),
            detail: item.detail,
            category: cat,
          });
        }
      }
      return items;
    }
  }

  if (checkResult?.checks_json) {
    const checks = parseChecks(checkResult.checks_json);
    for (const check of checks) {
      items.push({
        name: check.name,
        status: check.pass ? 'pass' : 'fail',
        detail: check.detail,
        category: classifyCheck(check.name),
      });
    }
  }

  if (items.length === 0 && liveStatus) {
    if (liveStatus.atem) {
      items.push({ name: 'ATEM Connection', status: liveStatus.atem.connected ? 'pass' : 'fail', detail: liveStatus.atem.connected ? (liveStatus.atem.model || 'Connected') : 'Switcher offline', category: 'devices' });
    }
    if (liveStatus.obs) {
      items.push({ name: 'OBS Studio', status: liveStatus.obs.connected ? 'pass' : 'fail', detail: liveStatus.obs.connected ? (liveStatus.obs.streaming ? 'Streaming' : 'Connected, not streaming') : 'OBS offline', category: 'stream' });
    }
    if (liveStatus.vmix) {
      items.push({ name: 'vMix', status: liveStatus.vmix.connected ? 'pass' : 'fail', detail: liveStatus.vmix.connected ? (liveStatus.vmix.streaming ? 'Streaming' : 'Connected') : 'vMix offline', category: 'stream' });
    }
    if (liveStatus.propresenter) {
      items.push({ name: 'ProPresenter', status: liveStatus.propresenter.connected ? 'pass' : 'fail', detail: liveStatus.propresenter.connected ? (liveStatus.propresenter.currentPresentation || 'Ready') : 'ProPresenter offline', category: 'presentation' });
    }
    if (liveStatus.mixer) {
      const muted = liveStatus.mixer.mainMuted;
      items.push({ name: 'Audio Console', status: liveStatus.mixer.connected ? (muted ? 'warn' : 'pass') : 'fail', detail: liveStatus.mixer.connected ? (muted ? 'Main bus MUTED' : (liveStatus.mixer.model || 'Online')) : 'Mixer offline', category: 'audio' });
    }
    if (liveStatus.companion) {
      items.push({ name: 'Companion', status: liveStatus.companion.connected ? 'pass' : 'fail', detail: liveStatus.companion.connected ? 'Running' : 'Companion offline', category: 'companion' });
    }
    if (liveStatus.encoder) {
      items.push({ name: 'Encoder', status: liveStatus.encoder.connected ? 'pass' : 'fail', detail: liveStatus.encoder.connected ? (liveStatus.encoder.streaming ? 'Streaming' : 'Connected') : 'Encoder offline', category: 'stream' });
    }
  }

  return items;
}

function groupByCategory(checks: DisplayCheck[]): { key: string; label: string; icon: string; checks: DisplayCheck[] }[] {
  const allCategories = [...CATEGORY_ORDER, 'general'] as string[];
  return allCategories
    .map(cat => ({
      key: cat,
      label: CATEGORY_LABELS[cat] || cat,
      icon: CATEGORY_ICONS[cat] || 'checkmark-circle-outline',
      checks: checks.filter(c => c.category === cat),
    }))
    .filter(g => g.checks.length > 0);
}

function StatusRing({ status, size = 80, colors }: { status: CheckStatus; size?: number; colors: ThemeColors }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (status === 'fail' || status === 'warn') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [status]);

  const color = statusColor(status, colors);
  const iconName = status === 'pass' ? 'checkmark-circle' : status === 'fail' ? 'close-circle' : status === 'warn' ? 'warning' : 'help-circle-outline';

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 3,
        borderColor: color,
        opacity: pulseAnim,
      }} />
      <Ionicons name={iconName as any} size={size * 0.5} color={color} />
    </View>
  );
}

export default function PreServiceChecksScreen() {
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const rooms = useStatusStore((s) => s.rooms);
  const liveStatus = useActiveRoomStatus();
  const colors = useThemeColors();

  const [checkResult, setCheckResult] = useState<PreServiceResult | null>(null);
  const [rundown, setRundown] = useState<RundownStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetched, setLastFetched] = useState<string | null>(null);

  const roomQuery = activeRoomId ? `?roomId=${activeRoomId}` : '';

  const fetchData = useCallback(async () => {
    try {
      const [checkRes, rundownRes] = await Promise.all([
        api<PreServiceResult | null>(`/api/church/preservice-check${roomQuery}`).catch(() => null),
        api<RundownStatus>(`/api/church/rundown/status${roomQuery}`).catch(() => ({ active: false })),
      ]);
      setCheckResult(checkRes);
      setRundown(rundownRes);
      setLastFetched(new Date().toISOString());
    } catch (err) {
      console.error('Failed to fetch pre-service check data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [roomQuery]);

  useEffect(() => {
    setIsLoading(true);
    fetchData();
  }, [activeRoomId]);

  usePolling(fetchData, 30000);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const runManualCheck = useCallback(async () => {
    setIsRunning(true);
    try {
      const res = await api<{ result: PreServiceResult | null }>(`/api/church/preservice-check/run${roomQuery}`, { method: 'POST' });
      if (res?.result) {
        setCheckResult(res.result);
        setLastFetched(new Date().toISOString());
      }
      const rundownRes = await api<RundownStatus>(`/api/church/rundown/status${roomQuery}`).catch(() => null);
      if (rundownRes) setRundown(rundownRes);
    } catch (err) {
      console.error('Failed to run manual check:', err);
      Alert.alert('Check Failed', 'Could not run pre-service check. Please try again.');
    } finally {
      setIsRunning(false);
    }
  }, [roomQuery]);

  const displayChecks = buildDisplayChecks(checkResult, rundown, liveStatus);
  const grouped = groupByCategory(displayChecks);
  const overall = rundown?.active && rundown.overall_status
    ? rundown.overall_status as CheckStatus
    : overallStatusFromChecks(displayChecks);

  const roomName = rooms.find(r => r.id === activeRoomId)?.name || 'No Room';
  const checkTime = checkResult?.created_at ? timeAgo(checkResult.created_at) : null;
  const passCount = displayChecks.filter(c => c.status === 'pass').length;
  const failCount = displayChecks.filter(c => c.status === 'fail').length;
  const warnCount = displayChecks.filter(c => c.status === 'warn').length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg }}>
        <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>{roomName}</Text>
        {checkTime && <Text style={{ fontSize: fontSize.xs, color: colors.textMuted }}>Last check: {checkTime}</Text>}
      </View>

      <View style={{
        backgroundColor: colors.surface,
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: `${statusColor(overall, colors)}40`,
        padding: spacing.xl,
        marginBottom: spacing.lg,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
          <StatusRing status={isLoading ? 'unknown' : overall} colors={colors} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fontSize.xl, fontWeight: '800', color: statusColor(isLoading ? 'unknown' : overall, colors) }}>
              {isLoading ? 'Loading...' : overallLabel(overall)}
            </Text>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4 }}>
              {isLoading ? 'Fetching check results' : `${passCount} passed${warnCount > 0 ? ` \u00b7 ${warnCount} warning${warnCount !== 1 ? 's' : ''}` : ''}${failCount > 0 ? ` \u00b7 ${failCount} failed` : ''}`}
            </Text>
            {rundown?.active && rundown.confirmation && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm }}>
                <Ionicons name="shield-checkmark" size={12} color={colors.online} />
                <Text style={{ fontSize: fontSize.xs, color: colors.online, fontWeight: '600' }}>
                  Confirmed by {rundown.confirmation.confirmedBy}
                </Text>
              </View>
            )}
          </View>
        </View>

        {rundown?.active && rundown.ai_summary && (
          <View style={{ marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.sm }}>
              <Ionicons name="sparkles" size={14} color={colors.accent} />
              <Text style={{ fontSize: fontSize.xs, color: colors.accent, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }}>AI Summary</Text>
            </View>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 }}>{rundown.ai_summary}</Text>
          </View>
        )}
      </View>

      <TouchableOpacity
        style={[
          { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.accent, borderRadius: borderRadius.md, paddingVertical: spacing.md, marginBottom: spacing.xl },
          isRunning && { opacity: 0.6 },
        ]}
        onPress={runManualCheck}
        disabled={isRunning}
        activeOpacity={0.7}
      >
        {isRunning ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Ionicons name="refresh" size={18} color="#ffffff" />
        )}
        <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: '#ffffff' }}>
          {isRunning ? 'Running Checks...' : 'Run Check Now'}
        </Text>
      </TouchableOpacity>

      {isLoading ? (
        <View style={{ paddingVertical: spacing.xxxl * 2, alignItems: 'center', gap: spacing.md }}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={{ fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center' }}>Loading pre-service checks...</Text>
        </View>
      ) : displayChecks.length === 0 ? (
        <View style={{ paddingVertical: spacing.xxxl * 2, alignItems: 'center', gap: spacing.md }}>
          <Ionicons name="clipboard-outline" size={48} color={colors.textMuted} />
          <Text style={{ fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center' }}>No check data available</Text>
          <Text style={{ fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' }}>Tap "Run Check Now" to check readiness</Text>
        </View>
      ) : (
        grouped.map(group => (
          <View key={group.key} style={{ marginBottom: spacing.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
              <Ionicons name={group.icon as any} size={16} color={colors.textSecondary} />
              <Text style={{ flex: 1, fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '600' }}>{group.label}</Text>
              <CategoryBadge checks={group.checks} colors={colors} />
            </View>
            {group.checks.map((check, i) => (
              <View key={`${group.key}-${i}`} style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: spacing.md,
                backgroundColor: colors.surface,
                borderRadius: borderRadius.md,
                borderWidth: 1,
                borderColor: colors.border,
                padding: spacing.md,
                marginBottom: spacing.xs,
              }}>
                <Ionicons
                  name={statusIcon(check.status) as any}
                  size={20}
                  color={statusColor(check.status, colors)}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.text }}>{check.name}</Text>
                  <Text style={{ fontSize: fontSize.sm, color: check.status === 'fail' ? colors.offline : colors.textSecondary, marginTop: 2 }}>
                    {check.detail}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ))
      )}

      <View style={{ height: spacing.xxxl }} />
    </ScrollView>
  );
}

function CategoryBadge({ checks, colors }: { checks: DisplayCheck[]; colors: ThemeColors }) {
  const allPass = checks.every(c => c.status === 'pass');
  const anyFail = checks.some(c => c.status === 'fail');
  const status: CheckStatus = anyFail ? 'fail' : allPass ? 'pass' : 'warn';
  const color = statusColor(status, colors);

  return (
    <View style={{ paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.full, backgroundColor: `${color}20` }}>
      <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color }}>
        {checks.filter(c => c.status === 'pass').length}/{checks.length}
      </Text>
    </View>
  );
}
