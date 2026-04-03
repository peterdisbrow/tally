import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStatusStore } from '../src/stores/statusStore';
import { useChatStore } from '../src/stores/chatStore';
import { useAuthStore } from '../src/stores/authStore';
import { api } from '../src/api/client';
import { useThemeColors } from '../src/theme/ThemeContext';
import { Sentry } from '../src/lib/sentry';
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
  const [error, setError] = useState<string | null>(null);
  const churchName = useAuthStore((s) => s.churchName);
  const setActiveRoom = useStatusStore((s) => s.setActiveRoom);
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();

  useEffect(() => {
    const controller = new AbortController();
    loadRooms(controller.signal);
    return () => controller.abort();
  }, []);

  async function loadRooms(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ rooms: Array<{ id: string; name: string; is_default?: boolean }> }>('/api/church/rooms', { signal });
      setRooms((data.rooms || []).map((r) => ({ id: r.id, name: r.name })));
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      Sentry.captureException(e, { extra: { context: 'loadRooms' } });
      setError(e instanceof Error ? e.message : 'Failed to load rooms. Check your connection and try again.');
    }
    if (!signal?.aborted) setLoading(false);
  }

  function selectRoom(room: Room) {
    useChatStore.getState().clearMessages();
    const statusStore = useStatusStore.getState();
    statusStore.setActiveRoom(room.id);
    router.replace('/(tabs)');
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: spacing.xxl, paddingBottom: spacing.xxl, paddingTop: insets.top + 16 }}>
        <Text style={{ fontSize: fontSize.xxxl, fontWeight: '800', color: colors.text, marginBottom: spacing.xs }}>{churchName || 'Tally Connect'}</Text>
        <Text style={{ fontSize: fontSize.lg, color: colors.textSecondary }}>Select a room to monitor</Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, marginTop: spacing.lg }}>Loading rooms...</Text>
        </View>
      ) : error ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xxxl }}>
          <Ionicons name="cloud-offline-outline" size={48} color={colors.critical} />
          <Text style={{ fontSize: fontSize.xl, fontWeight: '700', color: colors.text, marginTop: spacing.lg, marginBottom: spacing.sm }}>Connection Error</Text>
          <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: spacing.xxl }}>{error}</Text>
          <Pressable style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.accent, borderRadius: borderRadius.md, paddingHorizontal: spacing.xxl, paddingVertical: spacing.md }} onPress={() => loadRooms()}>
            <Ionicons name="refresh" size={18} color="#ffffff" />
            <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: '#ffffff', marginLeft: spacing.sm }}>Retry</Text>
          </Pressable>
        </View>
      ) : rooms.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xxxl }}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
          <Text style={{ fontSize: fontSize.xl, fontWeight: '700', color: colors.text, marginTop: spacing.lg, marginBottom: spacing.sm }}>No Rooms Found</Text>
          <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: spacing.xxl }}>
            Add rooms in the Tally Connect portal, then pull to refresh.
          </Text>
          <Pressable style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.accent, borderRadius: borderRadius.md, paddingHorizontal: spacing.xxl, paddingVertical: spacing.md }} onPress={() => loadRooms()}>
            <Ionicons name="refresh" size={18} color="#ffffff" />
            <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: '#ffffff', marginLeft: spacing.sm }}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: spacing.xxl, paddingBottom: spacing.xxxl }}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: colors.surface,
                  borderRadius: borderRadius.md,
                  padding: spacing.xl,
                  marginBottom: spacing.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                },
                pressed && { backgroundColor: colors.surfaceElevated, borderColor: colors.accent },
              ]}
              onPress={() => selectRoom(item)}
            >
              <View style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: colors.isDark ? 'rgba(34, 197, 94, 0.1)' : 'rgba(34, 197, 94, 0.08)',
                justifyContent: 'center',
                alignItems: 'center',
                marginRight: spacing.lg,
              }}>
                <Ionicons name={roomIcon(item.name) as any} size={28} color={colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>{item.name}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
