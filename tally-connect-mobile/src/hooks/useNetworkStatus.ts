import { useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { tallySocket } from '../ws/TallySocket';
import { useAuthStore } from '../stores/authStore';
import { getRelayUrl } from '../api/client';

// How long (ms) to wait before even attempting an offline confirmation ping.
// This absorbs brief NetInfo blips on launch and during network transitions.
const PRE_PING_DELAY_MS = 8000;

// Timeout for the HTTP ping to the relay server.
const PING_TIMEOUT_MS = 4000;

/**
 * Monitors network connectivity and triggers WebSocket reconnection when
 * connectivity is restored.
 *
 * Strategy — two-stage verification before showing the "no internet" banner:
 *   1. NetInfo must report disconnected for PRE_PING_DELAY_MS milliseconds.
 *   2. An actual HTTP HEAD request to the relay server must also fail.
 *
 * This means the banner will only appear if the device is genuinely offline
 * for 8+ seconds AND cannot reach the relay server — eliminating all known
 * false-positive triggers (app launch, brief transitions, flaky NetInfo).
 *
 * Returns null while the initial check is in progress, then true/false.
 */
export function useNetworkStatus(): boolean | null {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const wasOffline = useRef(false);
  const netInfoSaysOffline = useRef(false);
  const preDelayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimer = () => {
    if (preDelayTimer.current !== null) {
      clearTimeout(preDelayTimer.current);
      preDelayTimer.current = null;
    }
  };

  const pingRelayServer = async (): Promise<boolean> => {
    try {
      const url = await getRelayUrl();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
      try {
        // Any HTTP response (even 4xx/5xx) means we can reach the internet.
        await fetch(`${url}/health`, {
          method: 'HEAD',
          signal: controller.signal,
          cache: 'no-store',
        });
        return true;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return false;
    }
  };

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected !== false;

      if (connected) {
        netInfoSaysOffline.current = false;
        clearPendingTimer();
        setIsConnected(true);

        if (wasOffline.current) {
          wasOffline.current = false;
          if (useAuthStore.getState().isLoggedIn && !tallySocket.isConnected) {
            tallySocket.connect();
          }
        }
      } else {
        // NetInfo says offline. Don't trust it yet — wait, then do a real ping.
        netInfoSaysOffline.current = true;

        if (preDelayTimer.current === null) {
          preDelayTimer.current = setTimeout(async () => {
            preDelayTimer.current = null;

            // If NetInfo already recovered during the delay, bail out.
            if (!netInfoSaysOffline.current) return;

            // Confirm with an actual HTTP request to the relay server.
            const reachable = await pingRelayServer();

            // Only show the banner if NetInfo is STILL offline AND ping failed.
            if (!reachable && netInfoSaysOffline.current) {
              wasOffline.current = true;
              setIsConnected(false);
            }
            // If reachable, NetInfo was wrong — keep the current connected state.
          }, PRE_PING_DELAY_MS);
        }
      }
    });

    return () => {
      unsubscribe();
      clearPendingTimer();
    };
  }, []);

  return isConnected;
}
