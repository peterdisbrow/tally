import { C, s, NAV_GROUPS, ROLE_COLORS, ROLE_LABELS, tabsForRole } from './adminStyles';

export default function Sidebar({ tab, setTab, role, user, relayOk, relayErr, relayMeta, onSignOut, mobile = false, open = false, onClose }) {
  const availIds = new Set(tabsForRole(role).map(([id]) => id));
  const asideStyle = mobile
    ? {
      ...s.sidebar,
      width: 'min(86vw, 300px)',
      zIndex: 220,
      transform: open ? 'translateX(0)' : 'translateX(-110%)',
      transition: 'transform 0.18s ease',
      boxShadow: open ? '0 20px 45px rgba(0,0,0,0.45)' : 'none',
    }
    : s.sidebar;

  return (
    <>
      {mobile && open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            border: 'none',
            background: 'rgba(0,0,0,0.45)',
            zIndex: 210,
          }}
        />
      )}
      <aside style={asideStyle}>
        {/* Logo */}
        <div style={s.sidebarLogo}>
          {'\u26EA'} <span style={s.logoGreen}>Tally</span>{' '}
          <span style={{ color: C.muted, fontWeight: 400 }}>Admin</span>
        </div>

        {/* Relay status pill */}
        <div style={{ padding: '12px 20px 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.muted }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: relayOk === null ? C.muted : relayOk ? C.green : C.red,
            boxShadow: relayOk ? `0 0 6px ${C.green}` : 'none',
          }} />
          {relayOk === null ? 'Connecting\u2026' : relayOk ? 'Relay Live' : 'Relay Offline'}
        </div>

        {/* Nav groups */}
        <nav style={{ flex: 1, paddingTop: 4 }}>
          {NAV_GROUPS.map(group => {
            const visibleItems = group.items.filter(item => availIds.has(item.id));
            if (visibleItems.length === 0) return null;
            return (
              <div key={group.label}>
                <div style={s.sidebarSection}>{group.label}</div>
                {visibleItems.map(item => (
                  <button
                    key={item.id}
                    style={s.sidebarItem(tab === item.id)}
                    onClick={() => {
                      setTab(item.id);
                      if (mobile && onClose) onClose();
                    }}
                    onMouseEnter={e => {
                      if (tab !== item.id) {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                        e.currentTarget.style.color = C.white;
                      }
                    }}
                    onMouseLeave={e => {
                      if (tab !== item.id) {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = C.muted;
                      }
                    }}
                  >
                    <span style={{ fontSize: 15, width: 22, textAlign: 'center' }}>{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Footer — user info + sign out */}
        <div style={s.sidebarFooter}>
          {user && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.white, marginBottom: 3 }}>
                {user.name || user.email}
              </div>
              <span style={s.badge(ROLE_COLORS[role] || C.muted)}>
                {ROLE_LABELS[role] || role}
              </span>
            </div>
          )}
          <button
            style={{
              ...s.btn('secondary'),
              width: '100%', fontSize: 12, padding: '8px 0',
              textAlign: 'center',
            }}
            onClick={onSignOut}
          >
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}
