import React from 'react';
import { View, ViewStyle } from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import { borderRadius, spacing } from '../theme/spacing';

interface GlassCardProps {
  children: React.ReactNode;
  glowColor?: string;
  style?: ViewStyle;
}

export function GlassCard({ children, glowColor, style }: GlassCardProps) {
  const colors = useThemeColors();
  return (
    <View style={[{
      backgroundColor: colors.surfaceElevated,
      borderRadius: borderRadius.lg,
      padding: spacing.lg,
      borderWidth: 1,
      borderColor: colors.border,
    }, glowColor && { shadowColor: glowColor, shadowOpacity: colors.cardShadowOpacity, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 }, style]}>
      {children}
    </View>
  );
}
