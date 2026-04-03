import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

interface PulseDotProps {
  color: string;
  size?: number;
  pulseScale?: number;
}

export function PulseDot({ color, size = 8, pulseScale = 2.2 }: PulseDotProps) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ]),
    ).start();
  }, [anim]);

  const pulseOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.6, 0],
  });
  const pulseScaleAnim = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, pulseScale],
  });

  return (
    <View style={[styles.wrapper, { width: size * pulseScale, height: size * pulseScale }]}>
      <Animated.View
        style={[
          styles.pulse,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            opacity: pulseOpacity,
            transform: [{ scale: pulseScaleAnim }],
          },
        ]}
      />
      <View
        style={[
          styles.dot,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulse: {
    position: 'absolute',
  },
  dot: {},
});
