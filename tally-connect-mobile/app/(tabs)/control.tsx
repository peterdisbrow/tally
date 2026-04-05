import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, ScrollView,
  KeyboardAvoidingView, Platform, LayoutAnimation, UIManager, Alert,
  NativeSyntheticEvent, NativeScrollEvent, Image, ActionSheetIOS,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { useStatusStore, useActiveRoomStatus } from '../../src/stores/statusStore';
import { useCommandResultStore } from '../../src/stores/commandResultStore';
import { useChatStore } from '../../src/stores/chatStore';
import type { ChatAttachment } from '../../src/stores/chatStore';
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

  // Section collapse state — both start expanded
  const [commandsExpanded, setCommandsExpanded] = useState(true);
  const [chatExpanded, setChatExpanded] = useState(true);

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
  const [pendingAttachment, setPendingAttachment] = useState<ChatAttachment | null>(null);
  const [pendingAttachmentUri, setPendingAttachmentUri] = useState<string | null>(null);
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
    if (!trimmed && !pendingAttachment || isSending) return;
    setSendError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const success = await sendMessage(trimmed, activeRoomId || undefined, pendingAttachment || undefined);
    if (success) {
      setText('');
      setPendingAttachment(null);
      setPendingAttachmentUri(null);
    } else {
      setSendError('Failed to send message. Please try again.');
    }
  };

  const handleAttachmentPress = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Photo Library', 'Camera', 'Document'],
          cancelButtonIndex: 0,
        },
        (idx) => {
          if (idx === 1) pickImage('library');
          else if (idx === 2) pickImage('camera');
          else if (idx === 3) pickDocument();
        },
      );
    } else {
      Alert.alert('Attach File', 'Choose a source', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Photo Library', onPress: () => pickImage('library') },
        { text: 'Camera', onPress: () => pickImage('camera') },
        { text: 'Document', onPress: () => pickDocument() },
      ]);
    }
  };

  const pickImage = async (source: 'library' | 'camera') => {
    const request = source === 'camera'
      ? ImagePicker.requestCameraPermissionsAsync
      : ImagePicker.requestMediaLibraryPermissionsAsync;
    const { status } = await request();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow access in Settings to attach files.');
      return;
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.7, mediaTypes: ['images'] })
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.7, mediaTypes: ['images'] });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.base64) { Alert.alert('Error', 'Could not read image data.'); return; }
    const mimeType = asset.mimeType || 'image/jpeg';
    const ext = mimeType.split('/')[1] || 'jpg';
    const fileName = asset.fileName || `photo.${ext}`;
    setPendingAttachment({ data: asset.base64, mimeType, fileName });
    setPendingAttachmentUri(asset.uri);
  };

  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: '*/*' });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      setPendingAttachment({ data: base64, mimeType: asset.mimeType || 'application/octet-stream', fileName: asset.name });
      setPendingAttachmentUri(null);
    } catch {
      Alert.alert('Error', 'Could not read the selected file.');
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
  // Server-confirmed state; we use optimistic local state (spOptimistic) for
  // instant visual feedback while the command round-trips.
  const spEnabledServer = sp?.enabled ?? false;
  const [spOptimistic, setSpOptimistic] = useState<boolean | null>(null);
  const spEnabled = spOptimistic !== null ? spOptimistic : spEnabledServer;

  // Sync optimistic state back to server truth once we get a status update
  useEffect(() => {
    setSpOptimistic(null);
  }, [spEnabledServer]);

  const hasAtem = atem?.connected;
  const hasProPresenter = status?.propresenter?.connected;

  // --- Stream Protection toggle ---
  const handleSpToggle = async () => {
    const next = !spEnabled;
    setSpOptimistic(next); // optimistic update
    const cmd = next ? 'streamProtection.enable' : 'streamProtection.disable';
    const label = next ? 'Enable Stream Protection' : 'Disable Stream Protection';
    try {
      await executeCommand(cmd, {}, false, label);
    } catch {
      setSpOptimistic(null); // revert on failure
    }
  };

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
    // Detect attachment placeholder: "📎 filename.ext" possibly with leading text
    const attachMatch = item.message.match(/📎\s+(.+)$/);
    const attachFileName = attachMatch?.[1]?.trim() ?? null;
    const textBeforeAttach = attachMatch
      ? item.message.replace(/📎\s+.+$/, '').trim()
      : item.message;
    const isImageAttach = attachFileName
      ? /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(attachFileName)
      : false;

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
          {textBeforeAttach.length > 0 && (
            <Text style={[
              { fontSize: fontSize.md, lineHeight: 22 },
              isUser ? { color: '#ffffff' } : { color: colors.text },
            ]}>
              {textBeforeAttach}
            </Text>
          )}
          {attachFileName && !isImageAttach && (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.xs,
              marginTop: textBeforeAttach ? spacing.xs : 0,
              backgroundColor: isUser ? 'rgba(0,0,0,0.15)' : colors.isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)',
              borderRadius: borderRadius.sm,
              paddingHorizontal: spacing.sm,
              paddingVertical: spacing.xs,
            }}>
              <Ionicons name="document-outline" size={14} color={isUser ? '#fff' : colors.textSecondary} />
              <Text style={{ fontSize: fontSize.xs, color: isUser ? '#fff' : colors.textSecondary }} numberOfLines={1}>
                {attachFileName}
              </Text>
            </View>
          )}
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
          {/* Section header */}
          <Pressable
            onPress={toggleCommands}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.md,
              gap: spacing.sm,
            }}
            accessibilityLabel={commandsExpanded ? 'Collapse commands' : 'Expand commands'}
            accessibilityRole="button"
          >
            <Ionicons name="game-controller-outline" size={16} color={colors.accent} />
            <Text style={{ flex: 1, fontSize: fontSize.md, fontWeight: '700', color: colors.text }}>Commands</Text>
            {isStreaming && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <PulseDot color={colors.critical} size={6} />
                <Text style={{ fontSize: fontSize.xs, color: colors.critical, fontWeight: '700' }}>LIVE</Text>
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
              contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.sm }}
              showsVerticalScrollIndicator={false}
            >
              {/* Camera tally row */}
              {hasAtem && tallyInputs.length > 0 && (
                <View style={{ marginBottom: spacing.xs }}>
                  <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600', marginBottom: spacing.xs, letterSpacing: 0.5 }}>
                    CAMERA SELECT
                  </Text>
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
                        compact
                      />
                    )}
                  />
                </View>
              )}

              {/* Stream + Recording row */}
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                {/* Stream */}
                <BigButton
                  icon={isStreaming ? 'stop-circle' : 'radio'}
                  label={isStreaming ? 'Stop Stream' : 'Start Stream'}
                  sublabel={isStreaming ? 'Tap to end broadcast' : 'Tap to go live'}
                  color={isStreaming ? colors.critical : colors.online}
                  colors={colors}
                  onPress={() => {
                    if (!isStreaming) {
                      const cmd = status?.obs?.connected ? 'obs.startStream' : 'atem.startStreaming';
                      sendCommand(cmd, {}, false, 'Start Stream');
                    } else {
                      const cmd = status?.obs?.streaming ? 'obs.stopStream'
                        : status?.atem?.streaming ? 'atem.stopStreaming'
                        : status?.encoder?.streaming ? 'encoder.stopStream'
                        : 'obs.stopStream';
                      sendCommand(cmd, {}, true, 'Stop Stream');
                    }
                  }}
                  pending={
                    pending === 'obs.startStream' || pending === 'atem.startStreaming' ||
                    pending === 'obs.stopStream' || pending === 'atem.stopStreaming' || pending === 'encoder.stopStream'
                  }
                  destructive={!!isStreaming}
                  active={!!isStreaming}
                />

                {/* Recording */}
                <BigButton
                  icon={isRecording ? 'stop-circle' : 'radio-button-on'}
                  label={isRecording ? 'Stop Recording' : 'Start Recording'}
                  sublabel={isRecording ? 'Tap to stop' : 'Tap to record'}
                  color={colors.critical}
                  colors={colors}
                  onPress={() => {
                    if (!isRecording) {
                      sendCommand('obs.startRecording', {}, false, 'Start Recording');
                    } else {
                      sendCommand('obs.stopRecording', {}, true, 'Stop Recording');
                    }
                  }}
                  pending={pending === 'obs.startRecording' || pending === 'obs.stopRecording'}
                  destructive={!!isRecording}
                  active={!!isRecording}
                />
              </View>

              {/* Stream Protection */}
              <BigButton
                icon={spEnabled ? 'shield-checkmark' : 'shield-outline'}
                label={spEnabled ? 'Stream Protection: ON' : 'Stream Protection: OFF'}
                sublabel={spEnabled ? 'Tap to disable protection' : 'Tap to enable protection'}
                color={spEnabled ? colors.online : colors.textMuted}
                colors={colors}
                onPress={handleSpToggle}
                pending={pending === 'streamProtection.enable' || pending === 'streamProtection.disable'}
                active={spEnabled}
                fullWidth
              />

              {/* ATEM Cut + Auto */}
              {hasAtem && (
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <BigButton
                    icon="cut-outline"
                    label="CUT"
                    sublabel="Hard cut"
                    color={colors.critical}
                    colors={colors}
                    onPress={() => sendCommand('atem.cut', {}, false, 'ATEM Cut')}
                    pending={pending === 'atem.cut'}
                  />
                  <BigButton
                    icon="swap-horizontal-outline"
                    label="AUTO"
                    sublabel="Auto transition"
                    color={colors.warning}
                    colors={colors}
                    onPress={() => sendCommand('atem.auto', {}, false, 'ATEM Auto')}
                    pending={pending === 'atem.auto'}
                  />
                </View>
              )}

              {/* ProPresenter */}
              {hasProPresenter && (
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <BigButton
                    icon="chevron-back-circle-outline"
                    label="Prev Slide"
                    sublabel="ProPresenter"
                    colors={colors}
                    onPress={() => sendCommand('propresenter.previous')}
                    pending={pending === 'propresenter.previous'}
                  />
                  <BigButton
                    icon="chevron-forward-circle-outline"
                    label="Next Slide"
                    sublabel="ProPresenter"
                    colors={colors}
                    onPress={() => sendCommand('propresenter.next')}
                    pending={pending === 'propresenter.next'}
                  />
                </View>
              )}
            </ScrollView>
          )}
        </View>

        {/* ── Engineer Chat section ── */}
        <View style={chatExpanded ? { flex: 1 } : {}}>
          {/* Section header */}
          <Pressable
            onPress={toggleChat}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.md,
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
              <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.text }}>Tally Engineer</Text>
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

              {/* Pending attachment preview */}
              {pendingAttachment && (
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.sm,
                  backgroundColor: colors.isDark ? 'rgba(0,230,118,0.08)' : 'rgba(0,230,118,0.06)',
                  borderTopWidth: 1,
                  borderTopColor: colors.isDark ? 'rgba(0,230,118,0.2)' : 'rgba(0,230,118,0.15)',
                  gap: spacing.sm,
                }}>
                  {pendingAttachmentUri ? (
                    <Image source={{ uri: pendingAttachmentUri }} style={{ width: 44, height: 44, borderRadius: borderRadius.sm }} />
                  ) : (
                    <View style={{
                      width: 44, height: 44, borderRadius: borderRadius.sm,
                      backgroundColor: colors.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                      justifyContent: 'center', alignItems: 'center',
                    }}>
                      <Ionicons name="document-outline" size={22} color={colors.accent} />
                    </View>
                  )}
                  <Text style={{ flex: 1, fontSize: fontSize.sm, color: colors.text }} numberOfLines={1}>
                    {pendingAttachment.fileName}
                  </Text>
                  <Pressable onPress={() => { setPendingAttachment(null); setPendingAttachmentUri(null); }} hitSlop={8}>
                    <Ionicons name="close-circle" size={18} color={colors.textMuted} />
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
                <Pressable
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: pendingAttachment
                      ? colors.isDark ? 'rgba(0,230,118,0.2)' : 'rgba(0,230,118,0.15)'
                      : colors.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginRight: spacing.sm,
                    borderWidth: 1,
                    borderColor: pendingAttachment ? colors.accent : colors.border,
                  }}
                  onPress={handleAttachmentPress}
                  accessibilityLabel="Attach file"
                  accessibilityRole="button"
                >
                  <Ionicons
                    name="attach"
                    size={18}
                    color={pendingAttachment ? colors.accent : colors.textMuted}
                  />
                </Pressable>
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
                  placeholder={pendingAttachment ? 'Add a caption...' : 'Type a message...'}
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
                    (!text.trim() && !pendingAttachment || isSending) && {
                      backgroundColor: colors.surface,
                      shadowOpacity: 0,
                    },
                  ]}
                  onPress={handleSend}
                  disabled={(!text.trim() && !pendingAttachment) || isSending}
                  accessibilityLabel="Send message"
                  accessibilityRole="button"
                >
                  <Ionicons
                    name="send"
                    size={20}
                    color={(text.trim() || pendingAttachment) && !isSending ? '#ffffff' : colors.textMuted}
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

// --- Big action button for live control ---

interface BigButtonProps {
  icon: string;
  label: string;
  sublabel?: string;
  color?: string;
  onPress: () => void;
  pending?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  active?: boolean;
  fullWidth?: boolean;
  colors: any;
}

function BigButton({ icon, label, sublabel, color, onPress, pending, disabled, destructive, active, fullWidth, colors }: BigButtonProps) {
  const btnColor = color || colors.text;
  const bgColor = destructive
    ? 'rgba(239, 68, 68, 0.12)'
    : active
    ? `${btnColor}14`
    : colors.isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  const borderColor = active
    ? `${btnColor}60`
    : destructive
    ? 'rgba(239, 68, 68, 0.25)'
    : colors.border;

  return (
    <Pressable
      style={({ pressed }) => [
        {
          flex: fullWidth ? undefined : 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          backgroundColor: bgColor,
          borderRadius: borderRadius.md,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.md,
          borderWidth: 1,
          borderColor,
          minHeight: 60,
        },
        pressed && { opacity: 0.75 },
        disabled && { opacity: 0.35 },
        pending && { borderColor: colors.accent },
      ]}
      onPress={onPress}
      disabled={disabled || pending}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <View style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: active || destructive ? `${btnColor}20` : colors.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
        justifyContent: 'center',
        alignItems: 'center',
      }}>
        <Ionicons
          name={(pending ? 'ellipsis-horizontal' : icon) as any}
          size={20}
          color={disabled ? colors.textMuted : btnColor}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: disabled ? colors.textMuted : colors.text }} numberOfLines={1}>
          {pending ? 'Sending...' : label}
        </Text>
        {sublabel && !pending && (
          <Text style={{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 }} numberOfLines={1}>
            {sublabel}
          </Text>
        )}
      </View>
      {active && !pending && (
        <View style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: btnColor,
        }} />
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
