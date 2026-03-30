import { useState } from 'react';
import { C, s } from './adminStyles';

export default function OutreachTab({ api }) {
  const [messageType, setMessageType] = useState('introduction');
  const [prospectName, setProspectName] = useState('');
  const [churchName, setChurchName] = useState('');
  const [source, setSource] = useState('website');
  const [context, setContext] = useState('');
  const [output, setOutput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState('');

  const MESSAGE_TYPES = [
    { value: 'introduction', label: 'Introduction' },
    { value: 'follow_up', label: 'Follow Up' },
    { value: 'demo_invite', label: 'Demo Invite' },
    { value: 'onboarding', label: 'Onboarding' },
    { value: 'check_in', label: 'Check In' },
    { value: 'upgrade', label: 'Upgrade Pitch' },
    { value: 'reactivation', label: 'Reactivation' },
  ];

  const SOURCES = [
    { value: 'website', label: 'Website' },
    { value: 'referral', label: 'Referral' },
    { value: 'conference', label: 'Conference' },
    { value: 'social', label: 'Social Media' },
    { value: 'cold', label: 'Cold Outreach' },
    { value: 'other', label: 'Other' },
  ];

  async function generate() {
    if (!prospectName.trim() || !churchName.trim()) {
      setErr('Prospect name and church name are required');
      return;
    }
    setGenerating(true);
    setErr('');
    setOutput('');
    try {
      const data = await api('/api/admin/generate', {
        method: 'POST',
        body: {
          messageType,
          prospectName: prospectName.trim(),
          churchName: churchName.trim(),
          source,
          context: context.trim(),
        },
      });
      setOutput(data.message || '');
    } catch (e) {
      setErr(e.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  function copyOutput() {
    if (!output) return;
    navigator.clipboard.writeText(output).catch(() => {});
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Left: form */}
        <div style={s.card}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>Generate Outreach Message</div>

          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Message Type</label>
            <select style={s.input} value={messageType} onChange={e => setMessageType(e.target.value)}>
              {MESSAGE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Prospect Name *</label>
            <input
              style={s.input}
              value={prospectName}
              onChange={e => setProspectName(e.target.value)}
              placeholder="John Smith"
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Church Name *</label>
            <input
              style={s.input}
              value={churchName}
              onChange={e => setChurchName(e.target.value)}
              placeholder="Grace Community Church"
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Source</label>
            <select style={s.input} value={source} onChange={e => setSource(e.target.value)}>
              {SOURCES.map(src => <option key={src.value} value={src.value}>{src.label}</option>)}
            </select>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Additional Context</label>
            <textarea
              style={{ ...s.input, minHeight: 80 }}
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder="Any additional details about the prospect or conversation..."
            />
          </div>

          {err && <div style={s.err}>{err}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              style={s.btn('primary')}
              onClick={generate}
              disabled={generating}
            >
              {generating ? 'Generating...' : 'Generate Message'}
            </button>
          </div>
        </div>

        {/* Right: output */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Output</div>
            {output && (
              <button style={{ ...s.btn('secondary'), padding: '6px 12px', fontSize: 12 }} onClick={copyOutput}>
                Copy
              </button>
            )}
          </div>

          {output ? (
            <div style={{
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: 16,
              fontSize: 13,
              lineHeight: 1.7,
              color: C.white,
              whiteSpace: 'pre-wrap',
              minHeight: 200,
            }}>
              {output}
            </div>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minHeight: 200, color: C.muted, fontSize: 13,
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${C.border}`,
              borderRadius: 8,
            }}>
              {generating ? 'Generating...' : 'Fill out the form and click Generate'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
