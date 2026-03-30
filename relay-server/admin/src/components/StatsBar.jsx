import { C, s } from './adminStyles';

export default function StatsBar({ churches }) {
  const total   = churches.length;
  const online  = churches.filter(c => c.connected).length;
  const alerts  = churches.filter(c => (c.activeAlerts || 0) > 0).length;
  const offline = total - online;
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
      {[['Total', total, C.white], ['Online', online, C.green], ['Alerts', alerts, C.red], ['Offline', offline, C.muted]].map(([lbl, val, color]) => (
        <div key={lbl} style={s.statCard}>
          <div style={s.statLbl}>{lbl}</div>
          <div style={{ ...s.statVal, color }}>{val}</div>
        </div>
      ))}
    </div>
  );
}
