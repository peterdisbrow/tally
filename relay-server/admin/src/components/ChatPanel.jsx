import { useState, useEffect, useCallback, useRef } from 'react';
import { C, s, canWrite } from './adminStyles';

export default function ChatPanel({ churchId, api, role }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const lastTimestamp = useRef(null);
  const scrollRef = useRef(null);
  const pollRef = useRef(null);

  const scrollToBottom = () => setTimeout(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, 50);

  const loadMessages = useCallback(async () => {
    try {
      const data = await api(`/api/churches/${churchId}/chat?limit=50`);
      if (data?.messages) {
        setMessages(data.messages);
        if (data.messages.length > 0) lastTimestamp.current = data.messages[data.messages.length - 1].timestamp;
        // Instant scroll (no animation delay) so user sees newest messages first
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      }
    } catch {}
  }, [churchId, api]);

  useEffect(() => {
    loadMessages();
    const poll = async () => {
      if (!lastTimestamp.current) return;
      try {
        const data = await api(`/api/churches/${churchId}/chat?since=${encodeURIComponent(lastTimestamp.current)}`);
        if (data?.messages?.length > 0) {
          setMessages(prev => [...prev, ...data.messages]);
          lastTimestamp.current = data.messages[data.messages.length - 1].timestamp;
          scrollToBottom();
        }
      } catch {}
    };
    pollRef.current = setInterval(poll, 4000);
    return () => clearInterval(pollRef.current);
  }, [churchId, api, loadMessages]);

  const send = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      const data = await api(`/api/churches/${churchId}/chat`, { method: 'POST', body: { message: input.trim() } });
      if (data?.id) {
        setMessages(prev => [...prev, data]);
        lastTimestamp.current = data.timestamp;
        setInput('');
        scrollToBottom();
      }
    } catch {}
    setSending(false);
  };

  const sourceIcon = { telegram: '\uD83D\uDCF1', app: '\uD83D\uDCBB', dashboard: '\uD83C\uDF10' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: 12 }}>
        {messages.length === 0 && (
          <div style={{ color: C.muted, fontSize: 12, textAlign: 'center', padding: 40 }}>
            No messages yet. Start a conversation.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id || i} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: C.dim, fontFamily: 'monospace' }}>
              {sourceIcon[m.source] || '\uD83D\uDCAC'}{' '}
              <span style={{ color: m.sender_role === 'admin' ? C.green : C.white, fontWeight: 600 }}>
                {m.sender_name}
              </span>
              <span style={{ marginLeft: 8 }}>
                {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div style={{ fontSize: 13, color: C.white, marginTop: 2, lineHeight: 1.5, paddingLeft: 2 }}>
              {m.message}
            </div>
          </div>
        ))}
      </div>
      {canWrite(role) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            style={{ ...s.input, flex: 1 }}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Type a message..."
            onKeyDown={e => { if (e.key === 'Enter') send(); }}
          />
          <button style={s.btn('primary')} onClick={send} disabled={sending || !input.trim()}>
            {sending ? '...' : 'Send'}
          </button>
        </div>
      )}
    </div>
  );
}
