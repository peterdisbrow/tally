import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, Alert, Switch, ScrollView,
  KeyboardAvoidingView, Platform, LayoutAnimation, UIManager,
  NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useStatusStore, useActiveRoomStatus } from '../../src/stores/statusStore';
import { useCommandResultStore } from '../../src/stores/commandResultStore';
import { useChatStore } from '../../src/stores/chatStore';
import { tallySocket } from '../../src/ws/TallySocket';
import { useThemeColors } from '../../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { TallyIndicator } from '../../src/components/TallyIndicator';
import { PulseDot } from '../../src/components/PulseDot';
import type { ChatMessage } from '../../src/ws/types';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface QueuedCommand {
  command: string;
  params: Record<string, unknown>;
  label: string;
}

export default function ControlScreen() {
  const status = useActiveRoomStatus();
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const wsConnected = useStatusStore((s) => s.wsConnected);
  const colors = useThemeColors();

  // Command state
  const [pending, setPending] = useState<string | null>(null);
  const [commandQueue, setCommandQueue] = useState<QueuedCommand[]>([]);
  const prevConnected = useRef(wsConnected);

  // Section collapse state
  const [commandsExpanded, setCommandsExpanded] = useState(true);
  const [chatExpanded, setChatExpanded] = useState(false);

  const toggleCommands = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCommandsExpanded((v) => !v);
  };

  const toggleChat = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setChatExpanded((v) => !v);
  };

  // Chat state
  const messagesByRoom = useChatStore((s) => s.messagesByRoom);
  const isSending = useChatStore((s) => s.isSending);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const messages = messagesByRoom[activeRoomId ?? '__no_room__'] ?? [];
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<FlatList>(null);
  const isAtBottom = useRef(true);

  // Queue flush on reconnect
  useEffect(() => {
    if (!prevConnected.current && wsConnected && commandQueue.length > 0) {
      const summary = commandQueue.map((c) => `\u2022 ${c.label}`).join('\n');
      Alert.alert(
        'Connection Restored',
        `You have ${commandQueue.length} queued command${commandQueue.length !== 1 ? 's' : ''}:\n\n${summary}\n\nSend them now?`,
        [
          { text: 'Discard', style: 'destructive', onPress: () => setCommandQueue([]) },
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

  // Chat error auto-dismiss
  useEffect(() => {
    if (!sendError) return;
    const timer = setTimeout(() => setSendError(null), 5000);
    return () => clearTimeout(timer);
  }, [sendError]);

  // --- Command helpers ---

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

  const executeCommand = async (command: string, params: Record<string, unknown> = {}, label?: string) => {
    setPending(command);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      if (!tallySocket.isConnected) {
        const displayLabel = label || command;
        setCommandQueue((q) => {
          if (q.some((c) => c.command === command)) return q;
          return [...q, { command, params, label: displayLabel }];
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert('Offline \u2014 Command Queued', `"${displayLabel}" will be sent automatically when the connection is restored.`);
        return;
      }
      const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      tallySocket.send({ type: 'command', command, params, roomId: activeRoomId, messageId });

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
        Alert.alert('No Response', 'Command not acknowledged \u2014 check equipment status.');
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

  // --- Chat helpers ---

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    isAtBottom.current = distanceFromBottom < 50;
  }, []);

  const handleContentSizeChange = useCallback(() => {
    if (isAtBottom.current) {
      listRef.current?.scrollToEnd({ animated: false });
    }
  }, []);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    setSendError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const success = await sendMessage(trimmed, activeRoomId || undefined);
    if (success) {
      setText('');
    } else {
      setSendError('Failed to send message. Please try again.');
    }
  };

  // --- Derived state ---

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
  const isRecording = status?.obs?.recording;

  const sp = (status as any)?.streamProtection;
  const spEnabled = sp?.enabled ?? false;

  const hasAtem = atem?.connected;
  const hasProPresenter = status?.propresenter?.connected;

  // --- No room state ---

  if (!activeRoomId) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg, padding: 32 }}>
        <Ionicons name="game-controller-outline" size={48} color={colors.textMuted} />
        <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: 16, marginBottom: 8 }}>
          No Room Connected
        </Text>
        <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center' }}>
          Select a room to access controls and chat.
        </Text>
      </View>
    );
  }

  // --- Render ---

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const isUser = item.senderRole === 'td';
    return (
      <View style={[
        { marginBottom: spacing.md },
        isUser ? { alignItems: 'flex-end' as const } : { alignItems: 'flex-start' as const },
      ]}>
        <View style={[
          { maxWidth: '80%', padding: spacing.md },
          isUser ? {
            backgroundColor: 'rgba(0, 230, 118, 0.85)',
            borderTopLeftRadius: borderRadius.lg,
            borderTopRightRadius: borderRadius.lg,
            borderBottomLeftRadius: borderRadius.lg,
            borderBottomRightRadius: 4,
            shadowColor: colors.accent,
            shadowOpacity: 0.2,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
          } : {
            backgroundColor: colors.surfaceElevated,
            borderWidth: 1,
            borderColor: colors.border,
            borderTopLeftRadius: 4,
            borderTopRightRadius: borderRadius.lg,
            borderBottomRightRadius: borderRadius.lg,
            borderBottomLeftRadius: borderRadius.lg,
          },
        ]}>
          {!isUser && (
            <Text style={{ fontSize: fontSize.xs, color: colors.accentLight, fontWeight: '600', marginBottom: 4 }}>
              {item.senderName || 'Tally Engineer'}
            </Text>
          )}
          <Text style={[
            { fontSize: fontSize.md, lineHeight: 22 },
            isUser ? { color: '#ffffff' } : { color: colors.text },
          ]}>
            {item.message}
          </Text>
          <Text style={[
            { fontSize: 10, marginTop: 4, alignSelf: 'flex-end' as const },
            isUser ? { color: 'rgba(255,255,255,0.5)' } : { color: colors.textMuted },
          ]}>
            {formatTime(item.timestamp)}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      {/* Queued commands banner */}
      {commandQueue.length > 0 && (
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: `${colors.warning}20`,
          borderBottomWidth: 1,
          borderBottomColor: colors.warning,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          gap: spacing.sm,
        }}>
          <Ionicons name="time-outline" size={14} color={colors.warning} />
          <Text style={{ flex: 1, fontSize: fontSize.xs, color: colors.warning, fontWeight: '600' }}>
            {commandQueue.length} queued — waiting for reconnect
          </Text>
          <Pressable onPress={() => setCommandQueue([])} hitSlop={8}>
            <Ionicons name="close" size={14} color={colors.warning} />
          </Pressable>
        </View>
      )}

      {/* Main 50/50 content area */}
      <View style={{ flex: 1 }}>

        {/* ── Commands section ── */}
        <View style={[
          { borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
          commandsExpanded ? { flex: 1 } : {},
        ]}>
          {/* Collapsible header */}
          <Pressable
            onPress={toggleCommands}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              gap: spacing.sm,
            }}
            accessibilityLabel={commandsExpanded ? 'Collapse commands' : 'Expand commands'}
            accessibilityRole="button"
          >
            <Ionicons name="game-controller-outline" size={16} color={colors.accent} />
            <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>Commands</Text>
            {isStreaming && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <PulseDot color={colors.critical} size={6} />
                <Text style={{ fontSize: fontSize.xs, color: colors.critical, fontWeight: '600' }}>LIVE</Text>
              </View>
            )}
            <Ionicons
              name={commandsExpanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.textMuted}
            />
          </Pressable>

          {commandsExpanded && (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }}
              showsVerticalScrollIndicator={false}
            >
              {/* Row 1: Camera tally + ProPresenter */}
              {(hasAtem || hasProPresenter) && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                  {hasAtem && (
                    <FlatList
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      data={tallyInputs}
                      keyExtractor={(item) => String(item.number)}
                      style={{ flexShrink: 1 }}
                      renderItem={({ item }) => (
                        <TallyIndicator
                          inputNumber={item.number}
                          inputName={item.name}
                          isProgram={item.isProgram}
                          isPreview={item.isPreview}
                          onPress={() => sendCommand('atem.setProgram', { input: item.number })}
                          compact
                        />
                      )}
                    />
                  )}
                  {hasProPresenter && (
                    <View style={{ flexDirection: 'row', gap: spacing.xs }}>
                      <CompactButton
                        icon="chevron-back"
                        colors={colors}
                        onPress={() => sendCommand('propresenter.previousSlide')}
                        pending={pending === 'propresenter.previousSlide'}
                        accessibilityLabel="Previous slide"
                      />
                      <CompactButton
                        icon="chevron-forward"
                        colors={colors}
                        onPress={() => sendCommand('propresenter.nextSlide')}
                        pending={pending === 'propresenter.nextSlide'}
                        accessibilityLabel="Next slide"
                      />
                    </View>
                  )}
                </View>
              )}

              {/* Row 2: Stream, Recording, Stream Protection, ATEM */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' }}>
                {/* Stream start/stop */}
                {!isStreaming ? (
                  <CompactButton
                    icon="play"
                    label="Stream"
                    color={colors.online}
                    colors={colors}
                    onPress={() => {
                      const cmd = status?.obs?.connected ? 'obs.startStream' : 'atem.startStream';
                      sendCommand(cmd, {}, false, 'Start Stream');
                    }}
                    pending={pending === 'obs.startStream' || pending === 'atem.startStream'}
                  />
                ) : (
                  <CompactButton
                    icon="stop"
                    label="Stream"
                    color={colors.critical}
                    colors={colors}
                    onPress={() => {
                      const cmd = status?.obs?.streaming ? 'obs.stopStream'
                        : status?.atem?.streaming ? 'atem.stopStream'
                        : status?.encoder?.streaming ? 'encoder.stopStream'
                        : 'obs.stopStream';
                      sendCommand(cmd, {}, true, 'Stop Stream');
                    }}
                    pending={pending === 'obs.stopStream' || pending === 'atem.stopStream' || pending === 'encoder.stopStream'}
                    destructive
                  />
                )}

                {/* Recording start/stop */}
                {!isRecording ? (
                  <CompactButton
                    icon="radio-button-on"
                    label="Rec"
                    color={colors.critical}
                    colors={colors}
                    onPress={() => sendCommand('obs.startRecording', {}, false, 'Start Recording')}
                    pending={pending === 'obs.startRecording'}
                  />
                ) : (
                  <CompactButton
                    icon="square"
                    label="Rec"
                    colors={colors}
                    onPress={() => sendCommand('obs.stopRecording', {}, true, 'Stop Recording')}
                    pending={pending === 'obs.stopRecording'}
                    destructive
                  />
                )}

                {/* Stream Protection toggle */}
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: colors.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                  borderRadius: borderRadius.sm,
                  paddingHorizontal: spacing.sm,
                  paddingVertical: 4,
                  gap: spacing.xs,
                  borderWidth: 1,
                  borderColor: spEnabled ? `${colors.online}40` : colors.border,
                }}>
                  <Ionicons
                    name="shield-checkmark"
                    size={14}
                    color={spEnabled ? colors.online : colors.textMuted}
                  />
                  <Text style={{ fontSize: fontSize.xs, color: spEnabled ? colors.online : colors.textMuted, fontWeight: '600' }}>
                    SP
                  </Text>
                  <Switch
                    value={spEnabled}
                    onValueChange={(val) => sendCommand(val ? 'streamProtection.enable' : 'streamProtection.disable')}
                    trackColor={{ false: colors.border, true: colors.accent }}
                    thumbColor="#ffffff"
                    style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
                    accessibilityLabel="Stream protection"
                    accessibilityRole="switch"
                  />
                </View>

                {/* ATEM Cut/Auto */}
                {hasAtem && (
                  <>
                    <CompactButton
                      icon="cut-outline"
                      label="CUT"
                      color={colors.critical}
                      colors={colors}
                      onPress={() => sendCommand('atem.cut', {}, false, 'ATEM Cut')}
                      pending={pending === 'atem.cut'}
                    />
                    <CompactButton
                      icon="swap-horizontal-outline"
                      label="AUTO"
                      color={colors.warning}
                      colors={colors}
                      onPress={() => sendCommand('atem.auto', {}, false, 'ATEM Auto')}
                      pending={pending === 'atem.auto'}
                    />
                  </>
                )}
              </View>
            </ScrollView>
          )}
        </View>

        {/* ── Engineer Chat section ── */}
        <View style={chatExpanded ? { flex: 1 } : {}}>
          {/* Collapsible header */}
          <Pressable
            onPress={toggleChat}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderBottomWidth: chatExpanded ? 1 : 0,
              borderBottomColor: colors.border,
              backgroundColor: colors.surface,
            }}
            accessibilityLabel={chatExpanded ? 'Collapse chat' : 'Expand chat'}
            accessibilityRole="button"
          >
            <View style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: colors.isDark ? 'rgba(0, 230, 118, 0.2)' : 'rgba(0, 230, 118, 0.12)',
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: spacing.sm,
              borderWidth: 1,
              borderColor: colors.isDark ? 'rgba(0, 230, 118, 0.3)' : 'rgba(0, 230, 118, 0.2)',
            }}>
              <Ionicons name="hardware-chip-outline" size={14} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>Tally Engineer</Text>
              {!chatExpanded && messages.length > 0 && (
                <Text numberOfLines={1} style={{ fontSize: 10, color: colors.textSecondary, marginTop: 1 }}>
                  {messages[messages.length - 1]?.message}
                </Text>
              )}
              {!chatExpanded && messages.length === 0 && (
                <Text style={{ fontSize: 10, color: colors.textSecondary, marginTop: 1 }}>
                  Tap to chat
                </Text>
              )}
            </View>
            {messages.length > 0 && !chatExpanded && (
              <View style={{
                backgroundColor: colors.accent,
                borderRadius: 10,
                minWidth: 20,
                height: 20,
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 6,
                marginRight: spacing.sm,
              }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>{messages.length}</Text>
              </View>
            )}
            <Ionicons
              name={chatExpanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.textMuted}
            />
          </Pressable>

          {chatExpanded && (
            <>
              <FlatList
                ref={listRef}
                data={messages}
                keyExtractor={(item, idx) => item.id || `${idx}`}
                renderItem={renderMessage}
                contentContainerStyle={{ padding: spacing.lg, flexGrow: 1, justifyContent: 'flex-end' }}
                onScroll={handleScroll}
                scrollEventThrottle={100}
                onContentSizeChange={handleContentSizeChange}
                style={{ flex: 1 }}
                ListEmptyComponent={
                  <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 }}>
                    <Ionicons name="chatbubbles-outline" size={32} color={colors.textMuted} style={{ marginBottom: spacing.sm }} />
                    <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.text, marginBottom: spacing.xs }}>Tally Engineer</Text>
                    <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
                      Ask questions, send commands,{'\n'}or get diagnostics.
                    </Text>
                  </View>
                }
              />

              {/* Send error banner */}
              {sendError && (
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.sm,
                  backgroundColor: colors.isDark ? 'rgba(239, 68, 68, 0.12)' : 'rgba(220, 38, 38, 0.08)',
                  borderTopWidth: 1,
                  borderTopColor: colors.critical,
                  gap: spacing.sm,
                }}>
                  <Text style={{ fontSize: fontSize.sm, color: colors.critical, flex: 1 }}>{sendError}</Text>
                  <Pressable
                    onPress={() => { setSendError(null); handleSend(); }}
                    accessibilityLabel="Retry sending message"
                    accessibilityRole="button"
                    style={{ paddingHorizontal: spacing.sm, paddingVertical: 2 }}
                  >
                    <Text style={{ fontSize: fontSize.sm, color: colors.critical, fontWeight: '700' }}>Retry</Text>
                  </Pressable>
                  <Pressable onPress={() => setSendError(null)} accessibilityLabel="Dismiss error" accessibilityRole="button">
                    <Ionicons name="close-circle" size={18} color={colors.critical} />
                  </Pressable>
                </View>
              )}

              {/* Chat input bar */}
              <View style={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                backgroundColor: colors.surface,
              }}>
                <TextInput
                  style={{
                    flex: 1,
                    backgroundColor: colors.inputBg,
                    borderRadius: borderRadius.lg,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                    fontSize: fontSize.md,
                    color: colors.text,
                    maxHeight: 100,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                  placeholder="Type a message..."
                  placeholderTextColor={colors.textMuted}
                  value={text}
                  onChangeText={setText}
                  multiline
                  maxLength={1000}
                  returnKeyType="default"
                />
                <Pressable
                  style={[
                    {
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      backgroundColor: colors.accent,
                      justifyContent: 'center',
                      alignItems: 'center',
                      marginLeft: spacing.sm,
                      shadowColor: colors.accent,
                      shadowOpacity: 0.4,
                      shadowRadius: 8,
                      shadowOffset: { width: 0, height: 2 },
                    },
                    (!text.trim() || isSending) && {
                      backgroundColor: colors.surface,
                      shadowOpacity: 0,
                    },
                  ]}
                  onPress={handleSend}
                  disabled={!text.trim() || isSending}
                  accessibilityLabel="Send message"
                  accessibilityRole="button"
                >
                  <Ionicons
                    name="send"
                    size={20}
                    color={text.trim() && !isSending ? '#ffffff' : colors.textMuted}
                  />
                </Pressable>
              </View>
            </>
          )}
        </View>

      </View>
    </KeyboardAvoidingView>
  );
}

// --- Compact icon button for toolbar rows ---

interface CompactButtonProps {
  icon: string;
  label?: string;
  color?: string;
  onPress: () => void;
  pending?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  colors: any;
  accessibilityLabel?: string;
}

function CompactButton({ icon, label, color, onPress, pending, disabled, destructive, colors, accessibilityLabel }: CompactButtonProps) {
  const btnColor = color || colors.text;
  const bgColor = destructive
    ? 'rgba(239, 68, 68, 0.15)'
    : colors.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const bdrColor = destructive
    ? 'rgba(239, 68, 68, 0.3)'
    : colors.border;

  return (
    <Pressable
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          backgroundColor: bgColor,
          borderRadius: borderRadius.sm,
          paddingHorizontal: spacing.sm,
          paddingVertical: 6,
          borderWidth: 1,
          borderColor: bdrColor,
        },
        disabled && { opacity: 0.4 },
        pending && { borderColor: colors.accent },
      ]}
      onPress={onPress}
      disabled={disabled || pending}
      accessibilityLabel={accessibilityLabel || label || icon}
      accessibilityRole="button"
      hitSlop={4}
    >
      <Ionicons name={icon as any} size={16} color={disabled ? colors.textMuted : btnColor} />
      {label && (
        <Text style={{ fontSize: fontSize.xs, color: disabled ? colors.textMuted : btnColor, fontWeight: '600' }}>
          {pending ? '...' : label}
        </Text>
      )}
    </Pressable>
  );
}

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}
