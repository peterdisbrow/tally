import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite, PLAN_OPTIONS, PLAN_STATUS_OPTIONS, getEncoderNameFromStatus, getEncoderConnectedFromStatus, getEncoderLiveFromStatus } from './adminStyles';
import StatsBar from './StatsBar';
import ChurchDetailModal from './ChurchDetailModal';

export default function ChurchesTab({ api, role }) {
  const [churches, setChurches] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState('');
  const [modal, setModal]       = useState(null);
  const [detailChurch, setDetailChurch] = useState(null);
  const [form, setForm]         = useState({
    name: '',
    contactEmail: '',
    portalEmail: '',
    portalPassword: '',
    tier: 'connect',
    billingStatus: 'active',
  });
  const [formErr, setFormErr]   = useState('');
  const [formOk, setFormOk]     = useState('');
  const [saving, setSaving]     = useState(false);
  const [showTokens, setShowTokens] = useState({});
  const [billingDrafts, setBillingDrafts] = useState({});

  const load = useCallback(async () => {
    try {
      setErr('');
      const data = await api('/api/churches');
      const rows = Array.isArray(data) ? data : Object.values(data);
      setChurches(rows);
      setBillingDrafts((prev) => {
        const next = { ...prev };
        for (const c of rows) {
          if (!next[c.churchId]) {
            next[c.churchId] = {
              tier: c.billing_tier || 'connect',
              status: c.billing_status || 'inactive',
            };
          }
        }
        return next;
      });
    } catch(e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  async function addChurch(e) {
    e.preventDefault();
    setFormErr(''); setFormOk(''); setSaving(true);
    try {
      const data = await api('/api/churches/register', {
        method: 'POST',
        body: {
          name: form.name,
          email: form.contactEmail,
          portalEmail: form.portalEmail || undefined,
          password: form.portalPassword || undefined,
          tier: form.tier,
          billingStatus: form.billingStatus,
        },
      });
      setFormOk(`\u2705 Registered! Code: ${data.registrationCode || data.token || '\u2014'}`);
      setForm({
        name: '',
        contactEmail: '',
        portalEmail: '',
        portalPassword: '',
        tier: 'connect',
        billingStatus: 'active',
      });
      load();
    } catch(e) { setFormErr(e.message); }
    finally { setSaving(false); }
  }

  async function saveBilling(churchId) {
    const draft = billingDrafts[churchId];
    if (!draft) return;
    try {
      await api(`/api/churches/${churchId}/billing`, {
        method: 'PUT',
        body: {
          tier: draft.tier,
          status: draft.status,
        },
      });
      setChurches((prev) => prev.map((c) => (
        c.churchId === churchId
          ? { ...c, billing_tier: draft.tier, billing_status: draft.status }
          : c
      )));
    } catch (e) {
      alert(`Billing update failed: ${e.message}`);
    }
  }

  async function deleteChurch(churchId, name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/churches/${churchId}`, { method: 'DELETE' });
      setChurches(prev => prev.filter(c => c.churchId !== churchId));
    } catch(e) { alert('Error: ' + e.message); }
  }

  const statusColor = (c) => c.connected ? (c.activeAlerts > 0 ? C.red : C.green) : C.muted;
  const statusLabel = (c) => c.connected ? (c.activeAlerts > 0 ? 'Alert' : 'Online') : 'Offline';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <StatsBar churches={churches} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Churches ({churches.length})</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={s.btn('secondary')} onClick={load}>{'\u21BB'} Refresh</button>
          {canWrite(role) && <button style={s.btn('primary')} onClick={() => { setModal('add'); setFormErr(''); setFormOk(''); }}>+ Add Church</button>}
        </div>
      </div>

      {loading && <div style={s.empty}>Loading\u2026</div>}
      {err     && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}

      {!loading && !err && (
        churches.length === 0
          ? <div style={s.empty}>No churches yet. Add one to get started.</div>
          : <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Church', 'Account', 'Reg Code', 'Conn Token', 'Plan', 'Status', 'ATEM', 'Encoder', 'Stream', 'Last Seen', ...(canWrite(role) ? [''] : [])].map(h => <th key={h} style={s.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {churches.map(c => {
                    const st = c.status || {};
                    const encoderName = getEncoderNameFromStatus(st);
                    const encoderConnected = getEncoderConnectedFromStatus(st);
                    const encoderLive = getEncoderLiveFromStatus(st);
                    const draft = billingDrafts[c.churchId] || {
                      tier: c.billing_tier || 'connect',
                      status: c.billing_status || 'inactive',
                    };
                    return (
                      <tr key={c.churchId}>
                        <td style={s.td}>
                          <div
                            style={{ fontWeight: 600, cursor: 'pointer', color: C.white, transition: 'color 0.15s' }}
                            onClick={() => setDetailChurch(c)}
                            onMouseEnter={e => e.currentTarget.style.color = C.green}
                            onMouseLeave={e => e.currentTarget.style.color = C.white}
                            title="Click for details"
                          >{c.name}</div>
                          <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>{c.churchId?.slice(0, 12)}\u2026</div>
                          {c.has_slack && <span style={{ ...s.badge(C.green), marginTop: 2, fontSize: 10 }}>Slack</span>}
                        </td>
                        <td style={s.td}>
                          <div style={{ fontSize: 12 }}>{c.portal_email || '\u2014'}</div>
                        </td>
                        <td style={s.td}>
                          <div
                            onClick={() => {
                              if (!c.registrationCode) return;
                              navigator.clipboard.writeText(c.registrationCode);
                            }}
                            title={c.registrationCode ? 'Copy registration code' : ''}
                            style={{
                              fontFamily: 'monospace',
                              letterSpacing: 1,
                              fontSize: 12,
                              color: c.registrationCode ? C.green : C.muted,
                              cursor: c.registrationCode ? 'pointer' : 'default',
                            }}>
                            {c.registrationCode || '\u2014'}
                          </div>
                        </td>
                        <td style={s.td}>
                          <div style={{ fontFamily: 'monospace', fontSize: 11, letterSpacing: 0.5, color: c.token ? C.white : C.muted }}>
                            {showTokens[c.churchId] ? (c.token || '\u2014') : (c.token ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : '\u2014')}
                          </div>
                          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                            {c.token && (
                              <>
                                <button
                                  style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }}
                                  onClick={() => setShowTokens((prev) => ({ ...prev, [c.churchId]: !prev[c.churchId] }))}
                                >
                                  {showTokens[c.churchId] ? 'Hide' : 'Reveal'}
                                </button>
                                <button
                                  style={{ ...s.btn('primary'), padding: '4px 8px', fontSize: 11 }}
                                  onClick={() => navigator.clipboard.writeText(c.token)}
                                >
                                  Copy
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                        <td style={s.td}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <select
                              style={{ ...s.input, minWidth: 96, padding: '5px 8px', fontSize: 12 }}
                              value={draft.tier}
                              disabled={!canWrite(role)}
                              onChange={(e) => setBillingDrafts((prev) => ({
                                ...prev,
                                [c.churchId]: { ...draft, tier: e.target.value },
                              }))}
                            >
                              {PLAN_OPTIONS.map((plan) => (
                                <option key={plan} value={plan}>{plan}</option>
                              ))}
                            </select>
                            <select
                              style={{ ...s.input, minWidth: 104, padding: '5px 8px', fontSize: 12 }}
                              value={draft.status}
                              disabled={!canWrite(role)}
                              onChange={(e) => setBillingDrafts((prev) => ({
                                ...prev,
                                [c.churchId]: { ...draft, status: e.target.value },
                              }))}
                            >
                              {PLAN_STATUS_OPTIONS.map((status) => (
                                <option key={status} value={status}>{status}</option>
                              ))}
                            </select>
                            {canWrite(role) && <button
                              style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }}
                              onClick={() => saveBilling(c.churchId)}
                            >
                              Save
                            </button>}
                          </div>
                        </td>
                        <td style={s.td}><span style={s.badge(statusColor(c))}>{statusLabel(c)}</span></td>
                        <td style={s.td}><span style={s.badge(st.atem?.connected ? C.green : C.muted)}>{st.atem?.connected ? 'Connected' : '\u2014'}</span></td>
                        <td style={s.td}><span style={s.badge(encoderConnected ? C.green : C.muted)}>{encoderName} {encoderConnected ? 'Online' : '\u2014'}</span></td>
                        <td style={s.td}><span style={s.badge(encoderLive ? C.red : C.muted)}>{encoderLive ? '\uD83D\uDD34 Live' : 'Off'}</span></td>
                        <td style={{ ...s.td, color: C.muted, fontSize: 12 }}>{c.lastSeen ? new Date(c.lastSeen).toLocaleString() : '\u2014'}</td>
                        {canWrite(role) && <td style={s.td}>
                          <button style={{ ...s.btn('danger'), padding: '4px 10px', fontSize: 11 }} onClick={() => deleteChurch(c.churchId, c.name)}>Delete</button>
                        </td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
      )}

      {modal === 'add' && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div style={s.modalBox} role="dialog" aria-modal="true" aria-labelledby="add-church-modal-title">
            <div id="add-church-modal-title" style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>+ Add Church</div>
            <form onSubmit={addChurch}>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Church Name *</label>
                <input style={s.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Grace Community Church" autoFocus />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Contact Email</label>
                <input style={s.input} type="email" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} placeholder="td@gracecommunity.org" />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Login Email</label>
                <input style={s.input} type="email" value={form.portalEmail} onChange={e => setForm(f => ({ ...f, portalEmail: e.target.value }))} placeholder="admin@gracecommunity.org" />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Login Password</label>
                <input style={s.input} type="password" minLength={8} value={form.portalPassword} onChange={e => setForm(f => ({ ...f, portalPassword: e.target.value }))} placeholder="Minimum 8 characters (optional)" />
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <label style={s.label}>Plan</label>
                  <select style={s.input} value={form.tier} onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}>
                    {PLAN_OPTIONS.map((plan) => (
                      <option key={plan} value={plan}>{plan}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={s.label}>Plan Status</label>
                  <select style={s.input} value={form.billingStatus} onChange={e => setForm(f => ({ ...f, billingStatus: e.target.value }))}>
                    {PLAN_STATUS_OPTIONS.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </div>
              </div>
              {formErr && <div style={s.err}>{formErr}</div>}
              {formOk  && <div style={s.ok}>{formOk}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
                <button type="button" style={s.btn('secondary')} onClick={() => setModal(null)}>Close</button>
                <button type="submit" style={s.btn('primary')} disabled={saving}>{saving ? 'Registering\u2026' : 'Register Church'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {detailChurch && (
        <ChurchDetailModal
          church={detailChurch}
          api={api}
          role={role}
          onClose={() => setDetailChurch(null)}
          onUpdate={(updated) => {
            setChurches(prev => prev.map(c => c.churchId === updated.churchId ? { ...c, ...updated } : c));
            setDetailChurch(updated);
          }}
        />
      )}
    </div>
  );
}
