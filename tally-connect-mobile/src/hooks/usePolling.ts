import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Polls a callback at a given interval, pausing when the app is backgrounded.
 */
export function usePolling(callback: () => void, intervalMs: number) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (timer) return;
      savedCallback.current();
      timer = setInterval(() => savedCallback.current(), intervalMs);
    }

    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        start();
      } else {
        stop();
      }
    });

    // Start immediately if app is active
    if (AppState.currentState === 'active') {
      start();
    }

    return () => {
      stop();
      sub.remove();
    };
  }, [intervalMs]);
}
