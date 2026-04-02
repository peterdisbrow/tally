import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Switch, Linking, Platform,
} from 'react-native';
import Constants from 'expo-constants';
import { useNotificationStatus } from '../src/hooks/useNotifications';
import { useSettingsStore } from '../src/stores/settingsStore';
import { getRelayUrl } from '../src/api/client';
import { colors } from '../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';

const DEFAULT_URL = 'https://api.tallyconnect.app';

export default function SettingsScreen() {
  const { permission } = useNotificationStatus();
  const notificationsEnabled = permission === 'granted';
  const alertSounds = useSettingsStore((s) => s.alertSounds);
  const setAlertSounds = useSettingsStore((s) => s.setAlertSounds);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const [serverUrl, setServerUrl] = useState<string>(DEFAULT_URL);

  useEffect(() => {
    loadSettings();
    getRelayUrl().then(setServerUrl);
  }, []);

  const version = Constants.expoConfig?.version || '1.0.0';
  const buildNumber = Platform.select({
    ios: Constants.expoConfig?.ios?.buildNumber,
    android: String(Constants.expoConfig?.android?.versionCode ?? ''),
  }) || '1';

  const handleNotificationToggle = () => {
    // Open device settings so the user can enable/disable push notifications
    Linking.openSettings();
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>NOTIFICATIONS</Text>
      <View style={styles.card}>
        <SettingRow
          label="Push Notifications"
          description={notificationsEnabled ? 'Enabled' : 'Tap to open device settings'}
          value={notificationsEnabled}
          onValueChange={handleNotificationToggle}
        />
        <SettingRow
          label="Alert Sounds"
          description="Play sound for critical alerts"
          value={alertSounds}
          onValueChange={setAlertSounds}
        />
      </View>

      <Text style={styles.sectionTitle}>CONNECTION</Text>
      <View style={styles.card}>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Server</Text>
          <Text style={styles.infoValue} numberOfLines={1}>
            {serverUrl === DEFAULT_URL ? 'Default (Tally Connect Cloud)' : serverUrl}
          </Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>ABOUT</Text>
      <View style={styles.card}>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Version</Text>
          <Text style={styles.infoValue}>{version}</Text>
        </View>
        <View style={[styles.infoRow, { borderBottomWidth: 0 }]}>
          <Text style={styles.infoLabel}>Build</Text>
          <Text style={styles.infoValue}>{buildNumber}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

function SettingRow({ label, description, value, onValueChange }: {
  label: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingInfo}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor={colors.white}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  sectionTitle: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
    marginBottom: spacing.md,
    marginTop: spacing.xxl,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  settingInfo: { flex: 1, marginRight: spacing.md },
  settingLabel: { fontSize: fontSize.md, fontWeight: '600', color: colors.text },
  settingDesc: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  infoLabel: { fontSize: fontSize.md, color: colors.textSecondary },
  infoValue: { fontSize: fontSize.md, color: colors.text, fontWeight: '600', flexShrink: 1 },
});
