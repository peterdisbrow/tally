import { useState, useEffect, useCallback, useMemo } from 'react';
import { C, s, TAB_LABELS, canWrite, tabsForRole } from './components/adminStyles';
import { createApi } from './api';
import LoginScreen from './components/LoginScreen';
import Sidebar from './components/Sidebar';
import ChurchesTab from './components/ChurchesTab';
import ResellersTab from './components/ResellersTab';
import UsersTab from './components/UsersTab';
import AIUsageTab from './components/AIUsageTab';
import AlertsTab from './components/AlertsTab';
import TicketsTab from './components/TicketsTab';
import EmailsTab from './components/EmailsTab';
import MonitorTab from './components/MonitorTab';
import StatusTab from './components/StatusTab';
import OutreachTab from './components/OutreachTab';
import StreamsTab from './components/StreamsTab';
import AIChatDrawer from './components/AIChatDrawer';

export default function AdminPage() {
  const [token, setToken]   = useState(null);
  const [user, setUser]     = useState(null);
  const [tab, setTab]       = useState('churches');
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [relayOk, setRelayOk] = useState(null);
  const [relayErr, setRelayErr] = useState('');
  const [relayMeta, setRelayMeta] = useState('');
  const [showDiag, setShowDiag] = useState(false);

  const api = useMemo(() => createApi(() => token), [token]);

  const role = user?.role || 'admin';

  // Restore session from sessionStorage
  useEffect(() => {
    const savedToken = sessionStorage.getItem('tally_admin_token');
    const savedUser  = sessionStorage.getItem('tally_admin_user');
    if (savedToken) {
      setToken(savedToken);
    }
    if (savedUser) {
      try { setUser(JSON.parse(savedUser)); } catch {}
    }
  }, []);

  // Mobile breakpoint tracking
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 960px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    if (mq.addEventListener) {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  function handleLogin(newToken, newUser) {
    setToken(newToken);
    setUser(newUser);
  }

  function signOut() {
    sessionStorage.removeItem('tally_admin_token');
    sessionStorage.removeItem('tally_admin_user');
    setToken(null);    setUser(null);
    setRelayOk(null);
    setRelayErr('');
    setRelayMeta('');
    setShowDiag(false);
  }

  // Validate session and fetch latest user profile on mount
  useEffect(() => {
    if (!token) return;

    async function check() {
      try {
        // Fetch user profile to validate JWT + get latest role
        const profile = await api('/api/admin/me');
        if (profile?.user) {
          setUser(profile.user);
          sessionStorage.setItem('tally_admin_user', JSON.stringify(profile.user));
        }

        // Also check relay health
        const body = await api('/api/health');
        setRelayOk(true);
        setRelayErr('');
        setRelayMeta(`${body?.service || 'tally-relay'} \u2022 ${body?.registeredChurches != null ? `${body.registeredChurches} churches` : ''}`);
      } catch (err) {
        if (err.message === 'Token expired' || err.message === 'Account deactivated or not found') {
          signOut();
          return;
        }
        setRelayOk(false);
        setRelayErr(String(err.message || err));
        setRelayMeta('');
      }
    }

    check();
  }, [token, api]);

  // If current tab becomes unavailable for the user's role, reset to churches
  const availTabs = tabsForRole(role);
  useEffect(() => {
    if (!availTabs.find(([id]) => id === tab)) {
      setTab('churches');
    }
  }, [role, tab, availTabs]);

  // Close the mobile drawer when switching tabs.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [tab, isMobile]);

  useEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

  if (!token) return <LoginScreen onLogin={handleLogin} />;

  return (
    <div style={s.page}>
      {/* ── Sidebar ── */}
      <Sidebar
        tab={tab}
        setTab={setTab}
        role={role}
        user={user}
        relayOk={relayOk}
        relayErr={relayErr}
        relayMeta={relayMeta}
        onSignOut={signOut}
        mobile={isMobile}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* ── Top bar ── */}
      <div
        style={{
          ...s.topBar,
          marginLeft: isMobile ? 0 : s.topBar.marginLeft,
          padding: isMobile ? '12px 12px' : s.topBar.padding,
          gap: 10,
          flexWrap: isMobile ? 'wrap' : 'nowrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {isMobile && (
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
              style={{
                ...s.btn('secondary'),
                padding: '6px 10px',
                fontSize: 14,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              {sidebarOpen ? '\u00D7' : '\u2630'}
            </button>
          )}
          <div style={{ fontSize: isMobile ? 15 : 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {TAB_LABELS[tab] || 'Churches'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted, minWidth: 0 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: relayOk === null ? C.muted : relayOk ? C.green : C.red,
              boxShadow: relayOk ? `0 0 6px ${C.green}` : 'none',
            }} />
            <span style={{ whiteSpace: isMobile ? 'normal' : 'nowrap' }}>
              {relayOk === null
                ? 'Connecting\u2026'
                : relayOk
                  ? `Relay Live${relayMeta ? ` \u2022 ${relayMeta}` : ''}`
                  : `Relay Offline${relayErr ? ' \u2014 ' + relayErr : ''}`}
            </span>
          </div>
          {((!relayOk && relayErr) || showDiag) && (
            <button
              style={{ ...s.btn('secondary'), fontSize: 11, padding: '5px 10px' }}
              onClick={() => setShowDiag((v) => !v)}
            >
              {showDiag ? 'Hide' : 'Show'} details
            </button>
          )}
        </div>
      </div>

      {/* ── Content area ── */}
      <div
        style={{
          ...s.contentArea,
          marginLeft: isMobile ? 0 : s.contentArea.marginLeft,
          padding: isMobile ? '12px 12px 90px' : s.contentArea.padding,
          maxWidth: isMobile ? '100%' : s.contentArea.maxWidth,
        }}
      >
        <div style={{ ...s.card, marginBottom: 16, background: '#0d1017', borderColor: '#1d2e24' }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Tally operations dashboard</div>
          <div style={{ color: C.muted, fontSize: 12 }}>
            {canWrite(role)
              ? 'Manage churches, control relay registration, and onboard TDs.'
              : role === 'engineer'
                ? 'Monitor church connections, status, and system health.'
                : 'View churches and reseller accounts.'}
          </div>
        </div>

        {showDiag && (
          <div style={{ ...s.card, marginBottom: 16, background: '#0d1017' }}>
            <div style={{ fontSize: 12, color: C.muted }}>Diagnostics</div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0, color: C.yellow }}>{relayErr || 'No issues detected.'}</pre>
          </div>
        )}

        {tab === 'churches'  && <ChurchesTab  api={api} role={role} />}
        {tab === 'resellers' && <ResellersTab api={api} role={role} />}
        {tab === 'users'     && <UsersTab api={api} />}
        {tab === 'aiusage'   && <AIUsageTab api={api} />}
        {tab === 'alerts'    && <AlertsTab api={api} role={role} />}
        {tab === 'tickets'   && <TicketsTab api={api} role={role} />}
        {tab === 'emails'    && <EmailsTab api={api} role={role} />}
        {tab === 'monitor'   && <MonitorTab token={token} />}
        {tab === 'streams'   && <StreamsTab api={api} />}
        {tab === 'status'    && <StatusTab api={api} role={role} />}
        {tab === 'outreach'  && <OutreachTab api={api} />}
      </div>

      <AIChatDrawer api={api} />
    </div>
  );
}
