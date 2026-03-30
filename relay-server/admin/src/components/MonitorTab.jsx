import { useState, useEffect, useRef } from 'react';
import { C, s } from './adminStyles';

export default function MonitorTab({ token }) {
  const [churches, setChurches] = useState([]);
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  const [showOnlyOnline, setShowOnlyOnline] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    if (!token) return;

    const url = `/api/dashboard/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setErr('');
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'initial' || data.type === 'snapshot') {
          setChurches(data.churches || []);
        } else if (data.type === 'status') {
          setChurches(prev => prev.map(c =>
            c.churchId === data.churchId ? { ...c, ...data } : c
          ));
        } else if (data.type === 'connect') {
          setChurches(prev => {
            const exists = prev.find(c => c.churchId === data.churchId);
            if (exists) {
              return prev.map(c => c.churchId === data.churchId ? { ...c, connected: true, ...data } : c);
            }
            return [...prev, { ...data, connected: true }];
          });
        } else if (data.type === 'disconnect') {
          setChurches(prev => prev.map(c =>
            c.churchId === data.churchId ? { ...c, connected: false } : c
          ));
        } else if (data.type === 'alert') {
          setChurches(prev => prev.map(c =>
            c.churchId === data.churchId
              ? { ...c, activeAlerts: (c.activeAlerts || 0) + 1 }
              : c
          ));
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      setConnected(false);
      setErr('SSE connection lost. Reconnecting...');
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [token]);

  const filtered = churches.filter(c => {
    if (showOnlyOnline && !c.connected) return false;
    if (filter) {
      const q = filter.toLowerCase();
      return (c.name || '').toLowerCase().includes(q) || (c.churchId || '').toLowerCase().includes(q);
    }
    return true;
  });

  const online = churches.filter(c => c.connected).length;
  const withAlerts = churches.filter(c => c.connected && (c.activeAlerts || 0) > 0).length;

  return (
    <div>
      {/* Connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: connected ? C.green : C.red,
          boxShadow: connected ? `0 0 6px ${C.green}` : 'none',
        }} />
        <span style={{ fontSize: 13, color: connected ? C.green : C.red }}>
          {connected ? 'Live' : 'Disconnected'}
        </span>
        {err && <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{err}</span>}
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        {[
          ['Total', churches.length, C.white],
          ['Online', online, C.green],
          ['Alerts', withAlerts, C.red],
          ['Offline', churches.length - online, C.muted],
        ].map(([lbl, val, color]) => (
          <div key={lbl} style={s.statCard}>
            <div style={s.statLbl}>{lbl}</div>
            <div style={{ ...s.statVal, color, fontSize: 22 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ ...s.input, maxWidth: 280 }}
          placeholder="Search churches..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showOnlyOnline}
            onChange={e => setShowOnlyOnline(e.target.checked)}
          />
          Online only
        </label>
      </div>

      {/* Church list */}
      {filtered.length === 0 ? (
        <div style={s.empty}>
          {churches.length === 0 ? 'Waiting for data...' : 'No matching churches'}
        </div>
      ) : (
        <div style={s.card}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Church', 'Status', 'Alerts', 'Last Seen'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const st = c.status || {};
                const isOnline = c.connected;
                const alertCount = c.activeAlerts || 0;
                return (
                  <tr key={c.churchId}>
                    <td style={s.td}>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>
                        {c.churchId?.slice(0, 12)}{'\u2026'}
                      </div>
                    </td>
                    <td style={s.td}>
                      <span style={s.badge(isOnline ? (alertCount > 0 ? C.red : C.green) : C.muted)}>
                        {isOnline ? (alertCount > 0 ? 'Alert' : 'Online') : 'Offline'}
                      </span>
                    </td>
                    <td style={s.td}>
                      {alertCount > 0 ? (
                        <span style={{ color: C.red, fontWeight: 600 }}>{alertCount}</span>
                      ) : (
                        <span style={{ color: C.muted }}>{'\u2014'}</span>
                      )}
                    </td>
                    <td style={{ ...s.td, color: C.muted, fontSize: 12 }}>
                      {c.lastSeen ? new Date(c.lastSeen).toLocaleString() : '\u2014'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
