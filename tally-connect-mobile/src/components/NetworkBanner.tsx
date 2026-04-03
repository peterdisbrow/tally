import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';

interface NetworkBannerProps {
  isConnected: boolean | null;
}

/**
 * Persistent banner that slides in from the top when network connectivity
 * is lost, and slides out when it returns. Renders nothing until the
 * initial network check completes (isConnected !== null).
 */
export function NetworkBanner({ isConnected }: NetworkBannerProps) {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(-60)).current;
  const visible = isConnected === false;

  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: visible ? 0 : -60,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [visible, slideAnim]);

  // Don't mount anything until we have an initial reading
  if (isConnected === null) return null;

  return (
    <Animated.View
      style={[
        styles.banner,
        { paddingTop: insets.top + 8 },
        { transform: [{ translateY: slideAnim }] },
      ]}
      pointerEvents="none"
    >
      <View style={styles.inner}>
        <Text style={styles.icon}>⚠</Text>
        <Text style={styles.text}>No internet connection</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    backgroundColor: colors.warning,
    paddingBottom: 10,
    paddingHorizontal: 16,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  icon: {
    fontSize: 14,
    color: colors.black,
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.black,
    letterSpacing: 0.2,
  },
});
