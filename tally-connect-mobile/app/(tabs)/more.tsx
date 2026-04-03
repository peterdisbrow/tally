import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, Alert, Linking,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useAuthStore } from '../../src/stores/authStore';
import { useStatusStore } from '../../src/stores/statusStore';
import { useChatStore } from '../../src/stores/chatStore';
import { useUpdateStore } from '../../src/stores/updateStore';
import { useNotificationStatus } from '../../src/hooks/useNotifications';
import { api } from '../../src/api/client';
import { useTheme, useThemeColors, type ThemePreference } from '../../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { GlassCard } from '../../src/components/GlassCard';
import type { ServiceSession } from '../../src/ws/types';

export default function MoreScreen() {
  const churchName = useAuthStore((s) => s.churchName);
  const email = useAuthStore((s) => s.email);
  const logout = useAuthStore((s) => s.logout);
  const activeRoomName = useStatusStore((s) => s.rooms.find((r) => r.id === s.activeRoomId)?.name);
  const { pushToken, permission } = useNotificationStatus();
  const updateReady = useUpdateStore((s) => s.updateReady);
  const setUpdateReady = useUpdateStore((s) => s.setUpdateReady);
  const [session, setSession] = useState<ServiceSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [reports, setReports] = useState<any[]>([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'up-to-date' | 'ready'>('idle');
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const colors = useThemeColors();
  const { preference, setPreference } = useTheme();

  const handleCheckForUpdate = useCallback(async () => {
    if (__DEV__) {
      Alert.alert('Dev Mode', 'OTA updates are not available in development builds.');
      return;
    }
    setUpdateChecking(true);
    setUpdateStatus('idle');
    try {
      const check = await Updates.checkForUpdateAsync();
      setLastChecked(new Date());
      if (check.isAvailable) {
        const result = await Updates.fetchUpdateAsync();
        if (result.isNew) {
          setUpdateReady(true);
          setUpdateStatus('ready');
        } else {
          setUpdateStatus('up-to-date');
        }
      } else {
        setUpdateStatus('up-to-date');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const channel = Updates.channel ?? 'none';
      const rtVersion = Updates.runtimeVersion ?? 'unknown';
      Alert.alert(
        'Update Check Failed',
        `${message}\n\nChannel: ${channel}\nRuntime: ${rtVersion}`,
      );
    } finally {
      setUpdateChecking(false);
    }
  }, [setUpdateReady]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    api<{ session: ServiceSession }>('/api/church/session/active', { signal })
      .then((d) => setSession(d.session || d as any))
      .catch((err) => { if (err.name !== 'AbortError') console.error('Failed to load active session:', err); })
      .finally(() => { if (!signal.aborted) setSessionLoading(false); });

    api<{ reports: any[] }>('/api/church/service-reports', { signal })
      .then((d) => setReports((d.reports || []).slice(0, 5)))
      .catch((err) => { if (err.name !== 'AbortError') console.error('Failed to load recent reports:', err); })
      .finally(() => { if (!signal.aborted) setReportsLoading(false); });

    return () => controller.abort();
  }, []);

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/login');
        },
      },
    ]);
  };

  const themeOptions: { value: ThemePreference; label: string; icon: string }[] = [
    { value: 'system', label: 'System', icon: 'phone-portrait-outline' },
    { value: 'light', label: 'Light', icon: 'sunny-outline' },
    { value: 'dark', label: 'Dark', icon: 'moon-outline' },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg }}>
      {/* Church Info */}
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: borderRadius.md,
        padding: spacing.lg,
        marginBottom: spacing.xxl,
        borderWidth: 1,
        borderColor: colors.border,
      }}>
        <View style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: 'rgba(34, 197, 94, 0.8)',
          justifyContent: 'center',
          alignItems: 'center',
          marginRight: spacing.lg,
          shadowColor: colors.accent,
          shadowOpacity: colors.cardShadowOpacity,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }}>
          <Text style={{ fontSize: fontSize.xl, fontWeight: '700', color: '#ffffff' }}>
            {(churchName || 'C')[0].toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>{churchName}</Text>
          <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 }}>{email}</Text>
        </View>
      </View>

      {/* Appearance */}
      <View style={{ marginBottom: spacing.xxl }}>
        <Text style={{
          fontSize: fontSize.xs,
          color: colors.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 1,
          fontWeight: '600',
          marginBottom: spacing.md,
        }}>APPEARANCE</Text>
        <View style={{
          flexDirection: 'row',
          backgroundColor: colors.surface,
          borderRadius: borderRadius.md,
          borderWidth: 1,
          borderColor: colors.border,
          overflow: 'hidden',
        }}>
          {themeOptions.map((opt) => {
            const isActive = preference === opt.value;
            return (
              <Pressable
                key={opt.value}
                style={{
                  flex: 1,
                  paddingVertical: spacing.md,
                  alignItems: 'center',
                  backgroundColor: isActive ? (colors.isDark ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.1)') : 'transparent',
                  borderRightWidth: opt.value !== 'dark' ? 1 : 0,
                  borderRightColor: colors.border,
                }}
                onPress={() => setPreference(opt.value)}
                accessibilityLabel={`Theme: ${opt.label}${isActive ? ', selected' : ''}`}
                accessibilityRole="radio"
              >
                <Ionicons
                  name={opt.icon as any}
                  size={20}
                  color={isActive ? colors.accent : colors.textMuted}
                />
                <Text style={{
                  fontSize: fontSize.xs,
                  fontWeight: '600',
                  color: isActive ? colors.accent : colors.textSecondary,
                  marginTop: 4,
                }}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Active Session */}
      {(sessionLoading || session?.active) && (
        <View style={{ marginBottom: spacing.xxl }}>
          <Text style={{
            fontSize: fontSize.xs,
            color: colors.textSecondary,
            textTransform: 'uppercase',
            letterSpacing: 1,
            fontWeight: '600',
            marginBottom: spacing.md,
          }}>ACTIVE SESSION</Text>
          {sessionLoading ? (
            <View style={{
              backgroundColor: colors.surface,
              borderRadius: borderRadius.md,
              padding: spacing.lg,
              borderWidth: 1,
              borderColor: colors.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
            }}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>Loading session...</Text>
            </View>
          ) : (
          <GlassCard glowColor={colors.accent}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm }}>
              <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Grade</Text>
              <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: gradeColor(session.grade, colors) }}>
                {session.grade || '--'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm }}>
              <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Duration</Text>
              <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.text }}>
                {session.duration ? formatDuration(session.duration) : '--'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm }}>
              <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Incidents</Text>
              <Text style={[
                { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
                session.incidents && session.incidents > 0 ? { color: colors.warning } : {},
              ]}>
                {session.incidents ?? 0}
              </Text>
            </View>
          </GlassCard>
          )}
        </View>
      )}

      {/* Recent Reports */}
      {(reportsLoading || reports.length > 0) && (
        <View style={{ marginBottom: spacing.xxl }}>
          <Text style={{
            fontSize: fontSize.xs,
            color: colors.textSecondary,
            textTransform: 'uppercase',
            letterSpacing: 1,
            fontWeight: '600',
            marginBottom: spacing.md,
          }}>RECENT SERVICES</Text>
          <View style={{
            backgroundColor: colors.surface,
            borderRadius: borderRadius.md,
            padding: spacing.lg,
            borderWidth: 1,
            borderColor: colors.border,
          }}>
            {reportsLoading ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm }}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>Loading recent services...</Text>
              </View>
            ) : reports.map((r, i) => (
              <View key={r.id || i} style={[
                { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.md },
                i < reports.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border },
              ]}>
                <View>
                  <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>
                    {r.date ? new Date(r.date).toLocaleDateString() : 'Unknown'}
                  </Text>
                  <Text style={{ fontSize: fontSize.md, color: colors.text, marginTop: 2 }}>{r.name || 'Service'}</Text>
                </View>
                <Text style={{ fontSize: fontSize.xl, fontWeight: '800', color: gradeColor(r.grade, colors) }}>
                  {r.grade || '--'}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Push Notification Status */}
      <View style={{ marginBottom: spacing.xxl }}>
        <Text style={{
          fontSize: fontSize.xs,
          color: colors.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 1,
          fontWeight: '600',
          marginBottom: spacing.md,
        }}>NOTIFICATIONS</Text>
        <View style={{
          backgroundColor: colors.surface,
          borderRadius: borderRadius.md,
          padding: spacing.lg,
          borderWidth: 1,
          borderColor: colors.border,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: fontSize.md, color: colors.text }}>Push Notifications</Text>
            <Text style={{
              fontSize: fontSize.md,
              fontWeight: '600',
              color: permission === 'granted' ? colors.online : colors.warning,
            }}>
              {permission === 'granted' ? 'Enabled' : permission === 'simulator' ? 'Simulator' : 'Not Enabled'}
            </Text>
          </View>
          {pushToken && (
            <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.sm }} numberOfLines={1}>
              Token: {pushToken.slice(0, 30)}...
            </Text>
          )}
        </View>
      </View>

      {/* App Updates */}
      <View style={{ marginBottom: spacing.xxl }}>
        <Text style={{
          fontSize: fontSize.xs,
          color: colors.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 1,
          fontWeight: '600',
          marginBottom: spacing.md,
        }}>APP UPDATES</Text>
        <View style={{
          backgroundColor: colors.surface,
          borderRadius: borderRadius.md,
          padding: spacing.lg,
          borderWidth: 1,
          borderColor: colors.border,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: fontSize.md, color: colors.text }}>Version</Text>
            <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.text }}>
              {Constants.expoConfig?.version || '1.0.0'}
            </Text>
          </View>
          {lastChecked && (
            <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.sm }}>
              Last checked: {lastChecked.toLocaleTimeString()}
            </Text>
          )}
          <View style={{ marginTop: spacing.md }}>
            {updateReady || updateStatus === 'ready' ? (
              <Pressable
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  backgroundColor: colors.accent,
                  borderRadius: borderRadius.md,
                  padding: spacing.md,
                }}
                onPress={() => Updates.reloadAsync()}
                accessibilityLabel="Restart to apply update"
                accessibilityRole="button"
              >
                <Ionicons name="refresh" size={18} color="#ffffff" />
                <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: '#ffffff' }}>Restart to Apply Update</Text>
              </Pressable>
            ) : (
              <Pressable
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  backgroundColor: colors.surfaceElevated,
                  borderRadius: borderRadius.md,
                  padding: spacing.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
                onPress={handleCheckForUpdate}
                disabled={updateChecking}
                accessibilityLabel={updateChecking ? 'Checking for updates' : 'Check for updates'}
                accessibilityRole="button"
              >
                {updateChecking ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Ionicons name="cloud-download-outline" size={18} color={colors.accent} />
                )}
                <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.accent }}>
                  {updateChecking ? 'Checking...' : 'Check for Updates'}
                </Text>
              </Pressable>
            )}
            {updateStatus === 'up-to-date' && !updateChecking && (
              <Text style={{ fontSize: fontSize.xs, color: colors.online, marginTop: spacing.sm }}>
                You're up to date
              </Text>
            )}
          </View>
        </View>
      </View>

      {/* Menu Items */}
      <View style={{ marginBottom: spacing.xxl }}>
        <MenuItem colors={colors} icon="swap-horizontal-outline" label="Switch Room" onPress={() => {
          Alert.alert(
            'Switch Room',
            activeRoomName
              ? `This will disconnect from ${activeRoomName}. Continue?`
              : 'This will disconnect from your current room. Continue?',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Switch Room',
                style: 'destructive',
                onPress: () => {
                  useChatStore.getState().clearMessages();
                  router.replace('/room-picker');
                },
              },
            ],
          );
        }} />
        <MenuItem colors={colors} icon="construct-outline" label="Equipment Config" onPress={() => router.push('/equipment-config')} />
        <MenuItem colors={colors} icon="list-outline" label="Service Rundown" onPress={() => router.push('/rundown')} />
        <MenuItem colors={colors} icon="analytics-outline" label="Analytics" onPress={() => router.push('/analytics')} />
        <MenuItem colors={colors} icon="document-text-outline" label="Service Reports" onPress={() => router.push('/service-reports')} />
        <MenuItem colors={colors} icon="settings-outline" label="Settings" onPress={() => router.push('/settings')} />
        <MenuItem colors={colors} icon="help-circle-outline" label="Help & Support" onPress={() => {
          Linking.openURL('https://tallyconnect.app/docs');
        }} isLast />
      </View>

      {/* Sign Out */}
      <Pressable style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(220, 38, 38, 0.06)',
        borderRadius: borderRadius.md,
        padding: spacing.lg,
        borderWidth: 1,
        borderColor: colors.isDark ? 'rgba(239, 68, 68, 0.2)' : 'rgba(220, 38, 38, 0.15)',
        marginBottom: spacing.xxl,
      }} onPress={handleLogout} accessibilityLabel="Sign out" accessibilityRole="button">
        <Ionicons name="log-out-outline" size={20} color={colors.critical} />
        <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.critical, marginLeft: spacing.sm }}>Sign Out</Text>
      </Pressable>

      <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', marginBottom: spacing.lg }}>
        Tally Connect Mobile v{Constants.expoConfig?.version || '1.0.0'}
      </Text>
      <View style={{ height: spacing.xxxl }} />
    </ScrollView>
  );
}

function MenuItem({ icon, label, onPress, isLast, colors }: { icon: string; label: string; onPress: () => void; isLast?: boolean; colors: any }) {
  return (
    <Pressable style={[
      { flexDirection: 'row', alignItems: 'center', padding: spacing.lg },
      !isLast && { borderBottomWidth: 1, borderBottomColor: colors.border },
    ]} onPress={onPress} accessibilityLabel={label} accessibilityRole="button">
      <Ionicons name={icon as any} size={20} color={colors.textSecondary} style={{ width: 28, textAlign: 'center', marginRight: spacing.md }} />
      <Text style={{ flex: 1, fontSize: fontSize.md, color: colors.text }}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

function gradeColor(grade: string | undefined, colors: any): string {
  if (!grade) return colors.textMuted;
  if (grade.startsWith('A')) return colors.online;
  if (grade.startsWith('B')) return colors.accentLight;
  if (grade.startsWith('C')) return colors.warning;
  return colors.critical;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
