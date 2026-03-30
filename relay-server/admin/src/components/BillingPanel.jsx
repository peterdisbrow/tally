import { useState, useEffect } from 'react';
import { C, s, canWrite, PLAN_OPTIONS, PLAN_STATUS_OPTIONS } from './adminStyles';

const INTERVAL_OPTIONS = ['monthly', 'quarterly', 'yearly', 'one_time'];

export default function BillingPanel({ churchId, api, role, church, onUpdate }) {
  const [billing, setBilling]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [draft, setDraft]         = useState({
    tier: church?.billing_tier || 'connect',
    status: church?.billing_status || 'inactive',
    interval: church?.billing_interval || 'monthly',
  });
  const [saving, setSaving]       = useState(false);
  const [msg, setMsg]             = useState({ type: '', text: '' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sv = await api(`/api/admin/church/${churchId}/support-view`).catch(() => null);
        const bill = sv?.billing || null;
        if (!cancelled) {
          setBilling(bill);
          if (bill) {
            setDraft({
              tier: bill.tier || church?.billing_tier || 'connect',
              status: bill.status || church?.billing_status || 'inactive',
              interval: bill.billing_interval || church?.billing_interval || 'monthly',
            });
          }
        }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [churchId, api, church?.billing_tier, church?.billing_status, church?.billing_interval]);

  async function saveBilling() {
    setSaving(true); setMsg({ type: '', text: '' });
    try {
      const data = await api(`/api/churches/${churchId}/billing`, {
        method: 'PUT',
        body: {
          tier: draft.tier,
          status: draft.status,
          billingInterval: draft.interval,
        },
      });
      setMsg({ type: 'ok', text: 'Billing updated successfully.' });
      if (onUpdate && data.billing) {
        onUpdate({
          ...church,
          billing_tier: data.billing.tier,
          billing_status: data.billing.status,
          billing_interval: data.billing.billingInterval,
        });
      }
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ color: C.muted, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Loading...</div>;

  const bill = billing || {};
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString() : '\u2014';

  return (
    <div>
      {/* Current billing info */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Billing Details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 12, marginBottom: 16 }}>
          <div style={{ color: C.dim }}>Current Tier</div>
          <div><span style={s.badge(C.green)}>{bill.tier || church?.billing_tier || 'connect'}</span></div>
          <div style={{ color: C.dim }}>Status</div>
          <div style={{ color: C.white }}>{bill.status || church?.billing_status || 'inactive'}</div>
          <div style={{ color: C.dim }}>Interval</div>
          <div style={{ color: C.white }}>{bill.billing_interval || church?.billing_interval || 'monthly'}</div>
          {bill.trial_ends_at && (
            <>
              <div style={{ color: C.dim }}>Trial Ends</div>
              <div style={{ color: C.yellow }}>{fmtDate(bill.trial_ends_at)}</div>
            </>
          )}
          {bill.current_period_end && (
            <>
              <div style={{ color: C.dim }}>Period End</div>
              <div style={{ color: C.white }}>
                {new Date(bill.current_period_end * 1000).toLocaleDateString()}
              </div>
            </>
          )}
          {bill.cancel_at_period_end && (
            <>
              <div style={{ color: C.dim }}>Canceling</div>
              <div style={{ color: C.red }}>Will cancel at period end</div>
            </>
          )}
          {bill.stripe_customer_id && (
            <>
              <div style={{ color: C.dim }}>Stripe</div>
              <div>
                <a
                  href={`https://dashboard.stripe.com/customers/${bill.stripe_customer_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: C.green, fontSize: 12 }}
                >
                  View in Stripe &#8599;
                </a>
              </div>
            </>
          )}
          {bill.stripe_subscription_id && (
            <>
              <div style={{ color: C.dim }}>Subscription</div>
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: C.muted }}>
                {bill.stripe_subscription_id}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Edit billing */}
      {canWrite(role) && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Update Billing</div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 120 }}>
              <label style={s.label}>Plan</label>
              <select
                style={s.input}
                value={draft.tier}
                onChange={e => setDraft(d => ({ ...d, tier: e.target.value }))}
              >
                {PLAN_OPTIONS.map(plan => (
                  <option key={plan} value={plan}>{plan}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <label style={s.label}>Status</label>
              <select
                style={s.input}
                value={draft.status}
                onChange={e => setDraft(d => ({ ...d, status: e.target.value }))}
              >
                {PLAN_STATUS_OPTIONS.map(status => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <label style={s.label}>Interval</label>
              <select
                style={s.input}
                value={draft.interval}
                onChange={e => setDraft(d => ({ ...d, interval: e.target.value }))}
              >
                {INTERVAL_OPTIONS.map(iv => (
                  <option key={iv} value={iv}>{iv.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
          </div>

          {msg.text && <div style={msg.type === 'ok' ? s.ok : s.err}>{msg.text}</div>}

          <button
            style={s.btn('primary')}
            onClick={saveBilling}
            disabled={saving}
          >
            {saving ? 'Saving\u2026' : 'Save Billing'}
          </button>
        </div>
      )}
    </div>
  );
}
