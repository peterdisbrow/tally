import { useState, useEffect } from 'react';
import { C, s, getEncoderNameFromStatus, getEncoderConnectedFromStatus, getEncoderLiveFromStatus } from './adminStyles';

function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
function fmtTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
function healthColor(score) { return score >= 90 ? C.green : score >= 75 ? '#86efac' : score >= 50 ? C.yellow : C.red; }
function gradeBadge(g) {
  if (!g) return <span style={s.badge(C.muted)}>—</span>;
  const color = g === 'A' || g === 'A+' || g === 'B' ? C.green : g === 'C' ? C.yellow : C.red;
  return <span style={s.badge(color)}>{g}</span>;
}
function sevBadge(sev) {
  const color = sev === 'critical' ? C.red : sev === 'warning' ? C.yellow : C.muted;
  return <span style={s.badge(color)}>{sev || 'info'}</span>;
}

export default function OverviewPanel({ churchId, api }) {
  const [status, setStatus] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [sv, setSv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedRoom, setSelectedRoom] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [st, sc, supportView] = await Promise.all([
          api(`/api/churches/${churchId}/status`).catch(() => null),
          api(`/api/churches/${churchId}/schedule`).catch(() => null),
          api(`/api/admin/church/${churchId}/support-view`).catch(() => null),
        ]);
        if (!cancelled) { setStatus(st); setSchedule(sc); setSv(supportView); }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [churchId, api]);

  if (loading) return <div style={{ color: C.muted, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Loading...</div>;

  const st = status || {};
  const eq = st.status?.equipment || st.equipment || {};
  const sc = schedule || {};
  const connected = st.connected ?? false;
  const lastSeen = st.lastSeen || st.last_seen;
  const version = st.status?.version || st.version;
  const encoderName = getEncoderNameFromStatus(st.status || st);
  const encoderConnected = getEncoderConnectedFromStatus(st.status || st);
  const encoderLive = getEncoderLiveFromStatus(st.status || st);

  const ch = sv?.church || {};
  const hs = sv?.healthScore || { score: 100, trend: 'stable' };
  const bill = sv?.billing || {};
  const onb = sv?.onboarding || {};
  const integ = sv?.integrations || {};
  const cfg = sv?.config || {};
  const alerts = sv?.recentAlerts || [];
  const sessions = sv?.recentSessions || [];
  const tickets = sv?.recentTickets || [];
  const chat = sv?.chatHistory || [];
  const tds = sv?.tds || [];
  const rooms = sv?.rooms || [];
  const roomInstanceMap = sv?.roomInstanceMap || {};
  const instanceStatusMap = sv?.instanceStatusMap || {};

  // Get equipment for selected room (or default aggregate)
  function getDevicesForRoom(roomId) {
    if (!roomId) return eq;
    const instanceName = roomInstanceMap[roomId];
    if (!instanceName) return {};
    const instData = instanceStatusMap[instanceName];
    if (!instData) return {};
    return instData.connectedDevices || {};
  }
  const filteredDevices = getDevicesForRoom(selectedRoom);

  const chipStyle = (on) => ({
    display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 500,
    background: on ? 'rgba(34,197,94,.1)' : 'rgba(148,163,184,.08)',
    color: on ? C.green : C.dim,
    border: `1px solid ${on ? 'rgba(34,197,94,.2)' : 'rgba(148,163,184,.15)'}`,
  });
  const miniTh = { textAlign: 'left', padding: '4px 6px', fontSize: 10, color: C.dim, fontWeight: 500, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}` };
  const miniTd = { padding: '5px 6px', borderBottom: '1px solid rgba(26,46,31,.3)', color: C.muted, fontSize: 12 };
  const checkDot = (done) => ({
    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
    background: done ? C.green : C.dim,
    boxShadow: done ? `0 0 4px ${C.green}` : 'none',
  });

  return (
    <div>
      {/* Room Selector */}
      {rooms.length > 0 && (
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontSize: 12, color: C.muted, fontWeight: 500 }}>Room:</label>
          <select
            value={selectedRoom}
            onChange={e => setSelectedRoom(e.target.value)}
            style={{ ...s.input, width: 200, padding: '6px 10px', fontSize: 13 }}
          >
            <option value="">All Rooms</option>
            {rooms.map(rm => (
              <option key={rm.id} value={rm.id}>{rm.name}</option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: C.dim }}>{rooms.length} room{rooms.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Connection */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Connection</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={s.badge(connected ? C.green : C.muted)}>{connected ? 'Online' : 'Offline'}</span>
          {lastSeen && <span style={{ fontSize: 11, color: C.dim }}>Last seen: {new Date(lastSeen).toLocaleString()}</span>}
          {version && <span style={s.badge(C.blue)}>v{version}</span>}
        </div>
      </div>

      {/* Health Score */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Health</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...s.badge(healthColor(hs.score)), fontSize: 13, fontWeight: 700 }}>{hs.score}/100</span>
          <span style={{ fontSize: 12, color: C.muted }}>Trend: {hs.trend || 'stable'}</span>
          {sv?.status?.streamActive && <span style={s.badge(C.red)}>Stream Active</span>}
          {sv?.status?.currentSession && (
            <span style={s.badge(C.green)}>In Session — {Math.floor(sv.status.currentSession.duration / 60)} min</span>
          )}
        </div>
      </div>

      {/* Church Details */}
      {sv && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 12 }}>
            <div style={{ color: C.dim }}>Type</div><div style={{ color: C.white }}>{ch.church_type || 'recurring'}</div>
            <div style={{ color: C.dim }}>Portal Email</div><div style={{ color: C.white }}>{ch.portal_email || ch.email || '—'}</div>
            <div style={{ color: C.dim }}>Reg Code</div><div style={{ color: C.white, fontFamily: 'monospace' }}>{ch.registration_code || '—'}</div>
            <div style={{ color: C.dim }}>Referral Code</div><div style={{ color: C.white, fontFamily: 'monospace' }}>{ch.referral_code || '—'}</div>
            {ch.referred_by && <><div style={{ color: C.dim }}>Referred By</div><div style={{ color: C.white }}>{ch.referred_by}</div></>}
            <div style={{ color: C.dim }}>Timezone</div><div style={{ color: C.white }}>{ch.timezone || '—'}</div>
            <div style={{ color: C.dim }}>Registered</div><div style={{ color: C.white }}>{fmtTime(ch.registeredAt)}</div>
            {bill.tier && <><div style={{ color: C.dim }}>Tier</div><div><span style={s.badge(C.green)}>{bill.tier}</span></div></>}
            {bill.status && <><div style={{ color: C.dim }}>Billing Status</div><div style={{ color: C.white }}>{bill.status}{bill.billing_interval ? ` (${bill.billing_interval})` : ''}</div></>}
            {bill.trial_ends_at && <><div style={{ color: C.dim }}>Trial Ends</div><div style={{ color: C.yellow }}>{fmtDate(bill.trial_ends_at)}</div></>}
            {bill.stripe_customer_id && (
              <><div style={{ color: C.dim }}>Stripe</div><div><a href={`https://dashboard.stripe.com/customers/${bill.stripe_customer_id}`} target="_blank" rel="noopener" style={{ color: C.green, fontSize: 11 }}>View in Stripe ↗</a></div></>
            )}
          </div>
        </div>
      )}

      {/* Equipment */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          <span>Equipment</span>
          {selectedRoom && rooms.length > 0 && (
            <span style={{ fontSize: 10, color: C.dim, fontWeight: 400 }}>(filtered by room)</span>
          )}
        </div>
        {Object.keys(filteredDevices).length === 0 ? (
          <div style={{ color: C.muted, fontSize: 12 }}>
            {selectedRoom ? 'No equipment data for this room.' : 'No equipment data available.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, fontSize: 12 }}>
            {filteredDevices.atem && <div><span style={{ color: C.muted }}>ATEM:</span> <span style={{ color: C.white }}>{typeof filteredDevices.atem === 'object' ? (filteredDevices.atem.model || 'Connected') : (filteredDevices.atem ? 'Connected' : 'Not connected')}</span></div>}
            {(filteredDevices.obs !== undefined || filteredDevices.vmix !== undefined || !selectedRoom) && (
              <div><span style={{ color: C.muted }}>{selectedRoom ? (filteredDevices.obs ? 'OBS' : filteredDevices.vmix ? 'vMix' : encoderName) : encoderName}:</span> <span style={{ color: selectedRoom ? (filteredDevices.obs || filteredDevices.vmix ? C.green : C.muted) : (encoderConnected ? C.green : C.muted) }}>{selectedRoom ? (filteredDevices.obs || filteredDevices.vmix ? 'Connected' : 'Not connected') : (encoderConnected ? 'Connected' : 'Not connected')}</span></div>
            )}
            {!selectedRoom && <div><span style={{ color: C.muted }}>Stream:</span> <span style={{ color: encoderLive ? C.red : C.muted }}>{encoderLive ? 'Live' : 'Off-air'}</span></div>}
            {selectedRoom && filteredDevices.streamActive !== undefined && <div><span style={{ color: C.muted }}>Stream:</span> <span style={{ color: filteredDevices.streamActive ? C.red : C.muted }}>{filteredDevices.streamActive ? 'Live' : 'Off-air'}</span></div>}
            {filteredDevices.companion !== undefined && <div><span style={{ color: C.muted }}>Companion:</span> <span style={{ color: filteredDevices.companion ? C.green : C.muted }}>{filteredDevices.companion ? 'Connected' : 'Not connected'}</span></div>}
            {Array.isArray(filteredDevices.encoders) && filteredDevices.encoders.length > 0 && <div><span style={{ color: C.muted }}>Encoders:</span> <span style={{ color: C.white }}>{filteredDevices.encoders.length}</span></div>}
            {Array.isArray(filteredDevices.ptz) && filteredDevices.ptz.length > 0 && <div><span style={{ color: C.muted }}>PTZ Cameras:</span> <span style={{ color: C.white }}>{filteredDevices.ptz.length}</span></div>}
            {Array.isArray(filteredDevices.hyperdecks) && filteredDevices.hyperdecks.length > 0 && <div><span style={{ color: C.muted }}>HyperDecks:</span> <span style={{ color: C.white }}>{filteredDevices.hyperdecks.length}</span></div>}
            {!selectedRoom && eq.propresenter !== undefined && <div><span style={{ color: C.muted }}>ProPresenter:</span> <span style={{ color: eq.propresenter ? C.green : C.muted }}>{eq.propresenter ? 'Connected' : 'Not connected'}</span></div>}
            {!selectedRoom && eq.audio && <div><span style={{ color: C.muted }}>Audio Inputs:</span> <span style={{ color: C.white }}>{Array.isArray(eq.audio) ? eq.audio.length : eq.audio}</span></div>}
          </div>
        )}
      </div>

      {/* Integrations */}
      {sv && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Integrations</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span style={chipStyle(integ.planningCenter)}>Planning Center</span>
            <span style={chipStyle(integ.youtube)}>YouTube</span>
            <span style={chipStyle(integ.facebook)}>Facebook</span>
            <span style={chipStyle(integ.vimeo)}>Vimeo</span>
            {ch.slack_channel && <span style={chipStyle(true)}>Slack</span>}
          </div>
        </div>
      )}

      {/* Onboarding */}
      {sv && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Onboarding</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              ['App Connected', onb.app_connected],
              ['ATEM Connected', onb.atem_connected],
              ['First Session', onb.first_session],
              ['Telegram Setup', onb.telegram],
              ['Failover Tested', onb.failover_tested],
              ['Team Invited', onb.team_invited],
            ].map(([label, val]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.muted }}>
                <span style={checkDot(!!val)} />
                {label}
                {val && <span style={{ fontSize: 10, color: C.dim }}>{fmtDate(val)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Configuration */}
      {sv && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Configuration</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span style={chipStyle(cfg.autoRecovery)}>Auto-Recovery</span>
            <span style={chipStyle(cfg.failover)}>Failover{cfg.failoverAction ? ` (${cfg.failoverAction})` : ''}</span>
          </div>
          {cfg.autoPilotRulesCount > 0 && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>{cfg.autoPilotRulesCount} AutoPilot rule{cfg.autoPilotRulesCount !== 1 ? 's' : ''}</div>
          )}
        </div>
      )}

      {/* Signal Failover */}
      {st.status?.failover && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Signal Failover</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
            <span style={s.badge(
              st.status.failover.state === 'HEALTHY' ? C.green :
              st.status.failover.state === 'FAILOVER_ACTIVE' ? '#f97316' : C.red
            )}>
              {st.status.failover.state === 'HEALTHY' ? 'Healthy' :
               st.status.failover.state === 'SUSPECTED_BLACK' ? 'Suspected' :
               st.status.failover.state === 'CONFIRMED_OUTAGE' ? 'Outage Confirmed' :
               st.status.failover.state === 'FAILOVER_ACTIVE' ? 'Failover Active' :
               st.status.failover.state === 'ATEM_LOST' ? 'ATEM Lost' :
               st.status.failover.state}
            </span>
            {st.status.failover.diagnosisType && st.status.failover.state !== 'HEALTHY' && (
              <span style={{ color: C.dim }}>Diagnosis: {st.status.failover.diagnosisType}</span>
            )}
          </div>
          {st.status.failover.transitions && st.status.failover.transitions.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: C.muted }}>
              {st.status.failover.transitions.slice(0, 3).map((t, i) => (
                <div key={i}>
                  <span style={{ color: C.dim }}>{new Date(t.ts).toLocaleTimeString()}</span>{' '}
                  {t.from} → <span style={{ color: C.white }}>{t.to}</span>{' '}
                  <span style={{ color: C.dim }}>({t.trigger})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tech Directors */}
      {tds.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Tech Directors ({tds.length})</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={miniTh}>Name</th><th style={miniTh}>Email</th><th style={miniTh}>Access</th></tr></thead>
            <tbody>
              {tds.map(td => (
                <tr key={td.id}><td style={{ ...miniTd, color: C.white }}>{td.name || '—'}</td><td style={miniTd}>{td.email || '—'}</td><td style={miniTd}>{td.access_level || 'full'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Sessions */}
      {sessions.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Recent Sessions</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={miniTh}>Date</th><th style={miniTh}>Duration</th><th style={miniTh}>Grade</th><th style={miniTh}>Alerts</th></tr></thead>
            <tbody>
              {sessions.map(sess => (
                <tr key={sess.id}><td style={{ ...miniTd, color: C.white }}>{fmtDate(sess.startedAt)}</td><td style={miniTd}>{sess.duration || '—'} min</td><td style={miniTd}>{gradeBadge(sess.grade)}</td><td style={miniTd}>{sess.alerts || 0}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Alerts */}
      {alerts.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Recent Alerts ({alerts.length})</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={miniTh}>Type</th><th style={miniTh}>Severity</th><th style={miniTh}>Time</th><th style={miniTh}>Status</th></tr></thead>
            <tbody>
              {alerts.slice(0, 10).map(a => (
                <tr key={a.id}><td style={{ ...miniTd, color: C.white }}>{a.type || '—'}</td><td style={miniTd}>{sevBadge(a.severity)}</td><td style={miniTd}>{fmtTime(a.timestamp)}</td><td style={miniTd}>{a.resolved ? <span style={s.badge(C.green)}>Resolved</span> : <span style={s.badge(C.red)}>Open</span>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Support Tickets */}
      {tickets.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Support Tickets</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={miniTh}>Title</th><th style={miniTh}>Severity</th><th style={miniTh}>Status</th><th style={miniTh}>Created</th></tr></thead>
            <tbody>
              {tickets.map(t => (
                <tr key={t.id}><td style={{ ...miniTd, color: C.white }}>{t.title || '—'}</td><td style={miniTd}>{sevBadge(t.severity)}</td><td style={miniTd}><span style={s.badge(C.muted)}>{t.status || '—'}</span></td><td style={miniTd}>{fmtDate(t.created_at)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Service Window */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Service Window</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
          <span style={s.badge(sc.inServiceWindow ? C.green : C.muted)}>
            {sc.inServiceWindow ? 'In Service Window' : 'Outside Service Window'}
          </span>
          {sc.nextService && <span style={{ color: C.dim }}>Next: {sc.nextService.day} {sc.nextService.time || ''}</span>}
        </div>
        {sc.schedule && sc.schedule.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 11, color: C.muted }}>
            {sc.schedule.map((d, i) => (
              d.times && d.times.length > 0 ? <div key={i}><span style={{ color: C.white }}>{d.day}:</span> {d.times.join(', ')}</div> : null
            ))}
          </div>
        )}
      </div>

      {/* Chat Preview */}
      {chat.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Recent Chat ({chat.length})</div>
          <div style={{ maxHeight: 180, overflowY: 'auto', background: C.bg || '#09090B', border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {chat.map((m, i) => (
              <div key={i} style={{ fontSize: 12, lineHeight: 1.4 }}>
                <span style={{ fontWeight: 600, color: C.green, marginRight: 4 }}>{m.sender_name || m.source || 'System'}</span>
                <span style={{ color: C.muted }}>{m.message || m.text || ''}</span>
                <span style={{ fontSize: 10, color: C.dim, marginLeft: 6 }}>{fmtTime(m.timestamp || m.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
