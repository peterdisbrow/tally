// ── Design tokens ──────────────────────────────────────────────────────────────
export const C = {
  bg:      '#09090B',
  surface: '#0F1613',
  border:  '#1a2e1f',
  green:   '#22c55e',
  greenLt: '#4ade80',
  white:   '#F8FAFC',
  muted:   '#94A3B8',
  dim:     '#475569',
  red:     '#ef4444',
  yellow:  '#f59e0b',
  blue:    '#3b82f6',
};

export const PLAN_OPTIONS = ['connect', 'plus', 'pro', 'managed', 'event'];
export const PLAN_STATUS_OPTIONS = ['active', 'trialing', 'inactive', 'pending', 'past_due', 'canceled', 'trial_expired'];

export const ENCODER_TYPE_NAMES = {
  obs: 'OBS',
  vmix: 'vMix',
  ecamm: 'Ecamm',
  blackmagic: 'Blackmagic',
  aja: 'AJA HELO',
  epiphan: 'Epiphan',
  teradek: 'Teradek',
  yolobox: 'YoloBox',
  'youtube-live': 'YouTube Live',
  'facebook-live': 'Facebook Live',
  'vimeo-live': 'Vimeo Live',
  'tally-encoder': 'Tally Encoder',
  custom: 'Custom',
  'custom-rtmp': 'Custom RTMP',
  'rtmp-generic': 'RTMP',
};

// ── Sidebar nav groups ───────────────────────────────────────────────────────
export const NAV_GROUPS = [
  {
    label: 'Accounts',
    items: [
      { id: 'churches',  icon: '\u26EA', label: 'Churches' },
      { id: 'resellers', icon: '\uD83C\uDFE2', label: 'Resellers' },
      { id: 'users',     icon: '\uD83D\uDC64', label: 'Users' },
      { id: 'rooms',     icon: '\uD83D\uDEAA', label: 'Rooms' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { id: 'alerts',  icon: '\uD83D\uDD14', label: 'Alerts' },
      { id: 'tickets', icon: '\uD83C\uDFAB', label: 'Tickets' },
      { id: 'emails',  icon: '\uD83D\uDCE7', label: 'Emails' },
      { id: 'streams', icon: '\uD83C\uDFA5', label: 'Stream Preview' },
      { id: 'monitor', icon: '\uD83D\uDCE1', label: 'Monitor' },
      { id: 'status',  icon: '\uD83D\uDCCA', label: 'Status' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { id: 'aiusage', icon: '\uD83E\uDD16', label: 'AI Usage' },
    ],
  },
  {
    label: 'Growth',
    items: [
      { id: 'outreach', icon: '\uD83D\uDCEC', label: 'Outreach' },
    ],
  },
];

// ── Label lookup for active tab title ────────────────────────────────────────
export const TAB_LABELS = Object.fromEntries(
  NAV_GROUPS.flatMap(g => g.items.map(i => [i.id, i.label]))
);

export const SIDEBAR_W = 240;

export const s = {
  page:    { minHeight: '100vh', background: C.bg, color: C.white, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", fontSize: 14, overflowX: 'hidden' },
  header:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 28px', borderBottom: `1px solid ${C.border}`, background: C.surface, position: 'sticky', top: 0, zIndex: 10 },
  logo:    { fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px', color: C.white },
  logoGreen: { color: C.green },
  main:    { padding: '28px', maxWidth: 1200, margin: '0 auto' },

  // ── Sidebar layout ──
  sidebar: {
    position: 'fixed', top: 0, left: 0, bottom: 0, width: SIDEBAR_W,
    background: C.surface, borderRight: `1px solid ${C.border}`,
    display: 'flex', flexDirection: 'column', zIndex: 20,
    overflowY: 'auto', overflowX: 'hidden',
  },
  sidebarLogo: {
    padding: '20px 20px 16px', fontSize: 18, fontWeight: 700,
    letterSpacing: '-0.3px', color: C.white,
    borderBottom: `1px solid ${C.border}`,
  },
  sidebarSection: {
    fontSize: 10, fontWeight: 700, color: C.dim, textTransform: 'uppercase',
    letterSpacing: '0.08em', padding: '18px 20px 6px',
  },
  sidebarItem: (active) => ({
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 20px', fontSize: 13, fontWeight: 500,
    color: active ? C.green : C.muted,
    background: active ? 'rgba(34,197,94,0.08)' : 'transparent',
    border: 'none',
    borderLeft: `3px solid ${active ? C.green : 'transparent'}`,
    cursor: 'pointer', transition: 'all 0.15s',
    width: '100%', textAlign: 'left', fontFamily: 'inherit',
  }),
  sidebarFooter: {
    marginTop: 'auto', padding: '16px 20px',
    borderTop: `1px solid ${C.border}`,
  },
  topBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 28px', borderBottom: `1px solid ${C.border}`,
    background: C.surface, position: 'sticky', top: 0, zIndex: 10,
    marginLeft: SIDEBAR_W,
  },
  contentArea: {
    marginLeft: SIDEBAR_W, padding: '28px', maxWidth: 1200,
  },
  card:    { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 16, overflowX: 'auto' },
  tabBar:  { display: 'flex', gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 24 },
  tab:     (active) => ({ background: 'none', border: 'none', color: active ? C.green : C.muted, fontSize: 13, fontWeight: 600, padding: '10px 16px', cursor: 'pointer', borderBottom: `2px solid ${active ? C.green : 'transparent'}`, marginBottom: -1, transition: 'all 0.15s', whiteSpace: 'nowrap' }),
  btn:     (variant = 'primary') => ({
    background: variant === 'primary' ? C.green : variant === 'danger' ? C.red : 'rgba(255,255,255,0.08)',
    color: variant === 'primary' ? '#000' : C.white,
    border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', transition: 'opacity 0.15s',
  }),
  input:   { width: '100%', background: 'rgba(255,255,255,0.04)', border: `1px solid ${C.border}`, borderRadius: 8, color: C.white, fontSize: 13, padding: '9px 12px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  label:   { display: 'block', fontSize: 11, color: C.muted, marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  table:   { width: '100%', minWidth: 760, borderCollapse: 'collapse', fontSize: 13 },
  th:      { textAlign: 'left', padding: '8px 12px', color: C.muted, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: `1px solid ${C.border}` },
  td:      { padding: '10px 12px', borderBottom: `1px solid rgba(26,46,31,0.5)`, verticalAlign: 'middle' },
  badge:   (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: `${color}20`, color }),
  modal:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500 },
  modalBox:{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28, width: 420, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' },
  wideModalBox: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28, width: 640, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' },
  detailTab: (active) => ({ background: active ? 'rgba(34,197,94,0.12)' : 'none', border: active ? `1px solid rgba(34,197,94,0.3)` : '1px solid transparent', color: active ? C.green : C.muted, fontSize: 12, fontWeight: 600, padding: '6px 14px', cursor: 'pointer', borderRadius: 6, transition: 'all 0.15s', whiteSpace: 'nowrap' }),
  err:     { color: C.red, fontSize: 12, marginTop: 8 },
  ok:      { color: C.green, fontSize: 12, marginTop: 8 },
  empty:   { textAlign: 'center', color: C.muted, padding: '40px 20px', fontSize: 13 },
  statCard:{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 20px', flex: 1, minWidth: 110 },
  statVal: { fontSize: 28, fontWeight: 700, color: C.green, marginTop: 4 },
  statLbl: { fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em' },
  section: { background: 'rgba(255,255,255,0.02)', border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 13, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 },
};

// ── Role helpers ──────────────────────────────────────────────────────────────

export const ROLE_COLORS = { super_admin: C.red, admin: C.blue, engineer: C.yellow, sales: C.green };
export const ROLE_LABELS = { super_admin: 'Super Admin', admin: 'Admin', engineer: 'Engineer', sales: 'Sales' };
export const canWrite = (role) => ['super_admin', 'admin'].includes(role);
export const canManageUsers = (role) => role === 'super_admin';

export function normalizeEncoderType(type) {
  return String(type || '').trim().toLowerCase();
}

export function getEncoderNameFromStatus(status = {}) {
  const type = normalizeEncoderType(status?.encoder?.type);
  if (type && ENCODER_TYPE_NAMES[type]) return ENCODER_TYPE_NAMES[type];
  if (type) return type.toUpperCase();
  if (status?.obs) return 'OBS';
  return 'Encoder';
}

export function getEncoderConnectedFromStatus(status = {}) {
  const enc = status?.encoder || {};
  const hasSelectedEncoder = !!normalizeEncoderType(enc.type);
  if (typeof enc.connected === 'boolean') return enc.connected;
  if (hasSelectedEncoder) return false;
  return !!status?.obs?.connected;
}

export function getEncoderLiveFromStatus(status = {}) {
  const enc = status?.encoder || {};
  const encType = normalizeEncoderType(enc.type);
  if (typeof enc.live === 'boolean') return enc.live;
  if (!encType || encType === 'obs') return !!status?.obs?.streaming;
  return false;
}

export function tabsForRole(role) {
  switch (role) {
    case 'super_admin': return [['churches', '\u26EA Churches'], ['resellers', '\uD83C\uDFE2 Resellers'], ['users', '\uD83D\uDC64 Users'], ['rooms', '\uD83D\uDEAA Rooms'], ['aiusage', '\uD83E\uDD16 AI Usage'], ['alerts', '\uD83D\uDD14 Alerts'], ['tickets', '\uD83C\uDFAB Tickets'], ['emails', '\uD83D\uDCE7 Emails'], ['streams', '\uD83C\uDFA5 Stream Preview'], ['monitor', '\uD83D\uDCE1 Monitor'], ['status', '\uD83D\uDCCA Status'], ['outreach', '\uD83D\uDCEC Outreach']];
    case 'admin':       return [['churches', '\u26EA Churches'], ['resellers', '\uD83C\uDFE2 Resellers'], ['rooms', '\uD83D\uDEAA Rooms'], ['aiusage', '\uD83E\uDD16 AI Usage'], ['alerts', '\uD83D\uDD14 Alerts'], ['tickets', '\uD83C\uDFAB Tickets'], ['emails', '\uD83D\uDCE7 Emails'], ['streams', '\uD83C\uDFA5 Stream Preview'], ['monitor', '\uD83D\uDCE1 Monitor'], ['status', '\uD83D\uDCCA Status'], ['outreach', '\uD83D\uDCEC Outreach']];
    case 'engineer':    return [['churches', '\u26EA Churches'], ['rooms', '\uD83D\uDEAA Rooms'], ['alerts', '\uD83D\uDD14 Alerts'], ['streams', '\uD83C\uDFA5 Stream Preview'], ['monitor', '\uD83D\uDCE1 Monitor'], ['status', '\uD83D\uDCCA Status']];
    case 'sales':       return [['churches', '\u26EA Churches'], ['resellers', '\uD83C\uDFE2 Resellers'], ['outreach', '\uD83D\uDCEC Outreach']];
    default:            return [['churches', '\u26EA Churches']];
  }
}

export const TRIGGER_TYPES = [
  { value: 'propresenter_slide_change', label: 'ProPresenter Slide Change' },
  { value: 'schedule_timer', label: 'Schedule Timer (minutes into service)' },
  { value: 'equipment_state_match', label: 'Equipment State Match' },
];
