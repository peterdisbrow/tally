import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';

const ACCESS_LEVELS = ['viewer', 'operator', 'admin'];

export default function TDsPanel({ churchId, api, role }) {
  const [tds, setTds] = useState([]);
  const [oncall, setOncall] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [addForm, setAddForm] = useState({ name: '', email: '', accessLevel: 'operator' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [assignForm, setAssignForm] = useState({ tdId: '', roomId: '' });
  const [pwModal, setPwModal] = useState(null); // { tdId, name, password }
  const [emailEdit, setEmailEdit] = useState(null); // { tdId, value }

  const showMsg = (type, text) => setMsg({ type, text });

  const load = useCallback(async () => {
    try {
      setErr('');
      const [tdData, ocData, roomData] = await Promise.all([
        api(`/api/admin/church/${churchId}/tds`).catch(() => []),
        api(`/api/churches/${churchId}/oncall`).catch(() => null),
        api(`/api/admin/church/${churchId}/rooms`).catch(() => []),
      ]);
      setTds(Array.isArray(tdData) ? tdData : tdData?.tds || []);
      setOncall(ocData?.onCall || ocData?.oncall || null);
      setRooms(Array.isArray(roomData) ? roomData : roomData?.rooms || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [churchId, api]);

  useEffect(() => { load(); }, [load]);

  async function addTd(e) {
    e.preventDefault();
    const cleanName = addForm.name.trim();
    const cleanEmail = addForm.email.trim().toLowerCase();
    if (!cleanName) return;
    setSaving(true); showMsg('', '');
    try {
      await api(`/api/admin/church/${churchId}/tds`, {
        method: 'POST',
        body: {
          name: cleanName,
          email: cleanEmail,
          accessLevel: addForm.accessLevel,
        },
      });
      setAddForm({ name: '', email: '', accessLevel: 'operator' });
      showMsg('ok', cleanEmail ? 'TD added. Set a password to enable portal login.' : 'TD added.');
      load();
    } catch (e) { showMsg('err', e.message); }
    finally { setSaving(false); }
  }

  async function removeTd(tdId, name) {
    if (!confirm(`Remove TD "${name}"? This deletes their credentials and room assignments.`)) return;
    try {
      await api(`/api/admin/church/${churchId}/tds/${tdId}`, { method: 'DELETE' });
      showMsg('ok', `${name} removed.`);
      load();
    } catch (e) { showMsg('err', e.message); }
  }

  async function setOnCall(tdName) {
    try {
      await api(`/api/churches/${churchId}/oncall`, { method: 'POST', body: { tdName } });
      setOncall({ tdName });
      showMsg('ok', `${tdName} is now on-call.`);
    } catch (e) { showMsg('err', e.message); }
  }

  async function assignRoom(e) {
    e.preventDefault();
    if (!assignForm.tdId || !assignForm.roomId) return;
    setSaving(true); showMsg('', '');
    try {
      await api(`/api/admin/church/${churchId}/td-room-assignments`, {
        method: 'POST',
        body: { tdId: Number(assignForm.tdId), roomId: assignForm.roomId },
      });
      setAssignForm({ tdId: '', roomId: '' });
      showMsg('ok', 'Room assigned.');
      load();
    } catch (e) { showMsg('err', e.message); }
    finally { setSaving(false); }
  }

  async function removeAssignment(assignmentId) {
    try {
      await api(`/api/admin/church/${churchId}/td-room-assignments/${assignmentId}`, { method: 'DELETE' });
      showMsg('ok', 'Room assignment removed.');
      load();
    } catch (e) { showMsg('err', e.message); }
  }

  async function togglePortal(tdId, currentlyEnabled, hasEmail, hasPassword) {
    if (!currentlyEnabled && (!hasEmail || !hasPassword)) {
      showMsg('err', 'TD needs an email and password before portal access can be enabled.');
      return;
    }
    try {
      await api(`/api/admin/church/${churchId}/tds/${tdId}/portal-access`, {
        method: 'PUT',
        body: { enabled: !currentlyEnabled },
      });
      showMsg('ok', `Portal access ${!currentlyEnabled ? 'enabled' : 'disabled'}.`);
      load();
    } catch (e) { showMsg('err', e.message); }
  }

  async function setAccessLevel(tdId, accessLevel) {
    try {
      await api(`/api/admin/church/${churchId}/tds/${tdId}`, {
        method: 'PATCH',
        body: { accessLevel },
      });
      showMsg('ok', 'Access level updated.');
      load();
    } catch (e) { showMsg('err', e.message); }
  }

  async function submitPassword(e) {
    e.preventDefault();
    if (!pwModal || !pwModal.password || pwModal.password.length < 8) {
      showMsg('err', 'Password must be at least 8 characters.');
      return;
    }
    setSaving(true);
    try {
      await api(`/api/admin/church/${churchId}/tds/${pwModal.tdId}/set-password`, {
        method: 'POST',
        body: { password: pwModal.password },
      });
      setPwModal(null);
      showMsg('ok', 'Password set. Portal access enabled.');
      load();
    } catch (e) { showMsg('err', e.message); }
    finally { setSaving(false); }
  }

  async function submitEmail(e) {
    e.preventDefault();
    if (!emailEdit) return;
    const cleanEmail = emailEdit.value.trim().toLowerCase();
    setSaving(true);
    try {
      await api(`/api/admin/church/${churchId}/tds/${emailEdit.tdId}`, {
        method: 'PATCH',
        body: { email: cleanEmail },
      });
      setEmailEdit(null);
      showMsg('ok', 'Email updated.');
      load();
    } catch (e) { showMsg('err', e.message); }
    finally { setSaving(false); }
  }

  if (loading) return <div style={{ color: C.muted, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Loading...</div>;

  const canEdit = canWrite(role);

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
              <th style={s.th}>Name / Email</th>
              <th style={s.th}>Rooms</th>
              <th style={s.th}>Access</th>
              <th style={s.th}>Portal Login</th>
              {canEdit && <th style={s.th}>Actions</th>}
            </tr></thead>
            <tbody>
              {tds.map((td) => {
                const tdAssigns = td.roomAssignments || [];
                const isPortalLinked = td.telegram_chat_id && !String(td.telegram_chat_id).startsWith('portal_');
                const editingEmail = emailEdit && emailEdit.tdId === td.id;
                return (
                  <tr key={td.id}>
                    <td style={s.td}>
                      <div>{td.name || '—'}</div>
                      {editingEmail ? (
                        <form onSubmit={submitEmail} style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                          <input
                            style={{ ...s.input, fontSize: 11, padding: '4px 6px' }}
                            type="email"
                            value={emailEdit.value}
                            onChange={e => setEmailEdit({ ...emailEdit, value: e.target.value })}
                            placeholder="email@example.com"
                            autoFocus
                          />
                          <button type="submit" style={{ ...s.btn('primary'), padding: '4px 8px', fontSize: 10 }} disabled={saving}>Save</button>
                          <button type="button" style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 10 }} onClick={() => setEmailEdit(null)} disabled={saving}>Cancel</button>
                        </form>
                      ) : (
                        <div style={{ fontSize: 10, color: td.email ? C.dim : C.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {td.email || <em>no email</em>}
                          {canEdit && (
                            <button
                              type="button"
                              style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 10, padding: 0, textDecoration: 'underline' }}
                              onClick={() => setEmailEdit({ tdId: td.id, value: td.email || '' })}
                            >edit</button>
                          )}
                        </div>
                      )}
                      {isPortalLinked && <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>Telegram linked</div>}
                    </td>
                    <td style={s.td}>
                      {tdAssigns.length === 0 ? (
                        <span style={{ fontSize: 11, color: C.dim }}>All rooms</span>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {tdAssigns.map(a => (
                            <span key={a.assignment_id} style={{ ...s.badge(C.blue), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {a.room_name}
                              {canEdit && (
                                <span
                                  style={{ cursor: 'pointer', opacity: 0.6, fontSize: 10 }}
                                  onClick={() => removeAssignment(a.assignment_id)}
                                  title="Remove room assignment"
                                >{'×'}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={s.td}>
                      {canEdit ? (
                        <select
                          style={{ ...s.input, width: 'auto', padding: '4px 8px', fontSize: 11 }}
                          value={td.access_level || 'operator'}
                          onChange={e => setAccessLevel(td.id, e.target.value)}
                        >
                          {ACCESS_LEVELS.map(lvl => <option key={lvl} value={lvl}>{lvl}</option>)}
                        </select>
                      ) : (
                        <span style={s.badge(C.muted)}>{td.access_level || 'operator'}</span>
                      )}
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                        <span style={s.badge(td.has_password ? C.green : C.muted)}>
                          {td.has_password ? 'Password set' : 'No password'}
                        </span>
                        <span style={s.badge(td.portal_enabled ? C.green : C.muted)}>
                          {td.portal_enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    </td>
                    {canEdit && (
                      <td style={s.td}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          <button
                            style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 10 }}
                            onClick={() => setPwModal({ tdId: td.id, name: td.name, password: '' })}
                            disabled={!td.email}
                            title={!td.email ? 'TD needs an email first' : 'Set or reset password'}
                          >
                            {td.has_password ? 'Reset Password' : 'Set Password'}
                          </button>
                          <button
                            style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 10 }}
                            onClick={() => togglePortal(td.id, td.portal_enabled, !!td.email, !!td.has_password)}
                          >
                            {td.portal_enabled ? 'Disable Portal' : 'Enable Portal'}
                          </button>
                          <button
                            style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 10 }}
                            onClick={() => setOnCall(td.name)}
                          >On-Call</button>
                          <button
                            style={{ ...s.btn('danger'), padding: '4px 8px', fontSize: 10 }}
                            onClick={() => removeTd(td.id, td.name)}
                          >Remove</button>
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
      {canEdit && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Add TD</div>
          <div style={{ fontSize: 11, color: C.dim, marginBottom: 8 }}>
            Add an email to enable portal login (set password separately after creation).
          </div>
          <form onSubmit={addTd} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 8, alignItems: 'flex-end' }}>
            <div>
              <label style={{ ...s.label, fontSize: 10 }}>Name</label>
              <input
                style={s.input}
                value={addForm.name}
                onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                placeholder="TD name"
                disabled={saving}
              />
            </div>
            <div>
              <label style={{ ...s.label, fontSize: 10 }}>Email (optional)</label>
              <input
                style={s.input}
                type="email"
                value={addForm.email}
                onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
                placeholder="td@church.org"
                disabled={saving}
              />
            </div>
            <div>
              <label style={{ ...s.label, fontSize: 10 }}>Access</label>
              <select
                style={s.input}
                value={addForm.accessLevel}
                onChange={e => setAddForm(f => ({ ...f, accessLevel: e.target.value }))}
                disabled={saving}
              >
                {ACCESS_LEVELS.map(lvl => <option key={lvl} value={lvl}>{lvl}</option>)}
              </select>
            </div>
            <button type="submit" style={s.btn('primary')} disabled={saving || !addForm.name.trim()}>
              {saving ? 'Adding...' : 'Add'}
            </button>
          </form>
        </div>
      )}

      {/* Assign TD to Room */}
      {canEdit && rooms.length > 0 && tds.length > 0 && (
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
                  <option key={td.id} value={td.id}>{td.name}</option>
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

      {/* Set Password Modal */}
      {pwModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setPwModal(null); }}
        >
          <form
            onSubmit={submitPassword}
            style={{
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12,
              padding: 24, minWidth: 360, maxWidth: '90vw',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
              Set Password for {pwModal.name}
            </div>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 16 }}>
              Setting a password enables portal login. The TD will use their email + this password to sign in.
            </div>
            <label style={{ ...s.label, fontSize: 10 }}>New password (min 8 chars)</label>
            <input
              style={s.input}
              type="password"
              value={pwModal.password}
              onChange={e => setPwModal({ ...pwModal, password: e.target.value })}
              placeholder="Enter password"
              autoFocus
              minLength={8}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" style={s.btn('secondary')} onClick={() => setPwModal(null)} disabled={saving}>Cancel</button>
              <button type="submit" style={s.btn('primary')} disabled={saving || pwModal.password.length < 8}>
                {saving ? 'Saving...' : 'Set Password'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
