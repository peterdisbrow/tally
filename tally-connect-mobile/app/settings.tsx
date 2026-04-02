import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, Switch,
} from 'react-native';
import { useNotifications } from '../src/hooks/useNotifications';
import { colors } from '../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';

export default function SettingsScreen() {
  const { permission } = useNotifications();
  const notificationsEnabled = permission === 'granted';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>NOTIFICATIONS</Text>
      <View style={styles.card}>
        <SettingRow
          label="Push Notifications"
          description={notificationsEnabled ? 'Enabled' : 'Open device settings to enable'}
          value={notificationsEnabled}
          disabled
        />
        <SettingRow
          label="Alert Sounds"
          description="Play sound for critical alerts"
          value={true}
          disabled
        />
      </View>

      <Text style={styles.sectionTitle}>CONNECTION</Text>
      <View style={styles.card}>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Server</Text>
          <Text style={styles.infoValue}>Default (Tally Connect Cloud)</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>ABOUT</Text>
      <View style={styles.card}>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Version</Text>
          <Text style={styles.infoValue}>1.0.0</Text>
        </View>
        <View style={[styles.infoRow, { borderBottomWidth: 0 }]}>
          <Text style={styles.infoLabel}>Build</Text>
          <Text style={styles.infoValue}>1</Text>
        </View>
      </View>
    </ScrollView>
  );
}

function SettingRow({ label, description, value, disabled }: {
  label: string;
  description: string;
  value: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingInfo}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{description}</Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
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
  infoValue: { fontSize: fontSize.md, color: colors.text, fontWeight: '600' },
});
