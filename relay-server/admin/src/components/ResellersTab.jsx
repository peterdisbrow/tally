import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';

const RELAY_HOST = '';

const buttonMini = { ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 };

function ApiKeyDisplay({ apiKey, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.modalBox} role="dialog" aria-modal="true">
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, textAlign: 'center' }}>API Key — Copy Now!</div>
        <div style={{ color: C.muted, fontSize: 13, marginBottom: 16, textAlign: 'center' }}>This key will not be shown again.</div>
        <div
          style={{
            background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '12px 16px', fontFamily: 'monospace', fontSize: 13,
            color: C.green, cursor: 'pointer', wordBreak: 'break-all', textAlign: 'center',
          }}
          onClick={() => { navigator.clipboard.writeText(apiKey); setCopied(true); }}
        >
          {apiKey}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button
            style={s.btn('primary')}
            onClick={() => { navigator.clipboard.writeText(apiKey); setCopied(true); }}
          >
            {copied ? 'Copied!' : 'Copy API Key'}
          </button>
          <button style={s.btn('secondary')} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default function ResellersTab({ api, role }) {
  const [resellers, setResellers] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState('');
  const [modal, setModal]         = useState(null);   // 'add' | 'edit' | 'setpw' | null
  const [editId, setEditId]       = useState(null);
  const [form, setForm]           = useState({
    name: '', brandName: '', supportEmail: '', logoUrl: '',
    primaryColor: '#22c55e', churchLimit: 10, password: '',
  });
  const [formErr, setFormErr]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [apiKeyModal, setApiKeyModal] = useState(null); // string | null
  const [pwForm, setPwForm]       = useState({ id: '', password: '' });
  const [pwMsg, setPwMsg]         = useState('');

  const load = useCallback(async () => {
    try {
      setErr('');
      const data = await api('/api/resellers');
      setResellers(Array.isArray(data) ? data : []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  function openAdd() {
    setForm({ name: '', brandName: '', supportEmail: '', logoUrl: '', primaryColor: '#22c55e', churchLimit: 10, password: '' });
    setFormErr('');
    setModal('add');
  }

  function openEdit(r) {
    setEditId(r.id);
    setForm({
      name: r.name || '',
      brandName: r.brand_name || '',
      supportEmail: r.support_email || '',
      logoUrl: r.logo_url || '',
      primaryColor: r.primary_color || '#22c55e',
      churchLimit: r.church_limit || 10,
      password: '',
    });
    setFormErr('');
    setModal('edit');
  }

  async function submitReseller(e) {
    e.preventDefault();
    const isNew = modal === 'add';
    if (isNew && !form.password) { setFormErr('Portal password is required'); return; }
    setSaving(true); setFormErr('');
    try {
      const body = {
        name: form.name,
        brandName: form.brandName,
        supportEmail: form.supportEmail,
        logoUrl: form.logoUrl,
        primaryColor: form.primaryColor,
        churchLimit: parseInt(form.churchLimit) || 10,
      };
      if (isNew) body.password = form.password;

      const url = isNew ? '/api/resellers' : `/api/admin/resellers/${editId}`;
      const method = isNew ? 'POST' : 'PUT';
      const data = await api(url, { method, body });

      if (isNew && data.resellerId) {
        await api(`/api/admin/resellers/${data.resellerId}/password`, {
          method: 'POST',
          body: { password: form.password },
        });
        setModal(null);
        if (data.apiKey) setApiKeyModal(data.apiKey);
      } else {
        setModal(null);
      }
      load();
    } catch (e) { setFormErr(e.message); }
    finally { setSaving(false); }
  }

  function openSetPassword(id) {
    setPwForm({ id, password: '' });
    setPwMsg('');
    setModal('setpw');
  }

  async function submitSetPassword(e) {
    e.preventDefault();
    if (!pwForm.password) { setPwMsg('Password required'); return; }
    try {
      await api(`/api/admin/resellers/${pwForm.id}/password`, {
        method: 'POST',
        body: { password: pwForm.password },
      });
      setModal(null);
    } catch (e) { setPwMsg(e.message); }
  }

  async function toggleReseller(id, active) {
    try {
      await api(`/api/admin/resellers/${id}`, {
        method: 'PUT',
        body: { active: active ? 0 : 1 },
      });
      load();
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function deleteReseller(id, name) {
    if (!confirm(`Delete reseller "${name}"? This will deactivate the account.`)) return;
    try {
      await api(`/api/admin/resellers/${id}`, { method: 'DELETE' });
      load();
    } catch (e) { alert('Delete failed: ' + e.message); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Resellers ({resellers.length})</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={s.btn('secondary')} onClick={load}>{'\u21BB'} Refresh</button>
          {canWrite(role) && <button style={s.btn('primary')} onClick={openAdd}>+ Add Reseller</button>}
        </div>
      </div>

      {loading && <div style={s.empty}>Loading\u2026</div>}
      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}

      {!loading && !err && (
        resellers.length === 0
          ? <div style={s.empty}>No resellers yet</div>
          : <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Brand Name', 'Slug', 'Email', 'Churches', 'Color', 'Status', ...(canWrite(role) ? ['Actions'] : [])].map(h => <th key={h} style={s.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {resellers.map(r => (
                    <tr key={r.id}>
                      <td style={s.td}>
                        <div style={{ fontWeight: 600 }}>{r.brand_name || r.name}</div>
                      </td>
                      <td style={s.td}>
                        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.slug || ''}</span>
                      </td>
                      <td style={s.td}>{r.support_email || '\u2014'}</td>
                      <td style={s.td}>{r.churchCount || 0} / {r.church_limit || 10}</td>
                      <td style={s.td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            display: 'inline-block', width: 14, height: 14, borderRadius: 4,
                            background: r.primary_color || '#22c55e', border: `1px solid ${C.border}`,
                          }} />
                          <span style={{ fontSize: 12, color: C.muted }}>{r.primary_color || '#22c55e'}</span>
                        </div>
                      </td>
                      <td style={s.td}>
                        <span style={s.badge(r.active ? C.green : C.muted)}>{r.active ? 'Active' : 'Inactive'}</span>
                      </td>
                      {canWrite(role) && (
                        <td style={s.td}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button style={buttonMini} onClick={() => openEdit(r)}>Edit</button>
                            <button style={buttonMini} onClick={() => openSetPassword(r.id)}>Set Password</button>
                            <button style={buttonMini} onClick={() => window.open(`${RELAY_HOST}/portal`, '_blank')}>View Portal</button>
                            <button style={buttonMini} onClick={() => toggleReseller(r.id, r.active)}>
                              {r.active ? 'Deactivate' : 'Activate'}
                            </button>
                            <button style={{ ...buttonMini, color: C.red, borderColor: C.red }} onClick={() => deleteReseller(r.id, r.brand_name || r.name)}>
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
      )}

      {/* Add / Edit Reseller Modal */}
      {(modal === 'add' || modal === 'edit') && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div style={s.modalBox} role="dialog" aria-modal="true">
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
              {modal === 'add' ? '+ Add Reseller' : 'Edit Reseller'}
            </div>
            <form onSubmit={submitReseller}>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Internal Name</label>
                <input style={s.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="AV Solutions Inc" autoFocus />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Brand Name</label>
                <input style={s.input} value={form.brandName} onChange={e => setForm(f => ({ ...f, brandName: e.target.value }))} placeholder="AV Solutions Pro" />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Support Email</label>
                <input style={s.input} type="email" value={form.supportEmail} onChange={e => setForm(f => ({ ...f, supportEmail: e.target.value }))} placeholder="support@avsolutions.com" />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Logo URL</label>
                <input style={s.input} type="url" value={form.logoUrl} onChange={e => setForm(f => ({ ...f, logoUrl: e.target.value }))} placeholder="https://..." />
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <label style={s.label}>Primary Color</label>
                  <input style={{ ...s.input, padding: 4, height: 38 }} type="color" value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={s.label}>Church Limit</label>
                  <input style={s.input} type="number" min="1" value={form.churchLimit} onChange={e => setForm(f => ({ ...f, churchLimit: e.target.value }))} />
                </div>
              </div>
              {modal === 'add' && (
                <div style={{ marginBottom: 14 }}>
                  <label style={s.label}>Portal Password <span style={{ color: C.red }}>*</span></label>
                  <input style={s.input} type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Create portal password" />
                </div>
              )}
              {formErr && <div style={s.err}>{formErr}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
                <button type="button" style={s.btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button type="submit" style={s.btn('primary')} disabled={saving}>{saving ? 'Saving\u2026' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Set Password Modal */}
      {modal === 'setpw' && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div style={s.modalBox} role="dialog" aria-modal="true">
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>Set Portal Password</div>
            <form onSubmit={submitSetPassword}>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>New Password</label>
                <input style={s.input} type="password" value={pwForm.password} onChange={e => setPwForm(f => ({ ...f, password: e.target.value }))} placeholder="New portal password" autoFocus />
              </div>
              {pwMsg && <div style={s.err}>{pwMsg}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
                <button type="button" style={s.btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button type="submit" style={s.btn('primary')}>Set Password</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* API Key Display Modal */}
      {apiKeyModal && (
        <ApiKeyDisplay apiKey={apiKeyModal} onClose={() => setApiKeyModal(null)} />
      )}
    </div>
  );
}
