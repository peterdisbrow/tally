import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';

export default function TDsPanel({ churchId, api, role }) {
  const [tds, setTds] = useState([]);
  const [oncall, setOncall] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [addName, setAddName] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [assignForm, setAssignForm] = useState({ tdId: '', roomId: '' });

  const load = useCallback(async () => {
    try {
      setErr('');
      const [tdData, ocData, roomData, assignData] = await Promise.all([
        api(`/api/churches/${churchId}/tds`).catch(() => []),
        api(`/api/churches/${churchId}/oncall`).catch(() => null),
        api(`/api/admin/church/${churchId}/rooms`).catch(() => []),
        api(`/api/admin/church/${churchId}/td-room-assignments`).catch(() => []),
      ]);
      setTds(Array.isArray(tdData) ? tdData : tdData?.tds || []);
      setOncall(ocData?.onCall || ocData?.oncall || null);
      setRooms(Array.isArray(roomData) ? roomData : roomData?.rooms || []);
      setAssignments(Array.isArray(assignData) ? assignData : []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [churchId, api]);

  useEffect(() => { load(); }, [load]);

  async function addTd(e) {
    e.preventDefault();
    if (!addName.trim()) return;
    setSaving(true); setMsg({ type: '', text: '' });
    try {
      await api(`/api/churches/${churchId}/tds/add`, { method: 'POST', body: { name: addName.trim() } });
      setAddName('');
      setMsg({ type: 'ok', text: 'TD added.' });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
    finally { setSaving(false); }
  }

  async function removeTd(userId, name) {
    if (!confirm(`Remove TD "${name}"?`)) return;
    try {
      await api(`/api/churches/${churchId}/tds/${userId}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: `${name} removed.` });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
  }

  async function setOnCall(tdName) {
    try {
      await api(`/api/churches/${churchId}/oncall`, { method: 'POST', body: { tdName } });
      setOncall({ tdName });
      setMsg({ type: 'ok', text: `${tdName} is now on-call.` });
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
  }

  async function assignRoom(e) {
    e.preventDefault();
    if (!assignForm.tdId || !assignForm.roomId) return;
    setSaving(true); setMsg({ type: '', text: '' });
    try {
      await api(`/api/admin/church/${churchId}/td-room-assignments`, {
        method: 'POST',
        body: { tdId: Number(assignForm.tdId), roomId: assignForm.roomId },
      });
      setAssignForm({ tdId: '', roomId: '' });
      setMsg({ type: 'ok', text: 'Room assigned.' });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
    finally { setSaving(false); }
  }

  async function removeAssignment(assignmentId) {
    try {
      await api(`/api/admin/church/${churchId}/td-room-assignments/${assignmentId}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: 'Room assignment removed.' });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
  }

  // Build a lookup of assignments per TD
  const assignmentsByTd = {};
  for (const a of assignments) {
    if (!assignmentsByTd[a.td_id]) assignmentsByTd[a.td_id] = [];
    assignmentsByTd[a.td_id].push(a);
  }

  if (loading) return <div style={{ color: C.muted, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Loading...</div>;

  return (
    <div>
      {err && <div style={s.err}>{err}</div>}

      {/* On-Call */}
      <div style={s.section}>
        <div style={s.sectionTitle}>On-Call TD</div>
        {oncall?.tdName ? (
          <span style={s.badge(C.green)}>{oncall.tdName}</span>
        ) : (
          <span style={{ fontSize: 12, color: C.muted }}>No TD on-call</span>
        )}
      </div>

      {/* TD List */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Technical Directors ({tds.length})</div>
        {tds.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 12 }}>No TDs registered.</div>
        ) : (
          <table style={s.table}>
            <thead><tr>
              <th style={s.th}>Name</th>
              <th style={s.th}>Telegram</th>
              <th style={s.th}>Rooms</th>
              <th style={s.th}>Status</th>
              {canWrite(role) && <th style={s.th}>Actions</th>}
            </tr></thead>
            <tbody>
              {tds.map((td, i) => {
                const tdAssigns = assignmentsByTd[td.id] || [];
                return (
                  <tr key={td.id || td.telegram_user_id || i}>
                    <td style={s.td}>
                      <div>{td.name || td.td_name || '\u2014'}</div>
                      {td.email && <div style={{ fontSize: 10, color: C.dim }}>{td.email}</div>}
                    </td>
                    <td style={s.td}>
                      {td.telegram_chat_id && !td.telegram_chat_id.startsWith('portal_')
                        ? <span style={s.badge(C.green)}>Linked</span>
                        : <span style={s.badge(C.muted)}>{'\u2014'}</span>}
                    </td>
                    <td style={s.td}>
                      {tdAssigns.length === 0 ? (
                        <span style={{ fontSize: 11, color: C.dim }}>All rooms</span>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {tdAssigns.map(a => (
                            <span key={a.id} style={{ ...s.badge(C.blue), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {a.room_name}
                              {canWrite(role) && (
                                <span
                                  style={{ cursor: 'pointer', opacity: 0.6, fontSize: 10 }}
                                  onClick={() => removeAssignment(a.id)}
                                  title="Remove room assignment"
                                >{'\u00d7'}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={s.td}><span style={s.badge(td.active !== 0 ? C.green : C.muted)}>{td.active !== 0 ? 'Active' : 'Inactive'}</span></td>
                    {canWrite(role) && (
                      <td style={s.td}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 10 }} onClick={() => setOnCall(td.name || td.td_name)}>On-Call</button>
                          <button style={{ ...s.btn('danger'), padding: '4px 8px', fontSize: 10 }} onClick={() => removeTd(td.telegram_user_id || td.id, td.name || td.td_name)}>Remove</button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add TD */}
      {canWrite(role) && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Add TD</div>
          <form onSubmit={addTd} style={{ display: 'flex', gap: 8 }}>
            <input style={{ ...s.input, flex: 1 }} value={addName} onChange={e => setAddName(e.target.value)} placeholder="TD name" disabled={saving} />
            <button type="submit" style={s.btn('primary')} disabled={saving || !addName.trim()}>{saving ? 'Adding...' : 'Add'}</button>
          </form>
        </div>
      )}

      {/* Assign TD to Room */}
      {canWrite(role) && rooms.length > 0 && tds.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Assign TD to Room</div>
          <div style={{ fontSize: 11, color: C.dim, marginBottom: 8 }}>
            TDs without room assignments can see all rooms. Assigning a room restricts their portal access to only that room.
          </div>
          <form onSubmit={assignRoom} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ ...s.label, fontSize: 10 }}>TD</label>
              <select
                style={s.input}
                value={assignForm.tdId}
                onChange={e => setAssignForm(f => ({ ...f, tdId: e.target.value }))}
              >
                <option value="">Select TD...</option>
                {tds.map(td => (
                  <option key={td.id} value={td.id}>{td.name || td.td_name}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ ...s.label, fontSize: 10 }}>Room</label>
              <select
                style={s.input}
                value={assignForm.roomId}
                onChange={e => setAssignForm(f => ({ ...f, roomId: e.target.value }))}
              >
                <option value="">Select room...</option>
                {rooms.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
            <button type="submit" style={s.btn('primary')} disabled={saving || !assignForm.tdId || !assignForm.roomId}>
              {saving ? 'Assigning...' : 'Assign'}
            </button>
          </form>
        </div>
      )}

      {msg.text && <div style={msg.type === 'ok' ? s.ok : s.err}>{msg.text}</div>}
    </div>
  );
}
