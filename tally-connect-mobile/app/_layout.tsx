import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAuthStore } from '../src/stores/authStore';
import { useChatStore } from '../src/stores/chatStore';
import { useNotifications } from '../src/hooks/useNotifications';
import { useTallySocket } from '../src/hooks/useTallySocket';
import { colors } from '../src/theme/colors';

export default function RootLayout() {
  const checkAuth = useAuthStore((s) => s.checkAuth);
  useNotifications();
  useTallySocket();

  useEffect(() => {
    // Clear chat history on app boot — don't persist between sessions
    useChatStore.getState().clearMessages();
    checkAuth();
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="room-picker" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="analytics" options={{ title: 'Analytics' }} />
        <Stack.Screen name="service-reports" options={{ title: 'Service Reports' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </>
  );
}
