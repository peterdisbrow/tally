import { useState, useEffect, useCallback } from 'react';
import { C, s, canManageUsers, ROLE_COLORS, ROLE_LABELS } from './adminStyles';

const ROLE_OPTIONS = ['super_admin', 'admin', 'engineer', 'sales'];

export default function UsersTab({ api }) {
  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState('');
  const [modal, setModal]       = useState(null);  // 'add' | 'edit' | 'setpw' | null
  const [editUser, setEditUser] = useState(null);
  const [form, setForm]         = useState({ email: '', name: '', role: 'engineer', password: '' });
  const [formErr, setFormErr]   = useState('');
  const [formOk, setFormOk]     = useState('');
  const [saving, setSaving]     = useState(false);
  const [pwForm, setPwForm]     = useState({ userId: '', password: '' });
  const [pwMsg, setPwMsg]       = useState({ type: '', text: '' });

  const load = useCallback(async () => {
    try {
      setErr('');
      const data = await api('/api/admin/users');
      setUsers(Array.isArray(data) ? data : data.users || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  function openAdd() {
    setForm({ email: '', name: '', role: 'engineer', password: '' });
    setFormErr(''); setFormOk('');
    setModal('add');
  }

  function openEdit(u) {
    setEditUser(u);
    setForm({ email: u.email || '', name: u.name || '', role: u.role || 'engineer', password: '' });
    setFormErr(''); setFormOk('');
    setModal('edit');
  }

  async function submitUser(e) {
    e.preventDefault();
    setSaving(true); setFormErr(''); setFormOk('');
    try {
      if (modal === 'add') {
        if (!form.email) { setFormErr('Email is required'); setSaving(false); return; }
        if (!form.password || form.password.length < 8) { setFormErr('Password must be at least 8 characters'); setSaving(false); return; }
        await api('/api/admin/users', {
          method: 'POST',
          body: { email: form.email, name: form.name, role: form.role, password: form.password },
        });
        setFormOk('User created');
        setModal(null);
      } else {
        await api(`/api/admin/users/${editUser.id}`, {
          method: 'PUT',
          body: { email: form.email, name: form.name, role: form.role },
        });
        setModal(null);
      }
      load();
    } catch (e) { setFormErr(e.message); }
    finally { setSaving(false); }
  }

  function openSetPassword(u) {
    setPwForm({ userId: u.id, password: '' });
    setPwMsg({ type: '', text: '' });
    setModal('setpw');
  }

  async function submitSetPassword(e) {
    e.preventDefault();
    if (!pwForm.password || pwForm.password.length < 8) {
      setPwMsg({ type: 'err', text: 'Password must be at least 8 characters' });
      return;
    }
    try {
      await api(`/api/admin/users/${pwForm.userId}/password`, {
        method: 'PUT',
        body: { password: pwForm.password },
      });
      setPwMsg({ type: 'ok', text: 'Password updated' });
      setTimeout(() => setModal(null), 1000);
    } catch (e) {
      setPwMsg({ type: 'err', text: e.message });
    }
  }

  async function deleteUser(u) {
    if (!confirm(`Delete user "${u.name || u.email}"? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      load();
    } catch (e) { alert('Error: ' + e.message); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Admin Users ({users.length})</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={s.btn('secondary')} onClick={load}>{'\u21BB'} Refresh</button>
          <button style={s.btn('primary')} onClick={openAdd}>+ Add User</button>
        </div>
      </div>

      {loading && <div style={s.empty}>Loading\u2026</div>}
      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}

      {!loading && !err && (
        users.length === 0
          ? <div style={s.empty}>No admin users yet</div>
          : <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Name', 'Email', 'Role', 'Status', 'Actions'].map(h => <th key={h} style={s.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id}>
                      <td style={s.td}>
                        <div style={{ fontWeight: 600 }}>{u.name || '\u2014'}</div>
                      </td>
                      <td style={s.td}>{u.email}</td>
                      <td style={s.td}>
                        <span style={s.badge(ROLE_COLORS[u.role] || C.muted)}>
                          {ROLE_LABELS[u.role] || u.role}
                        </span>
                      </td>
                      <td style={s.td}>
                        <span style={s.badge(u.active !== false ? C.green : C.muted)}>
                          {u.active !== false ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td style={s.td}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }} onClick={() => openEdit(u)}>Edit</button>
                          <button style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }} onClick={() => openSetPassword(u)}>Set Password</button>
                          <button style={{ ...s.btn('danger'), padding: '4px 8px', fontSize: 11 }} onClick={() => deleteUser(u)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
      )}

      {/* Add / Edit User Modal */}
      {(modal === 'add' || modal === 'edit') && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div style={s.modalBox} role="dialog" aria-modal="true">
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
              {modal === 'add' ? '+ Add User' : 'Edit User'}
            </div>
            <form onSubmit={submitUser}>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Name</label>
                <input style={s.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="John Smith" autoFocus />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Email *</label>
                <input style={s.input} type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="john@tallyconnect.app" />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Role</label>
                <select style={s.input} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  {ROLE_OPTIONS.map(r => (
                    <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>
                  ))}
                </select>
              </div>
              {modal === 'add' && (
                <div style={{ marginBottom: 14 }}>
                  <label style={s.label}>Password * <span style={{ color: C.muted, fontWeight: 400 }}>(min 8 chars)</span></label>
                  <input style={s.input} type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Password" />
                </div>
              )}
              {formErr && <div style={s.err}>{formErr}</div>}
              {formOk && <div style={s.ok}>{formOk}</div>}
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
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>Set Password</div>
            <form onSubmit={submitSetPassword}>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>New Password <span style={{ color: C.muted, fontWeight: 400 }}>(min 8 chars)</span></label>
                <input style={s.input} type="password" value={pwForm.password} onChange={e => setPwForm(f => ({ ...f, password: e.target.value }))} placeholder="New password" autoFocus />
              </div>
              {pwMsg.text && <div style={pwMsg.type === 'ok' ? s.ok : s.err}>{pwMsg.text}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
                <button type="button" style={s.btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button type="submit" style={s.btn('primary')}>Set Password</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
