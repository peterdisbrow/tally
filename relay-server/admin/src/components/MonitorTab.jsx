import { useState, useEffect, useRef, useCallback } from 'react';
import { C, s, ENCODER_TYPE_NAMES } from './adminStyles';

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
  const [expandedDevices, setExpandedDevices] = useState({});
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
        } else if (data.type === 'status' || data.type === 'status_update') {
          setChurches(prev => prev.map(c =>
            c.churchId === data.churchId ? { ...c, ...data } : c
          ));
        } else if (data.type === 'connect' || data.type === 'church_connected') {
          setChurches(prev => {
            const exists = prev.find(c => c.churchId === data.churchId);
            if (exists) {
              return prev.map(c => c.churchId === data.churchId ? { ...c, connected: true, ...data } : c);
            }
            return [...prev, { ...data, connected: true }];
          });
        } else if (data.type === 'disconnect' || data.type === 'church_disconnected') {
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

  function refreshPlayer() {
    if (!expandedId) return;
    destroyPlayer();
    startPlayer(expandedId, streamKey?.hlsUrl);
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
      setExpandedDevices({});
      return;
    }

    destroyPlayer();
    setExpandedId(churchId);
    setStreamKey(null);
    setEquipment(null);
    setRooms([]);
    setSelectedRoom('');
    setExpandedDevices({});

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

  async function handleRoomSelect(roomId) {
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
    // Re-fetch equipment so the sidebar reflects the correct room's devices
    if (expandedId && api) {
      try {
        const data = await api(`/api/admin/church/${encodeURIComponent(expandedId)}/support-view`);
        setEquipment(data);
      } catch { /* ignore */ }
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
        } else if (data.type === 'status' || data.type === 'status_update') {
          setChurches(prev => prev.map(c => c.churchId === data.churchId ? { ...c, ...data } : c));
        } else if (data.type === 'connect' || data.type === 'church_connected') {
          setChurches(prev => {
            const exists = prev.find(c => c.churchId === data.churchId);
            if (exists) return prev.map(c => c.churchId === data.churchId ? { ...c, connected: true, ...data } : c);
            return [...prev, { ...data, connected: true }];
          });
        } else if (data.type === 'disconnect' || data.type === 'church_disconnected') {
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

  // Equipment rendering — expandable per-device sections
  function toggleDevice(key) {
    setExpandedDevices(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function renderEquipment() {
    if (!equipment) return null;
    let st = equipment.status || {};
    let devices = st.connectedDevices || {};
    let details = st.deviceDetails || {};
    let eqOnline = st.online;
    let streamActive = st.streamActive;

    if (selectedRoom && equipment.roomInstanceMap && equipment.roomInstanceMap[selectedRoom]) {
      const instName = equipment.roomInstanceMap[selectedRoom];
      const instData = (equipment.instanceStatusMap || {})[instName];
      if (instData) {
        devices = instData.connectedDevices || {};
        details = instData.deviceDetails || {};
        eqOnline = instData.online;
        streamActive = instData.streamActive;
      } else {
        devices = {};
        details = {};
        eqOnline = false;
        streamActive = false;
      }
    }

    const dot = (ok) => (
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: ok ? C.green : '#555', marginRight: 8, flexShrink: 0,
      }} />
    );

    const detailRow = (label, value, color) => value != null && value !== '' ? (
      <div style={{ display: 'flex', gap: 6, fontSize: 11, padding: '2px 0' }}>
        <span style={{ color: C.muted, minWidth: 70, flexShrink: 0 }}>{label}:</span>
        <span style={{ color: color || C.white, wordBreak: 'break-all' }}>{value}</span>
      </div>
    ) : null;

    const deviceHeader = (key, label, connected, subtitle) => (
      <div
        onClick={() => toggleDevice(key)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          padding: '6px 0', fontSize: 13, userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 10, color: C.muted, width: 14, textAlign: 'center', flexShrink: 0 }}>
          {expandedDevices[key] ? '\u25BC' : '\u25B6'}
        </span>
        {dot(connected)}
        <span style={{ fontWeight: 600 }}>{label}</span>
        {subtitle && <span style={{ fontSize: 11, color: C.muted, marginLeft: 4 }}>{subtitle}</span>}
      </div>
    );

    const deviceBody = (key, children) => expandedDevices[key] ? (
      <div style={{
        marginLeft: 30, padding: '4px 0 8px', borderLeft: `1px solid ${C.border}`,
        paddingLeft: 12, marginBottom: 4,
      }}>
        {children}
      </div>
    ) : null;

    const sections = [];

    // App connection
    sections.push(
      <div key="app">
        {deviceHeader('app', 'TallyConnect App', eqOnline, eqOnline ? 'Connected' : 'Offline')}
        {deviceBody('app', <>
          {detailRow('Hostname', details.system?.hostname)}
          {detailRow('Platform', details.system?.platform)}
          {detailRow('Room', details.system?.roomName)}
          {detailRow('Timezone', details.system?.timezone)}
          {details.system?.uptime > 0 && detailRow('Uptime', (() => {
            const sec = details.system.uptime;
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
          })())}
        </>)}
      </div>
    );

    // ATEM
    const atem = details.atem;
    if (atem) {
      const atemLabel = atem.model || atem.productIdentifier || 'ATEM';
      sections.push(
        <div key="atem">
          {deviceHeader('atem', 'ATEM', atem.connected, atem.connected ? atemLabel : null)}
          {deviceBody('atem', <>
            {detailRow('Model', atem.model || atem.productIdentifier)}
            {detailRow('IP', atem.ip)}
            {atem.protocolVersion && detailRow('Protocol', atem.protocolVersion)}

            {/* Streaming / Recording status */}
            {atem.streaming && (
              <div style={{ marginTop: 4, marginBottom: 4 }}>
                <span style={s.badge(C.red)}>Streaming</span>
                {atem.streamingService && <span style={{ fontSize: 11, color: C.muted, marginLeft: 6 }}>{atem.streamingService}</span>}
                {atem.streamingBitrate > 0 && <span style={{ fontSize: 11, color: C.muted, marginLeft: 6 }}>{Math.round(atem.streamingBitrate / 1000)} kbps</span>}
              </div>
            )}
            {atem.recording && (
              <div style={{ marginTop: 4, marginBottom: 4 }}>
                <span style={s.badge(C.red)}>Recording</span>
                {atem.recordingDuration && <span style={{ fontSize: 11, color: C.muted, marginLeft: 6 }}>{atem.recordingDuration}</span>}
              </div>
            )}

            {/* PGM / PVW status */}
            {(() => {
              const getInputName = (inputId) => {
                if (inputId == null) return null;
                const id = String(inputId);
                if (atem.inputSources && atem.inputSources[id]) {
                  const src = atem.inputSources[id];
                  return src.longName || src.shortName || `Input ${id}`;
                }
                if (atem.inputLabels && atem.inputLabels[id]) return atem.inputLabels[id];
                return `Input ${id}`;
              };
              const pgmName = getInputName(atem.programInput);
              const pvwName = getInputName(atem.previewInput);
              return (pgmName || pvwName) ? (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {pgmName && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.12)' }}>
                      <span style={s.badge(C.red)}>PGM</span>
                      <span style={{ color: C.red, fontWeight: 600 }}>{pgmName}</span>
                    </div>
                  )}
                  {pvwName && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 6px', borderRadius: 4, background: 'rgba(34,197,94,0.08)' }}>
                      <span style={s.badge(C.green)}>PVW</span>
                      <span style={{ color: C.green, fontWeight: 600 }}>{pvwName}</span>
                    </div>
                  )}
                </div>
              ) : null;
            })()}

            {/* ATEM Input Sources */}
            {atem.inputSources && Object.keys(atem.inputSources).length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Input Sources
                </div>
                {Object.entries(atem.inputSources)
                  .filter(([, src]) => src.isExternal !== false)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([id, src]) => {
                    const isPgm = Number(id) === atem.programInput;
                    const isPvw = Number(id) === atem.previewInput;
                    return (
                      <div key={id} style={{
                        display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
                        padding: '3px 6px', borderRadius: 4, marginBottom: 2,
                        background: isPgm ? 'rgba(239,68,68,0.12)' : isPvw ? 'rgba(34,197,94,0.08)' : 'transparent',
                      }}>
                        <span style={{ color: C.dim, minWidth: 14, textAlign: 'right' }}>{id}</span>
                        <span style={{ color: isPgm ? C.red : isPvw ? C.green : C.white, fontWeight: isPgm || isPvw ? 600 : 400 }}>
                          {src.longName || src.shortName}
                        </span>
                        {src.portType && (
                          <span style={{ fontSize: 10, color: C.muted, padding: '0 4px', background: 'rgba(255,255,255,0.05)', borderRadius: 3 }}>
                            {src.portType}
                          </span>
                        )}
                        {isPgm && <span style={s.badge(C.red)}>PGM</span>}
                        {isPvw && <span style={s.badge(C.green)}>PVW</span>}
                      </div>
                    );
                  })}
              </div>
            )}

            {/* Fallback: inputLabels only (older client that hasn't sent inputSources yet) */}
            {!atem.inputSources && atem.inputLabels && Object.keys(atem.inputLabels).length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Input Sources
                </div>
                {Object.entries(atem.inputLabels)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([id, name]) => {
                    const isPgm = Number(id) === atem.programInput;
                    const isPvw = Number(id) === atem.previewInput;
                    return (
                      <div key={id} style={{
                        display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
                        padding: '3px 6px', borderRadius: 4, marginBottom: 2,
                        background: isPgm ? 'rgba(239,68,68,0.12)' : isPvw ? 'rgba(34,197,94,0.08)' : 'transparent',
                      }}>
                        <span style={{ color: C.dim, minWidth: 14, textAlign: 'right' }}>{id}</span>
                        <span style={{ color: isPgm ? C.red : isPvw ? C.green : C.white, fontWeight: isPgm || isPvw ? 600 : 400 }}>
                          {name}
                        </span>
                        {isPgm && <span style={s.badge(C.red)}>PGM</span>}
                        {isPvw && <span style={s.badge(C.green)}>PVW</span>}
                      </div>
                    );
                  })}
              </div>
            )}
          </>)}
        </div>
      );
    }

    // OBS
    const obs = details.obs;
    if (obs) {
      sections.push(
        <div key="obs">
          {deviceHeader('obs', 'OBS', obs.connected, obs.connected && obs.version ? `v${obs.version}` : null)}
          {deviceBody('obs', <>
            {detailRow('App', obs.app)}
            {detailRow('Version', obs.version)}
            {detailRow('WebSocket', obs.websocketVersion)}
            {obs.streaming && <div style={{ marginTop: 2 }}><span style={s.badge(C.red)}>Streaming</span></div>}
            {obs.recording && <div style={{ marginTop: 2 }}><span style={s.badge(C.yellow)}>Recording</span></div>}
            {obs.bitrate > 0 && detailRow('Bitrate', `${obs.bitrate} kbps`)}
            {obs.fps > 0 && detailRow('FPS', obs.fps)}
          </>)}
        </div>
      );
    }

    // vMix
    const vmix = details.vmix;
    if (vmix) {
      sections.push(
        <div key="vmix">
          {deviceHeader('vmix', 'vMix', vmix.connected, vmix.connected && vmix.edition ? vmix.edition : null)}
          {deviceBody('vmix', <>
            {detailRow('Edition', vmix.edition)}
            {detailRow('Version', vmix.version)}
            {vmix.streaming && <div style={{ marginTop: 2 }}><span style={s.badge(C.red)}>Streaming</span></div>}
            {vmix.recording && <div style={{ marginTop: 2 }}><span style={s.badge(C.yellow)}>Recording</span></div>}
          </>)}
        </div>
      );
    }

    // Encoder
    const enc = details.encoder;
    if (enc && (enc.connected || enc.live || enc.type)) {
      const encName = ENCODER_TYPE_NAMES[enc.type] || enc.type || 'Encoder';
      sections.push(
        <div key="encoder">
          {deviceHeader('encoder', encName, enc.connected || enc.live, enc.live ? 'Live' : null)}
          {deviceBody('encoder', <>
            {detailRow('Type', encName)}
            {enc.details && detailRow('Details', enc.details)}
            {enc.bitrateKbps > 0 && detailRow('Bitrate', `${enc.bitrateKbps} kbps`)}
            {enc.fps > 0 && detailRow('FPS', enc.fps)}
            {enc.cpuUsage != null && detailRow('CPU', `${enc.cpuUsage}%`)}
            {enc.congestion != null && detailRow('Congestion', `${enc.congestion}%`, enc.congestion > 50 ? C.red : C.white)}
          </>)}
        </div>
      );
    }

    // Backup Encoder
    const bkEnc = details.backupEncoder;
    if (bkEnc && bkEnc.configured) {
      const bkName = ENCODER_TYPE_NAMES[bkEnc.type] || bkEnc.type || 'Backup Encoder';
      sections.push(
        <div key="backupEncoder">
          {deviceHeader('backupEncoder', `Backup: ${bkName}`, bkEnc.connected)}
          {deviceBody('backupEncoder', <>
            {detailRow('Type', bkName)}
            {detailRow('Status', bkEnc.connected ? 'Connected' : 'Standby')}
          </>)}
        </div>
      );
    }

    // Companion
    const comp = details.companion;
    if (comp) {
      sections.push(
        <div key="companion">
          {deviceHeader('companion', 'Companion', comp.connected, comp.connected && comp.connectionCount > 0 ? `${comp.connectionCount} connection${comp.connectionCount !== 1 ? 's' : ''}` : null)}
          {deviceBody('companion', <>
            {detailRow('Endpoint', comp.endpoint)}
            {detailRow('Connections', comp.connectionCount)}
          </>)}
        </div>
      );
    }

    // Mixer
    const mixer = details.mixer;
    if (mixer && (mixer.connected || mixer.type)) {
      sections.push(
        <div key="mixer">
          {deviceHeader('mixer', mixer.type ? `Mixer (${mixer.type})` : 'Mixer', mixer.connected, mixer.model || null)}
          {deviceBody('mixer', <>
            {detailRow('Type', mixer.type)}
            {detailRow('Model', mixer.model)}
            {detailRow('Firmware', mixer.firmware)}
            {mixer.mainMuted && <div style={{ marginTop: 2 }}><span style={s.badge(C.red)}>Main Muted</span></div>}
          </>)}
        </div>
      );
    }

    // ProPresenter
    const pp = details.proPresenter;
    if (pp && (pp.connected || pp.running)) {
      sections.push(
        <div key="propresenter">
          {deviceHeader('propresenter', 'ProPresenter', pp.connected, pp.version ? `v${pp.version}` : null)}
          {deviceBody('propresenter', <>
            {detailRow('Version', pp.version)}
            {pp.currentSlide && detailRow('Current Slide', pp.currentSlide)}
            {pp.activeLook && detailRow('Active Look', pp.activeLook)}
          </>)}
        </div>
      );
    }

    // Resolume
    const res = details.resolume;
    if (res && (res.connected || res.host)) {
      sections.push(
        <div key="resolume">
          {deviceHeader('resolume', 'Resolume', res.connected, res.version || null)}
          {deviceBody('resolume', <>
            {detailRow('Host', res.host)}
            {detailRow('Port', res.port)}
            {detailRow('Version', res.version)}
          </>)}
        </div>
      );
    }

    // HyperDecks
    const hd = details.hyperdeck;
    if (hd && (hd.connected || (details.hyperdecks || []).length > 0)) {
      const decks = details.hyperdecks?.length > 0 ? details.hyperdecks : (hd.decks || []);
      sections.push(
        <div key="hyperdeck">
          {deviceHeader('hyperdeck', 'HyperDeck', hd.connected, hd.recording ? 'Recording' : null)}
          {deviceBody('hyperdeck', <>
            {hd.recording && <div style={{ marginBottom: 4 }}><span style={s.badge(C.red)}>Recording</span></div>}
            {decks.map((d, i) => (
              <div key={i} style={{ fontSize: 11, padding: '2px 0' }}>
                {detailRow(`Deck ${i + 1}`, d.name || d.ip || `Deck ${i + 1}`)}
              </div>
            ))}
          </>)}
        </div>
      );
    }

    // Video Hubs
    if ((details.videoHubs || []).length > 0) {
      details.videoHubs.forEach((hub, i) => {
        sections.push(
          <div key={`videohub-${i}`}>
            {deviceHeader(`videohub-${i}`, hub.name || `VideoHub ${i + 1}`, hub.connected, hub.model || null)}
            {deviceBody(`videohub-${i}`, <>
              {detailRow('Model', hub.model)}
              {detailRow('IP', hub.ip || hub.host)}
            </>)}
          </div>
        );
      });
    }

    // PTZ Cameras
    if ((details.ptz || []).length > 0) {
      details.ptz.forEach((cam, i) => {
        sections.push(
          <div key={`ptz-${i}`}>
            {deviceHeader(`ptz-${i}`, cam.name || `PTZ ${i + 1}`, cam.connected !== false, cam.protocol || null)}
            {deviceBody(`ptz-${i}`, <>
              {detailRow('IP', cam.ip || cam.host)}
              {detailRow('Protocol', cam.protocol)}
              {detailRow('Model', cam.model)}
            </>)}
          </div>
        );
      });
    }

    // Smart Plugs
    if ((details.smartPlugs || []).length > 0) {
      details.smartPlugs.forEach((plug, i) => {
        sections.push(
          <div key={`plug-${i}`}>
            {deviceHeader(`plug-${i}`, plug.name || `Smart Plug ${i + 1}`, plug.connected !== false)}
            {deviceBody(`plug-${i}`, <>
              {detailRow('IP', plug.ip || plug.host)}
              {detailRow('Status', plug.on ? 'On' : 'Off')}
            </>)}
          </div>
        );
      });
    }

    // Audio monitoring
    const audio = details.audio;
    if (audio && audio.monitoring) {
      sections.push(
        <div key="audio">
          {deviceHeader('audio', 'Audio Monitor', audio.monitoring, audio.source || null)}
          {deviceBody('audio', <>
            {detailRow('Source', audio.source)}
            {audio.lastLevelDb != null && detailRow('Level', `${audio.lastLevelDb} dB`, audio.silenceDetected ? C.red : C.green)}
            {audio.silenceDetected && <div style={{ marginTop: 2 }}><span style={s.badge(C.red)}>Silence Detected</span></div>}
          </>)}
        </div>
      );
    }

    return (
      <div>
        <div style={s.sectionTitle}>Equipment Status</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sections}
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

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20 }}>
                              {/* Left: stream preview */}
                              <div>
                                {displayStream?.active ? (
                                  <div>
                                    <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={s.badge(C.red)}>{'\uD83D\uDD34'} LIVE</span>
                                      <button
                                        style={{ ...s.btn('secondary'), padding: '3px 10px', fontSize: 11 }}
                                        onClick={(e) => { e.stopPropagation(); refreshPlayer(); }}
                                        title="Refresh stream preview"
                                      >
                                        {'\u21BB'} Refresh
                                      </button>
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
