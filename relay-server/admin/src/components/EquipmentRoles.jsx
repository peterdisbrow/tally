import { useState, useEffect, useCallback } from 'react';
import { C, s } from './adminStyles';

const DEVICE_DISPLAY_NAMES = {
  atem: 'ATEM', encoder: 'Encoder', obs: 'OBS', vmix: 'vMix',
  hyperdeck: 'HyperDeck', proPresenter: 'ProPresenter', mixer: 'Audio Mixer',
  companion: 'Companion', ptz: 'PTZ', videohub: 'VideoHub',
  resolume: 'Resolume', ecamm: 'Ecamm', dante: 'Dante', ndi: 'NDI',
};

const ROLE_ICONS = {
  primary_switcher: '🎛',
  recording_device: '⏺',
  streaming_device: '📡',
  presentation: '📊',
  audio_mixer: '🔊',
  backup_encoder: '💾',
};

// Describe how commands route for each role
const ROLE_ROUTING = {
  primary_switcher: 'Switching commands (cut, auto, set preview)',
  recording_device: 'Record start/stop',
  streaming_device: 'Stream start/stop, go live',
  presentation: 'Slide next/prev/goto',
  audio_mixer: 'Audio levels, mute/unmute',
  backup_encoder: 'Backup recording/stream failover',
};

export default function EquipmentRoles({ api, roomId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [roles, setRoles] = useState({});
  const [autoDetected, setAutoDetected] = useState(false);
  const [defaults, setDefaults] = useState({});
  const [roleDefs, setRoleDefs] = useState({});
  const [equipment, setEquipment] = useState({});

  const load = useCallback(async () => {
    try {
      setErr('');
      const data = await api(`/api/admin/rooms/${roomId}/roles`);
      setRoles(data.roles || {});
      setAutoDetected(data.autoDetected);
      setDefaults(data.defaults || {});
      setRoleDefs(data.roleDefinitions || {});
      setEquipment(data.equipment || {});
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api, roomId]);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    setSaving(true); setErr(''); setOk('');
    try {
      await api(`/api/admin/rooms/${roomId}/roles`, {
        method: 'PUT',
        body: { roles },
      });
      setOk('Roles saved');
      setAutoDetected(false);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  function handleReset() {
    setRoles({ ...defaults });
    setOk('');
  }

  // Build list of detected devices from equipment config
  const detectedDevices = [];
  if (equipment && typeof equipment === 'object') {
    for (const [key, val] of Object.entries(equipment)) {
      if (key === '_roles') continue;
      if (!val) continue;
      if (Array.isArray(val)) {
        val.forEach((item, i) => {
          if (item.ip || item.host || item.encoderType) {
            detectedDevices.push({
              key, name: DEVICE_DISPLAY_NAMES[key] || key,
              ip: item.ip || item.host || '',
              detail: item.encoderType || item.type || '',
              index: i,
            });
          }
        });
      } else if (typeof val === 'object' && (val.configured || val.ip || val.host || val.type)) {
        detectedDevices.push({
          key, name: DEVICE_DISPLAY_NAMES[key] || key,
          ip: val.ip || val.host || '',
          detail: val.type || '',
        });
      }
    }
  }

  if (loading) return <div style={s.empty}>Loading roles…</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Equipment Roles</div>
        {onClose && (
          <button style={{ ...s.btn('secondary'), fontSize: 11, padding: '5px 12px' }} onClick={onClose}>Close</button>
        )}
      </div>

      {autoDetected && (
        <div style={{ ...s.section, background: 'rgba(59,130,246,0.06)', borderColor: 'rgba(59,130,246,0.2)', marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: C.blue }}>
            Auto-detected from connected devices. Save to lock in your choices.
          </div>
        </div>
      )}

      {/* Detected devices grid */}
      {detectedDevices.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={s.label}>Detected Devices</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
            {detectedDevices.map((d, i) => (
              <div key={i} style={{
                background: 'rgba(255,255,255,0.03)', border: `1px solid ${C.border}`,
                borderRadius: 8, padding: '8px 12px', fontSize: 12,
              }}>
                <div style={{ fontWeight: 600, color: C.white }}>{d.name}{d.index != null ? ` #${d.index + 1}` : ''}</div>
                {d.ip && <div style={{ color: C.muted, fontSize: 11 }}>{d.ip}</div>}
                {d.detail && <div style={{ color: C.dim, fontSize: 11 }}>{d.detail}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Role assignments */}
      <div style={{ marginBottom: 20 }}>
        <div style={s.label}>Role Assignments</div>
        <div style={{ display: 'grid', gap: 12 }}>
          {Object.entries(roleDefs).map(([roleKey, def]) => (
            <div key={roleKey} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: 'rgba(255,255,255,0.02)', border: `1px solid ${C.border}`,
              borderRadius: 8, padding: '10px 14px',
            }}>
              <span style={{ fontSize: 18, width: 28, textAlign: 'center' }}>{ROLE_ICONS[roleKey] || '⚙'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.white }}>{def.label}</div>
                <div style={{ fontSize: 11, color: C.dim }}>{ROLE_ROUTING[roleKey] || ''}</div>
              </div>
              <select
                style={{ ...s.input, width: 160, flex: 'none' }}
                value={roles[roleKey] || ''}
                onChange={e => setRoles(prev => {
                  const next = { ...prev };
                  if (e.target.value) next[roleKey] = e.target.value;
                  else delete next[roleKey];
                  return next;
                })}
              >
                <option value="">— None —</option>
                {def.compatible.map(devType => (
                  <option key={devType} value={devType}>
                    {DEVICE_DISPLAY_NAMES[devType] || devType}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Command routing summary */}
      <div style={{ marginBottom: 20 }}>
        <div style={s.label}>How Commands Will Route</div>
        <div style={{ ...s.section, padding: 14 }}>
          {Object.entries(roleDefs).map(([roleKey, def]) => {
            const assigned = roles[roleKey];
            const deviceName = assigned ? (DEVICE_DISPLAY_NAMES[assigned] || assigned) : null;
            return (
              <div key={roleKey} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                <span style={{ color: C.muted }}>{ROLE_ROUTING[roleKey] || def.label}</span>
                <span style={{ color: assigned ? C.green : C.dim, fontWeight: 600 }}>
                  {assigned ? `→ ${deviceName}` : 'Fallback (auto)'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {err && <div style={s.err}>{err}</div>}
      {ok && <div style={s.ok}>{ok}</div>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button style={{ ...s.btn('secondary'), fontSize: 12 }} onClick={handleReset}>
          Reset to Defaults
        </button>
        <button style={{ ...s.btn('primary'), fontSize: 12 }} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Roles'}
        </button>
      </div>
    </div>
  );
}
