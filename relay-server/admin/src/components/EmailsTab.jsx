import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite } from './adminStyles';

// ── Send History sub-component ───────────────────────────────────────────────
function SendHistory({ api }) {
  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [offset, setOffset]   = useState(0);
  const [stats, setStats]     = useState(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch]   = useState('');
  const [types, setTypes]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [preview, setPreview] = useState(null);
  const LIMIT = 50;

  const load = useCallback(async (off = 0, append = false) => {
    try {
      setErr('');
      let url = `/api/admin/emails?limit=${LIMIT}&offset=${off}`;
      if (typeFilter) url += `&type=${encodeURIComponent(typeFilter)}`;
      if (search.trim()) url += `&search=${encodeURIComponent(search.trim())}`;
      const data = await api(url);
      if (append) {
        setRows(prev => [...prev, ...(data.rows || [])]);
      } else {
        setRows(data.rows || []);
      }
      setTotal(data.total || 0);
      setOffset(off);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api, typeFilter, search]);

  const loadStats = useCallback(async () => {
    try {
      const data = await api('/api/admin/emails/stats');
      setStats(data);
    } catch { /* ignore */ }
  }, [api]);

  const loadTypes = useCallback(async () => {
    try {
      const templates = await api('/api/admin/emails/templates');
      setTypes(templates.map(t => ({ type: t.type, name: t.name })));
    } catch { /* ignore */ }
  }, [api]);

  useEffect(() => {
    load(0);
    loadStats();
    loadTypes();
  }, [load, loadStats, loadTypes]);

  async function handlePreview(row) {
    const baseType = row.email_type
      .replace(/^manual:/, '')
      .replace(/-\d{4}-W\d+$/, '')
      .replace(/^upgrade-.*/, 'upgrade');
    try {
      const data = await api(`/api/admin/emails/templates/${encodeURIComponent(baseType)}/preview`);
      setPreview({ subject: row.subject || data.subject, html: data.html });
    } catch {
      setPreview({ subject: row.subject || '(no subject)', html: '<div style="padding:40px;text-align:center;color:#999">Preview not available for this email type</div>' });
    }
  }

  async function handleResend(row) {
    if (!confirm(`Resend "${row.email_type}" to ${row.recipient}?`)) return;
    try {
      const data = await api('/api/admin/emails/send', {
        method: 'POST',
        body: { churchId: row.church_id, emailType: row.email_type.replace(/^manual:/, ''), to: row.recipient },
      });
      if (data.sent) {
        alert('Email resent');
        load(0);
      } else {
        alert(data.reason || 'Send failed');
      }
    } catch { alert('Failed to resend'); }
  }

  const typeBadgeColor = (type) => {
    if (type.startsWith('manual:') || type === 'custom') return C.yellow;
    return C.green;
  };

  return (
    <div>
      {/* Stats row */}
      {stats && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          {[['Total', stats.total, C.white], ['Today', stats.today, C.green], ['This Week', stats.thisWeek, C.blue]].map(([lbl, val, color]) => (
            <div key={lbl} style={s.statCard}>
              <div style={s.statLbl}>{lbl}</div>
              <div style={{ ...s.statVal, color, fontSize: 22 }}>{(val || 0).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <select
          style={{ ...s.input, maxWidth: 200 }}
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); }}
        >
          <option value="">All Types</option>
          {types.map(t => <option key={t.type} value={t.type}>{t.name}</option>)}
        </select>
        <input
          style={{ ...s.input, maxWidth: 240 }}
          placeholder="Search recipient or subject..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') load(0); }}
        />
        <button style={s.btn('primary')} onClick={() => load(0)}>Search</button>
      </div>

      {loading && <div style={s.empty}>Loading...</div>}
      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}

      {!loading && !err && (
        rows.length === 0
          ? <div style={s.empty}>No emails sent yet</div>
          : <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Date', 'Church', 'Type', 'Recipient', 'Subject', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const date = new Date(r.sent_at);
                    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                    return (
                      <tr key={i}>
                        <td style={{ ...s.td, whiteSpace: 'nowrap', fontSize: 12, color: C.muted }}>{dateStr}</td>
                        <td style={s.td}>{r.church_name || r.church_id || '\u2014'}</td>
                        <td style={s.td}><span style={s.badge(typeBadgeColor(r.email_type))}>{r.email_type}</span></td>
                        <td style={{ ...s.td, fontSize: 12 }}>{r.recipient || '\u2014'}</td>
                        <td style={{ ...s.td, fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subject || '\u2014'}</td>
                        <td style={s.td}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }} onClick={() => handlePreview(r)}>Preview</button>
                            <button style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }} onClick={() => handleResend(r)}>Resend</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length < total && (
                <div style={{ textAlign: 'center', padding: 16 }}>
                  <button style={s.btn('secondary')} onClick={() => load(offset + LIMIT, true)}>Load More</button>
                </div>
              )}
            </div>
      )}

      {/* Preview Modal */}
      {preview && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setPreview(null); }}>
          <div style={{ ...s.wideModalBox, width: 700 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>{preview.subject}</div>
            <iframe
              srcDoc={preview.html || '<p>No preview</p>'}
              style={{ width: '100%', height: 400, border: `1px solid ${C.border}`, borderRadius: 8, background: '#fff' }}
              title="Email Preview"
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={s.btn('secondary')} onClick={() => setPreview(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Templates sub-component ──────────────────────────────────────────────────
function Templates({ api }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState('');
  const [preview, setPreview]     = useState(null);
  const [editing, setEditing]     = useState(null);
  const [editSubject, setEditSubject] = useState('');
  const [editHtml, setEditHtml]   = useState('');
  const [editMsg, setEditMsg]     = useState('');
  const [saving, setSaving]       = useState(false);

  const load = useCallback(async () => {
    try {
      setErr('');
      const data = await api('/api/admin/emails/templates');
      setTemplates(data);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  async function handlePreview(type) {
    try {
      const data = await api(`/api/admin/emails/templates/${encodeURIComponent(type)}/preview`);
      setPreview({ subject: data.subject, html: data.html });
    } catch { alert('Failed to load preview'); }
  }

  async function handleEdit(type) {
    try {
      const data = await api(`/api/admin/emails/templates/${encodeURIComponent(type)}/preview`);
      const tmpl = templates.find(t => t.type === type);
      setEditing({ type, name: tmpl ? tmpl.name : type, hasOverride: data.hasOverride });
      setEditSubject(data.subject || '');
      setEditHtml(data.html || '');
      setEditMsg('');
    } catch { alert('Failed to load template'); }
  }

  async function handleSave() {
    if (!editSubject.trim() && !editHtml.trim()) { setEditMsg('Subject or HTML required'); return; }
    setSaving(true);
    try {
      await api(`/api/admin/emails/templates/${encodeURIComponent(editing.type)}`, {
        method: 'PUT',
        body: { subject: editSubject.trim() || null, html: editHtml.trim() || null },
      });
      setEditing(null);
      load();
    } catch (e) { setEditMsg(e.message || 'Save failed'); }
    finally { setSaving(false); }
  }

  async function handleRevert() {
    if (!confirm('Remove the override and revert to the default template?')) return;
    try {
      await api(`/api/admin/emails/templates/${encodeURIComponent(editing.type)}`, { method: 'DELETE' });
      setEditing(null);
      load();
    } catch { alert('Failed to revert'); }
  }

  if (loading) return <div style={s.empty}>Loading...</div>;
  if (err) return <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {templates.map(t => (
          <div key={t.type} style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>{t.name}</strong>
              {t.hasOverride && <span style={{ ...s.badge(C.yellow), fontSize: 10 }}>Override</span>}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>{t.trigger}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={{ ...s.btn('secondary'), padding: '6px 12px', fontSize: 12 }} onClick={() => handlePreview(t.type)}>Preview</button>
              <button style={{ ...s.btn('secondary'), padding: '6px 12px', fontSize: 12 }} onClick={() => handleEdit(t.type)}>Edit</button>
            </div>
          </div>
        ))}
      </div>

      {/* Preview Modal */}
      {preview && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setPreview(null); }}>
          <div style={{ ...s.wideModalBox, width: 700 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>{preview.subject}</div>
            <iframe
              srcDoc={preview.html || '<p>No preview</p>'}
              style={{ width: '100%', height: 400, border: `1px solid ${C.border}`, borderRadius: 8, background: '#fff' }}
              title="Template Preview"
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={s.btn('secondary')} onClick={() => setPreview(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div style={{ ...s.wideModalBox, width: 700 }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>Edit: {editing.name}</div>
            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>Subject</label>
              <input style={s.input} value={editSubject} onChange={e => setEditSubject(e.target.value)} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>HTML</label>
              <textarea
                style={{ ...s.input, minHeight: 240, fontFamily: 'monospace', fontSize: 12 }}
                value={editHtml}
                onChange={e => setEditHtml(e.target.value)}
              />
            </div>
            {editMsg && <div style={s.err}>{editMsg}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              {editing.hasOverride && (
                <button style={s.btn('danger')} onClick={handleRevert}>Revert to Default</button>
              )}
              <button
                style={s.btn('secondary')}
                onClick={() => setPreview({ subject: editSubject, html: editHtml })}
              >
                Preview
              </button>
              <button style={s.btn('secondary')} onClick={() => setEditing(null)}>Cancel</button>
              <button style={s.btn('primary')} disabled={saving} onClick={handleSave}>{saving ? 'Saving...' : 'Save Override'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Send Custom sub-component ────────────────────────────────────────────────
function SendCustom({ api }) {
  const [churches, setChurches] = useState([]);
  const [churchId, setChurchId] = useState('');
  const [to, setTo]             = useState('');
  const [subject, setSubject]   = useState('');
  const [html, setHtml]         = useState(
    '<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 0;">\n' +
    '  <div style="margin-bottom: 24px;">\n    <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-right: 8px;"></span>\n    <strong style="font-size: 16px; color: #111;">Tally</strong>\n  </div>\n\n' +
    '  <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your heading here</h1>\n' +
    '  <p style="font-size: 15px; color: #333; line-height: 1.6;">Your message here.</p>\n\n' +
    '  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />\n' +
    '  <p style="font-size: 12px; color: #999;">Tally</p>\n' +
    '</div>'
  );
  const [preview, setPreview]   = useState(null);
  const [sending, setSending]   = useState(false);
  const [msg, setMsg]           = useState({ text: '', ok: false });

  useEffect(() => {
    (async () => {
      try {
        const data = await api('/api/churches');
        const rows = Array.isArray(data) ? data : Object.values(data);
        setChurches(rows);
      } catch { /* ignore */ }
    })();
  }, [api]);

  function handleChurchSelect(e) {
    const id = e.target.value;
    setChurchId(id);
    const church = churches.find(c => c.churchId === id);
    if (church && church.portal_email) setTo(church.portal_email);
  }

  async function handleSend() {
    if (!to.trim()) { setMsg({ text: 'Recipient email required', ok: false }); return; }
    if (!subject.trim()) { setMsg({ text: 'Subject required', ok: false }); return; }
    if (!html.trim()) { setMsg({ text: 'HTML body required', ok: false }); return; }
    if (!confirm(`Send to ${to.trim()}?`)) return;

    setSending(true);
    setMsg({ text: '', ok: false });
    try {
      const data = await api('/api/admin/emails/send', {
        method: 'POST',
        body: { to: to.trim(), subject: subject.trim(), html: html.trim(), churchId: churchId || null },
      });
      if (data.sent) {
        setMsg({ text: `Email sent to ${to.trim()}`, ok: true });
      } else {
        setMsg({ text: data.reason || 'Send failed', ok: false });
      }
    } catch (e) { setMsg({ text: e.message || 'Request failed', ok: false }); }
    finally { setSending(false); }
  }

  return (
    <div>
      <div style={s.card}>
        <div style={{ marginBottom: 14 }}>
          <label style={s.label}>Church (optional)</label>
          <select style={s.input} value={churchId} onChange={handleChurchSelect}>
            <option value="">{'\u2014'} Select a church {'\u2014'}</option>
            {churches.map(c => (
              <option key={c.churchId} value={c.churchId}>
                {c.name}{c.portal_email ? ` (${c.portal_email})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={s.label}>Recipient Email *</label>
          <input style={s.input} type="email" value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com" />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={s.label}>Subject *</label>
          <input style={s.input} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Email subject line" />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={s.label}>HTML Body *</label>
          <textarea
            style={{ ...s.input, minHeight: 200, fontFamily: 'monospace', fontSize: 12 }}
            value={html}
            onChange={e => setHtml(e.target.value)}
          />
        </div>
        {msg.text && <div style={msg.ok ? s.ok : s.err}>{msg.text}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button style={s.btn('secondary')} onClick={() => setPreview({ subject, html })}>Preview</button>
          <button style={s.btn('primary')} disabled={sending} onClick={handleSend}>{sending ? 'Sending...' : 'Send Email'}</button>
        </div>
      </div>

      {/* Preview Modal */}
      {preview && (
        <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) setPreview(null); }}>
          <div style={{ ...s.wideModalBox, width: 700 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>{preview.subject}</div>
            <iframe
              srcDoc={preview.html || '<p>No preview</p>'}
              style={{ width: '100%', height: 400, border: `1px solid ${C.border}`, borderRadius: 8, background: '#fff' }}
              title="Custom Email Preview"
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={s.btn('secondary')} onClick={() => setPreview(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main EmailsTab ───────────────────────────────────────────────────────────
export default function EmailsTab({ api, role }) {
  const [subTab, setSubTab] = useState('history');

  const tabs = [
    { id: 'history',   label: 'Send History' },
    { id: 'templates', label: 'Templates' },
    ...(canWrite(role) ? [{ id: 'custom', label: 'Send Custom' }] : []),
  ];

  return (
    <div>
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button key={t.id} style={s.tab(subTab === t.id)} onClick={() => setSubTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {subTab === 'history'   && <SendHistory api={api} />}
      {subTab === 'templates' && <Templates api={api} />}
      {subTab === 'custom'    && <SendCustom api={api} />}
    </div>
  );
}
