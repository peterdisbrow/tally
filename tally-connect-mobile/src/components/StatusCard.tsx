import React from 'react';
import { View, Text } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../theme/spacing';

interface StatusCardProps {
  title: string;
  value: string;
  subtitle?: string;
  color?: string;
  icon?: string;
}

export function StatusCard({ title, value, subtitle, color, icon }: StatusCardProps) {
  const colors = useThemeColors();
  return (
    <View style={{
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      padding: spacing.lg,
      borderWidth: 1,
      borderColor: colors.border,
    }}>
      <Text style={{
        fontSize: fontSize.xs,
        color: colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: spacing.xs,
      }}>{title}</Text>
      <Text style={[{
        fontSize: fontSize.xxl,
        fontWeight: '700',
        color: colors.text,
      }, color ? { color } : null]}>
        {icon ? `${icon} ` : ''}{value}
      </Text>
      {subtitle ? <Text style={{
        fontSize: fontSize.xs,
        color: colors.textMuted,
        marginTop: spacing.xs,
      }}>{subtitle}</Text> : null}
    </View>
  );
}
