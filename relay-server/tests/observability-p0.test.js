/**
 * Pin Sunday-ops observability P0s that live in server.js / admin source
 * (no HTTP server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(require.resolve('../server.js'));

describe('Observability P0 pins', () => {
  const serverSrc = fs.readFileSync(path.join(here, 'server.js'), 'utf8');
  const statusTabSrc = fs.readFileSync(
    path.join(here, 'admin/src/components/StatusTab.jsx'),
    'utf8',
  );
  const adminMainSrc = fs.readFileSync(
    path.join(here, 'admin/src/main.jsx'),
    'utf8',
  );
  const adminPanelSrc = fs.readFileSync(
    path.join(here, 'src/adminPanel.js'),
    'utf8',
  );
  const monitorTabSrc = fs.readFileSync(
    path.join(here, 'admin/src/components/MonitorTab.jsx'),
    'utf8',
  );

  it('allows browser Sentry envelopes through Helmet connect-src', () => {
    expect(serverSrc).toContain('https://*.ingest.sentry.io');
    expect(serverSrc).toContain('https://*.ingest.us.sentry.io');
  });

  it('reports unhandledRejection / uncaughtException to Sentry', () => {
    expect(serverSrc).toContain('Sentry.captureException');
    expect(serverSrc).toContain("event: 'unhandled_rejection'");
    expect(serverSrc).toContain("event: 'uncaught_exception'");
  });

  it('exposes an AI readiness status component without interpolating the key', () => {
    expect(serverSrc).toContain("componentId: 'ai_assistant'");
    expect(serverSrc).toMatch(/ANTHROPIC_API_KEY configured/);
    expect(serverSrc).not.toMatch(/ai_assistant[\s\S]{0,400}process\.env\.ANTHROPIC_API_KEY\}/);
  });

  it('treats Telegram getWebhookInfo fetch failure as degraded, not outage', () => {
    expect(serverSrc).toContain('Telegram API unreachable');
    expect(serverSrc).toContain("state: 'degraded', detail: `Telegram API unreachable");
    expect(serverSrc).toContain('last_error_date');
  });

  it('maps status-component `outage` to red in the admin Status tab', () => {
    expect(statusTabSrc).toMatch(/case 'outage'/);
    expect(statusTabSrc).toMatch(/c\.state === 'down' \|\| c\.state === 'outage'/);
  });

  it('exposes last-successful alert send as a status component', () => {
    expect(serverSrc).toContain("componentId: 'alert_delivery'");
    expect(serverSrc).toContain('getDeliveryStatusComponent');
    expect(serverSrc).toContain('No outbound alert sends since process start');
  });

  it('captures unexpected runStatusChecks throws to Sentry (not Telegram fetch flaps)', () => {
    expect(serverSrc).toContain('function reportStatusCheckFailure');
    expect(serverSrc).toContain("reportStatusCheckFailure('scheduled run failed'");
    expect(serverSrc).toContain("reportStatusCheckFailure('initial run failed'");
    const helperStart = serverSrc.indexOf('function reportStatusCheckFailure');
    const helper = serverSrc.slice(helperStart, helperStart + 500);
    expect(helper).toContain('Sentry.captureException');

    const telegramStart = serverSrc.indexOf('let telegramFetchError = null;');
    const telegramBlock = serverSrc.slice(telegramStart, telegramStart + 2200);
    expect(telegramBlock).toContain("state: 'degraded'");
    expect(telegramBlock).not.toContain('Sentry.captureException');
    expect(telegramBlock).not.toContain('reportStatusCheckFailure');
  });

  it('surfaces last Resend failure type on the status component without changing outage policy', () => {
    expect(serverSrc).toContain('getLastResendFailure');
    expect(serverSrc).toContain('last ${lastFailure.type} ${lastFailure.at}');
  });

  it('admin SPA still inits Sentry from VITE_SENTRY_DSN or GET /api/admin/client-config', () => {
    expect(adminMainSrc).toContain('/api/admin/client-config');
    expect(adminMainSrc).toContain('sentryDsn');
    expect(adminMainSrc).toContain('Sentry.init');
    expect(adminMainSrc).toContain('VITE_SENTRY_DSN');
  });

  it('does not grant admin session from leftover HMAC tally_session cookies', () => {
    expect(adminPanelSrc).toContain("HMAC cookie `tally_session` with role === 'admin' is leftover");
    expect(adminPanelSrc).not.toMatch(/payload && payload\.role === 'admin'/);
    expect(adminPanelSrc).not.toContain("res.redirect('/admin/login')");
  });

  it('Monitor empty state is honest, not Waiting for data', () => {
    expect(monitorTabSrc).toContain('fleetEmptyState');
    expect(monitorTabSrc).toContain('hlsIdleState');
    expect(monitorTabSrc).not.toContain('Waiting for data...');
  });
});
