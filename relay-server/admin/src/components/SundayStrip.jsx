import { C, s } from './adminStyles';
import { ZERO_CONNECTED_NOTE } from '../monitorEmptyCopy';

export default function SundayStrip({ overview }) {
  const loaded = overview != null;
  const connected = overview?.onlineNow ?? 0;
  const unacked = overview?.unackedAlerts ?? overview?.activeAlerts ?? 0;
  const inService = overview?.inServiceNow ?? 0;

  const pills = [
    { label: 'Connected', value: loaded ? connected : '—', color: connected > 0 ? C.green : C.muted },
    { label: 'Open unacked alerts', value: loaded ? unacked : '—', color: unacked > 0 ? C.red : C.muted },
    { label: 'In service window now', value: loaded ? inService : '—', color: inService > 0 ? C.yellow : C.muted },
  ];

  return (
    <div style={{
      ...s.card,
      marginBottom: 16,
      padding: '10px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      flexWrap: 'wrap',
      background: '#0d1017',
      borderColor: '#1d2e24',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Sunday
      </div>
      {pills.map((p) => (
        <div key={p.label} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: p.color, lineHeight: 1 }}>{p.value}</span>
          <span style={{ fontSize: 12, color: C.muted }}>{p.label}</span>
        </div>
      ))}
      {loaded && connected === 0 && (
        <div style={{ width: '100%', fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          {ZERO_CONNECTED_NOTE}
        </div>
      )}
    </div>
  );
}
