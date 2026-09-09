import { useState } from 'react';
import { s } from './adminStyles';

export default function ChangePasswordModal({ api, onClose }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setOk('');
    if (newPassword !== confirm) {
      setErr('New passwords do not match');
      return;
    }
    setSaving(true);
    try {
      await api('/api/admin/me/password', {
        method: 'PUT',
        body: { currentPassword, newPassword },
      });
      setOk('Password updated');
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={s.modal} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.modalBox} role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <div id="change-password-title" style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>Change password</div>
        <form onSubmit={submit}>
          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Current password</label>
            <input style={s.input} type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoFocus />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>New password</label>
            <input style={s.input} type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Minimum 8 characters" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Confirm new password</label>
            <input style={s.input} type="password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {err && <div style={s.err}>{err}</div>}
          {ok && <div style={s.ok}>{ok}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
            <button type="button" style={s.btn('secondary')} onClick={onClose}>Close</button>
            <button type="submit" style={s.btn('primary')} disabled={saving}>{saving ? 'Saving…' : 'Update password'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
