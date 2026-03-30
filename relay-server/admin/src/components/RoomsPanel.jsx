import { useState, useEffect } from 'react';
import { C, s } from './adminStyles';

function fmtTime(d) { return d ? new Date(d).toLocaleString() : '—'; }

export default function RoomsPanel({ churchId, api }) {
  const [sv, setSv] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api(`/api/admin/church/${churchId}/support-view`);
        if (!cancelled) setSv(data);
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [churchId, api]);

  if (loading) return <div style={{ color: C.muted, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Loading...</div>;

  const rooms = sv?.rooms || [];
  const roomInstanceMap = sv?.roomInstanceMap || {};
  const instanceStatusMap = sv?.instanceStatusMap || {};
  const roomEquipment = sv?.roomEquipment || {};

  if (rooms.length === 0) {
    return <div style={{ color: C.muted, fontSize: 13, padding: '24px 0', textAlign: 'center' }}>No rooms configured.</div>;
  }

  const chipStyle = (on) => ({
    display: 'inline-block', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 500,
    background: on ? 'rgba(34,197,94,.1)' : 'rgba(148,163,184,.08)',
    color: on ? C.green : C.dim,
    border: `1px solid ${on ? 'rgba(34,197,94,.2)' : 'rgba(148,163,184,.15)'}`,
  });

  const miniTh = { textAlign: 'left', padding: '6px 10px', fontSize: 10, color: C.dim, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: `1px solid ${C.border}` };
  const miniTd = { padding: '8px 10px', borderBottom: `1px solid rgba(26,46,31,0.3)`, color: C.muted, fontSize: 12, verticalAlign: 'middle' };

  return (
    <div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>
        {rooms.length} room{rooms.length !== 1 ? 's' : ''} configured
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={miniTh}>Room</th>
            <th style={miniTh}>Instance</th>
            <th style={miniTh}>Status</th>
            <th style={miniTh}>Equipment</th>
            <th style={miniTh}>Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map(rm => {
            const instName = roomInstanceMap[rm.id];
            const instData = instName ? instanceStatusMap[instName] : null;
            const isOnline = instData ? instData.online : false;
            const eqConfig = roomEquipment[rm.id];

            // Build equipment chips from live data or config
            const chips = [];
            if (instData) {
              const d = instData.connectedDevices || {};
              if (d.atem) chips.push(['ATEM', true]);
              if (d.obs) chips.push(['OBS', true]);
              if (d.vmix) chips.push(['vMix', true]);
              if (d.companion) chips.push(['Companion', true]);
              if (d.encoders?.length) chips.push(['Encoder', true]);
              if (d.mixers?.length) chips.push(['Mixer', true]);
              if (d.ptz?.length) chips.push([`PTZ (${d.ptz.length})`, true]);
              if (d.hyperdecks?.length) chips.push(['HyperDeck', true]);
              if (d.videoHubs?.length) chips.push(['VideoHub', true]);
            } else if (eqConfig) {
              // Show configured equipment as offline
              if (eqConfig.atem) chips.push(['ATEM', false]);
              if (eqConfig.obs) chips.push(['OBS', false]);
              if (eqConfig.vmix) chips.push(['vMix', false]);
              if (eqConfig.companion) chips.push(['Companion', false]);
            }

            const lastSeen = instData?.lastHeartbeat
              ? fmtTime(instData.lastHeartbeat)
              : (isOnline ? 'Now' : '—');

            return (
              <tr key={rm.id}>
                <td style={{ ...miniTd, color: C.white, fontWeight: 500 }}>{rm.name}</td>
                <td style={{ ...miniTd, fontFamily: 'monospace', fontSize: 11 }}>{instName || '—'}</td>
                <td style={miniTd}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: isOnline ? C.green : C.muted,
                      boxShadow: isOnline ? `0 0 5px ${C.green}` : 'none',
                    }} />
                    <span style={{ fontSize: 11 }}>{isOnline ? 'Online' : 'Offline'}</span>
                  </div>
                </td>
                <td style={miniTd}>
                  {chips.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {chips.map(([label, on], i) => (
                        <span key={i} style={chipStyle(on)}>{label}</span>
                      ))}
                    </div>
                  ) : (
                    <span style={{ color: C.dim, fontSize: 11 }}>—</span>
                  )}
                </td>
                <td style={{ ...miniTd, fontSize: 11 }}>{lastSeen}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
