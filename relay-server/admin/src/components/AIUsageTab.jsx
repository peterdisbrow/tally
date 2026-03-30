import { useState, useEffect, useCallback } from 'react';
import { C, s } from './adminStyles';

const FEATURE_LABELS = {
  command_parser: 'Command Parser',
  setup_assistant: 'Setup Assistant',
  dashboard_chat: 'Dashboard Chat',
  church_chat: 'Church Chat',
};

export default function AIUsageTab({ api }) {
  const [totals, setTotals]         = useState(null);
  const [byChurch, setByChurch]     = useState([]);
  const [byFeature, setByFeature]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [err, setErr]               = useState('');
  const [dateFrom, setDateFrom]     = useState('');
  const [dateTo, setDateTo]         = useState('');

  const load = useCallback(async (from, to) => {
    try {
      setErr(''); setLoading(true);
      const params = new URLSearchParams();
      if (from) params.set('from', from + 'T00:00:00');
      if (to)   params.set('to', to + 'T23:59:59');
      const qs = params.toString();
      const data = await api('/api/admin/ai-usage' + (qs ? '?' + qs : ''));
      setTotals(data.totals || {});
      setByChurch(data.byChurch || []);
      setByFeature(data.byFeature || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load('', ''); }, [load]);

  function applyFilter() { load(dateFrom, dateTo); }
  function resetFilter() { setDateFrom(''); setDateTo(''); load('', ''); }

  const fmt = (n) => (n || 0).toLocaleString();
  const fmtCost = (n) => '$' + (n || 0).toFixed(4);

  return (
    <div>
      {/* Date range toolbar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ color: C.muted, fontSize: 13 }}>Date Range:</span>
        <input
          type="date"
          style={{ ...s.input, width: 150 }}
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          title="From date"
        />
        <span style={{ color: C.muted }}>to</span>
        <input
          type="date"
          style={{ ...s.input, width: 150 }}
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          title="To date"
        />
        <button style={{ ...s.btn('primary'), padding: '7px 16px' }} onClick={applyFilter}>Apply</button>
        <button style={{ ...s.btn('secondary'), padding: '7px 12px', fontSize: 12 }} onClick={resetFilter}>Reset (30d)</button>
      </div>

      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Requests (30d)', value: totals ? fmt(totals.total_requests) : '\u2014' },
          { label: 'Input Tokens', value: totals ? fmt(totals.total_input_tokens) : '\u2014' },
          { label: 'Output Tokens', value: totals ? fmt(totals.total_output_tokens) : '\u2014' },
          { label: 'Est. Cost (30d)', value: totals ? fmtCost(totals.total_cost) : '\u2014', highlight: true },
          { label: 'Cache Hits', value: totals ? fmt(totals.cache_hits) : '\u2014' },
        ].map(c => (
          <div key={c.label} style={{ ...s.statCard, ...(c.highlight ? { borderColor: C.green } : {}) }}>
            <div style={{ ...s.statVal, fontSize: 22 }}>{c.value}</div>
            <div style={s.statLbl}>{c.label}</div>
          </div>
        ))}
      </div>

      {loading && <div style={s.empty}>Loading\u2026</div>}

      {!loading && !err && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* By Church */}
          <div style={s.card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Usage by Church</div>
            <table style={{ ...s.table, minWidth: 0 }}>
              <thead>
                <tr>
                  {['Church', 'Requests', 'Input Tok', 'Output Tok', 'Cost'].map(h => <th key={h} style={s.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {byChurch.length === 0 ? (
                  <tr><td colSpan={5} style={{ ...s.td, textAlign: 'center', color: C.muted }}>No usage data yet</td></tr>
                ) : byChurch.map((r, i) => (
                  <tr key={i}>
                    <td style={s.td}>{r.church_name || r.church_id || 'Admin / Dashboard'}</td>
                    <td style={s.td}>{fmt(r.requests)}</td>
                    <td style={s.td}>{fmt(r.input_tokens)}</td>
                    <td style={s.td}>{fmt(r.output_tokens)}</td>
                    <td style={s.td}>{fmtCost(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* By Feature */}
          <div style={s.card}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Usage by Feature</div>
            <table style={{ ...s.table, minWidth: 0 }}>
              <thead>
                <tr>
                  {['Feature', 'Requests', 'Input Tok', 'Output Tok', 'Cost'].map(h => <th key={h} style={s.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {byFeature.length === 0 ? (
                  <tr><td colSpan={5} style={{ ...s.td, textAlign: 'center', color: C.muted }}>No usage data yet</td></tr>
                ) : byFeature.map((r, i) => (
                  <tr key={i}>
                    <td style={s.td}>{FEATURE_LABELS[r.feature] || r.feature}</td>
                    <td style={s.td}>{fmt(r.requests)}</td>
                    <td style={s.td}>{fmt(r.input_tokens)}</td>
                    <td style={s.td}>{fmt(r.output_tokens)}</td>
                    <td style={s.td}>{fmtCost(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
