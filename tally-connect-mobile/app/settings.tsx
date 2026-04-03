import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Switch, Linking, Platform,
} from 'react-native';
import Constants from 'expo-constants';
import { useNotificationStatus } from '../src/hooks/useNotifications';
import { useSettingsStore } from '../src/stores/settingsStore';
import { getRelayUrl } from '../src/api/client';
import { useThemeColors } from '../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';

const DEFAULT_URL = 'https://api.tallyconnect.app';

export default function SettingsScreen() {
  const { permission } = useNotificationStatus();
  const notificationsEnabled = permission === 'granted';
  const alertSounds = useSettingsStore((s) => s.alertSounds);
  const setAlertSounds = useSettingsStore((s) => s.setAlertSounds);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const [serverUrl, setServerUrl] = useState<string>(DEFAULT_URL);
  const colors = useThemeColors();

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
    Linking.openSettings();
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={{
        fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase',
        letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md, marginTop: spacing.xxl,
      }}>NOTIFICATIONS</Text>
      <View style={{ backgroundColor: colors.surface, borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border }}>
        <SettingRow
          colors={colors}
          label="Push Notifications"
          description={notificationsEnabled ? 'Enabled' : 'Tap to open device settings'}
          value={notificationsEnabled}
          onValueChange={handleNotificationToggle}
        />
        <SettingRow
          colors={colors}
          label="Alert Sounds"
          description="Play sound for critical alerts"
          value={alertSounds}
          onValueChange={setAlertSounds}
        />
      </View>

      <Text style={{
        fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase',
        letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md, marginTop: spacing.xxl,
      }}>CONNECTION</Text>
      <View style={{ backgroundColor: colors.surface, borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Server</Text>
          <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
            {serverUrl === DEFAULT_URL ? 'Default (Tally Connect Cloud)' : serverUrl}
          </Text>
        </View>
      </View>

      <Text style={{
        fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase',
        letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md, marginTop: spacing.xxl,
      }}>ABOUT</Text>
      <View style={{ backgroundColor: colors.surface, borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Version</Text>
          <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '600' }}>{version}</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: spacing.lg }}>
          <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Build</Text>
          <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '600' }}>{buildNumber}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

function SettingRow({ label, description, value, onValueChange, colors }: {
  label: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  colors: any;
}) {
  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    }}>
      <View style={{ flex: 1, marginRight: spacing.md }}>
        <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.text }}>{label}</Text>
        <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 }}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor="#ffffff"
      />
    </View>
  );
}
