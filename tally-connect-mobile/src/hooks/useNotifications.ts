import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import type { EventSubscription } from 'expo-modules-core';
import { api } from '../api/client';
import { useAuthStore } from '../stores/authStore';

// Configure how notifications are displayed when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export function useNotifications() {
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [permission, setPermission] = useState<string | null>(null);
  const notificationListener = useRef<EventSubscription | null>(null);
  const responseListener = useRef<EventSubscription | null>(null);
  const registeredTokenRef = useRef<string | null>(null);
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);

  useEffect(() => {
    registerForPushNotifications().then(({ token, status }) => {
      setPushToken(token);
      setPermission(status);
    });

    // Listen for incoming notifications while app is foregrounded
    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      console.log('[Notification received]', notification.request.content.title);
    });

    // Listen for when user interacts with a notification
    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      console.log('[Notification tapped]', data);
    });

    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  }, []);

  // Register/unregister push token with relay server
  useEffect(() => {
    if (!pushToken) return;

    if (isLoggedIn && registeredTokenRef.current !== pushToken) {
      api('/api/church/mobile/register-device', {
        method: 'POST',
        body: {
          pushToken,
          platform: Platform.OS,
          deviceName: Device.deviceName || `${Platform.OS} device`,
        },
      })
        .then(() => {
          registeredTokenRef.current = pushToken;
        })
        .catch(() => {
          // Will retry on next app launch
        });
    }

    if (!isLoggedIn && registeredTokenRef.current) {
      api('/api/church/mobile/unregister-device', {
        method: 'DELETE',
        body: { pushToken: registeredTokenRef.current },
      }).catch(() => {
        // Best-effort unregister
      });
      registeredTokenRef.current = null;
    }
  }, [pushToken, isLoggedIn]);

  return { pushToken, permission };
}

async function registerForPushNotifications(): Promise<{ token: string | null; status: string }> {
  if (!Device.isDevice) {
    return { token: null, status: 'simulator' };
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return { token: null, status: finalStatus };
  }

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: projectId || undefined,
    });
    return { token: tokenData.data, status: 'granted' };
  } catch {
    return { token: null, status: 'error' };
  }
}
