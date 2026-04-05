import { useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { tallySocket } from '../ws/TallySocket';
import { useAuthStore } from '../stores/authStore';

/**
 * Monitors network connectivity and triggers WebSocket reconnection
 * when connectivity is restored.
 *
 * Returns isConnected: null while the initial check is in progress,
 * then true/false based on actual network state.
 */
export function useNetworkStatus(): boolean | null {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const wasOffline = useRef(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      // Treat null (initial/pending) as connected to avoid false-positive
      // "no internet" banner on launch or during brief network transitions.
      const connected = state.isConnected !== false;
      setIsConnected(connected);

      if (!connected) {
        wasOffline.current = true;
      } else if (wasOffline.current) {
        // Connectivity just returned — reconnect WebSocket if logged in
        wasOffline.current = false;
        if (useAuthStore.getState().isLoggedIn && !tallySocket.isConnected) {
          tallySocket.connect();
        }
      }
    });

    return () => unsubscribe();
  }, []);

  return isConnected;
}
