import React, { useState } from 'react';
import { View, Text, Pressable, Modal, FlatList } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../theme/spacing';
import { useStatusStore } from '../stores/statusStore';

export function RoomSelector() {
  const [showPicker, setShowPicker] = useState(false);
  const rooms = useStatusStore((s) => s.rooms);
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const setActiveRoom = useStatusStore((s) => s.setActiveRoom);
  const colors = useThemeColors();

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  if (rooms.length <= 1) {
    return (
      <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '600' }}>{activeRoom?.name || 'Default Room'}</Text>
    );
  }

  return (
    <>
      <Pressable onPress={() => setShowPicker(true)} style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: borderRadius.sm,
        borderWidth: 1,
        borderColor: colors.border,
      }}>
        <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '600', marginRight: spacing.sm }}>{activeRoom?.name || 'Select Room'}</Text>
        <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>{'>'}</Text>
      </Pressable>

      <Modal visible={showPicker} transparent animationType="slide">
        <Pressable style={{ flex: 1, backgroundColor: colors.overlayBg, justifyContent: 'flex-end' }} onPress={() => setShowPicker(false)}>
          <View style={{
            backgroundColor: colors.surfaceElevated,
            borderTopLeftRadius: borderRadius.xl,
            borderTopRightRadius: borderRadius.xl,
            padding: spacing.xxl,
            maxHeight: '60%',
          }}>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, marginBottom: spacing.lg, textAlign: 'center' }}>Select Room</Text>
            <FlatList
              data={rooms}
              keyExtractor={(r) => r.id}
              renderItem={({ item }) => (
                <Pressable
                  style={[
                    {
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: spacing.lg,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.border,
                    },
                    item.id === activeRoomId && {
                      backgroundColor: colors.isDark ? 'rgba(34, 197, 94, 0.1)' : 'rgba(34, 197, 94, 0.06)',
                    },
                  ]}
                  onPress={() => {
                    setActiveRoom(item.id);
                    setShowPicker(false);
                  }}
                >
                  <View style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    marginRight: spacing.md,
                    backgroundColor: item.connected !== false ? colors.online : colors.offline,
                  }} />
                  <Text style={{ flex: 1, fontSize: fontSize.lg, color: colors.text }}>{item.name}</Text>
                  {item.id === activeRoomId && <Text style={{ fontSize: fontSize.md, color: colors.accent, fontWeight: '700' }}>{'OK'}</Text>}
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
