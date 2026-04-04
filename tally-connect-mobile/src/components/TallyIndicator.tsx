import React from 'react';
import { View, Text, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useThemeColors } from '../theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../theme/spacing';

interface TallyIndicatorProps {
  inputNumber: number;
  inputName: string;
  isProgram: boolean;
  isPreview: boolean;
  onPress?: () => void;
}

export function TallyIndicator({ inputNumber, inputName, isProgram, isPreview, onPress }: TallyIndicatorProps) {
  const colors = useThemeColors();
  const label = isProgram ? 'PGM' : isPreview ? 'PVW' : '';

  const handlePress = () => {
    if (onPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress();
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={!onPress}
      accessibilityLabel={`Input ${inputNumber}: ${inputName}${isProgram ? ', Program' : isPreview ? ', Preview' : ''}`}
      accessibilityRole="button"
    >
      <View style={[
        {
          width: 76,
          height: 84,
          borderRadius: borderRadius.md,
          alignItems: 'center' as const,
          justifyContent: 'center' as const,
          marginRight: spacing.sm,
        },
        isProgram && {
          backgroundColor: 'rgba(239, 68, 68, 0.85)',
          shadowColor: colors.tallyProgram,
          shadowOpacity: 0.6,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 8,
        },
        isPreview && {
          backgroundColor: 'rgba(0, 230, 118, 0.7)',
          shadowColor: colors.tallyPreview,
          shadowOpacity: 0.4,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        },
        !isProgram && !isPreview && {
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        },
      ]}>
        <Text style={{ fontSize: fontSize.xl, fontWeight: '800', color: isProgram || isPreview ? '#ffffff' : colors.text }}>{inputNumber}</Text>
        <Text style={{ fontSize: fontSize.xs, color: isProgram || isPreview ? 'rgba(255,255,255,0.8)' : colors.textSecondary, marginTop: 2, maxWidth: 64, textAlign: 'center' }} numberOfLines={1}>{inputName}</Text>
        {label ? <Text style={{ fontSize: 9, fontWeight: '700', color: 'rgba(255,255,255,0.9)', marginTop: 2, letterSpacing: 1 }}>{label}</Text> : null}
      </View>
    </Pressable>
  );
}
