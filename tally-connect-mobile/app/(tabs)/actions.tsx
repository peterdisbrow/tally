import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, ScrollView, Pressable, Alert, Switch,
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

interface QueuedCommand {
  command: string;
  params: Record<string, unknown>;
  label: string;
}

export default function ActionsScreen() {
  const status = useActiveRoomStatus();
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const wsConnected = useStatusStore((s) => s.wsConnected);
  const [pending, setPending] = useState<string | null>(null);
  const [commandQueue, setCommandQueue] = useState<QueuedCommand[]>([]);
  const colors = useThemeColors();
  const prevConnected = useRef(wsConnected);

  // When the socket reconnects, offer to flush any queued commands
  useEffect(() => {
    if (!prevConnected.current && wsConnected && commandQueue.length > 0) {
      const summary = commandQueue.map((c) => `• ${c.label}`).join('\n');
      Alert.alert(
        'Connection Restored',
        `You have ${commandQueue.length} queued command${commandQueue.length !== 1 ? 's' : ''}:\n\n${summary}\n\nSend them now?`,
        [
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => setCommandQueue([]),
          },
          {
            text: 'Send All',
            onPress: async () => {
              const queued = commandQueue;
              setCommandQueue([]);
              for (const item of queued) {
                await executeCommand(item.command, item.params);
              }
            },
          },
        ],
      );
    }
    prevConnected.current = wsConnected;
  }, [wsConnected]);

  const sendCommand = async (command: string, params: Record<string, unknown> = {}, destructive = false, label?: string) => {
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
                await executeCommand(command, params, label);
                resolve();
              },
            },
          ],
        );
      });
    }
    await executeCommand(command, params, label);
  };

  const executeCommand = async (command: string, params: Record<string, unknown>, label?: string) => {
    setPending(command);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      if (!tallySocket.isConnected) {
        // Queue the command for retry on reconnect
        const displayLabel = label || command;
        setCommandQueue((q) => {
          // Avoid duplicates of the same command
          if (q.some((c) => c.command === command)) return q;
          return [...q, { command, params, label: displayLabel }];
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          'Offline — Command Queued',
          `"${displayLabel}" will be sent automatically when the connection is restored.`,
        );
        return;
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
        }, 250);
      });

      if (result === null) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert('No Response', 'Command not acknowledged — check equipment status.');
      } else if (!result.success) {
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
    encoder_disconnected: 'Encoder Offline',
    restarting: 'Restarting',
    alert_sent: 'Alert Active',
    cdn_mismatch: 'CDN Mismatch',
  };

  const stateDescriptions: Record<string, string> = {
    encoder_disconnected: 'Check encoder connection and cables',
    restarting: 'Stream restart in progress — standby',
    alert_sent: 'Alert sent to engineering — monitoring for recovery',
    cdn_mismatch: 'Stream not reaching CDN — viewers may be affected',
  };

  const stateColors: Record<string, string> = {
    idle: colors.textMuted,
    protecting: colors.online,
    encoder_disconnected: colors.critical,
    restarting: colors.warning,
    alert_sent: colors.warning,
    cdn_mismatch: colors.warning,
  };

  if (!activeRoomId) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg, padding: 32 }}>
        <Ionicons name="hardware-chip-outline" size={48} color={colors.textMuted} />
        <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: 16, marginBottom: 8 }}>
          No Room Connected
        </Text>
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center' }}>
          Select a room to access stream controls and commands.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg }}>
      {/* Queued commands banner */}
      {commandQueue.length > 0 && (
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: `${colors.warning}20`,
          borderRadius: borderRadius.md,
          borderWidth: 1,
          borderColor: colors.warning,
          padding: spacing.md,
          marginBottom: spacing.lg,
          gap: spacing.sm,
        }}>
          <Ionicons name="time-outline" size={16} color={colors.warning} />
          <Text style={{ flex: 1, fontSize: fontSize.sm, color: colors.warning, fontWeight: '600' }}>
            {commandQueue.length} command{commandQueue.length !== 1 ? 's' : ''} queued — waiting for reconnect
          </Text>
          <Pressable onPress={() => setCommandQueue([])}>
            <Ionicons name="close" size={16} color={colors.warning} />
          </Pressable>
        </View>
      )}

      {/* Quick Actions — always-visible pinned commands */}
      <View style={{ marginBottom: spacing.xxl }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md }}>QUICK ACTIONS</Text>
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
              sendCommand(cmd, {}, false, 'Start Stream');
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
              sendCommand(cmd, {}, true, 'Stop Stream');
            }}
            pending={pending === 'obs.stopStream' || pending === 'atem.stopStream' || pending === 'encoder.stopStream'}
            disabled={!isStreaming}
          />
          {atem?.connected && (
            <GradientButton
              colors={colors}
              label="CUT"
              icon="cut-outline"
              gradientBg="rgba(239, 68, 68, 0.25)"
              borderColor="rgba(239, 68, 68, 0.4)"
              onPress={() => sendCommand('atem.cut', {}, false, 'ATEM Cut')}
              pending={pending === 'atem.cut'}
            />
          )}
        </View>
      </View>

      {/* Camera Switching */}
      {atem?.connected && (
        <View style={{ marginBottom: spacing.xxl }}>
          <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '600', marginBottom: spacing.md }}>CAMERAS</Text>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={tallyInputs}
            keyExtractor={(item) => String(item.number)}
            renderItem={({ item }) => (
              <TallyIndicator
                inputNumber={item.number}
                inputName={item.name}
                isProgram={item.isProgram}
                isPreview={item.isPreview}
                onPress={() => sendCommand('atem.setProgram', { input: item.number })}
              />
            )}
          />
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
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginRight: spacing.md }}>
              <PulseDot color={stateColors[spState] || colors.textMuted} size={8} style={{ marginTop: 3 }} />
              <View>
                <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '600' }}>
                  {spEnabled ? (stateLabels[spState] ?? 'Unknown') : 'Disabled'}
                </Text>
                {spEnabled && stateDescriptions[spState] && (
                  <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 }}>
                    {stateDescriptions[spState]}
                  </Text>
                )}
              </View>
            </View>
            <Switch
              value={spEnabled}
              onValueChange={(val) => sendCommand(val ? 'streamProtection.enable' : 'streamProtection.disable')}
              trackColor={{ false: colors.border, true: colors.accent }}
              thumbColor="#ffffff"
              accessibilityLabel="Stream protection"
              accessibilityRole="switch"
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
              accessibilityLabel="Restart stream protection"
              accessibilityRole="button"
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
  accessibilityLabel?: string;
}

function GradientButton({ label, icon, gradientBg, borderColor, color, onPress, pending, disabled, colors, accessibilityLabel }: GradientButtonProps) {
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
      accessibilityLabel={accessibilityLabel || label}
      accessibilityRole="button"
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
