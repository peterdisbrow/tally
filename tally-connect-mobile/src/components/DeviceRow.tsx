import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, fontSize } from '../theme/spacing';

interface DeviceRowProps {
  name: string;
  type: string;
  connected: boolean;
  detail?: string;
}

export function DeviceRow({ name, type, connected, detail }: DeviceRowProps) {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: connected ? colors.online : colors.offline }]} />
      <View style={styles.info}>
        <Text style={styles.name}>{name}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      <Text style={[styles.status, { color: connected ? colors.online : colors.offline }]}>
        {connected ? 'Online' : 'Offline'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.md,
  },
  info: {
    flex: 1,
  },
  name: {
    fontSize: fontSize.md,
    color: colors.text,
    fontWeight: '500',
  },
  detail: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: 2,
  },
  status: {
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
});
