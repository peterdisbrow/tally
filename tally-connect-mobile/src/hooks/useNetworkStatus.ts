import { useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { tallySocket } from '../ws/TallySocket';
import { useAuthStore } from '../stores/authStore';

// How long (ms) the device must be continuously offline before we show the banner.
// This absorbs brief null/false blips during app launch and network transitions.
const OFFLINE_DEBOUNCE_MS = 4000;

/**
 * Monitors network connectivity and triggers WebSocket reconnection
 * when connectivity is restored.
 *
 * Returns isConnected: null while the initial check is in progress,
 * then true once connected, or false only after being offline for
 * OFFLINE_DEBOUNCE_MS ms continuously (prevents false-positive banners).
 */
export function useNetworkStatus(): boolean | null {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const wasOffline = useRef(false);
  const offlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearOfflineTimer = () => {
      if (offlineTimer.current !== null) {
        clearTimeout(offlineTimer.current);
        offlineTimer.current = null;
      }
    };

    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected !== false;

      if (connected) {
        // Cancel any pending "go offline" timer — connectivity blip resolved.
        clearOfflineTimer();
        setIsConnected(true);

        if (wasOffline.current) {
          // Connectivity genuinely returned after a sustained outage.
          wasOffline.current = false;
          if (useAuthStore.getState().isLoggedIn && !tallySocket.isConnected) {
            tallySocket.connect();
          }
        }
      } else {
        // Don't immediately show the banner. Only mark as offline if the
        // disconnection persists for OFFLINE_DEBOUNCE_MS ms.
        if (offlineTimer.current === null) {
          offlineTimer.current = setTimeout(() => {
            offlineTimer.current = null;
            wasOffline.current = true;
            setIsConnected(false);
          }, OFFLINE_DEBOUNCE_MS);
        }
      }
    });

    return () => {
      unsubscribe();
      clearOfflineTimer();
    };
  }, []);

  return isConnected;
}
