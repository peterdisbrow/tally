import { useState, useEffect } from 'react';
import { C, s } from './adminStyles';

export default function SessionsPanel({ churchId, api }) {
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [debrief, setDebrief] = useState(null);
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await api(`/api/churches/${churchId}/sessions?limit=20`);
        setSessions(data.sessions || data || []);
        setTotal(data.total || 0);
      } catch { setSessions([]); }
      finally { setLoading(false); }
    })();
  }, [churchId, api]);

  async function loadTimeline(sessionId) {
    if (expandedId === sessionId) {
      setExpandedId(null);
      setTimeline(null);
      setDebrief(null);
      return;
    }
    setExpandedId(sessionId);
    setTimelineLoading(true);
    setDebrief(null);
    try {
      const data = await api(`/api/churches/${churchId}/sessions/${sessionId}/timeline`);
      setTimeline(data.timeline || []);
    } catch { setTimeline([]); }
    finally { setTimelineLoading(false); }
  }

  async function loadDebrief(sessionId) {
    setDebriefLoading(true);
    try {
      const data = await api(`/api/churches/${churchId}/sessions/${sessionId}/debrief`);
      setDebrief(data.debrief || 'No debrief available.');
    } catch { setDebrief('Error loading debrief.'); }
    finally { setDebriefLoading(false); }
  }

  function copyDebrief() {
    if (debrief) {
      navigator.clipboard.writeText(debrief);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const gradeIcon = (grade) => {
    if (!grade) return '\u{26AA}';
    if (grade === 'Clean') return '\u{1F7E2}';
    if (grade === 'Minor issues') return '\u{1F7E1}';
    return '\u{1F534}';
  };

  const severityColor = (sev) => {
    if (sev === 'CRITICAL' || sev === 'EMERGENCY') return C.red;
    if (sev === 'WARNING') return C.yellow;
    return C.green;
  };

  if (loading) return <div style={{ color: C.muted, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Loading sessions...</div>;

  if (sessions.length === 0) {
    return (
      <div style={s.section}>
        <div style={s.sectionTitle}>Service Sessions</div>
        <div style={{ color: C.muted, fontSize: 12, textAlign: 'center', padding: '24px 0' }}>
          No sessions recorded yet. Sessions are tracked automatically during service windows.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Service Sessions ({total})</div>

      {sessions.map(sess => {
        const isExpanded = expandedId === sess.id;
        const start = new Date(sess.started_at);
        const dateStr = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const timeStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

        return (
          <div key={sess.id} style={{ ...s.section, marginBottom: 8, padding: 0 }}>
            {/* Session header — clickable */}
            <div
              onClick={() => loadTimeline(sess.id)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 16px', cursor: 'pointer', transition: 'background 0.15s',
                borderRadius: isExpanded ? '8px 8px 0 0' : 8,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16 }}>{gradeIcon(sess.grade)}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{dateStr} {timeStr}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    {sess.duration_minutes ? `${sess.duration_minutes} min` : 'In progress'} {sess.td_name ? `\u2022 TD: ${sess.td_name}` : ''}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {(sess.alert_count || 0) > 0 && <span style={s.badge(C.red)}>{sess.alert_count} alerts</span>}
                {(sess.auto_recovered_count || 0) > 0 && <span style={s.badge(C.green)}>{sess.auto_recovered_count} auto-fixed</span>}
                {sess.stream_ran ? <span style={s.badge(C.blue)}>Streamed</span> : null}
                <span style={{ color: C.muted, fontSize: 14 }}>{isExpanded ? '\u25B2' : '\u25BC'}</span>
              </div>
            </div>

            {/* Expanded timeline */}
            {isExpanded && (
              <div style={{ padding: '0 16px 16px', borderTop: `1px solid ${C.border}` }}>
                {timelineLoading ? (
                  <div style={{ color: C.muted, fontSize: 12, padding: '16px 0', textAlign: 'center' }}>Loading timeline...</div>
                ) : !timeline || timeline.length === 0 ? (
                  <div style={{ color: C.muted, fontSize: 12, padding: '16px 0', textAlign: 'center' }}>No events recorded for this session.</div>
                ) : (
                  <div style={{ position: 'relative', paddingLeft: 24, marginTop: 12 }}>
                    {/* Vertical line */}
                    <div style={{ position: 'absolute', left: 7, top: 4, bottom: 4, width: 2, background: C.border }} />

                    {timeline.map((item, i) => {
                      const time = new Date(item.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                      let dotColor = C.green;
                      let label = '';
                      let icon = '';

                      if (item._type === 'marker') {
                        dotColor = C.blue;
                        label = item.label;
                        icon = item.label === 'Session Started' ? '\u{25B6}' : '\u{23F9}';
                        if (item.grade) label += ` (${item.grade})`;
                      } else if (item._type === 'alert') {
                        dotColor = severityColor(item.severity);
                        label = item.alert_type?.replace(/_/g, ' ') || 'Alert';
                        icon = item.severity === 'CRITICAL' || item.severity === 'EMERGENCY' ? '\u{1F534}' : '\u{26A0}\u{FE0F}';
                        if (item.acknowledged_at) label += ' \u2714';
                        if (item.escalated) label += ' ESCALATED';
                      } else if (item._type === 'event') {
                        dotColor = item.auto_resolved ? C.green : item.resolved ? C.yellow : C.muted;
                        label = item.event_type?.replace(/_/g, ' ') || 'Event';
                        icon = item.auto_resolved ? '\u{26A1}' : '\u{1F4CB}';
                        if (item.auto_resolved) label += ' (auto-resolved)';
                        else if (item.resolved) label += ' (resolved)';
                      }

                      return (
                        <div key={`${item._type}-${item.id || i}`} style={{ display: 'flex', gap: 10, marginBottom: 10, position: 'relative' }}>
                          {/* Dot */}
                          <div style={{
                            width: 16, height: 16, borderRadius: '50%', background: `${dotColor}20`,
                            border: `2px solid ${dotColor}`, position: 'absolute', left: -24, top: 1,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8,
                          }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span style={{ fontSize: 12 }}>{icon}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: dotColor }}>{label}</span>
                              <span style={{ fontSize: 11, color: C.dim }}>{time}</span>
                            </div>
                            {item.details && (
                              <div style={{ fontSize: 11, color: C.muted, marginTop: 2, paddingLeft: 20 }}>
                                {typeof item.details === 'string' ? item.details.substring(0, 120) : JSON.stringify(item.details).substring(0, 120)}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Debrief section */}
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button
                    style={s.btn('secondary')}
                    onClick={() => loadDebrief(sess.id)}
                    disabled={debriefLoading}
                  >
                    {debriefLoading ? 'Loading...' : debrief ? 'Refresh Debrief' : 'Generate Debrief'}
                  </button>
                  {debrief && (
                    <button style={s.btn('primary')} onClick={copyDebrief}>
                      {copied ? 'Copied!' : 'Copy Debrief'}
                    </button>
                  )}
                </div>

                {debrief && (
                  <pre style={{
                    marginTop: 8, padding: 12, background: 'rgba(0,0,0,0.3)', borderRadius: 6,
                    fontSize: 11, color: C.muted, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    border: `1px solid ${C.border}`, maxHeight: 300, overflowY: 'auto', fontFamily: 'monospace',
                  }}>
                    {debrief}
                  </pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
