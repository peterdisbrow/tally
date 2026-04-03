import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useAuthStore } from '../src/stores/authStore';
import { useChatStore } from '../src/stores/chatStore';
import { useNotifications } from '../src/hooks/useNotifications';
import { useTallySocket } from '../src/hooks/useTallySocket';
import { useUpdateCheck } from '../src/hooks/useUpdateCheck';
import { ThemeProvider, useThemeColors } from '../src/theme/ThemeContext';

function RootNavigator() {
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const isLoading = useAuthStore((s) => s.isLoading);
  const colors = useThemeColors();
  useNotifications();
  useTallySocket();
  useUpdateCheck();

  useEffect(() => {
    useChatStore.getState().clearMessages();
    checkAuth();
  }, []);

  useEffect(() => {
    if (!isLoading && !isLoggedIn) {
      router.replace('/login');
    }
  }, [isLoggedIn, isLoading]);

  return (
    <>
      <StatusBar style={colors.statusBarStyle} />
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
        <Stack.Screen name="analytics" options={{ title: 'Analytics', headerBackTitle: 'More' }} />
        <Stack.Screen name="service-reports" options={{ title: 'Service Reports', headerBackTitle: 'More' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings', headerBackTitle: 'More' }} />
        <Stack.Screen name="equipment-config" options={{ title: 'Equipment Config', headerBackTitle: 'More' }} />
        <Stack.Screen name="rundown" options={{ title: 'Service Rundown', headerBackTitle: 'More' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootNavigator />
    </ThemeProvider>
  );
}
