import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, Alert, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useStatusStore, useActiveRoomStatus } from '../../src/stores/statusStore';
import { tallySocket } from '../../src/ws/TallySocket';
import { colors } from '../../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { TallyIndicator } from '../../src/components/TallyIndicator';

export default function ActionsScreen() {
  const status = useActiveRoomStatus();
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const [pending, setPending] = useState<string | null>(null);

  const sendCommand = async (command: string, params: Record<string, unknown> = {}, destructive = false) => {
    if (destructive) {
      return new Promise<void>((resolve) => {
        Alert.alert(
          'Confirm Action',
          `Are you sure you want to ${command.replace('.', ' ')}?`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
            {
              text: 'Confirm',
              style: 'destructive',
              onPress: async () => {
                await executeCommand(command, params);
                resolve();
              },
            },
          ],
        );
      });
    }
    await executeCommand(command, params);
  };

  const executeCommand = async (command: string, params: Record<string, unknown>) => {
    setPending(command);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      if (!tallySocket.isConnected) {
        throw new Error('Not connected to server');
      }
      tallySocket.send({
        type: 'command',
        command,
        params,
        roomId: activeRoomId,
        messageId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Command Failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPending(null);
    }
  };

  const atem = status?.atem;
  const inputs = atem?.inputs || {};
  const tallyInputs = Object.entries(inputs)
    .filter(([, v]) => v.type === 'external')
    .map(([key, v]) => ({
      number: parseInt(key, 10),
      name: v.name || `Input ${key}`,
      isProgram: atem?.programInput === parseInt(key, 10),
      isPreview: atem?.previewInput === parseInt(key, 10),
    }))
    .sort((a, b) => a.number - b.number)
    .slice(0, 8);

  const isStreaming = status?.encoder?.streaming || status?.obs?.streaming || status?.atem?.streaming;

  // Stream Protection state
  const sp = (status as any)?.streamProtection;
  const spEnabled = sp?.enabled ?? false;
  const spState = sp?.state ?? 'idle';
  const spLastEvent = sp?.lastEvent;
  const spCanRestart = sp?.canManualRestart ?? false;

  const stateLabels: Record<string, string> = {
    idle: 'Off',
    protecting: 'Active',
    encoder_disconnected: 'Encoder Down',
    restarting: 'Restarting',
    alert_sent: 'Alert',
    cdn_mismatch: 'CDN Issue',
  };

  const stateColors: Record<string, string> = {
    idle: colors.textMuted,
    protecting: colors.online,
    encoder_disconnected: colors.critical,
    restarting: colors.warning,
    alert_sent: colors.warning,
    cdn_mismatch: colors.warning,
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Camera Switching */}
      {atem?.connected && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>CAMERAS</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {tallyInputs.map((input) => (
              <TallyIndicator
                key={input.number}
                inputNumber={input.number}
                inputName={input.name}
                isProgram={input.isProgram}
                isPreview={input.isPreview}
                onPress={() => sendCommand('atem.setProgram', { input: input.number })}
              />
            ))}
          </ScrollView>
          <View style={styles.transitionRow}>
            <ActionButton
              label="CUT"
              icon="cut-outline"
              onPress={() => sendCommand('atem.cut')}
              pending={pending === 'atem.cut'}
            />
            <ActionButton
              label="AUTO"
              icon="swap-horizontal-outline"
              onPress={() => sendCommand('atem.auto')}
              pending={pending === 'atem.auto'}
            />
          </View>
        </View>
      )}

      {/* Stream Control */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>STREAM</Text>
        <View style={styles.actionRow}>
          <ActionButton
            label="Start Stream"
            icon="play-circle-outline"
            color={colors.online}
            onPress={() => sendCommand('obs.startStream')}
            pending={pending === 'obs.startStream'}
            disabled={isStreaming}
          />
          <ActionButton
            label="Stop Stream"
            icon="stop-circle-outline"
            color={colors.critical}
            onPress={() => sendCommand('obs.stopStream', {}, true)}
            pending={pending === 'obs.stopStream'}
            disabled={!isStreaming}
          />
        </View>
      </View>

      {/* Stream Protection */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>STREAM PROTECTION</Text>
        <View style={spStyles.card}>
          <View style={spStyles.headerRow}>
            <View style={spStyles.statusRow}>
              <View style={[spStyles.statusDot, { backgroundColor: stateColors[spState] || colors.textMuted }]} />
              <Text style={spStyles.statusLabel}>
                {spEnabled ? (stateLabels[spState] || spState) : 'Disabled'}
              </Text>
            </View>
            <Switch
              value={spEnabled}
              onValueChange={(val) => sendCommand(val ? 'streamProtection.enable' : 'streamProtection.disable')}
              trackColor={{ false: colors.border, true: colors.accent }}
              thumbColor={colors.white}
            />
          </View>
          {spLastEvent && spEnabled && (
            <Text style={spStyles.eventText}>{spLastEvent}</Text>
          )}
          {spCanRestart && (
            <Pressable
              style={spStyles.restartBtn}
              onPress={() => sendCommand('streamProtection.restart')}
            >
              <Ionicons name="refresh-outline" size={16} color={colors.white} />
              <Text style={spStyles.restartLabel}>Restart Stream</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Recording */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>RECORDING</Text>
        <View style={styles.actionRow}>
          <ActionButton
            label="Start Rec"
            icon="radio-button-on-outline"
            color={colors.critical}
            onPress={() => sendCommand('obs.startRecording')}
            pending={pending === 'obs.startRecording'}
          />
          <ActionButton
            label="Stop Rec"
            icon="square-outline"
            onPress={() => sendCommand('obs.stopRecording', {}, true)}
            pending={pending === 'obs.stopRecording'}
          />
        </View>
      </View>

      {/* ProPresenter */}
      {status?.propresenter?.connected && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>PROPRESENTER</Text>
          {status.propresenter.currentSlide && (
            <Text style={styles.currentSlide}>
              {status.propresenter.currentSlide}
            </Text>
          )}
          <View style={styles.actionRow}>
            <ActionButton
              label="Previous"
              icon="chevron-back"
              onPress={() => sendCommand('propresenter.previousSlide')}
              pending={pending === 'propresenter.previousSlide'}
            />
            <ActionButton
              label="Next"
              icon="chevron-forward"
              onPress={() => sendCommand('propresenter.nextSlide')}
              pending={pending === 'propresenter.nextSlide'}
            />
          </View>
        </View>
      )}

      <View style={{ height: spacing.xxxl }} />
    </ScrollView>
  );
}

interface ActionButtonProps {
  label: string;
  icon: string;
  color?: string;
  onPress: () => void;
  pending?: boolean;
  disabled?: boolean;
}

function ActionButton({ label, icon, color, onPress, pending, disabled }: ActionButtonProps) {
  return (
    <Pressable
      style={[
        actionStyles.button,
        disabled && actionStyles.buttonDisabled,
        pending && actionStyles.buttonPending,
      ]}
      onPress={onPress}
      disabled={disabled || pending}
    >
      <Ionicons
        name={icon as any}
        size={24}
        color={disabled ? colors.textMuted : color || colors.text}
      />
      <Text style={[
        actionStyles.label,
        disabled && { color: colors.textMuted },
      ]}>
        {pending ? 'Sending...' : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
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
  transitionRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  currentSlide: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
});

const actionStyles = StyleSheet.create({
  button: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 72,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonPending: {
    borderColor: colors.accent,
  },
  label: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: '600',
    marginTop: spacing.sm,
  },
});

const spStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: fontSize.md,
    color: colors.text,
    fontWeight: '600',
  },
  eventText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  restartBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    backgroundColor: colors.warning,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  restartLabel: {
    fontSize: fontSize.sm,
    color: colors.white,
    fontWeight: '600',
  },
});
