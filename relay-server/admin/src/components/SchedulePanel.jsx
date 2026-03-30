import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function SchedulePanel({ churchId, api, role }) {
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/churches/${churchId}/schedule`);
      setSchedule(data);
      // Build draft from schedule
      const d = {};
      DAYS.forEach(day => { d[day] = ''; });
      if (data?.schedule) {
        data.schedule.forEach(s => { if (s.times?.length) d[s.day] = s.times.join(', '); });
      }
      if (data?.serviceTimes) {
        data.serviceTimes.forEach(s => { if (s.times?.length) d[s.day] = s.times.join(', '); });
      }
      setDraft(d);
    } catch { /* no schedule */ }
    finally { setLoading(false); }
  }, [churchId, api]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true); setMsg({ type: '', text: '' });
    try {
      const serviceTimes = DAYS.map(day => ({
        day,
        times: draft[day] ? draft[day].split(',').map(t => t.trim()).filter(Boolean) : [],
      })).filter(d => d.times.length > 0);
      await api(`/api/churches/${churchId}/schedule`, { method: 'PUT', body: { serviceTimes } });
      setMsg({ type: 'ok', text: 'Schedule saved.' });
      setEditing(false);
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
    finally { setSaving(false); }
  }

  if (loading) return <div style={{ color: C.muted, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Loading...</div>;

  const sc = schedule || {};

  return (
    <div>
      {/* Current Status */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Current Status</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
          <span style={s.badge(sc.inServiceWindow ? C.green : C.muted)}>
            {sc.inServiceWindow ? 'In Service Window' : 'Outside Service Window'}
          </span>
          {sc.nextService && <span style={{ color: C.dim }}>Next: {sc.nextService.day} {sc.nextService.time || ''}</span>}
        </div>
      </div>

      {/* Weekly Schedule */}
      <div style={s.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={s.sectionTitle}>Weekly Schedule</div>
          {canWrite(role) && !editing && <button style={{ ...s.btn('secondary'), padding: '4px 12px', fontSize: 11 }} onClick={() => setEditing(true)}>Edit</button>}
        </div>
        {editing ? (
          <div>
            {DAYS.map(day => (
              <div key={day} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <span style={{ width: 90, fontSize: 12, color: C.muted, flexShrink: 0 }}>{day}</span>
                <input
                  style={{ ...s.input, flex: 1 }}
                  value={draft[day] || ''}
                  onChange={e => setDraft(d => ({ ...d, [day]: e.target.value }))}
                  placeholder="e.g. 9:00 AM, 11:00 AM"
                  disabled={saving}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={s.btn('primary')} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
              <button style={s.btn('secondary')} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div>
            {DAYS.map(day => {
              const entry = sc.schedule?.find(d => d.day === day) || sc.serviceTimes?.find(d => d.day === day);
              const times = entry?.times || [];
              return times.length > 0 ? (
                <div key={day} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 12 }}>
                  <span style={{ width: 90, color: C.muted, flexShrink: 0 }}>{day}</span>
                  <span style={{ color: C.white }}>{times.join(', ')}</span>
                </div>
              ) : null;
            })}
            {!sc.schedule?.some(d => d.times?.length > 0) && !sc.serviceTimes?.some(d => d.times?.length > 0) && (
              <div style={{ color: C.muted, fontSize: 12 }}>No service times configured.</div>
            )}
          </div>
        )}
      </div>

      {msg.text && <div style={msg.type === 'ok' ? s.ok : s.err}>{msg.text}</div>}
    </div>
  );
}
