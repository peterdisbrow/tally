import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';

const PAGE_SIZE = 50;

export default function AlertsTab({ api, role }) {
  const [alerts, setAlerts]       = useState([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState('');
  const [search, setSearch]       = useState('');
  const [sevFilter, setSevFilter] = useState('all');
  const [ackFilter, setAckFilter] = useState('unack');
  const [sortCol, setSortCol]     = useState(null);
  const [sortDir, setSortDir]     = useState('asc');

  const load = useCallback(async (p) => {
    const targetPage = p || page;
    try {
      setErr(''); setLoading(true);
      const data = await api(`/api/admin/alerts?page=${targetPage}&limit=${PAGE_SIZE}`);
      if (Array.isArray(data)) {
        setAlerts(data);
        setTotal(data.length);
      } else {
        setAlerts(data.alerts || []);
        setTotal(data.total || (data.alerts || []).length);
        if (data.page) setPage(data.page);
      }
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api, page]);

  useEffect(() => { load(1); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  function changePage(delta) {
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const newPage = Math.max(1, Math.min(totalPages, page + delta));
    if (newPage !== page) { setPage(newPage); load(newPage); }
  }

  function toggleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  async function acknowledgeAlert(id) {
    try {
      await api(`/api/admin/alerts/${id}/acknowledge`, { method: 'POST' });
      load(page);
    } catch (e) { alert('Failed: ' + e.message); }
  }

  // Filter + sort
  let list = alerts;
  if (sevFilter !== 'all') list = list.filter(a => (a.severity || 'info') === sevFilter);
  if (ackFilter === 'unack') list = list.filter(a => !a.acknowledged_at);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(a => (a.church_name || '').toLowerCase().includes(q) || (a.instance_name || '').toLowerCase().includes(q));
  }
  if (sortCol) {
    const dir = sortDir === 'desc' ? -1 : 1;
    list = list.slice().sort((a, b) => {
      let va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
      if (typeof va === 'string') { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
      return va < vb ? -dir : va > vb ? dir : 0;
    });
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const sevColor = (sev) => sev === 'critical' ? C.red : sev === 'warning' ? C.yellow : C.green;
  const filterTab = (active) => ({
    background: active ? 'rgba(34,197,94,0.12)' : 'none',
    border: active ? '1px solid rgba(34,197,94,0.3)' : '1px solid transparent',
    color: active ? C.green : C.muted,
    fontSize: 12, fontWeight: 600, padding: '5px 12px', cursor: 'pointer',
    borderRadius: 6, transition: 'all 0.15s',
  });

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{ ...s.input, width: 200 }}
            placeholder="Search by church..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 2 }}>
            {['all', 'critical', 'warning', 'info'].map(f => (
              <button key={f} style={filterTab(sevFilter === f)} onClick={() => setSevFilter(f)}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {[['unack', 'Unacknowledged'], ['all', 'All']].map(([val, label]) => (
            <button key={val} style={filterTab(ackFilter === val)} onClick={() => setAckFilter(val)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}
      {loading && <div style={s.empty}>Loading\u2026</div>}

      {!loading && !err && (
        <div style={s.card}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => toggleSort('created_at')}>
                  Time {sortCol === 'created_at' ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : ''}
                </th>
                <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => toggleSort('church_name')}>
                  Church {sortCol === 'church_name' ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : ''}
                </th>
                <th style={s.th}>Room</th>
                <th style={s.th}>Type</th>
                <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => toggleSort('severity')}>
                  Severity {sortCol === 'severity' ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : ''}
                </th>
                <th style={s.th}>Status</th>
                {canWrite(role) && <th style={s.th}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {list.length === 0 ? (
                <tr><td colSpan={canWrite(role) ? 7 : 6} style={{ ...s.td, textAlign: 'center', color: C.muted }}>No alerts found</td></tr>
              ) : list.map(a => {
                const roomName = a.instance_name ? a.instance_name.split('::')[0] : '';
                return (
                  <tr key={a.id}>
                    <td style={s.td}>{new Date(a.created_at).toLocaleString()}</td>
                    <td style={s.td}>{a.church_name || 'Unknown'}</td>
                    <td style={{ ...s.td, color: C.muted, fontSize: 12 }}>{roomName || '\u2014'}</td>
                    <td style={s.td}>{a.alert_type || a.type || '\u2014'}</td>
                    <td style={s.td}><span style={s.badge(sevColor(a.severity))}>{a.severity || 'info'}</span></td>
                    <td style={s.td}>
                      {a.acknowledged_at
                        ? <span style={s.badge(C.muted)}>Acknowledged</span>
                        : <span style={s.badge(C.red)}>Active</span>
                      }
                    </td>
                    {canWrite(role) && (
                      <td style={s.td}>
                        {!a.acknowledged_at && (
                          <button
                            style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }}
                            onClick={() => acknowledgeAlert(a.id)}
                          >
                            Acknowledge
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', fontSize: 13, color: C.muted }}>
              <span>{total} alerts</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button style={{ ...s.btn('secondary'), padding: '5px 12px', fontSize: 12 }} disabled={page <= 1} onClick={() => changePage(-1)}>
                  Prev
                </button>
                <span>Page {page} of {totalPages}</span>
                <button style={{ ...s.btn('secondary'), padding: '5px 12px', fontSize: 12 }} disabled={page >= totalPages} onClick={() => changePage(1)}>
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
