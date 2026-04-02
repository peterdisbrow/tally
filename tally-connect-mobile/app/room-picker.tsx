import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useStatusStore } from '../src/stores/statusStore';
import { useChatStore } from '../src/stores/chatStore';
import { useAuthStore } from '../src/stores/authStore';
import { api } from '../src/api/client';
import { colors } from '../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';
import type { Room } from '../src/ws/types';

function roomIcon(name: string): string {
  const lower = name.toLowerCase();
  if (/sanctuary|worship|chapel|main/.test(lower)) return 'home';
  if (/gym|hall|multi|fellowship/.test(lower)) return 'business';
  if (/youth|kids|children/.test(lower)) return 'people';
  if (/outdoor|tent|overflow/.test(lower)) return 'leaf';
  return 'videocam';
}

export default function RoomPickerScreen() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const churchName = useAuthStore((s) => s.churchName);
  const setActiveRoom = useStatusStore((s) => s.setActiveRoom);

  useEffect(() => {
    loadRooms();
  }, []);

  async function loadRooms() {
    setLoading(true);
    try {
      const data = await api<{ rooms: Array<{ id: string; name: string; is_default?: boolean }> }>('/api/church/rooms');
      setRooms((data.rooms || []).map((r) => ({ id: r.id, name: r.name })));
    } catch {
      // Retry silently
    }
    setLoading(false);
  }

  function selectRoom(room: Room) {
    // Clear all stores for fresh state
    useChatStore.getState().clearMessages();
    const statusStore = useStatusStore.getState();
    statusStore.setActiveRoom(room.id);

    // Navigate to tabs — replace so back doesn't return here accidentally
    router.replace('/(tabs)');
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.churchName}>{churchName || 'Tally Connect'}</Text>
        <Text style={styles.subtitle}>Select a room to monitor</Text>
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>Loading rooms...</Text>
        </View>
      ) : rooms.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No Rooms Found</Text>
          <Text style={styles.emptyText}>
            Add rooms in the Tally Connect portal, then pull to refresh.
          </Text>
          <Pressable style={styles.retryButton} onPress={loadRooms}>
            <Ionicons name="refresh" size={18} color={colors.white} />
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.roomCard,
                pressed && styles.roomCardPressed,
              ]}
              onPress={() => selectRoom(item)}
            >
              <View style={styles.roomIconContainer}>
                <Ionicons name={roomIcon(item.name) as any} size={28} color={colors.accent} />
              </View>
              <View style={styles.roomInfo}>
                <Text style={styles.roomName}>{item.name}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: spacing.xxl,
    paddingTop: 60,
    paddingBottom: spacing.xxl,
  },
  churchName: {
    fontSize: fontSize.xxxl,
    fontWeight: '800',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: fontSize.lg,
    color: colors.textSecondary,
  },
  list: {
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxxl,
  },
  roomCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.xl,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  roomCardPressed: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.accent,
  },
  roomIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.lg,
  },
  roomInfo: {
    flex: 1,
  },
  roomName: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    marginTop: spacing.lg,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxxl,
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
    marginBottom: spacing.xxl,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
  },
  retryText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.white,
    marginLeft: spacing.sm,
  },
});
