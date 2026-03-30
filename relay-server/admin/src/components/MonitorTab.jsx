import { useState, useEffect, useRef, useCallback } from 'react';
import { C, s } from './adminStyles';

export default function MonitorTab({ token, api }) {
  const [churches, setChurches] = useState([]);
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  const [showOnlyOnline, setShowOnlyOnline] = useState(false);
  const [activeStreams, setActiveStreams] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [streamKey, setStreamKey] = useState(null);
  const [equipment, setEquipment] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(null);
  const esRef = useRef(null);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const statsIntervalRef = useRef(null);

  // SSE connection for live status
  useEffect(() => {
    if (!token) return;

    const url = `/api/dashboard/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setErr('');
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'initial' || data.type === 'snapshot') {
          setChurches(data.churches || []);
        } else if (data.type === 'status') {
          setChurches(prev => prev.map(c =>
            c.churchId === data.churchId ? { ...c, ...data } : c
          ));
        } else if (data.type === 'connect') {
          setChurches(prev => {
            const exists = prev.find(c => c.churchId === data.churchId);
            if (exists) {
              return prev.map(c => c.churchId === data.churchId ? { ...c, connected: true, ...data } : c);
            }
            return [...prev, { ...data, connected: true }];
          });
        } else if (data.type === 'disconnect') {
          setChurches(prev => prev.map(c =>
            c.churchId === data.churchId ? { ...c, connected: false } : c
          ));
        } else if (data.type === 'alert') {
          setChurches(prev => prev.map(c =>
            c.churchId === data.churchId
              ? { ...c, activeAlerts: (c.activeAlerts || 0) + 1 }
              : c
          ));
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      setConnected(false);
      setErr('SSE connection lost. Reconnecting...');
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [token]);

  // Load active streams
  const loadActiveStreams = useCallback(async () => {
    if (!api) return;
    try {
      const data = await api('/api/admin/streams');
      setActiveStreams(data.streams || []);
    } catch { /* ignore */ }
  }, [api]);

  useEffect(() => {
    loadActiveStreams();
  }, [loadActiveStreams]);

  // Get the currently displayed stream info (selected room or church-level fallback)
  const activeRoomStream = streamKey?.rooms?.find(r => r.roomId === selectedRoom) || null;
  const displayStream = activeRoomStream || streamKey;

  // Poll stream stats while expanded
  useEffect(() => {
    if (!expandedId || !api) {
      clearInterval(statsIntervalRef.current);
      return;
    }
    const poll = async () => {
      try {
        const data = await api(`/api/admin/stream/${expandedId}/key`);
        setStreamKey(prev => ({ ...prev, meta: data.meta, active: data.active, startedAt: data.startedAt, rooms: data.rooms }));
      } catch { /* ignore */ }
    };
    statsIntervalRef.current = setInterval(poll, 5000);
    return () => clearInterval(statsIntervalRef.current);
  }, [expandedId, api]);

  // HLS player helpers
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
          if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setTimeout(() => {
              if (hlsRef.current === hls) hls.loadSource(src);
            }, 3000);
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
      }
    }).catch(() => {
      video.src = src;
      video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
    });
  }

  // Expand a church row to show detail panel
  async function handleRowClick(churchId) {
    if (expandedId === churchId) {
      destroyPlayer();
      setExpandedId(null);
      setStreamKey(null);
      setEquipment(null);
      setRooms([]);
      setSelectedRoom('');
      return;
    }

    destroyPlayer();
    setExpandedId(churchId);
    setStreamKey(null);
    setEquipment(null);
    setRooms([]);
    setSelectedRoom('');

    if (!api) return;

    // Load rooms
    try {
      const data = await api(`/api/admin/church/${encodeURIComponent(churchId)}/rooms`);
      setRooms(data.rooms || []);
    } catch { /* rooms endpoint may not exist */ }

    // Load stream key + status (includes per-room keys)
    try {
      const data = await api(`/api/admin/stream/${churchId}/key`);
      setStreamKey(data);
      // Auto-select first room if rooms exist
      if (data.rooms?.length > 0) {
        setSelectedRoom(data.rooms[0].roomId);
        const firstRoom = data.rooms[0];
        if (firstRoom.active) {
          setTimeout(() => startPlayer(firstRoom.roomId, firstRoom.hlsUrl), 50);
        }
      } else if (data.active) {
        setTimeout(() => startPlayer(churchId, data.hlsUrl), 50);
      }
    } catch { /* ignore */ }

    // Load equipment
    try {
      const data = await api(`/api/admin/church/${encodeURIComponent(churchId)}/support-view`);
      setEquipment(data);
    } catch { /* ignore */ }
  }

  async function handleRegenerate() {
    if (!expandedId || !api) return;
    // If a room is selected, regenerate that room's key
    if (selectedRoom) {
      if (!confirm('Regenerate this room\'s stream key? This will disconnect any active stream for this room.')) return;
      try {
        const data = await api(`/api/admin/stream/${expandedId}/room/${selectedRoom}/key/regenerate`, { method: 'POST' });
        setStreamKey(prev => ({
          ...prev,
          rooms: (prev.rooms || []).map(r => r.roomId === selectedRoom ? { ...r, streamKey: data.streamKey, rtmpUrl: data.rtmpUrl, active: false, meta: null } : r),
        }));
        destroyPlayer();
      } catch {
        alert('Failed to regenerate room key');
      }
    } else {
      if (!confirm('Regenerate church stream key? This will disconnect any active stream.')) return;
      try {
        const data = await api(`/api/admin/stream/${expandedId}/key/regenerate`, { method: 'POST' });
        setStreamKey(prev => ({ ...prev, ...data }));
        destroyPlayer();
      } catch {
        alert('Failed to regenerate key');
      }
    }
  }

  function handleRoomSelect(roomId) {
    destroyPlayer();
    setSelectedRoom(roomId);
    if (roomId && streamKey?.rooms) {
      const room = streamKey.rooms.find(r => r.roomId === roomId);
      if (room?.active) {
        setTimeout(() => startPlayer(room.roomId, room.hlsUrl), 50);
      }
    } else if (!roomId && streamKey?.active) {
      setTimeout(() => startPlayer(expandedId, streamKey.hlsUrl), 50);
    }
  }

  function copyToClipboard(e, text) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(text);
      setTimeout(() => setCopyFeedback(null), 1500);
    }).catch(() => {
      // Fallback for older browsers / insecure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopyFeedback(text);
      setTimeout(() => setCopyFeedback(null), 1500);
    });
  }

  function handleRefresh() {
    loadActiveStreams();
    // Force SSE reconnect
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setConnected(false);
    // Re-trigger the SSE effect by toggling — the useEffect will re-run on token
    // Instead, just reconnect manually:
    if (!token) return;
    const url = `/api/dashboard/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;
    es.onopen = () => { setConnected(true); setErr(''); };
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'initial' || data.type === 'snapshot') {
          setChurches(data.churches || []);
        } else if (data.type === 'status') {
          setChurches(prev => prev.map(c => c.churchId === data.churchId ? { ...c, ...data } : c));
        } else if (data.type === 'connect') {
          setChurches(prev => {
            const exists = prev.find(c => c.churchId === data.churchId);
            if (exists) return prev.map(c => c.churchId === data.churchId ? { ...c, connected: true, ...data } : c);
            return [...prev, { ...data, connected: true }];
          });
        } else if (data.type === 'disconnect') {
          setChurches(prev => prev.map(c => c.churchId === data.churchId ? { ...c, connected: false } : c));
        } else if (data.type === 'alert') {
          setChurches(prev => prev.map(c => c.churchId === data.churchId ? { ...c, activeAlerts: (c.activeAlerts || 0) + 1 } : c));
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { setConnected(false); setErr('SSE connection lost. Reconnecting...'); };
  }

  // Derive stream status per church
  const streamSet = new Set(activeStreams.map(s => s.churchId));

  const filtered = churches.filter(c => {
    if (showOnlyOnline && !c.connected) return false;
    if (filter) {
      const q = filter.toLowerCase();
      return (c.name || '').toLowerCase().includes(q) || (c.churchId || '').toLowerCase().includes(q);
    }
    return true;
  });

  const online = churches.filter(c => c.connected).length;
  const withAlerts = churches.filter(c => c.connected && (c.activeAlerts || 0) > 0).length;
  const streaming = activeStreams.length;

  // Equipment rendering
  function renderEquipment() {
    if (!equipment) return null;
    let st = equipment.status || {};
    let devices = st.connectedDevices || {};
    let eqOnline = st.online;
    let streamActive = st.streamActive;

    if (selectedRoom && equipment.roomInstanceMap && equipment.roomInstanceMap[selectedRoom]) {
      const instName = equipment.roomInstanceMap[selectedRoom];
      const instData = (equipment.instanceStatusMap || {})[instName];
      if (instData) {
        devices = instData.connectedDevices || {};
        eqOnline = instData.online;
        streamActive = instData.streamActive;
      } else {
        devices = {};
        eqOnline = false;
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
    items.push({ label: `App ${eqOnline ? '(Connected)' : '(Offline)'}`, ok: eqOnline });
    if (devices.atem !== undefined) items.push({ label: 'ATEM', ok: devices.atem });
    if (devices.obs !== undefined) items.push({ label: 'OBS', ok: devices.obs });
    if (devices.vmix !== undefined) items.push({ label: 'vMix', ok: devices.vmix });
    if (devices.companion !== undefined) items.push({ label: 'Companion', ok: devices.companion });
    if (devices.propresenter !== undefined) items.push({ label: 'ProPresenter', ok: devices.propresenter });
    if (devices.resolume !== undefined) items.push({ label: 'Resolume', ok: devices.resolume });
    if (devices.mixer !== undefined) items.push({ label: 'Mixer', ok: devices.mixer });

    return (
      <div>
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
      {/* Connection status + active streams + refresh */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: connected ? C.green : C.red,
              boxShadow: connected ? `0 0 6px ${C.green}` : 'none',
            }} />
            <span style={{ fontSize: 13, color: connected ? C.green : C.red }}>
              {connected ? 'Live' : 'Disconnected'}
            </span>
          </div>
          {err && <span style={{ fontSize: 12, color: C.muted }}>{err}</span>}
          {streaming > 0 && (
            <span style={{ fontSize: 13, color: C.muted }}>
              {streaming} active stream{streaming > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button style={s.btn('secondary')} onClick={handleRefresh}>{'\u21BB'} Refresh</button>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        {[
          ['Total', churches.length, C.white],
          ['Online', online, C.green],
          ['Alerts', withAlerts, C.red],
          ['Offline', churches.length - online, C.muted],
          ['Streaming', streaming, C.blue],
        ].map(([lbl, val, color]) => (
          <div key={lbl} style={s.statCard}>
            <div style={s.statLbl}>{lbl}</div>
            <div style={{ ...s.statVal, color, fontSize: 22 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ ...s.input, maxWidth: 280 }}
          placeholder="Search churches..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showOnlyOnline}
            onChange={e => setShowOnlyOnline(e.target.checked)}
          />
          Online only
        </label>
      </div>

      {/* Church table */}
      {filtered.length === 0 ? (
        <div style={s.empty}>
          {churches.length === 0 ? 'Waiting for data...' : 'No matching churches'}
        </div>
      ) : (
        <div style={s.card}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Church', 'Status', 'Stream', 'Alerts', 'Last Seen'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const isOnline = c.connected;
                const alertCount = c.activeAlerts || 0;
                const isStreaming = streamSet.has(c.churchId);
                const isExpanded = expandedId === c.churchId;
                return (
                  <>
                    <tr
                      key={c.churchId}
                      onClick={() => handleRowClick(c.churchId)}
                      style={{
                        cursor: 'pointer',
                        background: isExpanded ? 'rgba(34,197,94,0.06)' : 'transparent',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                      onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td style={s.td}>
                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                        <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>
                          {c.churchId?.slice(0, 12)}{'\u2026'}
                        </div>
                      </td>
                      <td style={s.td}>
                        <span style={s.badge(isOnline ? (alertCount > 0 ? C.red : C.green) : C.muted)}>
                          {isOnline ? (alertCount > 0 ? 'Alert' : 'Online') : 'Offline'}
                        </span>
                      </td>
                      <td style={s.td}>
                        {isStreaming ? (
                          <span style={s.badge(C.red)}>{'\uD83D\uDD34'} Live</span>
                        ) : (
                          <span style={{ color: C.muted }}>{'\u2014'}</span>
                        )}
                      </td>
                      <td style={s.td}>
                        {alertCount > 0 ? (
                          <span style={{ color: C.red, fontWeight: 600 }}>{alertCount}</span>
                        ) : (
                          <span style={{ color: C.muted }}>{'\u2014'}</span>
                        )}
                      </td>
                      <td style={{ ...s.td, color: C.muted, fontSize: 12 }}>
                        {c.lastSeen ? new Date(c.lastSeen).toLocaleString() : '\u2014'}
                      </td>
                    </tr>

                    {/* Inline detail panel */}
                    {isExpanded && (
                      <tr key={`${c.churchId}-detail`}>
                        <td colSpan={5} style={{ padding: 0, borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ padding: 20, background: 'rgba(255,255,255,0.02)' }}>
                            {/* Room selector */}
                            {(streamKey?.rooms?.length > 0 || rooms.length > 0) && (
                              <div style={{ marginBottom: 16 }}>
                                <select
                                  style={{ ...s.input, maxWidth: 200 }}
                                  value={selectedRoom}
                                  onChange={e => handleRoomSelect(e.target.value)}
                                >
                                  <option value="">Church Default</option>
                                  {(streamKey?.rooms || rooms).map(rm => (
                                    <option key={rm.roomId || rm.id} value={rm.roomId || rm.id}>{rm.roomName || rm.name}</option>
                                  ))}
                                </select>
                              </div>
                            )}

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20 }}>
                              {/* Left: stream preview */}
                              <div>
                                {displayStream?.active ? (
                                  <div>
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
                                    minHeight: 200, background: C.surface, borderRadius: 8,
                                    border: `1px solid ${C.border}`, color: C.muted, fontSize: 13,
                                  }}>
                                    <div style={{ textAlign: 'center' }}>
                                      <span style={{ ...s.badge(C.muted), marginBottom: 8, display: 'inline-block' }}>Offline</span>
                                      <div>Stream offline {'\u2014'} waiting for RTMP input</div>
                                    </div>
                                  </div>
                                )}

                                {/* Encoder stats */}
                                {displayStream?.active && displayStream.meta && (
                                  <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                    {[
                                      displayStream.meta.bitrateKbps > 0 && ['Bitrate', `${displayStream.meta.bitrateKbps} kbps`, displayStream.meta.bitrateKbps < 1000 ? C.yellow : C.green],
                                      displayStream.meta.fps > 0 && ['FPS', `${displayStream.meta.fps}`, displayStream.meta.fps < 25 ? C.yellow : C.green],
                                      displayStream.meta.resolution && ['Resolution', displayStream.meta.resolution, C.white],
                                      displayStream.meta.codec && ['Codec', `${displayStream.meta.codec}${displayStream.meta.audioCodec ? ' / ' + displayStream.meta.audioCodec : ''}`, C.white],
                                      displayStream.startedAt && ['Uptime', (() => {
                                        const sec = Math.floor((Date.now() - new Date(displayStream.startedAt).getTime()) / 1000);
                                        const h = Math.floor(sec / 3600);
                                        const m = Math.floor((sec % 3600) / 60);
                                        const s2 = sec % 60;
                                        return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s2}s` : `${s2}s`;
                                      })(), C.white],
                                    ].filter(Boolean).map(([label, value, color]) => (
                                      <div key={label} style={{
                                        background: 'rgba(255,255,255,0.04)', border: `1px solid ${C.border}`,
                                        borderRadius: 8, padding: '8px 14px', minWidth: 80,
                                      }}>
                                        <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
                                        <div style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Stream key info */}
                                {displayStream && (
                                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                                    {selectedRoom && activeRoomStream && (
                                      <div style={{ color: C.green, fontSize: 11, fontWeight: 600, marginBottom: 2 }}>
                                        Room: {activeRoomStream.roomName}
                                      </div>
                                    )}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                      <span style={{ color: C.muted, flexShrink: 0 }}>RTMP:</span>
                                      <code style={{ color: C.muted, wordBreak: 'break-all', whiteSpace: 'normal' }}>
                                        {displayStream.rtmpUrl ? displayStream.rtmpUrl.replace(displayStream.streamKey, '{KEY}') : '\u2014'}
                                      </code>
                                      {displayStream.rtmpUrl && (
                                        <button
                                          style={{ ...s.btn('secondary'), padding: '2px 6px', fontSize: 10, flexShrink: 0 }}
                                          onClick={(e) => copyToClipboard(e, displayStream.rtmpUrl)}
                                        >
                                          {copyFeedback === displayStream.rtmpUrl ? '\u2713 Copied' : 'Copy'}
                                        </button>
                                      )}
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                      <span style={{ color: C.muted, flexShrink: 0 }}>Key:</span>
                                      <code style={{ color: C.white, wordBreak: 'break-all' }}>{displayStream.streamKey || '\u2014'}</code>
                                      {displayStream.streamKey && (
                                        <button
                                          style={{ ...s.btn('secondary'), padding: '2px 6px', fontSize: 10, flexShrink: 0 }}
                                          onClick={(e) => copyToClipboard(e, displayStream.streamKey)}
                                        >
                                          {copyFeedback === displayStream.streamKey ? '\u2713 Copied' : 'Copy'}
                                        </button>
                                      )}
                                    </div>
                                    <div>
                                      <button
                                        style={{ ...s.btn('danger'), padding: '4px 10px', fontSize: 11 }}
                                        onClick={(e) => { e.stopPropagation(); handleRegenerate(); }}
                                      >
                                        Regenerate {selectedRoom ? 'Room Key' : 'Key'}
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Right: equipment status */}
                              <div style={{ ...s.section, marginBottom: 0 }}>
                                {renderEquipment() || (
                                  <div style={{ color: C.muted, fontSize: 13 }}>Loading equipment...</div>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
