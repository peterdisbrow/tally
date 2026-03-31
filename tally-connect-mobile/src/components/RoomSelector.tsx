import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Modal, FlatList } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, borderRadius, fontSize } from '../theme/spacing';
import { useStatusStore } from '../stores/statusStore';

export function RoomSelector() {
  const [showPicker, setShowPicker] = useState(false);
  const rooms = useStatusStore((s) => s.rooms);
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const setActiveRoom = useStatusStore((s) => s.setActiveRoom);

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  if (rooms.length <= 1) {
    return (
      <Text style={styles.singleRoom}>{activeRoom?.name || 'Default Room'}</Text>
    );
  }

  return (
    <>
      <Pressable onPress={() => setShowPicker(true)} style={styles.selector}>
        <Text style={styles.roomName}>{activeRoom?.name || 'Select Room'}</Text>
        <Text style={styles.chevron}>{'>'}</Text>
      </Pressable>

      <Modal visible={showPicker} transparent animationType="slide">
        <Pressable style={styles.overlay} onPress={() => setShowPicker(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Select Room</Text>
            <FlatList
              data={rooms}
              keyExtractor={(r) => r.id}
              renderItem={({ item }) => (
                <Pressable
                  style={[
                    styles.roomRow,
                    item.id === activeRoomId && styles.roomRowActive,
                  ]}
                  onPress={() => {
                    setActiveRoom(item.id);
                    setShowPicker(false);
                  }}
                >
                  <View style={[styles.roomDot, {
                    backgroundColor: item.connected !== false ? colors.online : colors.offline,
                  }]} />
                  <Text style={styles.roomRowName}>{item.name}</Text>
                  {item.id === activeRoomId && <Text style={styles.check}>{'OK'}</Text>}
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  roomName: {
    fontSize: fontSize.md,
    color: colors.text,
    fontWeight: '600',
    marginRight: spacing.sm,
  },
  chevron: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  singleRoom: {
    fontSize: fontSize.md,
    color: colors.text,
    fontWeight: '600',
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surfaceElevated,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    padding: spacing.xxl,
    maxHeight: '60%',
  },
  sheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.lg,
    textAlign: 'center',
  },
  roomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  roomRowActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
  },
  roomDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: spacing.md,
  },
  roomRowName: {
    flex: 1,
    fontSize: fontSize.lg,
    color: colors.text,
  },
  check: {
    fontSize: fontSize.md,
    color: colors.accent,
    fontWeight: '700',
  },
});
