import React from 'react';
import { View, Text } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import { spacing, fontSize } from '../theme/spacing';

interface DeviceRowProps {
  name: string;
  type: string;
  connected: boolean;
  detail?: string;
}

export function DeviceRow({ name, type, connected, detail }: DeviceRowProps) {
  const colors = useThemeColors();
  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    }}>
      <View style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: spacing.md,
        backgroundColor: connected ? colors.online : colors.offline,
      }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: fontSize.md, color: colors.text, fontWeight: '500' }} numberOfLines={1} ellipsizeMode="tail">{name}</Text>
        {detail ? <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 }} numberOfLines={1} ellipsizeMode="tail">{detail}</Text> : null}
      </View>
      <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: connected ? colors.online : colors.offline }}>
        {connected ? 'Connected' : 'Disconnected'}
      </Text>
    </View>
  );
}
