import { useState } from 'react';
import { C, s } from './adminStyles';

export default function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setLoading(true);
    try {
      const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
      const txt = await res.text();
      let data;
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {
        data = { error: txt || 'Invalid login response' };
      }
      if (!res.ok) throw new Error(data.error || 'Invalid credentials');
      if (data?.token) {
        sessionStorage.setItem('tally_admin_token', data.token);
      }
      if (data?.user) {
        sessionStorage.setItem('tally_admin_user', JSON.stringify(data.user));
      }
      onLogin(data.token, data.user);
    } catch(e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div style={{ ...s.card, width: 'min(380px, 100%)', textAlign: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
          <span style={s.logoGreen}>Tally</span> Admin
        </div>
        <div style={{ color: C.muted, fontSize: 13, marginBottom: 24 }}>ATEM School — Restricted Access</div>
        <form onSubmit={submit}>
          <div style={{ marginBottom: 14, textAlign: 'left' }}>
            <label style={s.label}>Email</label>
            <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@atemschool.com" autoFocus />
          </div>
          <div style={{ marginBottom: 16, textAlign: 'left' }}>
            <label style={s.label}>Password</label>
            <input style={s.input} type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Enter password" />
          </div>
          {err && <div style={s.err}>{err}</div>}
          <button style={{ ...s.btn('primary'), width: '100%', padding: '10px', fontSize: 14, marginTop: 16 }} type="submit" disabled={loading}>
            {loading ? 'Signing in\u2026' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
