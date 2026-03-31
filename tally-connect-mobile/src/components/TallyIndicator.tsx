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
  const bgColor = isProgram
    ? colors.tallyProgram
    : isPreview
      ? colors.tallyPreview
      : colors.tallyOff;

  const label = isProgram ? 'PGM' : isPreview ? 'PVW' : '';

  const handlePress = () => {
    if (onPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress();
    }
  };

  return (
    <Pressable onPress={handlePress} disabled={!onPress}>
      <View style={[styles.indicator, { backgroundColor: bgColor }]}>
        <Text style={styles.number}>{inputNumber}</Text>
        <Text style={styles.name} numberOfLines={1}>{inputName}</Text>
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  indicator: {
    width: 72,
    height: 80,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
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
    maxWidth: 60,
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
