import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Pressable } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { useThemeColors } from '../../src/theme/ThemeContext';
import { useAlertStore } from '../../src/stores/alertStore';
import { useStatusStore } from '../../src/stores/statusStore';
import { useUpdateStore } from '../../src/stores/updateStore';
import { fontSize } from '../../src/theme/spacing';

function ConnectionBanner() {
  const wsConnected = useStatusStore((s) => s.wsConnected);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const [showConnected, setShowConnected] = useState(false);
  const pulseAnim = useRef(new Animated.Value(0.4)).current;
  const wasDisconnected = useRef(false);

  useEffect(() => {
    if (!wsConnected) {
      wasDisconnected.current = true;
      setVisible(true);
      setShowConnected(false);
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 0.4, duration: 800, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
      if (wasDisconnected.current) {
        setShowConnected(true);
        setVisible(true);
        const timer = setTimeout(() => {
          setVisible(false);
          setShowConnected(false);
          wasDisconnected.current = false;
        }, 2000);
        return () => clearTimeout(timer);
      } else {
        setVisible(false);
      }
    }
  }, [wsConnected]);

  if (!visible) return null;

  const bgColor = showConnected ? colors.online : '#d97706';
  return (
    <Animated.View style={[bannerStyles.banner, { paddingTop: insets.top + 4, backgroundColor: bgColor, opacity: showConnected ? 1 : pulseAnim }]}>
      <Text style={bannerStyles.text}>{showConnected ? 'Connected' : 'Reconnecting...'}</Text>
    </Animated.View>
  );
}

const bannerStyles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    alignItems: 'center',
    paddingBottom: 6,
  },
  text: {
    color: '#ffffff',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
});

function UpdateBanner() {
  const updateReady = useUpdateStore((s) => s.updateReady);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  if (!updateReady) return null;

  return (
    <Pressable
      style={[updateBannerStyles.banner, { paddingTop: insets.top + 4, backgroundColor: colors.accent }]}
      onPress={() => Updates.reloadAsync()}
    >
      <Ionicons name="arrow-down-circle" size={16} color="#ffffff" />
      <Text style={updateBannerStyles.text}>Update available — tap to restart</Text>
    </Pressable>
  );
}

const updateBannerStyles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 99,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingBottom: 6,
  },
  text: {
    color: '#ffffff',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
});

export default function TabLayout() {
  const unreadCount = useAlertStore((s) => s.unreadCount);
  const colors = useThemeColors();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
    <ConnectionBanner />
    <UpdateBanner />
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications-outline" size={size} color={color} />
          ),
          tabBarBadge: unreadCount > 0 ? unreadCount : undefined,
        }}
      />
      <Tabs.Screen
        name="actions"
        options={{
          title: 'Commands',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="flash-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Equipment',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="hardware-chip-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="checks"
        options={{
          title: 'Checks',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="clipboard-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Engineer',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-ellipses-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
    </View>
  );
}
