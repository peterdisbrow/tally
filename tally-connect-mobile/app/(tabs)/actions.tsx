import React, { useState } from 'react';
import {
  View, Text, ScrollView, Pressable, Alert, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useStatusStore, useActiveRoomStatus } from '../../src/stores/statusStore';
import { useCommandResultStore } from '../../src/stores/commandResultStore';
import { tallySocket } from '../../src/ws/TallySocket';
import { useThemeColors } from '../../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { TallyIndicator } from '../../src/components/TallyIndicator';
import { GlassCard } from '../../src/components/GlassCard';
import { PulseDot } from '../../src/components/PulseDot';

export default function ActionsScreen() {
  const status = useActiveRoomStatus();
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const [pending, setPending] = useState<string | null>(null);
  const colors = useThemeColors();

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
      const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      tallySocket.send({
        type: 'command',
        command,
        params,
        roomId: activeRoomId,
        messageId,
      });

      const result = await new Promise<{ success: boolean; error?: string } | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 3000);
        const check = setInterval(() => {
          const r = useCommandResultStore.getState().getResult(messageId);
          if (r) {
            clearTimeout(timeout);
            clearInterval(check);
            useCommandResultStore.getState().clearResult(messageId);
            resolve(r);
          }
        }, 100);
      });

      if (result && !result.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Command Failed', result.error || 'The command was not executed successfully.');
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
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

  const sp = (status as any)?.streamProtection;
  const spEnabled = sp?.enabled ?? false;
  const spState = sp?.state ?? 'idle';
  const spLastEvent = sp?.lastEvent;
  const spCanRestart = sp?.canManualRestart ?? false;
  const spCdnHealth = sp?.cdnHealth as string | null;
  const spCdnPlatforms = sp?.cdnPlatforms as Record<string, { live: boolean; viewerCount: number }> | null;

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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg }}>
      {/* Camera Switching */}
      {atem?.connected && (
        <View style={{ marginBottom: spacing.xxl }}>
          <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md }}>CAMERAS</Text>
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
          <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg }}>
            <GradientButton
              colors={colors}
              label="CUT"
              icon="cut-outline"
              gradientBg="rgba(239, 68, 68, 0.25)"
              borderColor="rgba(239, 68, 68, 0.4)"
              onPress={() => sendCommand('atem.cut')}
              pending={pending === 'atem.cut'}
            />
            <GradientButton
              colors={colors}
              label="AUTO"
              icon="swap-horizontal-outline"
              gradientBg="rgba(245, 158, 11, 0.2)"
              borderColor="rgba(245, 158, 11, 0.35)"
              onPress={() => sendCommand('atem.auto')}
              pending={pending === 'atem.auto'}
            />
          </View>
        </View>
      )}

      {/* Stream Control */}
      <View style={{ marginBottom: spacing.xxl }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md }}>STREAM</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <GradientButton
            colors={colors}
            label="Start Stream"
            icon="play-circle-outline"
            gradientBg="rgba(34, 197, 94, 0.2)"
            borderColor="rgba(34, 197, 94, 0.35)"
            color={colors.online}
            onPress={() => {
              const cmd = status?.obs?.connected ? 'obs.startStream' : 'atem.startStream';
              sendCommand(cmd);
            }}
            pending={pending === 'obs.startStream' || pending === 'atem.startStream'}
            disabled={isStreaming}
          />
          <GradientButton
            colors={colors}
            label="Stop Stream"
            icon="stop-circle-outline"
            gradientBg="rgba(239, 68, 68, 0.2)"
            borderColor="rgba(239, 68, 68, 0.35)"
            color={colors.critical}
            onPress={() => {
              const cmd = status?.obs?.streaming ? 'obs.stopStream'
                : status?.atem?.streaming ? 'atem.stopStream'
                : status?.encoder?.streaming ? 'encoder.stopStream'
                : 'obs.stopStream';
              sendCommand(cmd, {}, true);
            }}
            pending={pending === 'obs.stopStream' || pending === 'atem.stopStream' || pending === 'encoder.stopStream'}
            disabled={!isStreaming}
          />
        </View>
      </View>

      {/* Stream Protection */}
      <View style={{ marginBottom: spacing.xxl }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md }}>STREAM PROTECTION</Text>
        <View style={{
          backgroundColor: colors.surface,
          borderRadius: borderRadius.md,
          padding: spacing.lg,
          borderWidth: 1,
          borderColor: colors.border,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <PulseDot color={stateColors[spState] || colors.textMuted} size={8} />
              <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '600' }}>
                {spEnabled ? (stateLabels[spState] || spState) : 'Disabled'}
              </Text>
            </View>
            <Switch
              value={spEnabled}
              onValueChange={(val) => sendCommand(val ? 'streamProtection.enable' : 'streamProtection.disable')}
              trackColor={{ false: colors.border, true: colors.accent }}
              thumbColor="#ffffff"
            />
          </View>
          {spCdnHealth && spEnabled && (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginTop: spacing.md,
              paddingVertical: 5,
              paddingHorizontal: spacing.md,
              borderRadius: borderRadius.sm,
              backgroundColor: spCdnHealth === 'healthy'
                ? (colors.isDark ? 'rgba(34,197,94,0.1)' : 'rgba(22,163,74,0.06)')
                : spCdnHealth === 'mismatch'
                  ? (colors.isDark ? 'rgba(245,158,11,0.1)' : 'rgba(217,119,6,0.06)')
                  : (colors.isDark ? 'rgba(148,163,184,0.08)' : 'rgba(107,114,128,0.06)'),
            }}>
              <View style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                marginRight: 5,
                backgroundColor: spCdnHealth === 'healthy' ? colors.online : spCdnHealth === 'mismatch' ? colors.warning : colors.textMuted,
              }} />
              <Text style={{
                fontSize: fontSize.sm,
                fontWeight: '600',
                color: spCdnHealth === 'healthy' ? colors.online : spCdnHealth === 'mismatch' ? colors.warning : colors.textMuted,
              }}>
                {spCdnHealth === 'healthy' ? 'CDN: Healthy' : spCdnHealth === 'mismatch' ? 'CDN: Not Receiving' : 'CDN: Checking...'}
              </Text>
              {spCdnPlatforms && (
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginLeft: spacing.sm }}>
                  {[
                    spCdnPlatforms.youtube && `YT: ${spCdnPlatforms.youtube.live ? 'Live' : 'Down'}`,
                    spCdnPlatforms.facebook && `FB: ${spCdnPlatforms.facebook.live ? 'Live' : 'Down'}`,
                  ].filter(Boolean).join(' · ')}
                </Text>
              )}
            </View>
          )}
          {spLastEvent && spEnabled && (
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: spacing.md }}>{spLastEvent}</Text>
          )}
          {spCanRestart && (
            <Pressable
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: spacing.sm,
                marginTop: spacing.md,
                backgroundColor: colors.warning,
                borderRadius: borderRadius.md,
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.lg,
              }}
              onPress={() => sendCommand('streamProtection.restart')}
            >
              <Ionicons name="refresh-outline" size={16} color="#ffffff" />
              <Text style={{ fontSize: fontSize.sm, color: '#ffffff', fontWeight: '600' }}>Restart Stream</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Recording */}
      <View style={{ marginBottom: spacing.xxl }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md }}>RECORDING</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <GradientButton
            colors={colors}
            label="Start Rec"
            icon="radio-button-on-outline"
            gradientBg="rgba(239, 68, 68, 0.2)"
            borderColor="rgba(239, 68, 68, 0.35)"
            color={colors.critical}
            onPress={() => sendCommand('obs.startRecording')}
            pending={pending === 'obs.startRecording'}
          />
          <GradientButton
            colors={colors}
            label="Stop Rec"
            icon="square-outline"
            gradientBg={colors.surface}
            borderColor={colors.border}
            onPress={() => sendCommand('obs.stopRecording', {}, true)}
            pending={pending === 'obs.stopRecording'}
          />
        </View>
      </View>

      {/* ProPresenter */}
      {status?.propresenter?.connected && (
        <View style={{ marginBottom: spacing.xxl }}>
          <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md }}>PROPRESENTER</Text>
          <GlassCard glowColor={colors.accent}>
            {status.propresenter.currentSlide && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md }}>
                <Ionicons name="tv-outline" size={14} color={colors.textSecondary} />
                <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>
                  {status.propresenter.currentSlide}
                </Text>
              </View>
            )}
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <GradientButton
                colors={colors}
                label="Previous"
                icon="chevron-back"
                gradientBg="rgba(34, 197, 94, 0.15)"
                borderColor="rgba(34, 197, 94, 0.3)"
                onPress={() => sendCommand('propresenter.previousSlide')}
                pending={pending === 'propresenter.previousSlide'}
              />
              <GradientButton
                colors={colors}
                label="Next"
                icon="chevron-forward"
                gradientBg="rgba(34, 197, 94, 0.15)"
                borderColor="rgba(34, 197, 94, 0.3)"
                onPress={() => sendCommand('propresenter.nextSlide')}
                pending={pending === 'propresenter.nextSlide'}
              />
            </View>
          </GlassCard>
        </View>
      )}

      <View style={{ height: spacing.xxxl }} />
    </ScrollView>
  );
}

interface GradientButtonProps {
  label: string;
  icon: string;
  gradientBg: string;
  borderColor: string;
  color?: string;
  onPress: () => void;
  pending?: boolean;
  disabled?: boolean;
  colors: any;
}

function GradientButton({ label, icon, gradientBg, borderColor, color, onPress, pending, disabled, colors }: GradientButtonProps) {
  return (
    <Pressable
      style={[
        {
          flex: 1,
          borderRadius: borderRadius.md,
          padding: spacing.lg,
          alignItems: 'center' as const,
          justifyContent: 'center' as const,
          borderWidth: 1,
          minHeight: 72,
          backgroundColor: gradientBg,
          borderColor,
        },
        disabled && { opacity: 0.4 },
        pending && { borderColor: colors.accent },
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
        { fontSize: fontSize.sm, color: colors.text, fontWeight: '600', marginTop: spacing.sm },
        disabled && { color: colors.textMuted },
      ]}>
        {pending ? 'Sending...' : label}
      </Text>
    </Pressable>
  );
}
