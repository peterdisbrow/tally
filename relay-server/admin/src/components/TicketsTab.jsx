import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';

const PAGE_SIZE = 50;

export default function TicketsTab({ api, role }) {
  const [tickets, setTickets]       = useState([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(true);
  const [err, setErr]               = useState('');
  const [search, setSearch]         = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortCol, setSortCol]       = useState(null);
  const [sortDir, setSortDir]       = useState('asc');
  const [detailTicket, setDetailTicket] = useState(null);

  const load = useCallback(async (p) => {
    const targetPage = p || page;
    try {
      setErr(''); setLoading(true);
      const data = await api(`/api/admin/tickets?page=${targetPage}&limit=${PAGE_SIZE}`);
      if (Array.isArray(data)) {
        setTickets(data);
        setTotal(data.length);
      } else {
        setTickets(data.tickets || []);
        setTotal(data.total || (data.tickets || []).length);
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

  // Filter + sort
  let list = tickets;
  if (statusFilter !== 'all') list = list.filter(t => t.status === statusFilter);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(t => (t.title || '').toLowerCase().includes(q) || (t.church_name || '').toLowerCase().includes(q));
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
  const sevColor = (sev) => sev === 'critical' || sev === 'high' ? C.red : sev === 'medium' ? C.yellow : C.green;
  const statusColor = (st) => st === 'open' ? C.red : st === 'in_progress' ? C.yellow : C.green;
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
            placeholder="Search tickets..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 2 }}>
            {[['all', 'All'], ['open', 'Open'], ['in_progress', 'In Progress'], ['resolved', 'Resolved']].map(([val, label]) => (
              <button key={val} style={filterTab(statusFilter === val)} onClick={() => setStatusFilter(val)}>
                {label}
              </button>
            ))}
          </div>
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
                  Created {sortCol === 'created_at' ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : ''}
                </th>
                <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => toggleSort('church_name')}>
                  Church {sortCol === 'church_name' ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : ''}
                </th>
                <th style={s.th}>Severity</th>
                <th style={s.th}>Category</th>
                <th style={s.th}>Title</th>
                <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => toggleSort('status')}>
                  Status {sortCol === 'status' ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : ''}
                </th>
                <th style={s.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 ? (
                <tr><td colSpan={7} style={{ ...s.td, textAlign: 'center', color: C.muted }}>No tickets found</td></tr>
              ) : list.map(t => {
                const statusLabel = (t.status || 'open').replace('_', ' ');
                return (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setDetailTicket(t)}>
                    <td style={s.td}>{new Date(t.created_at).toLocaleString()}</td>
                    <td style={s.td}>{t.church_name || 'Unknown'}</td>
                    <td style={s.td}><span style={s.badge(sevColor(t.severity))}>{t.severity || 'low'}</span></td>
                    <td style={s.td}>{t.category || '\u2014'}</td>
                    <td style={s.td}>{t.title || 'Untitled'}</td>
                    <td style={s.td}><span style={s.badge(statusColor(t.status))}>{statusLabel}</span></td>
                    <td style={s.td}>
                      <button
                        style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }}
                        onClick={(e) => { e.stopPropagation(); setDetailTicket(t); }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', fontSize: 13, color: C.muted }}>
              <span>{total} tickets</span>
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

      {/* Ticket Detail Modal */}
      {detailTicket && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setDetailTicket(null); }}>
          <div style={s.wideModalBox} role="dialog" aria-modal="true">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{detailTicket.title || 'Ticket Details'}</div>
              <button style={{ ...s.btn('secondary'), padding: '6px 12px', fontSize: 12 }} onClick={() => setDetailTicket(null)}>Close</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 16px', fontSize: 13, marginBottom: 20 }}>
              <div style={{ color: C.dim }}>Status</div>
              <div><span style={s.badge(statusColor(detailTicket.status))}>{(detailTicket.status || 'open').replace('_', ' ')}</span></div>
              <div style={{ color: C.dim }}>Church</div>
              <div style={{ color: C.white }}>{detailTicket.church_name || 'Unknown'}</div>
              <div style={{ color: C.dim }}>Category</div>
              <div style={{ color: C.white }}>{detailTicket.category || '\u2014'}</div>
              <div style={{ color: C.dim }}>Severity</div>
              <div><span style={s.badge(sevColor(detailTicket.severity))}>{detailTicket.severity || 'low'}</span></div>
              <div style={{ color: C.dim }}>Created</div>
              <div style={{ color: C.white }}>{new Date(detailTicket.created_at).toLocaleString()}</div>
            </div>

            {detailTicket.description && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Description</div>
                <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, margin: 0 }}>{detailTicket.description}</p>
              </div>
            )}

            {detailTicket.updates && detailTicket.updates.length > 0 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Updates</div>
                {detailTicket.updates.map((u, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.green, marginTop: 5, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{u.author || 'System'}</div>
                      <div style={{ fontSize: 13, color: C.muted }}>{u.message || ''}</div>
                      <div style={{ fontSize: 11, color: C.dim }}>{new Date(u.created_at).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
