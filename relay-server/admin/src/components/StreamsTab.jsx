import { useState, useEffect, useCallback, useRef } from 'react';
import { C, s } from './adminStyles';

export default function StreamsTab({ api }) {
  const [churches, setChurches]   = useState([]);
  const [churchId, setChurchId]   = useState('');
  const [rooms, setRooms]         = useState([]);
  const [selectedRoom, setSelectedRoom] = useState('');
  const [streamKey, setStreamKey] = useState(null);
  const [activeStreams, setActiveStreams] = useState([]);
  const [equipment, setEquipment] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState('');
  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  // Load churches and active streams on mount
  const loadChurches = useCallback(async () => {
    try {
      setErr('');
      const data = await api('/api/churches');
      const rows = Array.isArray(data) ? data : Object.values(data);
      setChurches(rows);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);

  const loadActiveStreams = useCallback(async () => {
    try {
      const data = await api('/api/admin/streams');
      setActiveStreams(data.streams || []);
    } catch { /* ignore */ }
  }, [api]);

  useEffect(() => {
    loadChurches();
    loadActiveStreams();
  }, [loadChurches, loadActiveStreams]);

  // Auto-select first active stream if none selected
  useEffect(() => {
    if (!churchId && activeStreams.length > 0) {
      handleChurchSelect(activeStreams[0].churchId);
    }
  }, [activeStreams]);

  function destroyPlayer() {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  }

  function startPlayer(cId, hlsUrl) {
    const video = videoRef.current;
    if (!video) return;

    const src = hlsUrl || streamKey?.hlsUrl || `/api/admin/stream/${cId}/live.m3u8`;

    import('hls.js').then(({ default: Hls }) => {
      if (Hls.isSupported()) {
        const hls = new Hls({
          liveDurationInfinity: true,
          liveBackBufferLength: 0,
          maxBufferLength: 6,
          maxMaxBufferLength: 12,
        });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            console.error('[HLS] Fatal error', data);
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              setTimeout(() => {
                if (hlsRef.current === hls) hls.loadSource(src);
              }, 3000);
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
      }
    }).catch(() => {
      // hls.js not available, try native
      video.src = src;
      video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
    });
  }

  async function handleChurchSelect(id) {
    destroyPlayer();
    setSelectedRoom('');
    setRooms([]);
    setStreamKey(null);
    setEquipment(null);

    if (!id) {
      setChurchId('');
      return;
    }

    setChurchId(id);

    // Load rooms
    try {
      const data = await api(`/api/admin/church/${encodeURIComponent(id)}/rooms`);
      setRooms(data.rooms || []);
    } catch { /* rooms endpoint may not exist */ }

    // Load stream key + status
    await refreshStreamState(id);
    // Load equipment status
    await loadEquipment(id);
  }

  async function refreshStreamState(id) {
    try {
      const data = await api(`/api/admin/stream/${id}/key`);
      setStreamKey(data);
      if (data.active) {
        startPlayer(id, data.hlsUrl);
      }
    } catch (e) {
      console.error('Failed to fetch stream key', e);
    }
  }

  async function loadEquipment(id) {
    try {
      const data = await api(`/api/admin/church/${encodeURIComponent(id)}/support-view`);
      setEquipment(data);
    } catch { /* ignore */ }
  }

  async function handleRegenerate() {
    if (!churchId) return;
    if (!confirm('Regenerate stream key? This will disconnect any active stream.')) return;
    try {
      const data = await api(`/api/admin/stream/${churchId}/key/regenerate`, { method: 'POST' });
      setStreamKey(prev => ({ ...prev, ...data }));
      destroyPlayer();
    } catch {
      alert('Failed to regenerate key');
    }
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  // Equipment rendering helpers
  function renderEquipment() {
    if (!equipment) return null;
    let st = equipment.status || {};
    let devices = st.connectedDevices || {};
    let online = st.online;
    let streamActive = st.streamActive;

    // Room filtering
    if (selectedRoom && equipment.roomInstanceMap && equipment.roomInstanceMap[selectedRoom]) {
      const instName = equipment.roomInstanceMap[selectedRoom];
      const instData = (equipment.instanceStatusMap || {})[instName];
      if (instData) {
        devices = instData.connectedDevices || {};
        online = instData.online;
        streamActive = instData.streamActive;
      } else {
        devices = {};
        online = false;
        streamActive = false;
      }
    }

    const dot = (ok) => (
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: ok ? C.green : '#555', marginRight: 8,
      }} />
    );

    const items = [];
    items.push({ label: `App ${online ? '(Connected)' : '(Offline)'}`, ok: online });
    if (devices.atem !== undefined) items.push({ label: 'ATEM', ok: devices.atem });
    if (devices.obs !== undefined) items.push({ label: 'OBS', ok: devices.obs });
    if (devices.vmix !== undefined) items.push({ label: 'vMix', ok: devices.vmix });
    if (devices.companion !== undefined) items.push({ label: 'Companion', ok: devices.companion });
    if (devices.propresenter !== undefined) items.push({ label: 'ProPresenter', ok: devices.propresenter });
    if (devices.resolume !== undefined) items.push({ label: 'Resolume', ok: devices.resolume });
    if (devices.mixer !== undefined) items.push({ label: 'Mixer', ok: devices.mixer });

    return (
      <div style={s.section}>
        <div style={s.sectionTitle}>Equipment Status</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', fontSize: 13 }}>
              {dot(item.ok)}{item.label}
            </div>
          ))}
        </div>
        {streamActive && (
          <div style={{ marginTop: 12 }}>
            <span style={s.badge(C.red)}>{'\uD83D\uDD34'} Stream Active</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Active streams count */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, color: C.muted }}>
          {activeStreams.length > 0
            ? `${activeStreams.length} active stream${activeStreams.length > 1 ? 's' : ''}`
            : 'No active streams'}
        </div>
        <button style={s.btn('secondary')} onClick={() => { loadChurches(); loadActiveStreams(); }}>{'\u21BB'} Refresh</button>
      </div>

      {/* Church selector */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <select
          style={{ ...s.input, maxWidth: 320 }}
          value={churchId}
          onChange={e => handleChurchSelect(e.target.value)}
        >
          <option value="">{'\u2014'} Select a church {'\u2014'}</option>
          {churches.map(c => (
            <option key={c.churchId} value={c.churchId}>
              {c.name}{c.connected ? ' (online)' : ''}
            </option>
          ))}
        </select>

        {/* Room selector */}
        {rooms.length > 0 && (
          <select
            style={{ ...s.input, maxWidth: 200 }}
            value={selectedRoom}
            onChange={e => setSelectedRoom(e.target.value)}
          >
            <option value="">All Rooms</option>
            {rooms.map(rm => (
              <option key={rm.id} value={rm.id}>{rm.name}</option>
            ))}
          </select>
        )}
      </div>

      {loading && <div style={s.empty}>Loading...</div>}
      {err && <div style={{ color: C.red, padding: '12px 0', fontSize: 13 }}>{err}</div>}

      {!churchId && !loading && (
        <div style={{
          ...s.empty,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: 300, background: C.surface, borderRadius: 12, border: `1px solid ${C.border}`,
        }}>
          Select a church to preview its stream
        </div>
      )}

      {churchId && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20 }}>
          {/* Video player area */}
          <div>
            {streamKey?.active ? (
              <div style={{ position: 'relative' }}>
                <div style={{ marginBottom: 8 }}>
                  <span style={s.badge(C.red)}>{'\uD83D\uDD34'} LIVE</span>
                </div>
                <video
                  ref={videoRef}
                  style={{
                    width: '100%', borderRadius: 8, background: '#000',
                    border: `1px solid ${C.border}`,
                  }}
                  controls
                  muted
                  playsInline
                />
              </div>
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 300, background: C.surface, borderRadius: 12,
                border: `1px solid ${C.border}`, color: C.muted, fontSize: 13,
              }}>
                <div>
                  <span style={{ ...s.badge(C.muted), marginBottom: 8, display: 'inline-block' }}>Offline</span>
                  <div>Stream offline {'\u2014'} waiting for RTMP input</div>
                </div>
              </div>
            )}

            {/* Stream key info */}
            {streamKey && (
              <div style={{ ...s.card, marginTop: 16 }}>
                <div style={s.sectionTitle}>Stream Key</div>
                <div style={{ marginBottom: 12 }}>
                  <label style={s.label}>RTMP URL</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <code style={{ fontSize: 12, color: C.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {streamKey.rtmpUrl ? streamKey.rtmpUrl.replace(streamKey.streamKey, '{STREAM_KEY}') : '\u2014'}
                    </code>
                    {streamKey.rtmpUrl && (
                      <button style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }} onClick={() => copyToClipboard(streamKey.rtmpUrl)}>Copy</button>
                    )}
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={s.label}>Stream Key</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <code style={{ fontSize: 12, color: C.white, flex: 1 }}>
                      {streamKey.streamKey || '\u2014'}
                    </code>
                    {streamKey.streamKey && (
                      <button style={{ ...s.btn('secondary'), padding: '4px 8px', fontSize: 11 }} onClick={() => copyToClipboard(streamKey.streamKey)}>Copy</button>
                    )}
                  </div>
                </div>
                <button
                  style={{ ...s.btn('danger'), padding: '6px 12px', fontSize: 12 }}
                  onClick={handleRegenerate}
                >
                  Regenerate Key
                </button>
              </div>
            )}
          </div>

          {/* Right sidebar - equipment */}
          <div>
            {renderEquipment()}
          </div>
        </div>
      )}
    </div>
  );
}
