import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, ActivityIndicator,
  Modal, TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
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
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [creating, setCreating] = useState(false);
  const churchName = useAuthStore((s) => s.churchName);
  const logout = useAuthStore((s) => s.logout);
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
      const loaded = (data.rooms || []).map((r) => ({ id: r.id, name: r.name }));
      setRooms(loaded);

      // If the user was previously in a room that still exists, skip the picker
      const previousRoomId = useStatusStore.getState().activeRoomId;
      if (previousRoomId && loaded.some((r) => r.id === previousRoomId)) {
        router.replace('/(tabs)');
        return;
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      Sentry.captureException(e, { extra: { context: 'loadRooms' } });
      setError(e instanceof Error ? e.message : 'Failed to load rooms. Check your connection and try again.');
    }
    if (!signal?.aborted) setLoading(false);
  }

  function selectRoom(room: Room) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    useChatStore.getState().clearMessages();
    const statusStore = useStatusStore.getState();
    statusStore.setActiveRoom(room.id);
    router.replace('/(tabs)');
  }

  function handleLogout() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => logout(),
      },
    ]);
  }

  async function handleCreateRoom() {
    const name = newRoomName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await api('/api/church/app/rooms', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setShowCreateModal(false);
      setNewRoomName('');
      loadRooms();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create room.';
      Alert.alert('Create Room Failed', msg);
    } finally {
      setCreating(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: spacing.xxl, paddingBottom: spacing.xxl, paddingTop: insets.top + 16, flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: fontSize.xxxl, fontWeight: '800', color: colors.text, marginBottom: spacing.xs }}>{churchName || 'Tally Connect'}</Text>
          <Text style={{ fontSize: fontSize.lg, color: colors.textSecondary }}>Select a room to monitor</Text>
        </View>
        <Pressable
          onPress={handleLogout}
          style={({ pressed }) => ({
            marginTop: 4,
            padding: spacing.sm,
            opacity: pressed ? 0.6 : 1,
          })}
          hitSlop={12}
        >
          <Ionicons name="log-out-outline" size={26} color={colors.textMuted} />
        </Pressable>
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
            Create a room to get started, or add rooms in the Tally Connect portal.
          </Text>
          <Pressable
            style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.accent, borderRadius: borderRadius.md, paddingHorizontal: spacing.xxl, paddingVertical: spacing.md, marginBottom: spacing.md }}
            onPress={() => setShowCreateModal(true)}
          >
            <Ionicons name="add" size={18} color="#ffffff" />
            <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: '#ffffff', marginLeft: spacing.sm }}>Create Room</Text>
          </Pressable>
          <Pressable style={{ flexDirection: 'row', alignItems: 'center', borderRadius: borderRadius.md, paddingHorizontal: spacing.xxl, paddingVertical: spacing.md }} onPress={() => loadRooms()}>
            <Ionicons name="refresh" size={18} color={colors.textSecondary} />
            <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.textSecondary, marginLeft: spacing.sm }}>Refresh</Text>
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
                backgroundColor: colors.isDark ? 'rgba(0, 230, 118, 0.1)' : 'rgba(0, 230, 118, 0.08)',
                justifyContent: 'center',
                alignItems: 'center',
                marginRight: spacing.lg,
              }}>
                <Ionicons name={roomIcon(item.name) as any} size={28} color={colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }} numberOfLines={1} ellipsizeMode="tail">{item.name}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
          )}
        />
      )}

      <Modal
        visible={showCreateModal}
        transparent
        animationType="fade"
        onRequestClose={() => { setShowCreateModal(false); setNewRoomName(''); }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }}
        >
          <View style={{ backgroundColor: colors.surface, borderRadius: borderRadius.lg, padding: spacing.xxl, width: '85%', maxWidth: 360 }}>
            <Text style={{ fontSize: fontSize.xl, fontWeight: '700', color: colors.text, marginBottom: spacing.lg }}>Create Room</Text>
            <TextInput
              style={{
                backgroundColor: colors.bg,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: borderRadius.md,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
                fontSize: fontSize.md,
                color: colors.text,
                marginBottom: spacing.xxl,
              }}
              placeholder="Room name (e.g. Sanctuary)"
              placeholderTextColor={colors.textMuted}
              value={newRoomName}
              onChangeText={setNewRoomName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleCreateRoom}
            />
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <Pressable
                style={({ pressed }) => ({
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: spacing.md,
                  borderRadius: borderRadius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  opacity: pressed ? 0.7 : 1,
                })}
                onPress={() => { setShowCreateModal(false); setNewRoomName(''); }}
              >
                <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.textSecondary }}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => ({
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: spacing.md,
                  borderRadius: borderRadius.md,
                  backgroundColor: newRoomName.trim() ? colors.accent : colors.border,
                  opacity: pressed ? 0.8 : 1,
                })}
                onPress={handleCreateRoom}
                disabled={creating || !newRoomName.trim()}
              >
                {creating ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: '#ffffff' }}>Create</Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
