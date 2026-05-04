import { useState, useEffect, useCallback, useRef } from 'react';
import { C, s } from './adminStyles';

const LEVEL_FILTERS = [
  ['all',   'All'],
  ['info',  'Info'],
  ['warn',  'Warn+'],
  ['error', 'Error'],
];

const RANGE_FILTERS = [
  ['1h',  '1h'],
  ['6h',  '6h'],
  ['24h', '24h'],
  ['7d',  '7d'],
];

const REFRESH_MS = 30_000;

function levelColor(level) {
  if (level === 'error') return C.red;
  if (level === 'warn')  return C.yellow;
  return C.green;
}

export default function LogsTab({ api }) {
  const [churches, setChurches]     = useState([]);
  const [churchId, setChurchId]     = useState('');
  const [level, setLevel]           = useState('all');
  const [range, setRange]           = useState('24h');
  const [logs, setLogs]             = useState([]);
  const [loading, setLoading]       = useState(false);
  const [err, setErr]               = useState('');
  const [copied, setCopied]         = useState(false);
  const [lastFetched, setLastFetched] = useState(null);
  const refreshTimer = useRef(null);

  // Load church list once for the selector.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api('/api/admin/churches?limit=500');
        if (cancelled) return;
        const list = (data?.churches || []).slice().sort((a, b) =>
          (a.name || '').localeCompare(b.name || ''));
        setChurches(list);
        if (!churchId && list.length > 0) setChurchId(list[0].churchId);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!churchId) return;
    try {
      setErr('');
      setLoading(true);
      const qs = `level=${encodeURIComponent(level)}&range=${encodeURIComponent(range)}&limit=1000`;
      const data = await api(`/api/admin/churches/${encodeURIComponent(churchId)}/logs?${qs}`);
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
      setLastFetched(new Date());
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [api, churchId, level, range]);

  useEffect(() => { load(); }, [load]);

  // 30s auto-refresh.
  useEffect(() => {
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    refreshTimer.current = setInterval(load, REFRESH_MS);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [load]);

  async function copyAsJson() {
    try {
      const text = JSON.stringify(logs, null, 2);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr('Failed to copy to clipboard');
    }
  }

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
          <select
            style={{ ...s.input, minWidth: 220 }}
            value={churchId}
            onChange={e => setChurchId(e.target.value)}
          >
            {churches.length === 0 && <option value="">No churches</option>}
            {churches.map(c => (
              <option key={c.churchId} value={c.churchId}>{c.name || c.churchId}</option>
            ))}
          </select>

          <div style={{ display: 'flex', gap: 2 }}>
            {LEVEL_FILTERS.map(([v, label]) => (
              <button key={v} style={filterTab(level === v)} onClick={() => setLevel(v)}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 2 }}>
            {RANGE_FILTERS.map(([v, label]) => (
              <button key={v} style={filterTab(range === v)} onClick={() => setRange(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {lastFetched && (
            <span style={{ color: C.muted, fontSize: 11 }}>
              Updated {lastFetched.toLocaleTimeString()}
            </span>
          )}
          <button style={{ ...s.btn('secondary'), padding: '5px 12px', fontSize: 12 }} onClick={load} disabled={loading || !churchId}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button style={{ ...s.btn('secondary'), padding: '5px 12px', fontSize: 12 }} onClick={copyAsJson} disabled={logs.length === 0}>
            {copied ? 'Copied!' : 'Copy as JSON'}
          </button>
        </div>
      </div>

      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}

      {/* Log table */}
      <div style={{ ...s.card, padding: 0, overflow: 'hidden' }}>
        <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <table style={{ ...s.table, margin: 0 }}>
            <thead style={{ position: 'sticky', top: 0, background: C.surface, zIndex: 1 }}>
              <tr>
                <th style={{ ...s.th, width: 170 }}>Time</th>
                <th style={{ ...s.th, width: 70 }}>Level</th>
                <th style={{ ...s.th, width: 120 }}>Room</th>
                <th style={{ ...s.th, width: 110 }}>Device</th>
                <th style={s.th}>Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ ...s.td, textAlign: 'center', color: C.muted, padding: '24px 0' }}>
                    {loading ? 'Loading…' : 'No logs in selected window'}
                  </td>
                </tr>
              ) : logs.map(row => {
                let errorPreview = '';
                if (row.error_json) {
                  try {
                    const parsed = JSON.parse(row.error_json);
                    if (parsed?.error?.message) errorPreview = parsed.error.message;
                    else if (parsed?.context) errorPreview = JSON.stringify(parsed.context);
                  } catch { /* ignore parse */ }
                }
                return (
                  <tr key={row.id}>
                    <td style={{ ...s.td, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}>
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td style={s.td}>
                      <span style={s.badge(levelColor(row.level))}>{row.level}</span>
                    </td>
                    <td style={{ ...s.td, color: C.muted, fontSize: 12 }}>{row.room_id || '—'}</td>
                    <td style={{ ...s.td, color: C.muted, fontSize: 12 }}>
                      {row.device_type || '—'}
                      {row.device_id ? <div style={{ fontSize: 10, color: C.dim }}>{row.device_id}</div> : null}
                    </td>
                    <td style={{ ...s.td, fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-word' }}>
                      <div style={{ color: levelColor(row.level) }}>{row.message}</div>
                      {errorPreview && (
                        <div style={{ marginTop: 4, color: C.muted, fontSize: 11 }}>{errorPreview}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}` }}>
          <span>{logs.length} {logs.length === 1 ? 'entry' : 'entries'}</span>
          <span>Auto-refreshes every 30s • retention 7d / 10k rows per church</span>
        </div>
      </div>
    </div>
  );
}
