import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, FlatList,
  Pressable, KeyboardAvoidingView, Platform,
  Alert as RNAlert, NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useChatStore } from '../../src/stores/chatStore';
import { useStatusStore } from '../../src/stores/statusStore';
import { useThemeColors } from '../../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { PulseDot } from '../../src/components/PulseDot';
import type { ChatMessage } from '../../src/ws/types';

export default function ChatScreen() {
  const messagesByRoom = useChatStore((s) => s.messagesByRoom);
  const isSending = useChatStore((s) => s.isSending);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const messages = messagesByRoom[activeRoomId ?? '__no_room__'] ?? [];
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<FlatList>(null);
  const isAtBottom = useRef(true);
  const colors = useThemeColors();

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

  useEffect(() => {
    if (!sendError) return;
    const timer = setTimeout(() => setSendError(null), 5000);
    return () => clearTimeout(timer);
  }, [sendError]);

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
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface,
      }}>
        <View style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: colors.isDark ? 'rgba(0, 230, 118, 0.2)' : 'rgba(0, 230, 118, 0.12)',
          justifyContent: 'center',
          alignItems: 'center',
          marginRight: spacing.md,
          borderWidth: 1,
          borderColor: colors.isDark ? 'rgba(0, 230, 118, 0.3)' : 'rgba(0, 230, 118, 0.2)',
        }}>
          <Ionicons name="hardware-chip-outline" size={20} color={colors.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.text }}>Tally Engineer</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 }}>
            <PulseDot color={colors.online} size={6} />
            <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>Monitoring your stream</Text>
          </View>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item, idx) => item.id || `${idx}`}
        renderItem={renderMessage}
        contentContainerStyle={{ padding: spacing.lg, flexGrow: 1, justifyContent: 'flex-end' }}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        onContentSizeChange={handleContentSizeChange}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 80 }}>
            <Ionicons name="chatbubbles-outline" size={48} color={colors.textMuted} style={{ marginBottom: spacing.md }} />
            <Text style={{ fontSize: fontSize.xl, fontWeight: '700', color: colors.text, marginBottom: spacing.sm }}>Tally Engineer</Text>
            <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
              Ask questions, send commands, or get diagnostics.{'\n'}
              Try "What's the stream status?" or "Switch to camera 2"
            </Text>
          </View>
        }
      />

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
    </KeyboardAvoidingView>
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
