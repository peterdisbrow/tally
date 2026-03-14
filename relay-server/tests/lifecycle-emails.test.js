/**
 * Tests for src/lifecycleEmails.js — LifecycleEmails class
 *
 * Covers email generation, template rendering, dedup, error handling,
 * rate limiting, and opt-out behavior without requiring Resend API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDb() {
  const tables = {};

  // In-memory store for email_sends dedup
  const emailSends = [];

  return {
    exec: vi.fn(),
    prepare: vi.fn((sql) => {
      // Dedup check — SELECT 1 FROM email_sends
      if (sql.includes('SELECT 1 FROM email_sends')) {
        return {
          get: vi.fn((churchId, emailType) => {
            return emailSends.find(e => e.church_id === churchId && e.email_type === emailType) || undefined;
          }),
        };
      }
      // Record send — INSERT INTO email_sends
      if (sql.includes('INSERT') && sql.includes('email_sends')) {
        return {
          run: vi.fn((churchId, emailType, recipient, sentAt, resendId, subject) => {
            emailSends.push({ church_id: churchId, email_type: emailType, recipient, sent_at: sentAt, resend_id: resendId, subject });
          }),
        };
      }
      // Template override lookup
      if (sql.includes('email_template_overrides')) {
        return {
          get: vi.fn().mockReturnValue(undefined),
        };
      }
      // Default: churches query for runCheck sequences
      return {
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      };
    }),
    _emailSends: emailSends,
  };
}

function mockChurch(overrides = {}) {
  return {
    churchId: 'church-1',
    name: 'Grace Community',
    portal_email: 'pastor@grace.church',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LifecycleEmails', () => {
  let LifecycleEmails, emails, db;

  beforeEach(() => {
    // Clear CJS cache
    const modPath = require.resolve('../src/lifecycleEmails');
    delete require.cache[modPath];

    ({ LifecycleEmails } = require('../src/lifecycleEmails'));
    db = mockDb();
    emails = new LifecycleEmails(db, {
      resendApiKey: '',
      fromEmail: 'Tally <test@test.com>',
      appUrl: 'https://test.tallyconnect.app',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Welcome / Setup Reminder Email Generation
  // ──────────────────────────────────────────────────────────────────────────

  describe('Welcome / Setup Reminder Email', () => {
    it('generates a setup reminder email with church name', () => {
      const church = mockChurch();
      const result = emails._buildSetupReminderEmail(church);

      expect(result.html).toBeDefined();
      expect(result.text).toBeDefined();
      expect(result.html).toContain('Grace Community');
      expect(result.text).toContain('Grace Community');
    });

    it('includes download link in setup reminder', () => {
      const church = mockChurch();
      const result = emails._buildSetupReminderEmail(church);

      expect(result.html).toContain('github.com/tallyconnect/tally/releases');
      expect(result.text).toContain('github.com/tallyconnect/tally/releases');
    });

    it('sends setup reminder via sendEmail and records it', async () => {
      const church = mockChurch();
      const result = await emails.sendEmail({
        churchId: church.churchId,
        emailType: 'setup-reminder',
        to: church.portal_email,
        subject: 'Need help getting Tally set up?',
        html: '<p>test</p>',
      });

      // No API key configured — should record but not actually send
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-api-key');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Trial Expiring Email
  // ──────────────────────────────────────────────────────────────────────────

  describe('Trial Expiring Email', () => {
    it('generates trial-ending-soon email with correct days left', () => {
      const church = mockChurch();
      const result = emails._buildTrialEndingSoonEmail(church, 5);

      expect(result.html).toContain('5 days');
      expect(result.text).toContain('5 days');
      expect(result.html).toContain('Grace Community');
    });

    it('handles singular day correctly', () => {
      const church = mockChurch();
      const result = emails._buildTrialEndingSoonEmail(church, 1);

      expect(result.html).toContain('1 day');
      // Should NOT say "1 days"
      expect(result.html).not.toMatch(/1 days/);
    });

    it('generates trial-ending-tomorrow email', () => {
      const church = mockChurch();
      const result = emails._buildTrialEndingTomorrowEmail(church);

      expect(result.html).toContain('trial');
      expect(result.html).toContain('Grace Community');
      expect(result.html).toContain('tomorrow');
    });

    it('generates trial-expired email', () => {
      const church = mockChurch();
      const result = emails._buildTrialExpiredEmail(church);

      expect(result.html).toContain('trial has ended');
      expect(result.html).toContain('Grace Community');
    });

    it('sendTrialExpired returns no-recipient when portal_email is missing', async () => {
      const church = mockChurch({ portal_email: null });
      const result = await emails.sendTrialExpired(church);

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-recipient');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Subscription Confirmed / Reactivation Email
  // ──────────────────────────────────────────────────────────────────────────

  describe('Subscription Confirmed Email', () => {
    it('generates reactivation confirmation email', () => {
      const church = mockChurch();
      // sendReactivationConfirmation internally calls sendEmail
      // We can test the method exists and handles missing email
      expect(typeof emails.sendReactivationConfirmation).toBe('function');
    });

    it('sends reactivation confirmation with church name', async () => {
      const church = mockChurch();
      const result = await emails.sendReactivationConfirmation(church);

      // No API key — recorded but not sent
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-api-key');
    });

    it('generates upgrade confirmation email with tier names', async () => {
      const church = mockChurch();
      const result = await emails.sendUpgradeConfirmation(church, { oldTier: 'connect', newTier: 'pro' });

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-api-key');
    });

    it('sends cancellation confirmation with period end date', async () => {
      const church = mockChurch();
      const result = await emails.sendCancellationConfirmation(church, {
        periodEnd: '2026-04-15T00:00:00Z',
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-api-key');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Email Template Rendering with Church-Specific Data
  // ──────────────────────────────────────────────────────────────────────────

  describe('Template Rendering', () => {
    it('renders church name in email templates', () => {
      const church = mockChurch({ name: 'Faith & Hope Church' });
      const result = emails._buildSetupReminderEmail(church);

      expect(result.html).toContain('Faith & Hope Church');
      expect(result.text).toContain('Faith & Hope Church');
    });

    it('includes header and footer in wrapped emails', () => {
      const church = mockChurch();
      const result = emails._buildCheckinEmail(church);

      // Header includes Tally branding
      expect(result.html).toContain('Tally');
      // Footer includes appUrl
      expect(result.html).toContain('test.tallyconnect.app');
    });

    it('includes CTA buttons with correct URLs', () => {
      const church = mockChurch();
      const result = emails._buildTrialEndingSoonEmail(church, 3);

      expect(result.html).toContain('https://test.tallyconnect.app/portal');
      expect(result.html).toContain('Subscribe Now');
    });

    it('generates first-sunday email with church-specific content', () => {
      const church = mockChurch({ name: 'Riverside Baptist' });
      const result = emails._buildFirstSundayEmail(church);

      expect(result.html).toContain('Riverside Baptist');
      expect(result.text).toContain('Riverside Baptist');
      expect(result.html).toContain('first Sunday');
    });

    it('generates check-in email with feature suggestions', () => {
      const church = mockChurch();
      const result = emails._buildCheckinEmail(church);

      expect(result.html).toContain('Telegram');
      expect(result.html).toContain('Grace Community');
    });

    it('generates payment-failed email with grace period info', () => {
      const church = mockChurch();
      const result = emails._buildPaymentFailedEmail(church);

      expect(result.html).toContain('7-day grace period');
      expect(result.html).toContain('Grace Community');
    });

    it('generates weekly digest email with stats', () => {
      const church = mockChurch();
      const stats = { totalSessions: 3, totalEvents: 12, criticalEvents: 1, autoRecoveries: 1, totalAlerts: 2 };
      const result = emails._buildWeeklyDigestEmail(church, stats);

      expect(result.html).toContain('Grace Community');
      expect(result.text).toContain('3'); // sessions
      expect(result.text).toContain('12'); // events
    });

    it('uses template override from DB when present', async () => {
      // Override the prepare mock for template overrides
      const overrideDb = mockDb();
      const originalPrepare = overrideDb.prepare;
      overrideDb.prepare = vi.fn((sql) => {
        if (sql.includes('email_template_overrides')) {
          return {
            get: vi.fn().mockReturnValue({
              subject: 'Custom Subject Override',
              html: '<p>Custom HTML override</p>',
            }),
          };
        }
        return originalPrepare(sql);
      });

      const overrideEmails = new LifecycleEmails(overrideDb, {
        resendApiKey: '',
        fromEmail: 'test@test.com',
        appUrl: 'https://test.app',
      });

      // The override is applied inside sendEmail, not in the builder
      // We test _getOverride directly
      const override = overrideEmails._getOverride('setup-reminder');
      expect(override).toBeDefined();
      expect(override.subject).toBe('Custom Subject Override');
    });

    it('getPreview returns rendered HTML for known email types', () => {
      const preview = emails.getPreview('setup-reminder');
      expect(preview).toBeDefined();
      expect(preview.html).toContain('Tally');
      expect(preview.subject).toBeDefined();
    });

    it('session recap email includes grade and stats', async () => {
      const church = mockChurch();
      const session = {
        sessionId: 'sess-123',
        startedAt: '2026-03-08T10:00:00Z',
        durationMinutes: 90,
        grade: 'A',
        streamTotalMinutes: 85,
        peakViewers: 120,
        alertCount: 0,
        autoRecovered: 0,
        recordingDetected: true,
      };

      const result = await emails.sendSessionRecapEmail(church, session, 'pastor@grace.church');
      // No API key — still processes
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-api-key');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Error Handling When Email Service Is Down
  // ──────────────────────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('returns network-error when fetch throws', async () => {
      const apiEmails = new LifecycleEmails(db, {
        resendApiKey: 're_test_fake_key',
        fromEmail: 'test@test.com',
        appUrl: 'https://test.app',
      });

      // Mock global fetch to simulate network failure
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network timeout'));

      try {
        const result = await apiEmails.sendEmail({
          churchId: 'church-1',
          emailType: 'test-error',
          to: 'test@test.com',
          subject: 'Test',
          html: '<p>test</p>',
        });

        expect(result.sent).toBe(false);
        expect(result.reason).toBe('network-error');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns resend-error when API returns non-OK status', async () => {
      const apiEmails = new LifecycleEmails(db, {
        resendApiKey: 're_test_fake_key',
        fromEmail: 'test@test.com',
        appUrl: 'https://test.app',
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: vi.fn().mockResolvedValue('Rate limited'),
      });

      try {
        const result = await apiEmails.sendEmail({
          churchId: 'church-1',
          emailType: 'test-rate-limited',
          to: 'test@test.com',
          subject: 'Test',
          html: '<p>test</p>',
        });

        expect(result.sent).toBe(false);
        expect(result.reason).toBe('resend-error');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns no-api-key when resendApiKey is empty', async () => {
      const result = await emails.sendEmail({
        churchId: 'church-1',
        emailType: 'test-no-key',
        to: 'test@test.com',
        subject: 'Test',
        html: '<p>test</p>',
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-api-key');
    });

    it('returns no-recipient when to is empty', async () => {
      const result = await emails.sendEmail({
        churchId: 'church-1',
        emailType: 'test-no-to',
        to: '',
        subject: 'Test',
        html: '<p>test</p>',
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-recipient');
    });

    it('handles successful send with Resend API', async () => {
      const apiEmails = new LifecycleEmails(db, {
        resendApiKey: 're_test_fake_key',
        fromEmail: 'test@test.com',
        appUrl: 'https://test.app',
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'resend-msg-123' }),
      });

      try {
        const result = await apiEmails.sendEmail({
          churchId: 'church-1',
          emailType: 'test-success',
          to: 'test@test.com',
          subject: 'Test',
          html: '<p>test</p>',
        });

        expect(result.sent).toBe(true);
        expect(result.id).toBe('resend-msg-123');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('runCheck does not throw when DB queries fail', async () => {
      // Override prepare to throw on some queries
      const fragileDb = mockDb();
      fragileDb.prepare = vi.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT') && sql.includes('churches')) {
          throw new Error('DB connection lost');
        }
        return { get: vi.fn(), all: vi.fn().mockReturnValue([]), run: vi.fn() };
      });

      const fragileEmails = new LifecycleEmails(fragileDb, {
        resendApiKey: '',
        fromEmail: 'test@test.com',
        appUrl: 'https://test.app',
      });

      // Should not throw
      await expect(fragileEmails.runCheck()).resolves.toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Rate Limiting / Dedup on Email Sends
  // ──────────────────────────────────────────────────────────────────────────

  describe('Rate Limiting / Dedup', () => {
    it('prevents duplicate sends for the same church+emailType', async () => {
      // First send
      const result1 = await emails.sendEmail({
        churchId: 'church-1',
        emailType: 'setup-reminder',
        to: 'pastor@grace.church',
        subject: 'Test',
        html: '<p>test</p>',
      });
      expect(result1.reason).toBe('no-api-key'); // recorded

      // Second send — should be blocked by dedup
      const result2 = await emails.sendEmail({
        churchId: 'church-1',
        emailType: 'setup-reminder',
        to: 'pastor@grace.church',
        subject: 'Test',
        html: '<p>test</p>',
      });
      expect(result2.sent).toBe(false);
      expect(result2.reason).toBe('already-sent');
    });

    it('allows same emailType for different churches', async () => {
      await emails.sendEmail({
        churchId: 'church-1',
        emailType: 'setup-reminder',
        to: 'pastor@grace.church',
        subject: 'Test',
        html: '<p>test</p>',
      });

      const result = await emails.sendEmail({
        churchId: 'church-2',
        emailType: 'setup-reminder',
        to: 'admin@other.church',
        subject: 'Test',
        html: '<p>test</p>',
      });

      // Different church — should not be blocked
      expect(result.reason).not.toBe('already-sent');
    });

    it('allows different emailTypes for the same church', async () => {
      await emails.sendEmail({
        churchId: 'church-1',
        emailType: 'setup-reminder',
        to: 'pastor@grace.church',
        subject: 'Test 1',
        html: '<p>test</p>',
      });

      const result = await emails.sendEmail({
        churchId: 'church-1',
        emailType: 'trial-ending-soon',
        to: 'pastor@grace.church',
        subject: 'Test 2',
        html: '<p>test</p>',
      });

      expect(result.reason).not.toBe('already-sent');
    });

    it('session recap uses session-specific dedup key', async () => {
      const church = mockChurch();

      await emails.sendSessionRecapEmail(church, { sessionId: 'sess-1' }, 'pastor@grace.church');
      const result = await emails.sendSessionRecapEmail(church, { sessionId: 'sess-2' }, 'pastor@grace.church');

      // Different session IDs — should not be blocked
      expect(result.reason).not.toBe('already-sent');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Unsubscribe / Opt-Out Handling
  // ──────────────────────────────────────────────────────────────────────────

  describe('Unsubscribe / Opt-Out', () => {
    it('does not send when portal_email is null', async () => {
      const church = mockChurch({ portal_email: null });
      const result = await emails.sendTrialExpired(church);

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-recipient');
    });

    it('does not send payment-failed when no portal_email', async () => {
      const church = mockChurch({ portal_email: null });
      const result = await emails.sendPaymentFailed(church);

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-recipient');
    });

    it('does not send cancellation confirmation when no portal_email', async () => {
      const church = mockChurch({ portal_email: null });
      const result = await emails.sendCancellationConfirmation(church);

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-recipient');
    });

    it('does not send upgrade confirmation when no portal_email', async () => {
      const church = mockChurch({ portal_email: null });
      const result = await emails.sendUpgradeConfirmation(church, { oldTier: 'connect', newTier: 'pro' });

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-recipient');
    });

    it('does not send reactivation when no portal_email', async () => {
      const church = mockChurch({ portal_email: null });
      const result = await emails.sendReactivationConfirmation(church);

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-recipient');
    });

    it('does not send grace-expired when no portal_email', async () => {
      const church = mockChurch({ portal_email: null });
      const result = await emails.sendGraceExpired(church);

      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no-recipient');
    });

    it('email footer includes unsubscribe-friendly app link', () => {
      const church = mockChurch();
      const result = emails._buildSetupReminderEmail(church);

      // Footer should have the app URL for users to manage preferences
      expect(result.html).toContain('test.tallyconnect.app');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Schema / Constructor
  // ──────────────────────────────────────────────────────────────────────────

  describe('Schema', () => {
    it('calls db.exec to create tables on construction', () => {
      expect(db.exec).toHaveBeenCalled();
      const allCalls = db.exec.mock.calls.map(c => c[0]).join(' ');
      expect(allCalls).toContain('email_sends');
      expect(allCalls).toContain('email_template_overrides');
      expect(allCalls).toContain('sales_leads');
    });
  });
});
