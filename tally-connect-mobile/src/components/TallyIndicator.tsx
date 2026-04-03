import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors } from '../theme/colors';
import { spacing, borderRadius, fontSize } from '../theme/spacing';

interface TallyIndicatorProps {
  inputNumber: number;
  inputName: string;
  isProgram: boolean;
  isPreview: boolean;
  onPress?: () => void;
}

export function TallyIndicator({ inputNumber, inputName, isProgram, isPreview, onPress }: TallyIndicatorProps) {
  const label = isProgram ? 'PGM' : isPreview ? 'PVW' : '';

  const handlePress = () => {
    if (onPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress();
    }
  };

  return (
    <Pressable onPress={handlePress} disabled={!onPress}>
      <View style={[
        styles.indicator,
        isProgram && styles.pgm,
        isPreview && styles.pvw,
        !isProgram && !isPreview && styles.off,
      ]}>
        <Text style={styles.number}>{inputNumber}</Text>
        <Text style={styles.name} numberOfLines={1}>{inputName}</Text>
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  indicator: {
    width: 76,
    height: 84,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  pgm: {
    backgroundColor: 'rgba(239, 68, 68, 0.85)',
    shadowColor: colors.tallyProgram,
    shadowOpacity: 0.6,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  pvw: {
    backgroundColor: 'rgba(34, 197, 94, 0.7)',
    shadowColor: colors.tallyPreview,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  off: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  number: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.white,
  },
  name: {
    fontSize: fontSize.xs,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 2,
    maxWidth: 64,
    textAlign: 'center',
  },
  label: {
    fontSize: 9,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.9)',
    marginTop: 2,
    letterSpacing: 1,
  },
});
