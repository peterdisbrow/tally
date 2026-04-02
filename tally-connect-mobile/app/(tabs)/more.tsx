import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, Alert, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useStatusStore } from '../../src/stores/statusStore';
import { useChatStore } from '../../src/stores/chatStore';
import { useNotifications } from '../../src/hooks/useNotifications';
import { api } from '../../src/api/client';
import { colors } from '../../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import type { ServiceSession } from '../../src/ws/types';

export default function MoreScreen() {
  const churchName = useAuthStore((s) => s.churchName);
  const email = useAuthStore((s) => s.email);
  const logout = useAuthStore((s) => s.logout);
  const { pushToken, permission } = useNotifications();
  const [session, setSession] = useState<ServiceSession | null>(null);
  const [reports, setReports] = useState<any[]>([]);

  useEffect(() => {
    // Fetch active session
    api<{ session: ServiceSession }>('/api/church/session/active')
      .then((d) => setSession(d.session || d as any))
      .catch(() => {});

    // Fetch recent service reports
    api<{ reports: any[] }>('/api/church/service-reports')
      .then((d) => setReports((d.reports || []).slice(0, 5)))
      .catch(() => {});
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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Church Info */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {(churchName || 'C')[0].toUpperCase()}
          </Text>
        </View>
        <View style={styles.profileInfo}>
          <Text style={styles.churchName}>{churchName}</Text>
          <Text style={styles.email}>{email}</Text>
        </View>
      </View>

      {/* Active Session */}
      {session?.active && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ACTIVE SESSION</Text>
          <View style={styles.card}>
            <View style={styles.sessionRow}>
              <Text style={styles.sessionLabel}>Grade</Text>
              <Text style={[styles.sessionValue, { color: gradeColor(session.grade) }]}>
                {session.grade || '--'}
              </Text>
            </View>
            <View style={styles.sessionRow}>
              <Text style={styles.sessionLabel}>Duration</Text>
              <Text style={styles.sessionValue}>
                {session.duration ? formatDuration(session.duration) : '--'}
              </Text>
            </View>
            <View style={styles.sessionRow}>
              <Text style={styles.sessionLabel}>Incidents</Text>
              <Text style={[
                styles.sessionValue,
                session.incidents && session.incidents > 0 ? { color: colors.warning } : {},
              ]}>
                {session.incidents ?? 0}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* Recent Reports */}
      {reports.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>RECENT SERVICES</Text>
          <View style={styles.card}>
            {reports.map((r, i) => (
              <View key={r.id || i} style={[styles.reportRow, i < reports.length - 1 && styles.reportBorder]}>
                <View>
                  <Text style={styles.reportDate}>
                    {r.date ? new Date(r.date).toLocaleDateString() : 'Unknown'}
                  </Text>
                  <Text style={styles.reportName}>{r.name || 'Service'}</Text>
                </View>
                <Text style={[styles.reportGrade, { color: gradeColor(r.grade) }]}>
                  {r.grade || '--'}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Push Notification Status */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>NOTIFICATIONS</Text>
        <View style={styles.card}>
          <View style={styles.notifRow}>
            <Text style={styles.notifLabel}>Push Notifications</Text>
            <Text style={[
              styles.notifValue,
              { color: permission === 'granted' ? colors.online : colors.warning },
            ]}>
              {permission === 'granted' ? 'Enabled' : permission === 'simulator' ? 'Simulator' : 'Not Enabled'}
            </Text>
          </View>
          {pushToken && (
            <Text style={styles.tokenText} numberOfLines={1}>
              Token: {pushToken.slice(0, 30)}...
            </Text>
          )}
        </View>
      </View>

      {/* Menu Items */}
      <View style={styles.section}>
        <MenuItem icon="swap-horizontal-outline" label="Switch Room" onPress={() => {
          useChatStore.getState().clearMessages();
          router.replace('/room-picker');
        }} />
        <MenuItem icon="analytics-outline" label="Analytics" onPress={() => router.push('/analytics')} />
        <MenuItem icon="document-text-outline" label="Service Reports" onPress={() => router.push('/service-reports')} />
        <MenuItem icon="settings-outline" label="Settings" onPress={() => router.push('/settings')} />
        <MenuItem icon="help-circle-outline" label="Help & Support" onPress={() => {
          Linking.openURL('https://tallyconnect.app/docs');
        }} />
      </View>

      {/* Sign Out */}
      <Pressable style={styles.logoutButton} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={20} color={colors.critical} />
        <Text style={styles.logoutText}>Sign Out</Text>
      </Pressable>

      <Text style={styles.version}>Tally Connect Mobile v1.0.0</Text>
      <View style={{ height: spacing.xxxl }} />
    </ScrollView>
  );
}

function MenuItem({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <Pressable style={menuStyles.item} onPress={onPress}>
      <Ionicons name={icon as any} size={22} color={colors.textSecondary} />
      <Text style={menuStyles.label}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

function gradeColor(grade?: string): string {
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.lg,
  },
  avatarText: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.white,
  },
  profileInfo: {
    flex: 1,
  },
  churchName: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  email: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  section: {
    marginBottom: spacing.xxl,
  },
  sectionTitle: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sessionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  sessionLabel: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
  },
  sessionValue: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  reportRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  reportBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  reportDate: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  reportName: {
    fontSize: fontSize.md,
    color: colors.text,
    marginTop: 2,
  },
  reportGrade: {
    fontSize: fontSize.xl,
    fontWeight: '800',
  },
  notifRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  notifLabel: {
    fontSize: fontSize.md,
    color: colors.text,
  },
  notifValue: {
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  tokenText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.2)',
    marginBottom: spacing.xxl,
  },
  logoutText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.critical,
    marginLeft: spacing.sm,
  },
  version: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
});

const menuStyles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.text,
    marginLeft: spacing.md,
  },
});
