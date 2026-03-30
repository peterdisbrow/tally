import { useState, useEffect } from 'react';
import { C, s, canWrite } from './adminStyles';
import OverviewPanel from './OverviewPanel';
import ChatPanel from './ChatPanel';
import TDsPanel from './TDsPanel';
import SchedulePanel from './SchedulePanel';
import SessionsPanel from './SessionsPanel';
import AutomationPanel from './AutomationPanel';
import BillingPanel from './BillingPanel';
import RoomsPanel from './RoomsPanel';

const DETAIL_TABS = [
  ['overview', 'Overview'],
  ['rooms', 'Rooms'],
  ['chat', 'Chat'],
  ['tds', 'TDs'],
  ['schedule', 'Schedule'],
  ['slack', 'Slack'],
  ['sessions', 'Sessions'],
  ['automation', 'Automation'],
  ['billing', 'Billing'],
];

export default function ChurchDetailModal({ church, api, role, onClose, onUpdate }) {
  const [detailTab, setDetailTab] = useState('overview');
  const [slackForm, setSlackForm] = useState({ webhookUrl: '', channel: '' });
  const [slackLoaded, setSlackLoaded] = useState(false);
  const [slackSaving, setSlackSaving] = useState(false);
  const [slackTesting, setSlackTesting] = useState(false);
  const [slackMsg, setSlackMsg] = useState({ type: '', text: '' });

  // Load current Slack config when modal opens
  useEffect(() => {
    if (!church?.churchId) return;
    (async () => {
      try {
        const data = await api(`/api/churches/${church.churchId}/slack`);
        setSlackForm({
          webhookUrl: data.webhookUrlFull || data.webhookUrl || '',
          channel: data.channel || '',
        });
      } catch {
        // No Slack config yet — that's fine, start blank
        setSlackForm({ webhookUrl: '', channel: '' });
      }
      setSlackLoaded(true);
    })();
  }, [church?.churchId, api]);

  async function saveSlack() {
    if (!slackForm.webhookUrl) {
      setSlackMsg({ type: 'err', text: 'Webhook URL is required.' });
      return;
    }
    setSlackSaving(true);
    setSlackMsg({ type: '', text: '' });
    try {
      await api(`/api/churches/${church.churchId}/slack`, {
        method: 'PUT',
        body: { webhookUrl: slackForm.webhookUrl, channel: slackForm.channel || undefined },
      });
      setSlackMsg({ type: 'ok', text: 'Slack webhook saved.' });
      if (onUpdate) onUpdate({ ...church, has_slack: true });
    } catch (e) {
      setSlackMsg({ type: 'err', text: e.message });
    } finally {
      setSlackSaving(false);
    }
  }

  async function removeSlack() {
    if (!confirm('Remove Slack integration for this church?')) return;
    setSlackSaving(true);
    setSlackMsg({ type: '', text: '' });
    try {
      await api(`/api/churches/${church.churchId}/slack`, { method: 'DELETE' });
      setSlackForm({ webhookUrl: '', channel: '' });
      setSlackMsg({ type: 'ok', text: 'Slack integration removed.' });
      if (onUpdate) onUpdate({ ...church, has_slack: false });
    } catch (e) {
      setSlackMsg({ type: 'err', text: e.message });
    } finally {
      setSlackSaving(false);
    }
  }

  async function testSlack() {
    setSlackTesting(true);
    setSlackMsg({ type: '', text: '' });
    try {
      await api(`/api/churches/${church.churchId}/slack/test`, { method: 'POST' });
      setSlackMsg({ type: 'ok', text: 'Test message sent to Slack!' });
    } catch (e) {
      setSlackMsg({ type: 'err', text: `Test failed: ${e.message}` });
    } finally {
      setSlackTesting(false);
    }
  }

  const statusColor = church.connected ? C.green : C.muted;
  const statusLabel = church.connected ? 'Online' : 'Offline';

  return (
    <div style={s.modal} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.wideModalBox} role="dialog" aria-modal="true" aria-labelledby="church-detail-title">
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div id="church-detail-title" style={{ fontSize: 18, fontWeight: 700 }}>{church.name}</div>
            <div style={{ fontSize: 12, color: C.muted, fontFamily: 'monospace', marginTop: 2 }}>{church.churchId}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <span style={s.badge(statusColor)}>{statusLabel}</span>
              <span style={s.badge(C.blue)}>{church.billing_tier || 'connect'}</span>
              <span style={s.badge(church.billing_status === 'active' || church.billing_status === 'trialing' ? C.green : C.yellow)}>{church.billing_status || 'inactive'}</span>
              {church.has_slack && <span style={s.badge(C.green)}>Slack</span>}
            </div>
          </div>
          <button style={{ ...s.btn('secondary'), padding: '6px 12px', fontSize: 12 }} onClick={onClose}>Close</button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, overflowX: 'auto', paddingBottom: 2 }}>
          {DETAIL_TABS.map(([id, label]) => (
            <button key={id} style={s.detailTab(detailTab === id)} onClick={() => setDetailTab(id)}>{label}</button>
          ))}
        </div>

        {/* Overview tab */}
        {detailTab === 'overview' && (
          <OverviewPanel churchId={church.churchId} api={api} />
        )}

        {/* Rooms tab */}
        {detailTab === 'rooms' && (
          <RoomsPanel churchId={church.churchId} api={api} />
        )}

        {/* Chat tab */}
        {detailTab === 'chat' && (
          <ChatPanel churchId={church.churchId} api={api} role={role} />
        )}

        {/* Slack tab */}
        {detailTab === 'slack' && (
          <div>
            <div style={s.section}>
              <div style={s.sectionTitle}>
                <span>Slack Alerts Configuration</span>
              </div>
              <div style={{ color: C.muted, fontSize: 12, marginBottom: 16 }}>
                Connect a Slack incoming webhook to receive real-time alerts for stream issues, equipment status, and auto-recoveries.
              </div>

              {!slackLoaded ? (
                <div style={{ color: C.muted, fontSize: 12, padding: '12px 0' }}>Loading Slack config...</div>
              ) : (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <label style={s.label}>Webhook URL *</label>
                    <input
                      style={s.input}
                      value={slackForm.webhookUrl}
                      onChange={e => setSlackForm(f => ({ ...f, webhookUrl: e.target.value }))}
                      placeholder="https://hooks.slack.com/services/T00000/B00000/XXXXXXXX"
                      disabled={!canWrite(role)}
                    />
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={s.label}>Channel Override (optional)</label>
                    <input
                      style={s.input}
                      value={slackForm.channel}
                      onChange={e => setSlackForm(f => ({ ...f, channel: e.target.value }))}
                      placeholder="#av-alerts"
                      disabled={!canWrite(role)}
                    />
                    <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>Leave blank to use the webhook default channel.</div>
                  </div>

                  {slackMsg.text && <div style={slackMsg.type === 'ok' ? s.ok : s.err}>{slackMsg.text}</div>}

                  {canWrite(role) && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                      <button
                        style={s.btn('primary')}
                        onClick={saveSlack}
                        disabled={slackSaving || !slackForm.webhookUrl}
                      >
                        {slackSaving ? 'Saving...' : 'Save Webhook'}
                      </button>
                      {slackForm.webhookUrl && (
                        <button
                          style={s.btn('secondary')}
                          onClick={testSlack}
                          disabled={slackTesting}
                        >
                          {slackTesting ? 'Sending...' : 'Send Test'}
                        </button>
                      )}
                      {church.has_slack && (
                        <button
                          style={s.btn('danger')}
                          onClick={removeSlack}
                          disabled={slackSaving}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* How-to guide */}
            <div style={s.section}>
              <div style={s.sectionTitle}>How to get a Slack webhook URL</div>
              <ol style={{ margin: 0, paddingLeft: 20, color: C.muted, fontSize: 12, lineHeight: 1.8 }}>
                <li>Go to <span style={{ color: C.white }}>api.slack.com/apps</span> and create a new app</li>
                <li>Enable <span style={{ color: C.white }}>Incoming Webhooks</span></li>
                <li>Click <span style={{ color: C.white }}>Add New Webhook to Workspace</span></li>
                <li>Select a channel and copy the webhook URL</li>
              </ol>
            </div>
          </div>
        )}

        {/* Sessions tab */}
        {detailTab === 'sessions' && (
          <SessionsPanel churchId={church.churchId} api={api} />
        )}

        {/* Automation tab */}
        {detailTab === 'automation' && (
          <AutomationPanel churchId={church.churchId} api={api} role={role} />
        )}

        {/* TDs tab */}
        {detailTab === 'tds' && (
          <TDsPanel churchId={church.churchId} api={api} role={role} />
        )}

        {/* Schedule tab */}
        {detailTab === 'schedule' && (
          <SchedulePanel churchId={church.churchId} api={api} role={role} />
        )}

        {/* Billing tab */}
        {detailTab === 'billing' && (
          <BillingPanel churchId={church.churchId} api={api} role={role} church={church} onUpdate={onUpdate} />
        )}
      </div>
    </div>
  );
}
