import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function createQueryClientMock(initial = {}) {
  const state = {
    churches: [
      { churchId: 'church-1', name: 'Grace Community' },
      ...(initial.churches || []),
    ],
    emailSends: [...(initial.emailSends || [])],
    emailPreferences: [...(initial.emailPreferences || [])],
    overrides: [...(initial.overrides || [])],
    leads: [...(initial.leads || [])],
    serviceEvents: [...(initial.serviceEvents || [])],
    counts: initial.counts || {},
    flags: initial.flags || {},
    lastSessionAt: initial.lastSessionAt || null,
  };

  const counters = {
    send: state.emailSends.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0),
    lead: state.leads.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0),
  };

  const normalize = (sql) => sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const bySendTime = (a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime();

  const client = {
    state,
    exec: vi.fn(async () => {}),
    query: vi.fn(async (sql) => {
      const normalized = normalize(sql);
      if (normalized.includes('from churches')) {
        return state.churches.map((row) => ({ ...row }));
      }
      if (normalized.includes('from email_preferences')) {
        return state.emailPreferences.map((row) => ({ ...row }));
      }
      if (normalized.includes('from email_template_overrides')) {
        return state.overrides.map((row) => ({ ...row }));
      }
      if (normalized.includes('from email_sends')) {
        return state.emailSends.slice().sort(bySendTime).map((row) => ({ ...row }));
      }
      if (normalized.includes('from sales_leads')) {
        return state.leads.map((row) => ({ ...row }));
      }
      if (normalized.includes('from service_events') && !normalized.includes('count(*) as cnt')) {
        return state.serviceEvents.map((row) => ({ ...row }));
      }
      if (normalized.includes('from service_sessions') && normalized.includes('max(started_at)')) {
        return state.lastSessionAt ? [{ last_at: state.lastSessionAt }] : [];
      }
      if (normalized.includes('from service_sessions') && normalized.includes("grade like '%clean%'")) {
        return [{ cnt: state.counts.cleanSessions ?? 0 }];
      }
      if (normalized.includes('from service_sessions') && normalized.includes('count(*) as cnt')) {
        return [{ cnt: state.counts.sessions ?? 0 }];
      }
      if (normalized.includes('from service_events') && normalized.includes('count(*) as cnt') && normalized.includes('auto_resolved = 1')) {
        return [{ cnt: state.counts.autoResolvedEvents ?? 0 }];
      }
      if (normalized.includes('from service_events') && normalized.includes('count(*) as cnt')) {
        return [{ cnt: state.counts.events ?? 0 }];
      }
      if (normalized.includes('from alerts') && normalized.includes('count(*) as cnt')) {
        return [{ cnt: state.counts.alerts ?? 0 }];
      }
      if (normalized.includes('from church_reviews')) {
        return state.flags.reviewExists ? [{ 1: 1 }] : [];
      }
      if (normalized.includes('from service_schedules')) {
        return state.flags.hasSchedule ? [{ 1: 1 }] : [];
      }
      if (normalized.includes('from stream_platforms')) {
        return state.flags.hasStreamPlatform ? [{ 1: 1 }] : [];
      }
      if (normalized.includes('from rooms')) {
        return [{ cnt: state.counts.rooms ?? 0 }];
      }
      return [];
    }),
  };

  client.queryOne = vi.fn(async (sql, params = []) => {
    const rows = await client.query(sql, params);
    return rows[0] || null;
  });

  client.queryValue = vi.fn(async (sql, params = []) => {
    const row = await client.queryOne(sql, params);
    if (!row) return null;
    return Object.values(row)[0] ?? null;
  });

  client.run = vi.fn(async (sql, params = []) => {
    const normalized = normalize(sql);

    if (normalized.startsWith('insert or replace into email_preferences')) {
      const [churchId, category, enabled, updatedAt] = params;
      state.emailPreferences = state.emailPreferences.filter(
        (row) => !(row.church_id === churchId && row.category === category),
      );
      state.emailPreferences.push({
        church_id: churchId,
        category,
        enabled,
        updated_at: updatedAt,
      });
      return { changes: 1, lastInsertRowid: null, rows: [] };
    }

    if (normalized.includes('into email_sends')) {
      const [churchId, emailType, recipient, sentAt, resendId, subject] = params;
      const existing = state.emailSends.find(
        (row) => row.church_id === churchId && row.email_type === emailType,
      );

      if (normalized.includes('insert or ignore') && existing) {
        return { changes: 0, lastInsertRowid: existing.id ?? null, rows: [] };
      }

      const row = {
        id: existing?.id || ++counters.send,
        church_id: churchId,
        email_type: emailType,
        recipient,
        sent_at: sentAt,
        resend_id: resendId || null,
        subject: subject || null,
      };

      if (existing) {
        Object.assign(existing, row);
      } else {
        state.emailSends.push(row);
      }

      return { changes: 1, lastInsertRowid: row.id, rows: [] };
    }

    if (normalized.startsWith('insert into email_template_overrides')) {
      const [emailType, subject, html, updatedAt] = params;
      const existing = state.overrides.find((row) => row.email_type === emailType);
      const row = {
        email_type: emailType,
        subject: subject || null,
        html: html || null,
        updated_at: updatedAt,
      };
      if (existing) Object.assign(existing, row);
      else state.overrides.push(row);
      return { changes: 1, lastInsertRowid: null, rows: [] };
    }

    if (normalized.startsWith('delete from email_template_overrides')) {
      const [emailType] = params;
      state.overrides = state.overrides.filter((row) => row.email_type !== emailType);
      return { changes: 1, lastInsertRowid: null, rows: [] };
    }

    if (normalized.includes('into sales_leads')) {
      const [email, name, churchName, source, capturedAt] = params;
      const existing = state.leads.find((row) => row.email === email);
      const row = {
        id: existing?.id || ++counters.lead,
        email,
        name: name || null,
        church_name: churchName || null,
        source: source || 'website',
        captured_at: capturedAt,
        status: 'active',
      };
      if (existing) Object.assign(existing, row);
      else state.leads.push(row);
      return { changes: 1, lastInsertRowid: row.id, rows: [] };
    }

    return { changes: 0, lastInsertRowid: null, rows: [] };
  });

  return client;
}

async function settle(emails) {
  await emails.ready;
  await emails._writeQueue;
}

function mockChurch(overrides = {}) {
  return {
    churchId: 'church-1',
    name: 'Grace Community',
    portal_email: 'pastor@grace.church',
    ...overrides,
  };
}

describe('LifecycleEmails query-client support', () => {
  let LifecycleEmails;
  let emails;
  let queryClient;

  beforeEach(() => {
    const modPath = require.resolve('../src/lifecycleEmails');
    delete require.cache[modPath];

    ({ LifecycleEmails } = require('../src/lifecycleEmails'));
    queryClient = createQueryClientMock();
    emails = new LifecycleEmails(queryClient, {
      resendApiKey: '',
      fromEmail: 'Tally <test@test.com>',
      appUrl: 'https://test.tallyconnect.app',
    });
  });

  afterEach(async () => {
    if (emails) await settle(emails);
  });

  it('hydrates and updates preferences through the query-client cache', async () => {
    await settle(emails);

    expect(emails.getPreferences('church-1')).toMatchObject({
      billing: true,
      onboarding: true,
      'weekly-digest': true,
    });

    expect(emails.setPreference('church-1', 'billing', false)).toBe(true);
    expect(emails.getPreferences('church-1').billing).toBe(false);

    await settle(emails);
    expect(queryClient.state.emailPreferences).toEqual([
      expect.objectContaining({
        church_id: 'church-1',
        category: 'billing',
        enabled: 0,
      }),
    ]);
  });

  it('records sends, dedupes them, and powers history stats from cache', async () => {
    await settle(emails);

    const first = await emails.sendEmail({
      churchId: 'church-1',
      emailType: 'trial-ending-soon',
      to: 'pastor@grace.church',
      subject: 'Your trial ends soon',
      html: '<p>trial</p>',
    });

    expect(first.sent).toBe(false);
    expect(first.reason).toBe('no-api-key');

    const duplicate = await emails.sendEmail({
      churchId: 'church-1',
      emailType: 'trial-ending-soon',
      to: 'pastor@grace.church',
      subject: 'Your trial ends soon',
      html: '<p>trial</p>',
    });

    expect(duplicate.sent).toBe(false);
    expect(duplicate.reason).toBe('already-sent');

    const history = emails.getEmailHistory({ churchId: 'church-1' });
    expect(history.total).toBe(1);
    expect(history.rows[0]).toMatchObject({
      church_id: 'church-1',
      email_type: 'trial-ending-soon',
      church_name: 'Grace Community',
    });

    expect(emails.getEmailStats()).toMatchObject({
      total: 1,
      today: 1,
      thisWeek: 1,
    });
  });

  it('keeps template previews and lead capture usable without sqlite sync access', async () => {
    await settle(emails);

    expect(emails.getTemplateList().find((entry) => entry.type === 'weekly-digest')).toMatchObject({
      hasOverride: false,
    });

    emails.applyOverride('weekly-digest', {
      subject: 'Weekly green light',
      html: '<p>override</p>',
    });

    expect(emails.getPreview('weekly-digest')).toMatchObject({
      subject: 'Weekly green light',
      hasOverride: true,
    });

    expect(emails.getPreview('annual-renewal-reminder')).toMatchObject({
      subject: 'Your annual Tally subscription renews in 30 days',
      hasOverride: false,
    });
    expect(emails.getPreview('annual-renewal-reminder').html).toContain('Your year with Tally');

    expect(emails.getPreview('first-year-anniversary')).toMatchObject({
      subject: 'Sample Church just completed one year with Tally',
      hasOverride: false,
    });
    expect(emails.getPreview('first-year-anniversary').html).toContain('One year with Tally');

    const lead = emails.captureLead({
      email: 'newlead@example.com',
      name: 'New Lead',
      source: 'landing-page',
      churchName: 'Pioneer Church',
    });

    expect(lead).toMatchObject({
      email: 'newlead@example.com',
      name: 'New Lead',
      source: 'landing-page',
      church_name: 'Pioneer Church',
      status: 'active',
    });

    emails.removeOverride('weekly-digest');
    expect(emails.getPreview('weekly-digest')).toMatchObject({
      hasOverride: false,
    });
  });

  it('runs the Monday check loop on the query client without sqlite fallback', async () => {
    const mondayMorning = new Date('2026-04-06T14:00:00.000Z');
    const runCheckClient = createQueryClientMock({
      churches: [{
        churchId: 'church-1',
        name: 'Grace Community',
        portal_email: 'pastor@grace.church',
        billing_status: 'active',
        billing_tier: 'pro',
        onboarding_app_connected_at: '2026-02-01T00:00:00.000Z',
        registeredAt: '2026-02-15T00:00:00.000Z',
      }],
      serviceEvents: [
        { event_type: 'stream_stopped', resolved: 1, auto_resolved: 1 },
        { event_type: 'atem_disconnected', resolved: 0, auto_resolved: 0 },
      ],
      counts: {
        sessions: 5,
        cleanSessions: 3,
        alerts: 1,
      },
      lastSessionAt: '2026-03-01T00:00:00.000Z',
    });

    const runCheckEmails = new LifecycleEmails(runCheckClient, {
      resendApiKey: '',
      fromEmail: 'Tally <test@test.com>',
      appUrl: 'https://test.tallyconnect.app',
    });

    vi.useFakeTimers();
    vi.setSystemTime(mondayMorning);

    try {
      await settle(runCheckEmails);
      await runCheckEmails.runCheck();

      expect(runCheckClient.query).toHaveBeenCalled();
      expect(runCheckClient.state.emailSends.map((row) => row.email_type)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^weekly-digest-/),
          'inactivity-alert',
          'review-request',
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
