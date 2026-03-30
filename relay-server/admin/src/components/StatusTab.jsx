import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';

export default function StatusTab({ api, role }) {
  const [components, setComponents] = useState([]);
  const [incidents, setIncidents]   = useState([]);
  const [health, setHealth]         = useState(null);
  const [updatedAt, setUpdatedAt]   = useState(null);
  const [loading, setLoading]       = useState(true);
  const [err, setErr]               = useState('');
  const [running, setRunning]       = useState(false);

  const load = useCallback(async () => {
    try {
      setErr('');
      const [compData, incData, healthData] = await Promise.all([
        api('/api/status/components'),
        api('/api/status/incidents?limit=20'),
        api('/api/health').catch(() => null),
      ]);
      setComponents(compData.components || []);
      setUpdatedAt(compData.updatedAt || null);
      setIncidents(Array.isArray(incData) ? incData : []);
      setHealth(healthData);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  async function runChecks() {
    setRunning(true);
    try {
      await api('/api/status/run-checks', { method: 'POST' });
      await load();
    } catch (e) { alert('Check failed: ' + e.message); }
    finally { setRunning(false); }
  }

  const stateColor = (state) => {
    switch (state) {
      case 'operational': return C.green;
      case 'degraded':    return C.yellow;
      case 'down':        return C.red;
      default:            return C.muted;
    }
  };

  const stateLabel = (state) => {
    switch (state) {
      case 'operational': return 'Operational';
      case 'degraded':    return 'Degraded';
      case 'down':        return 'Down';
      default:            return state || 'Unknown';
    }
  };

  const formatUptime = (secs) => {
    if (!secs) return '\u2014';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const overallStatus = () => {
    if (components.length === 0) return 'unknown';
    if (components.some(c => c.state === 'down')) return 'down';
    if (components.some(c => c.state === 'degraded')) return 'degraded';
    return 'operational';
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: stateColor(overallStatus()),
            boxShadow: overallStatus() === 'operational' ? `0 0 6px ${C.green}` : 'none',
          }} />
          <span style={{ fontSize: 15, fontWeight: 700 }}>
            System {stateLabel(overallStatus())}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={s.btn('secondary')} onClick={load}>{'\u21BB'} Refresh</button>
          {canWrite(role) && (
            <button style={s.btn('primary')} onClick={runChecks} disabled={running}>
              {running ? 'Running...' : 'Run Checks'}
            </button>
          )}
        </div>
      </div>

      {loading && <div style={s.empty}>Loading...</div>}
      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}

      {/* Health stats */}
      {health && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
          {[
            ['Uptime', formatUptime(health.uptime), C.green],
            ['Churches', health.churches || 0, C.white],
            ['Connected', health.connected || 0, C.green],
            ['Memory', health.memory ? `${health.memory.heap_used_mb || health.memory.rss_mb || 0} MB` : '\u2014', C.blue],
          ].map(([lbl, val, color]) => (
            <div key={lbl} style={s.statCard}>
              <div style={s.statLbl}>{lbl}</div>
              <div style={{ ...s.statVal, color, fontSize: 22 }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Components */}
      {!loading && !err && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Components</div>
          {components.length === 0 ? (
            <div style={s.empty}>No components configured</div>
          ) : (
            <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Component', 'Status', 'Latency', 'Detail', 'Last Checked'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {components.map(c => (
                    <tr key={c.component_id}>
                      <td style={s.td}>
                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                        <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>{c.component_id}</div>
                      </td>
                      <td style={s.td}>
                        <span style={s.badge(stateColor(c.state))}>{stateLabel(c.state)}</span>
                      </td>
                      <td style={{ ...s.td, fontSize: 12, color: C.muted }}>
                        {c.latency_ms != null ? `${c.latency_ms}ms` : '\u2014'}
                      </td>
                      <td style={{ ...s.td, fontSize: 12, color: C.muted, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.detail || '\u2014'}
                      </td>
                      <td style={{ ...s.td, fontSize: 12, color: C.muted }}>
                        {c.last_checked_at ? new Date(c.last_checked_at).toLocaleString() : '\u2014'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {updatedAt && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
              Last updated: {new Date(updatedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Recent Incidents */}
      {!loading && !err && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Recent Incidents</div>
          {incidents.length === 0 ? (
            <div style={s.empty}>No recent incidents</div>
          ) : (
            <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Component', 'Change', 'Message', 'Started', 'Resolved'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {incidents.map(inc => (
                    <tr key={inc.id}>
                      <td style={{ ...s.td, fontSize: 12 }}>{inc.component_id}</td>
                      <td style={s.td}>
                        <span style={s.badge(stateColor(inc.previous_state))}>{stateLabel(inc.previous_state)}</span>
                        <span style={{ color: C.muted, margin: '0 6px' }}>{'\u2192'}</span>
                        <span style={s.badge(stateColor(inc.new_state))}>{stateLabel(inc.new_state)}</span>
                      </td>
                      <td style={{ ...s.td, fontSize: 12, color: C.muted, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {inc.message || '\u2014'}
                      </td>
                      <td style={{ ...s.td, fontSize: 12, color: C.muted }}>
                        {inc.started_at ? new Date(inc.started_at).toLocaleString() : '\u2014'}
                      </td>
                      <td style={{ ...s.td, fontSize: 12, color: C.muted }}>
                        {inc.resolved_at ? new Date(inc.resolved_at).toLocaleString() : (
                          <span style={{ color: C.red }}>Ongoing</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
