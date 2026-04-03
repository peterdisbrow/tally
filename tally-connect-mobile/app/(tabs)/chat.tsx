import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, FlatList, StyleSheet,
  Pressable, KeyboardAvoidingView, Platform,
  Alert as RNAlert, NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useChatStore } from '../../src/stores/chatStore';
import { useStatusStore } from '../../src/stores/statusStore';
import { colors } from '../../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import type { ChatMessage } from '../../src/ws/types';

export default function ChatScreen() {
  const messages = useChatStore((s) => s.messages);
  const isSending = useChatStore((s) => s.isSending);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<FlatList>(null);
  const isAtBottom = useRef(true);

  const clearMessages = useChatStore((s) => s.clearMessages);

  // Clear stale messages when room changes; new messages arrive via WebSocket
  useEffect(() => {
    clearMessages();
  }, [activeRoomId]);

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

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const isUser = item.senderRole === 'td';

    return (
      <View style={[
        msgStyles.row,
        isUser ? msgStyles.rowRight : msgStyles.rowLeft,
      ]}>
        <View style={[
          msgStyles.bubble,
          isUser ? msgStyles.bubbleUser : msgStyles.bubbleAI,
        ]}>
          {!isUser && (
            <Text style={msgStyles.sender}>
              {item.senderName || 'Tally Engineer'}
            </Text>
          )}
          <Text style={[
            msgStyles.text,
            isUser ? msgStyles.textUser : msgStyles.textAI,
          ]}>
            {item.message}
          </Text>
          <Text style={[
            msgStyles.time,
            isUser ? msgStyles.timeUser : msgStyles.timeAI,
          ]}>
            {formatTime(item.timestamp)}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item, idx) => item.id || `${idx}`}
        renderItem={renderMessage}
        contentContainerStyle={styles.list}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        onContentSizeChange={handleContentSizeChange}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="chatbubble-ellipses-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>Tally Engineer</Text>
            <Text style={styles.emptyText}>
              Ask questions, send commands, or get diagnostics.{'\n'}
              Try "What's the stream status?" or "Switch to camera 2"
            </Text>
          </View>
        }
      />

      {sendError && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{sendError}</Text>
          <Pressable onPress={() => setSendError(null)}>
            <Ionicons name="close-circle" size={18} color={colors.critical} />
          </Pressable>
        </View>
      )}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          placeholder="Type a message..."
          placeholderTextColor={colors.textMuted}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={1000}
          returnKeyType="default"
        />
        <Pressable
          style={[styles.sendButton, (!text.trim() || isSending) && styles.sendDisabled]}
          onPress={handleSend}
          disabled={!text.trim() || isSending}
        >
          <Ionicons
            name="send"
            size={20}
            color={text.trim() && !isSending ? colors.white : colors.textMuted}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  list: {
    padding: spacing.lg,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  emptyText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderTopWidth: 1,
    borderTopColor: colors.critical,
  },
  errorText: {
    fontSize: fontSize.sm,
    color: colors.critical,
    flex: 1,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: spacing.sm,
  },
  sendDisabled: {
    backgroundColor: colors.surface,
  },
});

const msgStyles = StyleSheet.create({
  row: {
    marginBottom: spacing.md,
  },
  rowLeft: {
    alignItems: 'flex-start',
  },
  rowRight: {
    alignItems: 'flex-end',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: borderRadius.lg,
    padding: spacing.md,
  },
  bubbleUser: {
    backgroundColor: colors.accent,
    borderBottomRightRadius: 4,
  },
  bubbleAI: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  sender: {
    fontSize: fontSize.xs,
    color: colors.accentLight,
    fontWeight: '600',
    marginBottom: 4,
  },
  text: {
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  textUser: {
    color: colors.white,
  },
  textAI: {
    color: colors.text,
  },
  time: {
    fontSize: 10,
    marginTop: 4,
    alignSelf: 'flex-end',
  },
  timeUser: {
    color: 'rgba(255,255,255,0.5)',
  },
  timeAI: {
    color: colors.textMuted,
  },
});
