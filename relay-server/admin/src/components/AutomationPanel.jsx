import { useState, useEffect, useCallback } from 'react';
import { C, s, canWrite, TRIGGER_TYPES } from './adminStyles';

export default function AutomationPanel({ churchId, api, role }) {
  const [rules, setRules] = useState([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');
  const [form, setForm] = useState({
    name: '', triggerType: 'propresenter_slide_change',
    presentationPattern: '', minutesIntoService: '5',
    command: '', paramJson: '{}',
  });
  const [commandLog, setCommandLog] = useState(null);
  const [logLoading, setLogLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/churches/${churchId}/automation`);
      setRules(data.rules || []);
      setPaused(data.paused || false);
    } catch { setRules([]); }
    finally { setLoading(false); }
  }, [churchId, api]);

  useEffect(() => { load(); }, [load]);

  async function togglePause() {
    const endpoint = paused ? 'resume' : 'pause';
    try {
      await api(`/api/churches/${churchId}/automation/${endpoint}`, { method: 'POST' });
      setPaused(!paused);
    } catch {}
  }

  async function toggleRule(ruleId, currentEnabled) {
    try {
      await api(`/api/churches/${churchId}/automation/${ruleId}`, {
        method: 'PUT', body: { enabled: !currentEnabled },
      });
      setRules(prev => prev.map(r => r.id === ruleId ? { ...r, enabled: !currentEnabled } : r));
    } catch {}
  }

  async function deleteRule(ruleId, name) {
    if (!confirm(`Delete rule "${name}"?`)) return;
    try {
      await api(`/api/churches/${churchId}/automation/${ruleId}`, { method: 'DELETE' });
      setRules(prev => prev.filter(r => r.id !== ruleId));
    } catch {}
  }

  async function createRule(e) {
    e.preventDefault();
    setCreating(true); setCreateErr('');
    try {
      let triggerConfig = {};
      if (form.triggerType === 'propresenter_slide_change') {
        triggerConfig = { presentationPattern: form.presentationPattern || undefined };
      } else if (form.triggerType === 'schedule_timer') {
        triggerConfig = { minutesIntoService: parseInt(form.minutesIntoService) || 0 };
      } else if (form.triggerType === 'equipment_state_match') {
        triggerConfig = { conditions: JSON.parse(form.paramJson || '{}') };
      }

      let params = {};
      try { params = JSON.parse(form.paramJson || '{}'); } catch {}

      await api(`/api/churches/${churchId}/automation`, {
        method: 'POST',
        body: {
          name: form.name,
          triggerType: form.triggerType,
          triggerConfig,
          actions: [{ command: form.command, params }],
        },
      });
      setShowCreate(false);
      setForm({ name: '', triggerType: 'propresenter_slide_change', presentationPattern: '', minutesIntoService: '5', command: '', paramJson: '{}' });
      load();
    } catch (err) { setCreateErr(err.message); }
    finally { setCreating(false); }
  }

  async function loadCommandLog() {
    setLogLoading(true);
    try {
      const data = await api(`/api/churches/${churchId}/command-log?limit=30`);
      setCommandLog(Array.isArray(data) ? data : []);
    } catch { setCommandLog([]); }
    finally { setLogLoading(false); }
  }

  if (loading) return <div style={{ color: C.muted, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Loading automation...</div>;

  return (
    <div>
      {/* Header with pause/resume */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Autopilot Rules ({rules.length})</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canWrite(role) && (
            <button
              style={s.btn(paused ? 'primary' : 'danger')}
              onClick={togglePause}
            >
              {paused ? '\u25B6 Resume' : '\u23F8 Pause'} Autopilot
            </button>
          )}
          {canWrite(role) && (
            <button style={s.btn('primary')} onClick={() => setShowCreate(true)}>+ New Rule</button>
          )}
        </div>
      </div>

      {paused && (
        <div style={{ background: 'rgba(245,158,11,0.1)', border: `1px solid rgba(245,158,11,0.3)`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: C.yellow }}>
          Autopilot is paused. No automation rules will fire until resumed.
        </div>
      )}

      {/* Rules list */}
      {rules.length === 0 ? (
        <div style={s.section}>
          <div style={{ color: C.muted, fontSize: 12, textAlign: 'center', padding: '16px 0' }}>
            No automation rules yet. Create one to get started.
          </div>
        </div>
      ) : (
        rules.map(rule => (
          <div key={rule.id} style={{ ...s.section, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>{rule.enabled ? '\u{1F7E2}' : '\u{26AA}'}</span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{rule.name}</span>
                <span style={s.badge(C.blue)}>{rule.trigger_type?.replace(/_/g, ' ')}</span>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                {rule.trigger_type === 'propresenter_slide_change' && rule.trigger_config?.presentationPattern
                  ? `When presentation matches: "${rule.trigger_config.presentationPattern}"`
                  : rule.trigger_type === 'schedule_timer'
                  ? `At ${rule.trigger_config?.minutesIntoService || 0} minutes into service`
                  : rule.trigger_type === 'equipment_state_match'
                  ? `When equipment state matches conditions`
                  : 'On any matching event'}
                {' \u2192 '}
                {(rule.actions || []).map(a => a.command).join(', ') || 'No actions'}
              </div>
              <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>
                Fired {rule.fire_count || 0} times
                {rule.last_fired_at ? ` \u2022 Last: ${new Date(rule.last_fired_at).toLocaleString()}` : ''}
              </div>
            </div>
            {canWrite(role) && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  style={{ ...s.btn(rule.enabled ? 'secondary' : 'primary'), padding: '4px 10px', fontSize: 11 }}
                  onClick={() => toggleRule(rule.id, rule.enabled)}
                >
                  {rule.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  style={{ ...s.btn('danger'), padding: '4px 10px', fontSize: 11 }}
                  onClick={() => deleteRule(rule.id, rule.name)}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))
      )}

      {/* Create rule form */}
      {showCreate && canWrite(role) && (
        <div style={{ ...s.section, marginTop: 16 }}>
          <div style={s.sectionTitle}>Create Automation Rule</div>
          <form onSubmit={createRule}>
            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>Rule Name *</label>
              <input style={s.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Switch to Cam 1 during worship" required />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>Trigger Type *</label>
              <select style={s.input} value={form.triggerType} onChange={e => setForm(f => ({ ...f, triggerType: e.target.value }))}>
                {TRIGGER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            {form.triggerType === 'propresenter_slide_change' && (
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Presentation Name Pattern (optional)</label>
                <input style={s.input} value={form.presentationPattern} onChange={e => setForm(f => ({ ...f, presentationPattern: e.target.value }))} placeholder="worship (matches any presentation containing this)" />
                <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>Leave blank to match any slide change.</div>
              </div>
            )}
            {form.triggerType === 'schedule_timer' && (
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Minutes Into Service *</label>
                <input style={s.input} type="number" min="0" value={form.minutesIntoService} onChange={e => setForm(f => ({ ...f, minutesIntoService: e.target.value }))} />
              </div>
            )}
            {form.triggerType === 'equipment_state_match' && (
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Conditions (JSON)</label>
                <input style={s.input} value={form.paramJson} onChange={e => setForm(f => ({ ...f, paramJson: e.target.value }))} placeholder='{"obs.streaming": true}' />
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>Action Command *</label>
              <input style={s.input} value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))} placeholder="e.g. atem.setProgram, obs.startStream" required />
              <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>Any Tally command: atem.cut, atem.setProgram, obs.startStream, propresenter.next, etc.</div>
            </div>

            {form.triggerType !== 'equipment_state_match' && (
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Action Parameters (JSON, optional)</label>
                <input style={s.input} value={form.paramJson} onChange={e => setForm(f => ({ ...f, paramJson: e.target.value }))} placeholder='{"input": 1}' />
              </div>
            )}

            {createErr && <div style={s.err}>{createErr}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" style={s.btn('secondary')} onClick={() => setShowCreate(false)}>Cancel</button>
              <button type="submit" style={s.btn('primary')} disabled={creating}>{creating ? 'Creating...' : 'Create Rule'}</button>
            </div>
          </form>
        </div>
      )}

      {/* Command log */}
      <div style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Command Log</div>
          <button style={s.btn('secondary')} onClick={loadCommandLog} disabled={logLoading}>
            {logLoading ? 'Loading...' : commandLog ? 'Refresh' : 'Load Log'}
          </button>
        </div>

        {commandLog && (
          commandLog.length === 0 ? (
            <div style={{ ...s.section, color: C.muted, fontSize: 12, textAlign: 'center', padding: '12px 0' }}>
              No commands logged yet.
            </div>
          ) : (
            <div style={{ ...s.section, maxHeight: 250, overflowY: 'auto' }}>
              {commandLog.map((log, i) => (
                <div key={log.id || i} style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: 11, borderBottom: i < commandLog.length - 1 ? `1px solid ${C.border}` : 'none', paddingBottom: 6 }}>
                  <span style={{ color: C.dim, minWidth: 55, flexShrink: 0 }}>
                    {new Date(log.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <span style={s.badge(log.source === 'autopilot' ? C.blue : log.source === 'telegram' ? C.yellow : C.muted)}>
                    {log.source}
                  </span>
                  <span style={{ color: C.white, fontWeight: 600 }}>{log.command}</span>
                  {log.result && <span style={{ color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(log.result).substring(0, 50)}</span>}
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
