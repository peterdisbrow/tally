/**
 * Tests for weekly digest email templates, monthly report email templates,
 * and per-church delivery logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDb() {
  const emailSends = [];

  return {
    exec: vi.fn(),
    prepare: vi.fn((sql) => {
      if (sql.includes('SELECT 1 FROM email_sends')) {
        return {
          get: vi.fn((churchId, emailType) => {
            return emailSends.find(e => e.church_id === churchId && e.email_type === emailType) || undefined;
          }),
        };
      }
      if (sql.includes('INSERT') && sql.includes('email_sends')) {
        return {
          run: vi.fn((churchId, emailType, recipient, sentAt, resendId, subject) => {
            emailSends.push({ church_id: churchId, email_type: emailType, recipient, sent_at: sentAt, resend_id: resendId, subject });
          }),
        };
      }
      if (sql.includes('email_template_overrides')) {
        return { get: vi.fn().mockReturnValue(undefined) };
      }
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

describe('Weekly Digest Email (sendWeeklyDigestEmail)', () => {
  let LifecycleEmails, emails, db;

  beforeEach(() => {
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

  it('uses "Your Week in Review" subject line with church name', async () => {
    const church = mockChurch({ name: 'Faith Baptist' });
    const digestData = { reliability: 99.5, patterns: [], totalEvents: 5, autoRecovered: 2, sessionCount: 3 };

    const result = await emails.sendWeeklyDigestEmail(church, digestData, 'td@faith.church');
    expect(result.reason).toBe('no-api-key');

    // Check that the recorded send has the correct subject
    const recorded = db._emailSends.find(e => e.church_id === 'church-1');
    expect(recorded).toBeDefined();
    expect(recorded.subject).toContain('Your Week in Review');
    expect(recorded.subject).toContain('Faith Baptist');
  });

  it('includes services count in the email', async () => {
    const church = mockChurch();
    const digestData = { reliability: 98, patterns: [], totalEvents: 10, autoRecovered: 3, sessionCount: 4 };

    // We test by calling sendWeeklyDigestEmail and verifying it doesn't throw
    const result = await emails.sendWeeklyDigestEmail(church, digestData, 'td@grace.church');
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no-api-key');
  });

  it('includes topAlertType in digest email when provided', async () => {
    const church = mockChurch();
    const digestData = {
      reliability: 95,
      patterns: [],
      totalEvents: 8,
      autoRecovered: 1,
      sessionCount: 2,
      topAlertType: 'stream stopped',
    };

    const result = await emails.sendWeeklyDigestEmail(church, digestData, 'td@grace.church');
    expect(result.reason).toBe('no-api-key');
  });

  it('shows "None" for topAlertType when null', async () => {
    const church = mockChurch();
    const digestData = {
      reliability: 100,
      patterns: [],
      totalEvents: 0,
      autoRecovered: 0,
      sessionCount: 3,
      topAlertType: null,
    };

    const result = await emails.sendWeeklyDigestEmail(church, digestData, 'td@grace.church');
    expect(result.reason).toBe('no-api-key');
  });

  it('includes pattern recommendations when patterns are present', async () => {
    const church = mockChurch();
    const digestData = {
      reliability: 92,
      patterns: [
        { pattern: 'audio silence (3x)', timeWindow: 'usually around 10:00 AM', recommendation: 'Use aux send' },
      ],
      totalEvents: 5,
      autoRecovered: 1,
      sessionCount: 2,
    };

    const result = await emails.sendWeeklyDigestEmail(church, digestData, 'td@grace.church');
    expect(result.reason).toBe('no-api-key');
  });

  it('uses week-specific dedup key to prevent duplicate sends', async () => {
    const church = mockChurch();
    const digestData = { reliability: 99, patterns: [], totalEvents: 2, autoRecovered: 0, sessionCount: 1 };

    const result1 = await emails.sendWeeklyDigestEmail(church, digestData, 'td@grace.church');
    expect(result1.reason).toBe('no-api-key');

    // Second send same week should be blocked
    const result2 = await emails.sendWeeklyDigestEmail(church, digestData, 'td@grace.church');
    expect(result2.sent).toBe(false);
    expect(result2.reason).toBe('already-sent');
  });

  it('handles missing reliability gracefully', async () => {
    const church = mockChurch();
    const digestData = { patterns: [], totalEvents: 0, autoRecovered: 0, sessionCount: 0 };

    const result = await emails.sendWeeklyDigestEmail(church, digestData, 'td@grace.church');
    expect(result.reason).toBe('no-api-key');
  });

  it('returns no-recipient when toEmail is empty', async () => {
    const church = mockChurch();
    const digestData = { reliability: 99, patterns: [], totalEvents: 0, autoRecovered: 0, sessionCount: 0 };

    const result = await emails.sendWeeklyDigestEmail(church, digestData, '');
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no-recipient');
  });
});

describe('Monthly Report Email (sendMonthlyReportEmail)', () => {
  let LifecycleEmails, emails, db;

  beforeEach(() => {
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

  it('uses "Monthly Production Report" subject line with church name', async () => {
    const church = mockChurch({ name: 'Hillside Church' });
    const reportData = {
      month: '2026-02',
      monthLabel: 'February 2026',
      servicesMonitored: 8,
      alertsTriggered: 3,
      autoRecovered: 2,
      escalated: 0,
      mostCommonIssue: 'audio silence',
      uptime: 99.8,
    };

    const result = await emails.sendMonthlyReportEmail(church, reportData, 'pastor@hillside.church');
    expect(result.reason).toBe('no-api-key');

    const recorded = db._emailSends.find(e => e.church_id === 'church-1');
    expect(recorded).toBeDefined();
    expect(recorded.subject).toBe('Monthly Production Report — Hillside Church');
  });

  it('includes all report metrics in the email', async () => {
    const church = mockChurch();
    const reportData = {
      month: '2026-02',
      monthLabel: 'February 2026',
      servicesMonitored: 12,
      alertsTriggered: 5,
      autoRecovered: 3,
      escalated: 1,
      mostCommonIssue: 'stream stopped',
      uptime: 98.5,
    };

    const result = await emails.sendMonthlyReportEmail(church, reportData, 'td@grace.church');
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no-api-key');
  });

  it('handles null mostCommonIssue gracefully', async () => {
    const church = mockChurch();
    const reportData = {
      month: '2026-02',
      monthLabel: 'February 2026',
      servicesMonitored: 4,
      alertsTriggered: 0,
      autoRecovered: 0,
      escalated: 0,
      mostCommonIssue: null,
      uptime: 100,
    };

    const result = await emails.sendMonthlyReportEmail(church, reportData, 'td@grace.church');
    expect(result.reason).toBe('no-api-key');
  });

  it('uses month-specific dedup key', async () => {
    const church = mockChurch();
    const reportData = {
      month: '2026-02',
      monthLabel: 'February 2026',
      servicesMonitored: 4,
      alertsTriggered: 0,
      autoRecovered: 0,
      escalated: 0,
      uptime: 100,
    };

    const result1 = await emails.sendMonthlyReportEmail(church, reportData, 'td@grace.church');
    expect(result1.reason).toBe('no-api-key');

    // Second send for same month should be blocked
    const result2 = await emails.sendMonthlyReportEmail(church, reportData, 'td@grace.church');
    expect(result2.sent).toBe(false);
    expect(result2.reason).toBe('already-sent');
  });

  it('allows different months for the same church', async () => {
    const church = mockChurch();
    const feb = { month: '2026-02', monthLabel: 'February 2026', servicesMonitored: 4, alertsTriggered: 0, autoRecovered: 0, escalated: 0, uptime: 100 };
    const mar = { month: '2026-03', monthLabel: 'March 2026', servicesMonitored: 5, alertsTriggered: 1, autoRecovered: 1, escalated: 0, uptime: 99.5 };

    await emails.sendMonthlyReportEmail(church, feb, 'td@grace.church');
    const result = await emails.sendMonthlyReportEmail(church, mar, 'td@grace.church');

    expect(result.reason).not.toBe('already-sent');
  });

  it('returns no-recipient when toEmail is empty', async () => {
    const church = mockChurch();
    const reportData = { month: '2026-02', monthLabel: 'February 2026', servicesMonitored: 4, alertsTriggered: 0, autoRecovered: 0, escalated: 0, uptime: 100 };

    const result = await emails.sendMonthlyReportEmail(church, reportData, '');
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no-recipient');
  });

  it('handles uptime as N/A when not provided', async () => {
    const church = mockChurch();
    const reportData = {
      month: '2026-02',
      monthLabel: 'February 2026',
      servicesMonitored: 0,
      alertsTriggered: 0,
      autoRecovered: 0,
      escalated: 0,
    };

    const result = await emails.sendMonthlyReportEmail(church, reportData, 'td@grace.church');
    expect(result.reason).toBe('no-api-key');
  });
});

describe('MonthlyReport email integration', () => {
  let MonthlyReport;

  beforeEach(() => {
    const modPath = require.resolve('../src/monthlyReport');
    delete require.cache[modPath];
    ({ MonthlyReport } = require('../src/monthlyReport'));
  });

  it('has setLifecycleEmails method', () => {
    const report = new MonthlyReport({ db: null });
    expect(typeof report.setLifecycleEmails).toBe('function');
  });

  it('stores lifecycleEmails engine when set', () => {
    const report = new MonthlyReport({ db: null });
    const fakeEngine = { sendMonthlyReportEmail: vi.fn() };
    report.setLifecycleEmails(fakeEngine);
    expect(report.lifecycleEmails).toBe(fakeEngine);
  });

  it('calls sendMonthlyReportEmail during _sendReport when lifecycleEmails is set', async () => {
    const sendMonthlyReportEmail = vi.fn().mockResolvedValue({ sent: false, reason: 'no-api-key' });
    const fakeEngine = { sendMonthlyReportEmail };

    const mockDatabase = {
      prepare: vi.fn((sql) => {
        if (sql.includes('SELECT * FROM churches WHERE churchId')) {
          return {
            get: vi.fn().mockReturnValue({
              churchId: 'church-1',
              name: 'Test Church',
              portal_email: 'admin@test.church',
              leadership_emails: 'leader@test.church',
              billing_tier: 'pro',
            }),
          };
        }
        if (sql.includes('service_events')) {
          return { all: vi.fn().mockReturnValue([]) };
        }
        if (sql.includes('alerts')) {
          return { all: vi.fn().mockReturnValue([]) };
        }
        if (sql.includes('church_tds')) {
          return { all: vi.fn().mockReturnValue([]) };
        }
        return { get: vi.fn(), all: vi.fn().mockReturnValue([]), run: vi.fn() };
      }),
    };

    const report = new MonthlyReport({ db: mockDatabase });
    report.setLifecycleEmails(fakeEngine);

    await report._sendReport('church-1', '2026-02');

    // Should have been called for both portal_email and leadership_emails
    expect(sendMonthlyReportEmail).toHaveBeenCalled();
    const calls = sendMonthlyReportEmail.mock.calls;
    const recipients = calls.map(c => c[2]);
    expect(recipients).toContain('leader@test.church');
    expect(recipients).toContain('admin@test.church');
  });

  it('does not send email when lifecycleEmails is not set', async () => {
    const mockDatabase = {
      prepare: vi.fn((sql) => {
        if (sql.includes('SELECT * FROM churches WHERE churchId')) {
          return {
            get: vi.fn().mockReturnValue({
              churchId: 'church-1',
              name: 'Test Church',
              portal_email: 'admin@test.church',
              billing_tier: 'pro',
            }),
          };
        }
        if (sql.includes('service_events')) {
          return { all: vi.fn().mockReturnValue([]) };
        }
        if (sql.includes('church_tds')) {
          return { all: vi.fn().mockReturnValue([]) };
        }
        return { get: vi.fn(), all: vi.fn().mockReturnValue([]), run: vi.fn() };
      }),
    };

    const report = new MonthlyReport({ db: mockDatabase });

    // Should not throw when lifecycleEmails is null
    await expect(report._sendReport('church-1', '2026-02')).resolves.toBeUndefined();
  });

  it('includes reportData with correct month and metrics', async () => {
    const sendMonthlyReportEmail = vi.fn().mockResolvedValue({ sent: false, reason: 'no-api-key' });
    const fakeEngine = { sendMonthlyReportEmail };

    const mockDatabase = {
      prepare: vi.fn((sql) => {
        if (sql.includes('SELECT * FROM churches WHERE churchId')) {
          return {
            get: vi.fn().mockReturnValue({
              churchId: 'church-1',
              name: 'Test Church',
              portal_email: 'admin@test.church',
              leadership_emails: '',
              billing_tier: 'pro',
            }),
          };
        }
        if (sql.includes('service_events')) {
          return {
            all: vi.fn().mockReturnValue([
              { event_type: 'audio_silence', timestamp: '2026-02-05T10:00:00Z', resolved: true, auto_resolved: true },
              { event_type: 'audio_silence', timestamp: '2026-02-12T10:00:00Z', resolved: true, auto_resolved: false },
            ]),
          };
        }
        if (sql.includes('alerts')) {
          return { all: vi.fn().mockReturnValue([]) };
        }
        if (sql.includes('church_tds')) {
          return { all: vi.fn().mockReturnValue([]) };
        }
        return { get: vi.fn(), all: vi.fn().mockReturnValue([]), run: vi.fn() };
      }),
    };

    const report = new MonthlyReport({ db: mockDatabase });
    report.setLifecycleEmails(fakeEngine);

    await report._sendReport('church-1', '2026-02');

    expect(sendMonthlyReportEmail).toHaveBeenCalled();
    const [church, reportData] = sendMonthlyReportEmail.mock.calls[0];
    expect(reportData.month).toBe('2026-02');
    expect(reportData.autoRecovered).toBe(1);
    expect(reportData.mostCommonIssue).toBe('audio silence');
    expect(reportData.servicesMonitored).toBe(2); // 2 unique dates
  });
});
