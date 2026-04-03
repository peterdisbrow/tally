import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Switch, Linking, Platform, TouchableOpacity, Alert,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { useNotificationStatus } from '../src/hooks/useNotifications';
import { useSettingsStore } from '../src/stores/settingsStore';
import { getRelayUrl } from '../src/api/client';
import { useTheme, useThemeColors, ThemePreference } from '../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';

const DEFAULT_URL = 'https://api.tallyconnect.app';

export default function SettingsScreen() {
  const { permission } = useNotificationStatus();
  const notificationsEnabled = permission === 'granted';
  const alertSounds = useSettingsStore((s) => s.alertSounds);
  const setAlertSounds = useSettingsStore((s) => s.setAlertSounds);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const [serverUrl, setServerUrl] = useState<string>(DEFAULT_URL);
  const [serverUrlError, setServerUrlError] = useState(false);
  const colors = useThemeColors();
  const { preference, setPreference } = useTheme();

  useEffect(() => {
    loadSettings();
    getRelayUrl()
      .then(setServerUrl)
      .catch(() => setServerUrlError(true));
  }, []);

  const version = Constants.expoConfig?.version || '1.0.0';
  const buildNumber = Platform.select({
    ios: Constants.expoConfig?.ios?.buildNumber,
    android: String(Constants.expoConfig?.android?.versionCode ?? ''),
  }) || '1';

  const handleNotificationToggle = () => {
    Linking.openSettings();
  };

  const handleResetServerUrl = () => {
    Alert.alert(
      'Reset Server URL',
      'This will clear the saved server URL and use the default Tally Connect Cloud server. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await SecureStore.deleteItemAsync('relay_url');
            setServerUrl(DEFAULT_URL);
            setServerUrlError(false);
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={{
        fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase',
        letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md, marginTop: spacing.xxl,
      }}>APPEARANCE</Text>
      <View style={{ backgroundColor: colors.surface, borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border }}>
        <View style={{ padding: spacing.lg }}>
          <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.text, marginBottom: spacing.sm }}>Theme</Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {(['system', 'light', 'dark'] as ThemePreference[]).map((opt) => (
              <TouchableOpacity
                key={opt}
                onPress={() => {
                  Haptics.selectionAsync();
                  setPreference(opt);
                }}
                style={{
                  flex: 1,
                  paddingVertical: spacing.sm,
                  minHeight: 44,
                  borderRadius: borderRadius.sm,
                  borderWidth: 1,
                  borderColor: preference === opt ? colors.accent : colors.border,
                  backgroundColor: preference === opt ? colors.accent + '22' : colors.surfaceElevated,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{
                  fontSize: fontSize.sm,
                  fontWeight: preference === opt ? '600' : '400',
                  color: preference === opt ? colors.accent : colors.textSecondary,
                  textTransform: 'capitalize',
                }}>{opt}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

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
      <View style={{ backgroundColor: colors.surface, borderRadius: borderRadius.md, borderWidth: 1, borderColor: serverUrlError ? colors.critical : colors.border }}>
        {serverUrlError ? (
          <View style={{ padding: spacing.lg }}>
            <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.critical, marginBottom: spacing.xs }}>
              Could not load server settings
            </Text>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.md }}>
              The saved server URL may be corrupted.
            </Text>
            <TouchableOpacity
              onPress={handleResetServerUrl}
              style={{
                backgroundColor: colors.critical,
                borderRadius: borderRadius.sm,
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.md,
                alignSelf: 'flex-start',
              }}
            >
              <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' }}>Reset to Default</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Server</Text>
            <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
              {serverUrl === DEFAULT_URL ? 'Default (Tally Connect Cloud)' : serverUrl}
            </Text>
          </View>
        )}
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
