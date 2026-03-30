import { useState, useRef, useEffect, useCallback } from 'react';
import { C } from './adminStyles';

export default function AIChatDrawer({ api }) {
  const [open, setOpen]         = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [sending, setSending]   = useState(false);
  const [churchStates, setChurchStates] = useState(null);
  const messagesEndRef = useRef(null);

  // Fetch church states when drawer opens (for AI context)
  useEffect(() => {
    if (!open || churchStates) return;
    api('/api/churches').then(data => {
      if (Array.isArray(data)) {
        const map = {};
        data.forEach(c => { map[c.churchId] = c; });
        setChurchStates(map);
      } else {
        setChurchStates(data || {});
      }
    }).catch(() => setChurchStates({}));
  }, [open, churchStates, api]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    if (mq.addEventListener) {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(async () => {
    const msg = input.trim();
    if (!msg || sending) return;

    setInput('');
    const userMsg = { role: 'user', content: msg };
    setMessages(prev => [...prev, userMsg]);
    setSending(true);

    try {
      // Build history (last 20 messages)
      const history = [...messages, userMsg].slice(-20).map(m => ({ role: m.role, content: m.content }));
      const res = await api('/api/admin/chat', {
        method: 'POST',
        body: { message: msg, history, churchStates: churchStates || {} },
      });
      const reply = res.reply || res.error || 'No response.';
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, messages, api, churchStates]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      {/* Floating action button */}
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          position: 'fixed', bottom: isMobile ? 12 : 24, right: isMobile ? 12 : 28, width: 52, height: 52,
          borderRadius: '50%', background: open ? C.muted : C.green, color: open ? C.white : '#000',
          border: 'none', fontSize: 22, cursor: 'pointer', zIndex: 101,
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.2s',
        }}
        title="Tally AI"
      >
        {open ? '\u00D7' : 'AI'}
      </button>

      {/* Chat drawer */}
      {open && (
        <div style={{
          position: 'fixed',
          bottom: isMobile ? 72 : 86,
          right: isMobile ? 8 : 28,
          width: isMobile ? 'calc(100vw - 16px)' : 380,
          maxWidth: isMobile ? 'none' : 420,
          maxHeight: isMobile ? '70vh' : '60vh',
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 100,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            padding: '14px 16px', borderBottom: `1px solid ${C.border}`,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Tally AI</div>
              <div style={{ fontSize: 10, color: C.muted }}>Church AV assistant</div>
            </div>
          </div>

          {/* Messages */}
          <div style={{
            flex: 1, overflow: 'auto', padding: '12px 14px',
            display: 'flex', flexDirection: 'column', gap: 10,
            minHeight: 200, maxHeight: isMobile ? 'calc(70vh - 130px)' : 'calc(60vh - 130px)',
          }}>
            {messages.length === 0 && (
              <div style={{ color: C.muted, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>
                Ask me anything about your churches.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
              }}>
                <div style={{
                  background: m.role === 'user' ? 'rgba(34,197,94,0.15)' : C.bg,
                  border: `1px solid ${m.role === 'user' ? 'rgba(34,197,94,0.3)' : C.border}`,
                  borderRadius: 10, padding: '8px 12px', fontSize: 13,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {m.content}
                </div>
                <div style={{ fontSize: 9, color: C.dim, marginTop: 2, textAlign: m.role === 'user' ? 'right' : 'left' }}>
                  {m.role === 'user' ? 'You' : 'Tally AI'}
                </div>
              </div>
            ))}
            {sending && (
              <div style={{ alignSelf: 'flex-start', color: C.green, fontSize: 12, padding: '4px 0' }}>
                Thinking\u2026
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{
            padding: '10px 14px', borderTop: `1px solid ${C.border}`,
            display: 'flex', gap: 8,
          }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about status, alerts, fixes\u2026"
              rows={1}
              style={{
                flex: 1, background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: 8, padding: '8px 10px', color: C.white,
                fontSize: 13, resize: 'none', outline: 'none',
                fontFamily: 'inherit', maxHeight: 80,
              }}
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              style={{
                background: C.green, color: '#000', border: 'none',
                borderRadius: 8, padding: '8px 14px', fontSize: 13,
                fontWeight: 600, cursor: sending ? 'not-allowed' : 'pointer',
                opacity: (sending || !input.trim()) ? 0.5 : 1,
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
