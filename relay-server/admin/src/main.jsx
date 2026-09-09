import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import AdminPage from './AdminPage';

function scrubSentryEvent(event) {
  if (event.request?.headers) {
    delete event.request.headers.authorization;
    delete event.request.headers.Authorization;
    delete event.request.headers.cookie;
    delete event.request.headers.Cookie;
  }
  return event;
}

async function resolveSentryDsn() {
  const fromVite = typeof import.meta.env.VITE_SENTRY_DSN === 'string'
    ? import.meta.env.VITE_SENTRY_DSN.trim()
    : '';
  if (fromVite) return fromVite;
  try {
    const res = await fetch('/api/admin/client-config');
    if (!res.ok) return '';
    const cfg = await res.json();
    return String(cfg?.sentryDsn || '').trim();
  } catch {
    return '';
  }
}

async function start() {
  const dsn = await resolveSentryDsn();
  if (dsn) {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE || 'production',
      tracesSampleRate: 0.1,
      beforeSend(event) {
        return scrubSentryEvent(event);
      },
    });
  }

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      {dsn ? (
        <Sentry.ErrorBoundary fallback={<div style={{ padding: 24, color: '#94A3B8' }}>Admin failed to load. Refresh or check Sentry.</div>}>
          <AdminPage />
        </Sentry.ErrorBoundary>
      ) : (
        <AdminPage />
      )}
    </React.StrictMode>
  );
}

start();
