import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useAuthStore } from '../src/stores/authStore';
import { useChatStore } from '../src/stores/chatStore';
import { useNotifications } from '../src/hooks/useNotifications';
import { useTallySocket } from '../src/hooks/useTallySocket';
import { useUpdateCheck } from '../src/hooks/useUpdateCheck';
import { colors } from '../src/theme/colors';

export default function RootLayout() {
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const isLoading = useAuthStore((s) => s.isLoading);
  useNotifications();
  useTallySocket();
  useUpdateCheck();

  useEffect(() => {
    // Clear chat history on app boot — don't persist between sessions
    useChatStore.getState().clearMessages();
    checkAuth();
  }, []);

  // Redirect to login when auth state becomes logged-out (e.g. 401 forceLogout)
  useEffect(() => {
    if (!isLoading && !isLoggedIn) {
      router.replace('/login');
    }
  }, [isLoggedIn, isLoading]);

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
        <Stack.Screen name="analytics" options={{ title: 'Analytics', headerBackTitle: 'More' }} />
        <Stack.Screen name="service-reports" options={{ title: 'Service Reports', headerBackTitle: 'More' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings', headerBackTitle: 'More' }} />
      </Stack>
    </>
  );
}
