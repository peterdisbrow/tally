import * as Sentry from '@sentry/react-native';

// TODO: Replace placeholder DSN with the real project DSN from sentry.io
const DSN = 'https://placeholder@sentry.io/0';

export function initSentry(): void {
  Sentry.init({
    dsn: DSN,
    // Disable in dev so console errors aren't swallowed
    enabled: !__DEV__,
    // Capture 10% of transactions for performance monitoring
    tracesSampleRate: 0.1,
  });
}

export { Sentry };
