import React, { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';
import EquipmentRoles from './EquipmentRoles';

function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }

export default function RoomsTab({ api, role }) {
  const [rooms, setRooms] = useState([]);
  const [churches, setChurches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [filterChurch, setFilterChurch] = useState('');

  // Modal state
  const [modal, setModal] = useState(null); // 'add' | 'edit'
  const [form, setForm] = useState({ churchId: '', name: '', description: '' });
  const [editId, setEditId] = useState(null);
  const [formErr, setFormErr] = useState('');
  const [formOk, setFormOk] = useState('');
  const [saving, setSaving] = useState(false);
  const [rolesRoomId, setRolesRoomId] = useState(null);

  const load = useCallback(async () => {
    try {
      setErr('');
      const [roomData, churchData] = await Promise.all([
        api('/api/admin/rooms?limit=200'),
        api('/api/admin/churches?limit=200'),
      ]);
      setRooms(roomData.rooms || []);
      setChurches(churchData.churches || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const filtered = rooms.filter(r => {
    if (filterChurch && r.campus_id !== filterChurch) return false;
    if (search) {
      const q = search.toLowerCase();
      return (r.name || '').toLowerCase().includes(q)
        || (r.church_name || '').toLowerCase().includes(q)
        || (r.description || '').toLowerCase().includes(q);
    }
    return true;
  });

  function openAdd() {
    setForm({ churchId: filterChurch || '', name: '', description: '' });
    setFormErr(''); setFormOk('');
    setModal('add');
  }

  function openEdit(room) {
    setEditId(room.id);
    setForm({ churchId: room.campus_id, name: room.name, description: room.description || '' });
    setFormErr(''); setFormOk('');
    setModal('edit');
  }

  async function handleSave(e) {
    e.preventDefault();
    setFormErr(''); setFormOk(''); setSaving(true);
    try {
      if (modal === 'add') {
        await api('/api/admin/rooms', {
          method: 'POST',
          body: { churchId: form.churchId, name: form.name, description: form.description },
        });
        setFormOk('Room created');
        setForm({ churchId: form.churchId, name: '', description: '' });
      } else {
        await api(`/api/admin/rooms/${editId}`, {
          method: 'PATCH',
          body: { name: form.name, description: form.description },
        });
        setFormOk('Room updated');
      }
      load();
    } catch (e) { setFormErr(e.message); }
    finally { setSaving(false); }
  }

  async function deleteRoom(room) {
    if (!confirm(`Delete room "${room.name}"? This soft-deletes the room and cleans up related data.`)) return;
    try {
      await api(`/api/admin/rooms/${room.id}`, { method: 'DELETE' });
      setRooms(prev => prev.filter(r => r.id !== room.id));
    } catch (e) { alert('Error: ' + e.message); }
  }

  const churchMap = {};
  for (const c of churches) churchMap[c.churchId] = c.name;

  if (loading) return <div style={s.empty}>Loading rooms…</div>;
  if (err) return <div style={{ ...s.card, ...s.err }}>{err}</div>;

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ ...s.input, maxWidth: 260 }}
          placeholder="Search rooms…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          style={{ ...s.input, maxWidth: 220 }}
          value={filterChurch}
          onChange={e => setFilterChurch(e.target.value)}
        >
          <option value="">All churches</option>
          {churches.map(c => (
            <option key={c.churchId} value={c.churchId}>{c.name}</option>
          ))}
        </select>
        {canWrite(role) && (
          <button style={s.btn('primary')} onClick={openAdd}>+ Add Room</button>
        )}
        <span style={{ fontSize: 12, color: C.muted, marginLeft: 'auto' }}>
          {filtered.length} room{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div style={s.card}>
        {filtered.length === 0 ? (
          <div style={s.empty}>No rooms found.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Room</th>
                  <th style={s.th}>Church</th>
                  <th style={s.th}>Description</th>
                  <th style={s.th}>Created</th>
                  {canWrite(role) && <th style={s.th}></th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <React.Fragment key={r.id}>
                    <tr>
                      <td style={{ ...s.td, fontWeight: 600, color: C.white }}>{r.name}</td>
                      <td style={s.td}>{r.church_name || churchMap[r.campus_id] || r.campus_id}</td>
                      <td style={{ ...s.td, color: C.muted, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.description || '—'}
                      </td>
                      <td style={s.td}>{fmtDate(r.created_at)}</td>
                      {canWrite(role) && (
                        <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                          <button
                            style={{ ...s.btn(rolesRoomId === r.id ? 'primary' : 'secondary'), fontSize: 11, padding: '5px 10px', marginRight: 6 }}
                            onClick={() => setRolesRoomId(rolesRoomId === r.id ? null : r.id)}
                          >Roles</button>
                          <button style={{ ...s.btn('secondary'), fontSize: 11, padding: '5px 10px', marginRight: 6 }} onClick={() => openEdit(r)}>Edit</button>
                          <button style={{ ...s.btn('danger'), fontSize: 11, padding: '5px 10px' }} onClick={() => deleteRoom(r)}>Delete</button>
                        </td>
                      )}
                    </tr>
                    {rolesRoomId === r.id && (
                      <tr>
                        <td colSpan={canWrite(role) ? 5 : 4} style={{ padding: '12px 16px', background: 'rgba(255,255,255,0.01)', borderBottom: `1px solid ${C.border}` }}>
                          <EquipmentRoles api={api} roomId={r.id} onClose={() => setRolesRoomId(null)} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      {modal && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div style={s.modalBox} role="dialog" aria-modal="true">
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
              {modal === 'add' ? '+ Add Room' : 'Edit Room'}
            </div>
            <form onSubmit={handleSave}>
              {modal === 'add' && (
                <div style={{ marginBottom: 14 }}>
                  <label style={s.label}>Church *</label>
                  <select
                    style={s.input}
                    value={form.churchId}
                    onChange={e => setForm(f => ({ ...f, churchId: e.target.value }))}
                    required
                  >
                    <option value="">Select a church…</option>
                    {churches.map(c => (
                      <option key={c.churchId} value={c.churchId}>{c.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Room Name *</label>
                <input
                  style={s.input}
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  required
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Description</label>
                <input
                  style={s.input}
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                />
              </div>
              {formErr && <div style={s.err}>{formErr}</div>}
              {formOk && <div style={s.ok}>{formOk}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
                <button type="button" style={s.btn('secondary')} onClick={() => setModal(null)}>Close</button>
                <button type="submit" style={s.btn('primary')} disabled={saving}>
                  {saving ? 'Saving…' : modal === 'add' ? 'Add' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
