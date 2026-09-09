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
});
