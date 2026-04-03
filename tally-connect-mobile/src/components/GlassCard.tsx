import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { colors } from '../theme/colors';
import { borderRadius, spacing } from '../theme/spacing';

interface GlassCardProps {
  children: React.ReactNode;
  glowColor?: string;
  style?: ViewStyle;
}

export function GlassCard({ children, glowColor, style }: GlassCardProps) {
  return (
    <View style={[styles.card, glowColor && { shadowColor: glowColor, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
});
