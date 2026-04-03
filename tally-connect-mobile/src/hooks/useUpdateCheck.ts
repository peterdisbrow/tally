import { useEffect } from 'react';
import * as Updates from 'expo-updates';
import { useUpdateStore } from '../stores/updateStore';
import { Sentry } from '../lib/sentry';

/**
 * Checks for OTA updates on app launch (non-blocking).
 * If an update is found, downloads it and flags it in the store
 * so the UI can show a "tap to restart" banner.
 */
export function useUpdateCheck() {
  useEffect(() => {
    if (__DEV__) return; // expo-updates doesn't work in dev

    (async () => {
      try {
        const check = await Updates.checkForUpdateAsync();
        if (check.isAvailable) {
          const result = await Updates.fetchUpdateAsync();
          if (result.isNew) {
            useUpdateStore.getState().setUpdateReady(true);
          }
        }
      } catch (err) {
        console.warn(
          '[OTA] Update check failed:',
          err instanceof Error ? err.message : err,
          '| channel:', Updates.channel ?? 'none',
          '| runtime:', Updates.runtimeVersion ?? 'unknown',
        );
        Sentry.captureException(err, {
          extra: { context: 'OTA update check', channel: Updates.channel, runtimeVersion: Updates.runtimeVersion },
        });
      }
    })();
  }, []);
}
