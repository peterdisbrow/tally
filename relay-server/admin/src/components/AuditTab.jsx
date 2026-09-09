import { useState, useEffect, useCallback } from 'react';
import { C, s } from './adminStyles';

const PAGE_SIZE = 50;

export default function AuditTab({ api }) {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [action, setAction] = useState('');
  const [adminEmail, setAdminEmail] = useState('');

  const load = useCallback(async (p) => {
    const targetPage = p || page;
    try {
      setErr('');
      setLoading(true);
      const params = new URLSearchParams({ page: String(targetPage), limit: String(PAGE_SIZE) });
      if (action.trim()) params.set('action', action.trim());
      if (adminEmail.trim()) params.set('adminEmail', adminEmail.trim());
      const data = await api(`/api/admin/audit-log?${params.toString()}`);
      setLogs(data.logs || []);
      setTotal(data.total || 0);
      if (data.page) setPage(data.page);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [api, page, action, adminEmail]);

  useEffect(() => { load(1); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  function changePage(delta) {
    const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
    const newPage = Math.max(1, Math.min(totalPages, page + delta));
    if (newPage !== page) {
      setPage(newPage);
      load(newPage);
    }
  }

  function formatDetails(details) {
    if (!details) return '—';
    if (typeof details === 'object') return JSON.stringify(details);
    try {
      const parsed = JSON.parse(details);
      return typeof parsed === 'object' ? JSON.stringify(parsed) : String(details);
    } catch {
      return String(details);
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Audit log</div>
        <form
          onSubmit={(e) => { e.preventDefault(); setPage(1); load(1); }}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          <input
            style={{ ...s.input, width: 180 }}
            placeholder="Action (e.g. billing_updated)"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
          <input
            style={{ ...s.input, width: 180 }}
            placeholder="Admin email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
          <button type="submit" style={s.btn('secondary')}>Filter</button>
        </form>
      </div>

      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}
      {loading && <div style={s.empty}>Loading…</div>}

      {!loading && !err && (
        <div style={s.card}>
          <table style={s.table}>
            <thead>
              <tr>
                {['When', 'Admin', 'Action', 'Target', 'Details'].map((h) => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr><td colSpan={5} style={{ ...s.td, textAlign: 'center', color: C.muted }}>No audit entries</td></tr>
              ) : logs.map((row) => (
                <tr key={row.id || `${row.created_at}-${row.action}-${row.target_id}`}>
                  <td style={{ ...s.td, color: C.muted, fontSize: 12, whiteSpace: 'nowrap' }}>
                    {row.created_at ? new Date(row.created_at).toLocaleString() : '—'}
                  </td>
                  <td style={s.td}>{row.admin_email || '—'}</td>
                  <td style={s.td}><span style={s.badge(C.green)}>{row.action || '—'}</span></td>
                  <td style={s.td}>
                    <div style={{ fontSize: 12 }}>{row.target_type || '—'}</div>
                    <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>{row.target_id || ''}</div>
                  </td>
                  <td style={{ ...s.td, color: C.muted, fontSize: 12, maxWidth: 320, wordBreak: 'break-word' }}>
                    {formatDetails(row.details)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', fontSize: 13, color: C.muted }}>
              <span>{total} entries</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button style={{ ...s.btn('secondary'), padding: '5px 12px', fontSize: 12 }} disabled={page <= 1} onClick={() => changePage(-1)}>Prev</button>
                <span>Page {page} of {totalPages}</span>
                <button style={{ ...s.btn('secondary'), padding: '5px 12px', fontSize: 12 }} disabled={page >= totalPages} onClick={() => changePage(1)}>Next</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
