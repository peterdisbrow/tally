/**
 * Church Portal — self-service management for individual churches
 *
 * Routes:
 *   GET  /church-login                   login page
 *   POST /api/church/login               validate → JWT cookie → redirect
 *   POST /api/church/logout              clear cookie
 *   GET  /church-portal                  portal HTML (cookie auth)
 *
 *   GET  /api/church/me                  church profile
 *   PUT  /api/church/me                  update email, phone, notification prefs
 *   GET  /api/church/rooms               list rooms
 *   POST /api/church/rooms               create room
 *   PATCH /api/church/rooms/:roomId      update room
 *   DELETE /api/church/rooms/:roomId     delete room
 *   GET  /api/church/schedule            service schedule
 *   PUT  /api/church/schedule            update schedule
 *   GET  /api/church/tds                 tech directors list
 *   POST /api/church/tds                 add TD
 *   DELETE /api/church/tds/:tdId         remove TD
 *   PUT  /api/church/tds/:tdId/access-level   set access level
 *   PUT  /api/church/tds/:tdId/portal-access  toggle portal login
 *   POST /api/church/tds/:tdId/set-password   admin sets TD password
 *   POST /api/td/change-password              TD changes own password
 *   GET  /api/church/sessions            recent sessions
 *   GET  /api/church/guest-tokens        list guest tokens
 *   POST /api/church/guest-tokens        generate token
 *   DELETE /api/church/guest-tokens/:tok revoke token
 *
 * Admin helper routes (requireAdmin):
 *   POST /api/churches/:churchId/portal-credentials  { email, password }
 */

const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { createLogger } = require('./logger');
const { hasOpenSocket, getSocketForInstance } = require('./runtimeSockets');
const { SqliteQueryClient } = require('./db/queryClient');
const {
  buildNonTestSessionClauseSync,
  buildNonTestSessionClause,
  buildTestSessionPredicate,
  ensureColumn,
} = require('./schemaCompat');
const log = createLogger('portal');
const { hashPassword, verifyPassword, generateRegistrationCode: _genRegCode } = require('./auth');
const { createRateLimit } = require('./rateLimit');
const { isStreamActive, isRecordingActive } = require('./status-utils');
const { escapeHtml } = require('./escapeHtml');
const { generateCsrfToken, setCsrfCookie } = require('./csrf');

function safeErrorMessage(err, fallback = 'Internal server error') {
  if (process.env.NODE_ENV === 'production') return fallback;
  return err?.message || fallback;
}

function friendlyInputName(input) {
  if (input == null) return '';
  const n = Number(input);
  if (n >= 1 && n <= 40) return `Cam ${n}`;
  if (n >= 1000 && n < 2000) return 'Color Bars';
  if (n === 2001) return 'Color 1';
  if (n === 2002) return 'Color 2';
  if (n === 3010) return 'MP1';
  if (n === 3011) return 'MP1 Key';
  if (n === 3020) return 'MP2';
  if (n === 3021) return 'MP2 Key';
  if (n === 6000) return 'Super Source';
  if (n === 7001) return 'Clean Feed 1';
  if (n === 7002) return 'Clean Feed 2';
  if (n === 10010) return 'ME 1 PGM';
  if (n === 10011) return 'ME 1 PVW';
  return `${n}`;
}

/**
 * Resolve the room instance for this request.
 *
 * Priority:
 *  1. req.tdRoomId — TD is locked to a specific room via their JWT
 *  2. ?roomId= query param — explicit room filter from the frontend
 *
 * Returns null if no room filter, or the instance name (undefined if room is offline).
 */
function resolveRoomInstance(req, churches) {
  const roomId = req.tdRoomId || req.query.roomId;
  if (!roomId) return null; // no room filter — return all
  const runtime = churches.get(req.church.churchId);
  return runtime?.roomInstanceMap?.[roomId] || undefined; // undefined = room offline
}

/**
 * Get the effective roomId for this request (TD-scoped or query param).
 */
function getEffectiveRoomId(req) {
  return req.tdRoomId || req.query.roomId || null;
}

function getRequestedRoomContext(req, churches) {
  const roomId = getEffectiveRoomId(req);
  return {
    roomId,
    instanceName: resolveRoomInstance(req, churches),
  };
}

/**
 * Filter pre-service check items by room_equipment config.
 * Same denylist approach as the portal status filtering: remove checks for
 * equipment types that are NOT configured for this room.
 * Also converts the Camera Inputs "0/0" check to a warning (known ATEM limitation).
 */
async function filterChecksByRoomEquipment(checks, roomId, churchId, querySource) {
  if (!Array.isArray(checks)) return checks;

  // Camera Inputs "0/0" is a known false-positive — convert to warning/pass
  checks = checks.map(c => {
    if (/camera\s*inputs/i.test(c.name) && /0\/0/i.test(c.detail)) {
      return { ...c, pass: true, detail: c.detail + ' (informational — ATEM camera detection is limited)' };
    }
    return c;
  });

  if (!roomId || !querySource) return checks;
  try {
    const eqRow = querySource.queryOne
      ? await querySource.queryOne('SELECT equipment FROM room_equipment WHERE room_id = ? AND church_id = ?', [roomId, churchId])
      : querySource.prepare('SELECT equipment FROM room_equipment WHERE room_id = ? AND church_id = ?').get(roomId, churchId);
    if (!eqRow) return checks; // no config = show all
    const eq = JSON.parse(eqRow.equipment);

    return checks.filter(c => {
      const n = c.name.toLowerCase();
      if (n.includes('atem') || n.includes('switcher'))                     return !!eq.atemIp;
      if (n.includes('obs'))                                                return !!eq.obsUrl;
      if (n.includes('vmix'))                                               return !!eq.vmix?.host;
      if (n.includes('audio') || n.includes('mixer') || n.includes('console') || n === 'main output')
                                                                            return !!(eq.mixer?.type || eq.mixer?.host);
      if (n.includes('propresenter'))                                       return !!eq.proPresenter?.host;
      if (n.includes('resolume'))                                           return !!eq.resolume?.host;
      if (n.includes('encoder'))                                            return !!(eq.encoderType || eq.encoderHost);
      if (n.includes('companion'))                                          return !!eq.companionUrl;
      if (n.includes('camera') || n.includes('input'))                      return !!(eq.ptz?.length);
      if (n.includes('hyperdeck'))                                          return !!(eq.hyperdecks?.length);
      if (n.includes('videohub'))                                           return !!(eq.videoHubs?.length);
      return true; // unknown check type — keep it
    });
  } catch { return checks; }
}

// ─── JWT helpers ───────────────────────────────────────────────────────────────

function issueChurchToken(churchId, jwtSecret) {
  return jwt.sign({ type: 'church_portal', churchId }, jwtSecret, { expiresIn: '7d' });
}

function issueTdToken(tdId, churchId, accessLevel, jwtSecret, roomId) {
  const payload = { type: 'td_portal', tdId, churchId, accessLevel };
  if (roomId) payload.roomId = roomId;
  return jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
}

function generateRegistrationCode(db) {
  return _genRegCode(db);
}

/**
 * Original church-admin-only middleware. Still used internally; most routes
 * now use requirePortalAuth (admin OR TD) or requireAdminAuth (admin only).
 */
function requireChurchPortalAuth(db, jwtSecret, queryClient = null) {
  const client = queryClient || db;
  const normalizeChurchRow = (row) => {
    if (!row) return null;
    if (row.churchid !== undefined && row.churchId === undefined) {
      row.churchId = row.churchid;
    }
    return row;
  };
  return async (req, res, next) => {
    const token = req.cookies?.tally_church_session;
    if (!token) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
      return res.redirect('/church-login');
    }
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.type !== 'church_portal') throw new Error('wrong type');
      const church = client.queryOne
        ? await client.queryOne('SELECT * FROM churches WHERE churchId = ?', [payload.churchId])
        : client.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
      if (!church) throw new Error('church not found');
      req.church = normalizeChurchRow(church);
      next();
    } catch {
      res.clearCookie('tally_church_session');
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
      return res.redirect('/church-login');
    }
  };
}

/**
 * Accepts EITHER a church admin JWT OR a TD JWT (cookie-based).
 * Sets req.church always; sets req.td + req.tdAccessLevel for TD sessions.
 */
function requirePortalAuth(db, jwtSecret, queryClient = null) {
  const client = queryClient || db;
  const normalizeChurchRow = (row) => {
    if (!row) return null;
    if (row.churchid !== undefined && row.churchId === undefined) {
      row.churchId = row.churchid;
    }
    return row;
  };
  return async (req, res, next) => {
    // Accept token from cookie (portal) or Authorization: Bearer header (mobile app)
    let token = req.cookies?.tally_church_session;
    let fromBearer = false;
    if (!token) {
      const authHeader = req.headers.authorization || '';
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
        fromBearer = true;
      }
    }
    if (!token) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
      return res.redirect('/church-login');
    }
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.type === 'church_portal') {
        const church = client.queryOne
          ? await client.queryOne('SELECT * FROM churches WHERE churchId = ?', [payload.churchId])
          : client.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
        if (!church) throw new Error('church not found');
        req.church = normalizeChurchRow(church);
        return next();
      }
      if (payload.type === 'td_portal') {
        const td = client.queryOne
          ? await client.queryOne('SELECT * FROM church_tds WHERE id = ? AND church_id = ?', [payload.tdId, payload.churchId])
          : client.prepare('SELECT * FROM church_tds WHERE id = ? AND church_id = ?').get(payload.tdId, payload.churchId);
        if (!td || !td.portal_enabled) throw new Error('td not found or disabled');
        const church = client.queryOne
          ? await client.queryOne('SELECT * FROM churches WHERE churchId = ?', [payload.churchId])
          : client.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
        if (!church) throw new Error('church not found');
        req.church = normalizeChurchRow(church);
        req.td = td;
        req.tdAccessLevel = td.access_level || 'operator';
        // Room scoping: if the token carries a roomId, lock this session to that room
        if (payload.roomId) {
          req.tdRoomId = payload.roomId;
        }
        return next();
      }
      // Mobile app tokens (from /api/church/mobile/login)
      if (payload.type === 'church_app') {
        // Primary lookup by churchId from JWT. If churchId is null (tokens issued
        // during the Postgres cutover bug window had churchId omitted), fall back
        // to the name field which is also signed in the JWT and is unique.
        let church = null;
        if (payload.churchId) {
          church = client.queryOne
            ? await client.queryOne('SELECT *, churchId AS "churchId" FROM churches WHERE churchId = ?', [payload.churchId])
            : client.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
        }
        if (!church && payload.name) {
          church = client.queryOne
            ? await client.queryOne('SELECT *, churchId AS "churchId" FROM churches WHERE name = ?', [payload.name])
            : client.prepare('SELECT * FROM churches WHERE name = ?').get(payload.name);
        }
        if (!church) throw new Error('church not found');
        req.church = normalizeChurchRow(church);
        return next();
      }
      throw new Error('wrong type');
    } catch {
      if (!fromBearer) res.clearCookie('tally_church_session');
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
      return res.redirect('/church-login');
    }
  };
}

/**
 * Admin-only middleware — rejects TD sessions.
 * Used for billing, team management, profile changes, account deletion, etc.
 */
function requireAdminAuth(db, jwtSecret, queryClient = null) {
  const client = queryClient || db;
  const normalizeChurchRow = (row) => {
    if (!row) return null;
    if (row.churchid !== undefined && row.churchId === undefined) {
      row.churchId = row.churchid;
    }
    return row;
  };
  return async (req, res, next) => {
    const token = req.cookies?.tally_church_session;
    if (!token) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
      return res.redirect('/church-login');
    }
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.type !== 'church_portal') throw new Error('admin only');
      const church = client.queryOne
        ? await client.queryOne('SELECT * FROM churches WHERE churchId = ?', [payload.churchId])
        : client.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
      if (!church) throw new Error('church not found');
      req.church = normalizeChurchRow(church);
      next();
    } catch {
      res.clearCookie('tally_church_session');
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
      return res.redirect('/church-login');
    }
  };
}

function requireChurchPortalOrAppAuth(db, jwtSecret, queryClient = null) {
  const client = queryClient || db;
  const portalAuth = requirePortalAuth(db, jwtSecret, client);
  const normalizeChurchRow = (row) => {
    if (!row) return null;
    if (row.churchid !== undefined && row.churchId === undefined) {
      row.churchId = row.churchid;
    }
    return row;
  };
  return async (req, res, next) => {
    const auth = req.headers?.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), jwtSecret);
        if (payload.type !== 'church_portal' && payload.type !== 'church_app') {
          throw new Error('wrong type');
        }
        const church = client.queryOne
          ? await client.queryOne('SELECT * FROM churches WHERE churchId = ?', [payload.churchId])
          : client.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
        if (!church) return res.status(404).json({ error: 'Church not found' });
        req.church = normalizeChurchRow(church);
        return next();
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }
    return portalAuth(req, res, next);
  };
}

// ─── Dashboard Stats ────────────────────────────────────────────────────────────

const SCHEDULE_DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SCHEDULE_DAY_LABELS_MAP = {
  sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday',
};

/**
 * Compute at-a-glance dashboard stats for a church.
 * @param {import('better-sqlite3').Database} db
 * @param {string} churchId
 * @param {Map} churches  In-memory runtime map (for equipment status)
 * @param {Date} [now]  Injectable for testing
 * @returns {object}
 */
async function getDashboardStats(dbOrClient, churchId, churches, now) {
  if (!now) now = new Date();
  const useClient = dbOrClient && typeof dbOrClient.queryOne === 'function';
  const qOne = async (sql, params = []) => {
    if (useClient) return dbOrClient.queryOne(sql, params);
    if (dbOrClient && typeof dbOrClient.prepare === 'function') {
      return dbOrClient.prepare(sql).get(...params) || null;
    }
    return null;
  };

  // ── Time boundaries ─────────────────────────────────────────────────────
  const dayOfWeek = now.getDay(); // 0=Sun
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - dayOfWeek);
  thisWeekStart.setHours(0, 0, 0, 0);
  const thisWeekStartISO = thisWeekStart.toISOString();

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekStartISO = lastWeekStart.toISOString();
  const nonTestSessionClause = useClient
    ? await buildNonTestSessionClause(dbOrClient)
    : buildNonTestSessionClauseSync(dbOrClient);

  // ── This week sessions ────────────────────────────────────────────────
  let thisWeekSessions = { services: 0, alerts: 0, autoRecoveries: 0, totalDurationMin: 0, totalStreamMin: 0 };
  try {
    const row = await qOne(`
      SELECT
        COUNT(*) AS services,
        COALESCE(SUM(alert_count), 0) AS alerts,
        COALESCE(SUM(auto_recovered_count), 0) AS autoRecoveries,
        COALESCE(SUM(duration_minutes), 0) AS totalDurationMin,
        COALESCE(SUM(stream_runtime_minutes), 0) AS totalStreamMin
      FROM service_sessions
      WHERE church_id = ? AND started_at >= ?${nonTestSessionClause}
    `, [churchId, thisWeekStartISO]);
    if (row) {
      thisWeekSessions = row;
    }
  } catch { /* table may not exist */ }

  const uptimePercent = thisWeekSessions.totalDurationMin > 0
    ? Math.round(Math.min(100, (thisWeekSessions.totalStreamMin / thisWeekSessions.totalDurationMin) * 100) * 10) / 10
    : (thisWeekSessions.services > 0 ? 100 : 0);

  // ── Last week alerts (for trend) ──────────────────────────────────────
  let lastWeekAlerts = 0;
  try {
    const row = await qOne(`
      SELECT COALESCE(SUM(alert_count), 0) AS alerts
      FROM service_sessions
      WHERE church_id = ? AND started_at >= ? AND started_at < ?${nonTestSessionClause}
    `, [churchId, lastWeekStartISO, thisWeekStartISO]);
    if (row) lastWeekAlerts = row.alerts;
  } catch { /* table may not exist */ }

  const alertDiff = thisWeekSessions.alerts - lastWeekAlerts;
  let alertsTrending = 'stable';
  if (alertDiff > 0) alertsTrending = 'up';
  else if (alertDiff < 0) alertsTrending = 'down';
  const comparedToLastWeek = alertDiff > 0 ? `+${alertDiff}` : String(alertDiff);

  // ── Equipment status (from in-memory runtime) ─────────────────────────
  const equipmentStatus = { total: 0, healthy: 0, warning: 0, offline: 0 };
  const runtime = churches ? churches.get(churchId) : null;
  if (runtime && runtime.status) {
    const st = runtime.status;
    const devices = [];

    // ATEM
    if (st.atem) {
      const connected = st.atem === true || !!(st.atem && st.atem.connected);
      devices.push(connected ? 'healthy' : 'offline');
    }
    // OBS
    if (st.obs) {
      const connected = st.obs === true || !!(st.obs && st.obs.connected);
      devices.push(connected ? 'healthy' : 'offline');
    }
    // Encoder
    if (st.encoder) {
      const enc = typeof st.encoder === 'object' ? st.encoder : {};
      const connected = st.encoder === true || !!enc.connected;
      devices.push(connected ? 'healthy' : 'offline');
    }
    // Mixer
    if (st.mixer) {
      const connected = !!(st.mixer && st.mixer.connected);
      devices.push(connected ? 'healthy' : 'offline');
    }
    // vMix
    if (st.vmix && st.vmix.connected != null) {
      devices.push(st.vmix.connected ? 'healthy' : 'offline');
    }
    // HyperDecks
    if (st.hyperdecks && Array.isArray(st.hyperdecks)) {
      for (const hd of st.hyperdecks) {
        devices.push(hd.connected ? 'healthy' : 'offline');
      }
    }
    if (st.hyperdeck) {
      devices.push(st.hyperdeck.connected ? 'healthy' : 'offline');
    }
    // VideoHubs
    if (st.videoHubs && Array.isArray(st.videoHubs)) {
      for (const hub of st.videoHubs) {
        devices.push(hub.connected ? 'healthy' : 'offline');
      }
    }
    // PTZ cameras
    if (st.ptzCameras && Array.isArray(st.ptzCameras)) {
      for (const cam of st.ptzCameras) {
        devices.push(cam.connected ? 'healthy' : 'offline');
      }
    }
    // Smart plugs
    if (Array.isArray(st.smartPlugs)) {
      for (const plug of st.smartPlugs) {
        devices.push(plug.connected ? 'healthy' : 'offline');
      }
    }

    equipmentStatus.total = devices.length;
    equipmentStatus.healthy = devices.filter(d => d === 'healthy').length;
    equipmentStatus.warning = devices.filter(d => d === 'warning').length;
    equipmentStatus.offline = devices.filter(d => d === 'offline').length;
  }

  // ── Next service (from schedule) ──────────────────────────────────────
  let nextService = null;
  try {
    const row = await qOne('SELECT schedule FROM churches WHERE churchId = ?', [churchId]);
    const sched = (row && row.schedule) ? JSON.parse(row.schedule) : {};
    nextService = _findNextService(sched, now);
  } catch { /* no schedule */ }

  return {
    thisWeek: {
      services: thisWeekSessions.services,
      alerts: thisWeekSessions.alerts,
      autoRecoveries: thisWeekSessions.autoRecoveries,
      uptimePercent,
    },
    trend: {
      alertsTrending,
      comparedToLastWeek,
    },
    equipmentStatus,
    nextService,
  };
}

/**
 * Find the next upcoming service window from the schedule.
 * @param {object} sched  { sunday: [{start, end, label}], ... }
 * @param {Date} now
 * @returns {object|null}  { time: ISO, label, minutesUntil }
 */
function _findNextService(sched, now) {
  if (!sched || typeof sched !== 'object') return null;

  const candidates = [];
  const currentDayIndex = now.getDay(); // 0=Sun

  // Check next 7 days (including today)
  for (let offset = 0; offset < 7; offset++) {
    const dayIndex = (currentDayIndex + offset) % 7;
    const dayKey = SCHEDULE_DAY_NAMES[dayIndex];
    const windows = sched[dayKey];
    if (!Array.isArray(windows)) continue;

    for (const w of windows) {
      if (!w.start) continue;
      // Parse start time (format: "HH:MM" or "H:MM")
      const parts = w.start.split(':');
      if (parts.length < 2) continue;
      const hour = parseInt(parts[0], 10);
      const minute = parseInt(parts[1], 10);
      if (isNaN(hour) || isNaN(minute)) continue;

      const candidate = new Date(now);
      candidate.setDate(now.getDate() + offset);
      candidate.setHours(hour, minute, 0, 0);

      // Skip if in the past
      if (candidate <= now) continue;

      const minutesUntil = Math.round((candidate - now) / 60000);
      const dayLabel = SCHEDULE_DAY_LABELS_MAP[dayKey] || dayKey;
      const timeStr = candidate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const label = w.label ? `${dayLabel} ${timeStr} — ${w.label}` : `${dayLabel} ${timeStr}`;

      candidates.push({ time: candidate.toISOString(), label, minutesUntil });
    }
  }

  if (candidates.length === 0) return null;
  // Return the soonest
  candidates.sort((a, b) => a.minutesUntil - b.minutesUntil);
  return candidates[0];
}

// ─── HTML builders ─────────────────────────────────────────────────────────────

const _loginHtmlTemplate = require('fs').readFileSync(require('path').join(__dirname, '../public/portal/login.html'), 'utf8');
const _loginAssetHash = (() => {
  const crypto = require('crypto');
  return crypto.createHash('md5')
    .update(require('fs').readFileSync(require('path').join(__dirname, '../public/portal/login.css')))
    .digest('hex').slice(0, 8);
})();
function buildChurchLoginHtml(error = '') {
  const errorBlock = error
    ? `<div class="error">${error.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))}</div>`
    : '';
  return _loginHtmlTemplate.replace('{{ERROR_BLOCK}}', errorBlock)
    .replace(/(\/portal\/login\.css)/, `$1?v=${_loginAssetHash}`);
}

// Portal HTML is served from separate static files (public/portal/)
const _portalHtmlTemplate = require('fs').readFileSync(require('path').join(__dirname, '../public/portal/portal.html'), 'utf8');

// Cache-bust static assets: compute a short content hash at startup so browsers
// fetch fresh CSS/JS whenever the files change across deploys.
const _assetHash = (() => {
  const crypto = require('crypto');
  const portalDir = require('path').join(__dirname, '../public/portal');
  const hash = crypto.createHash('md5');
  for (const f of ['portal.css', 'portal.js']) {
    hash.update(require('fs').readFileSync(require('path').join(portalDir, f)));
  }
  return hash.digest('hex').slice(0, 8);
})();

function buildChurchPortalHtml(church, { roomCount = 0 } = {}) {
  const name = church.name || 'Your Church';
  let html = _portalHtmlTemplate
    .replace(/\{\{CHURCH_ID\}\}/g, church.churchId)
    .replace(/\{\{CHURCH_NAME\}\}/g, _escapeHtml(name))
    .replace(/(\/portal\/portal\.(?:css|js))/g, `$1?v=${_assetHash}`);
  // Server-side: strip the zero-rooms gate entirely when the church already has rooms.
  // This prevents any client-side race condition from briefly flashing the overlay.
  if (roomCount > 0) {
    html = html.replace(/<div id="zero-rooms-gate"[\s\S]*?<!--\s*\/zero-rooms-gate\s*-->/, '');
  }
  return html;
}

function _escapeHtml(str) {
  return String(str).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─── Route setup ───────────────────────────────────────────────────────────────

function setupChurchPortal(app, db, churches, jwtSecret, requireAdmin, { billing, lifecycleEmails, preServiceCheck, sessionRecap, weeklyDigest, rundownEngine, scheduler, aiRateLimiter, guestTdMode, signalFailover, broadcastToPortal, aiTriageEngine, preServiceRundown, viewerBaseline, streamOAuth, planningCenter, queryClient, onRoomCreated = () => {}, onRoomDeleted = () => {}, onRoomRestored = () => {} } = {}) {
  const portalQuery = queryClient || (
    db && typeof db.query === 'function'
      && typeof db.run === 'function'
      && typeof db.prepare !== 'function'
        ? db
        : new SqliteQueryClient(db)
  );
  const autoIncrementPrimaryKey = portalQuery?.driver === 'postgres'
    ? 'BIGSERIAL PRIMARY KEY'
    : 'INTEGER PRIMARY KEY AUTOINCREMENT';

  async function qAll(sql, params = []) {
    return portalQuery.query(sql, params);
  }

  async function qOne(sql, params = []) {
    return portalQuery.queryOne(sql, params);
  }

  async function qValue(sql, params = []) {
    return portalQuery.queryValue(sql, params);
  }

  async function qRun(sql, params = []) {
    return portalQuery.run(sql, params);
  }

  async function getNonTestSessionClause(columnRef = 'session_type') {
    return buildNonTestSessionClause(portalQuery, columnRef);
  }

  async function getTestSessionPredicate(columnRef = 'session_type') {
    return buildTestSessionPredicate(portalQuery, columnRef);
  }

  async function ensureSessionTypeColumn() {
    await ensureColumn(portalQuery, 'service_sessions', 'session_type', 'TEXT');
  }

  function normalizeChurchRow(row) {
    if (!row) return null;
    if (row.churchid !== undefined && row.churchId === undefined) {
      row.churchId = row.churchid;
    }
    return row;
  }

  async function getChurchById(churchId) {
    return normalizeChurchRow(await qOne('SELECT * FROM churches WHERE churchId = ?', [churchId]));
  }

  async function getChurchByPortalEmail(email) {
    return normalizeChurchRow(await qOne('SELECT * FROM churches WHERE portal_email = ?', [email]));
  }

  async function getChurchByPortalEmailExcluding(email, churchId) {
    return normalizeChurchRow(await qOne('SELECT churchId FROM churches WHERE portal_email = ? AND churchId != ?', [email, churchId]));
  }

  async function getTdByEmail(email) {
    return qOne('SELECT * FROM church_tds WHERE email = ? AND portal_enabled = 1', [email]);
  }

  async function getTdById(tdId, churchId) {
    return qOne('SELECT * FROM church_tds WHERE id = ? AND church_id = ?', [tdId, churchId]);
  }

  async function getTdRoomAssignments(tdId, churchId) {
    return qAll('SELECT room_id FROM td_room_assignments WHERE td_id = ? AND church_id = ?', [tdId, churchId]);
  }

  async function getRoomCount(churchId) {
    return qValue('SELECT COUNT(*) AS cnt FROM rooms WHERE campus_id = ? AND deleted_at IS NULL', [churchId]);
  }

  async function getRoomEquipment(roomId, churchId) {
    return qOne('SELECT equipment FROM room_equipment WHERE room_id = ? AND church_id = ?', [roomId, churchId]);
  }
  async function getRoomById(roomId, churchId) {
    return qOne('SELECT id, name, campus_id, description, created_at, deleted_at, stream_key FROM rooms WHERE id = ? AND campus_id = ?', [roomId, churchId]);
  }
  async function getRoomByIdIncludingDeleted(roomId, churchId) {
    return qOne('SELECT id, name, campus_id, description, created_at, deleted_at, stream_key FROM rooms WHERE id = ? AND campus_id = ?', [roomId, churchId]);
  }
  async function getRoomAssignmentCount(churchId) {
    return qValue('SELECT COUNT(*) AS cnt FROM rooms WHERE campus_id = ? AND deleted_at IS NULL', [churchId]);
  }
  async function getCurrentRoomId(churchId) {
    return qValue('SELECT room_id FROM churches WHERE churchId = ?', [churchId]);
  }
  const express = require('express');
  log.info('Setup started');

  // ── Push config changes to connected desktop clients ───────────────────────
  function pushConfigToClients(churchId, section, data, roomId) {
    const church = churches.get(churchId);
    if (!church?.sockets?.size) return;
    const msg = JSON.stringify({ type: 'config_update', section, data, roomId: roomId || null });
    for (const sock of church.sockets.values()) {
      if (sock.readyState === 1) sock.send(msg);
    }
  }

  async function resolvePortalLiveStatus(churchRow, req) {
    const runtime = churches.get(churchRow.churchId);
    const requestedRoomId = req.tdRoomId || req.query.roomId;
    const requestedInstance = req.query.instance;
    let resolvedInstance = requestedInstance || null;
    let roomOffline = false;

    if (requestedRoomId && runtime?.roomInstanceMap) {
      resolvedInstance = runtime.roomInstanceMap[requestedRoomId] || null;
      if (!resolvedInstance) roomOffline = true;
    }

    let statusObj = runtime?.status || {};
    let isConnected = runtime?.sockets?.size
      ? [...runtime.sockets.values()].some(s => s.readyState === 1)
      : false;

    if (roomOffline) {
      statusObj = { _offline: true };
      isConnected = false;
    } else if (resolvedInstance && runtime?.instanceStatus?.[resolvedInstance]) {
      statusObj = runtime.instanceStatus[resolvedInstance];
      const instSocket = runtime.sockets?.get(resolvedInstance);
      isConnected = !!(instSocket && instSocket.readyState === 1);
    }

    if (requestedRoomId && statusObj && !statusObj._offline) {
      try {
        const eqRow = await getRoomEquipment(requestedRoomId, churchRow.churchId);
        if (eqRow) {
          const eq = JSON.parse(eqRow.equipment);
          const filtered = { ...statusObj };
          if (!eq.atemIp) delete filtered.atem;
          if (!eq.encoderType && !eq.encoderHost) delete filtered.encoder;
          if (!eq.obsUrl) delete filtered.obs;
          if (!eq.mixer?.type && !eq.mixer?.host) delete filtered.mixer;
          if (!eq.proPresenter?.host) { delete filtered.proPresenter; delete filtered.propresenter; }
          if (!eq.resolume?.host) delete filtered.resolume;
          if (!eq.vmix?.host) delete filtered.vmix;
          if (!eq.companionUrl) delete filtered.companion;
          if (!eq.ptz?.length) { delete filtered.ptz; delete filtered.cameras; }
          if (!eq.hyperdecks?.length) { delete filtered.hyperdeck; delete filtered.hyperDeck; delete filtered.hyperdecks; delete filtered.hyperDecks; }
          if (!eq.videoHubs?.length) delete filtered.videoHubs;
          statusObj = filtered;
        }
      } catch { /* If equipment config can't be read, show unfiltered status */ }
    }

    return {
      connected: isConnected,
      status: statusObj,
      instanceStatus: resolvedInstance
        ? { [resolvedInstance]: runtime?.instanceStatus?.[resolvedInstance] || {} }
        : (runtime?.instanceStatus || {}),
      instances: runtime?.sockets ? Array.from(runtime.sockets.keys()) : [],
      roomInstanceMap: runtime?.roomInstanceMap || {},
      lastSeen: runtime?.lastSeen || null,
      broadcastHealth: runtime?.broadcastHealth || null,
    };
  }

  // ── Rate limiting for login endpoint ───────────────────────────────────────
  const loginRateLimit = createRateLimit({
    scope: 'church_portal_login',
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    keyGenerator: (_req, ip) => ip,
    onLimit: (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(429).send(buildChurchLoginHtml('Too many login attempts. Please try again later.'));
    },
  });

  const billingRateLimit = createRateLimit({ scope: 'church_billing', maxAttempts: 3, windowMs: 60_000 });

  // ── Schema ──────────────────────────────────────────────────────────────────
  const migrations = [
    "ALTER TABLE churches ADD COLUMN portal_email TEXT",
    "ALTER TABLE churches ADD COLUMN portal_password_hash TEXT",
    "ALTER TABLE churches ADD COLUMN phone TEXT",
    "ALTER TABLE churches ADD COLUMN location TEXT",
    "ALTER TABLE churches ADD COLUMN notes TEXT",
    "ALTER TABLE churches ADD COLUMN notifications TEXT DEFAULT '{}'",
    "ALTER TABLE churches ADD COLUMN telegram_chat_id TEXT",
    "ALTER TABLE churches ADD COLUMN parent_church_id TEXT",
    "ALTER TABLE churches ADD COLUMN campus_name TEXT",
    "ALTER TABLE churches ADD COLUMN schedule TEXT DEFAULT '{}'",
    "ALTER TABLE churches ADD COLUMN auto_recovery_enabled INTEGER DEFAULT 1",
    "ALTER TABLE churches ADD COLUMN leadership_emails TEXT DEFAULT ''",
  ];
  for (const m of migrations) {
    try { db.exec(m); } catch { /* already exists */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_churches_parent_church_id ON churches(parent_church_id)'); } catch {}

  // Ensure portal-specific columns exist on church_tds (table created by telegramBot)
  const _portalMigrations = [
    "ALTER TABLE church_tds ADD COLUMN role TEXT DEFAULT 'td'",
    "ALTER TABLE church_tds ADD COLUMN email TEXT",
    "ALTER TABLE church_tds ADD COLUMN phone TEXT",
    "ALTER TABLE churches ADD COLUMN referral_code TEXT",
    "ALTER TABLE churches ADD COLUMN referred_by TEXT",
    "ALTER TABLE churches ADD COLUMN locale TEXT DEFAULT 'en'",
    "ALTER TABLE church_tds ADD COLUMN password_hash TEXT",
    "ALTER TABLE church_tds ADD COLUMN portal_enabled INTEGER DEFAULT 0",
    "ALTER TABLE church_tds ADD COLUMN last_portal_login TEXT",
    "ALTER TABLE church_tds ADD COLUMN access_level TEXT DEFAULT 'operator'",
  ];
  for (const m of _portalMigrations) {
    try { db.exec(m); } catch { /* column already exists */ }
  }

  // ── TD ↔ Room assignments (many-to-many) ──────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS td_room_assignments (
      id         ${autoIncrementPrimaryKey},
      td_id      INTEGER NOT NULL,
      room_id    TEXT NOT NULL,
      church_id  TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_td_room_td ON td_room_assignments(td_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_td_room_room ON td_room_assignments(room_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_td_room_unique ON td_room_assignments(td_id, room_id)');

  // Telegram macros table
  db.exec(`
    CREATE TABLE IF NOT EXISTS church_macros (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(church_id, name)
    )
  `);

  // Guest tokens table (extend if not exists)
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest_tokens (
      token      TEXT PRIMARY KEY,
      church_id  TEXT,
      churchId   TEXT NOT NULL,
      label      TEXT,
      createdAt  TEXT NOT NULL,
      expiresAt  TEXT
    )
  `);
  try { db.exec('ALTER TABLE guest_tokens ADD COLUMN church_id TEXT'); } catch { /* already exists */ }
  try { db.exec('UPDATE guest_tokens SET church_id = churchId WHERE church_id IS NULL AND churchId IS NOT NULL'); } catch { /* ignore */ }

  // Support triage/ticket tables (created in relay too; repeated here for module resilience)
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_triage_runs (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      issue_category TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT DEFAULT '',
      triage_result TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      autofix_attempts_json TEXT DEFAULT '[]',
      timezone TEXT,
      app_version TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      triage_id TEXT,
      issue_category TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      forced_bypass INTEGER NOT NULL DEFAULT 0,
      diagnostics_json TEXT DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS support_ticket_updates (
      id ${autoIncrementPrimaryKey},
      ticket_id TEXT NOT NULL,
      message TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  // Reviews / testimonials table
  db.exec(`
    CREATE TABLE IF NOT EXISTS church_reviews (
      id            TEXT PRIMARY KEY,
      church_id     TEXT NOT NULL,
      reviewer_name TEXT NOT NULL,
      reviewer_role TEXT DEFAULT '',
      rating        INTEGER NOT NULL,
      body          TEXT NOT NULL,
      church_name   TEXT NOT NULL,
      approved      INTEGER DEFAULT 0,
      featured      INTEGER DEFAULT 0,
      submitted_at  TEXT NOT NULL,
      approved_at   TEXT,
      source        TEXT DEFAULT 'portal'
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_approved ON church_reviews(approved)');

  // Referrals table — tracks who referred whom and credit status
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id              TEXT PRIMARY KEY,
      referrer_id     TEXT NOT NULL,
      referred_id     TEXT NOT NULL,
      referred_name   TEXT DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'pending',
      credit_amount   INTEGER DEFAULT 0,
      created_at      TEXT NOT NULL,
      converted_at    TEXT,
      credited_at     TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id)');

  // Smart plugs — Shelly devices assigned to rooms/equipment
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_plugs (
      id              TEXT PRIMARY KEY,
      church_id       TEXT NOT NULL,
      plug_ip         TEXT NOT NULL,
      plug_name       TEXT NOT NULL DEFAULT '',
      room_id         TEXT,
      assigned_device TEXT DEFAULT '',
      created_at      TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_smart_plugs_church ON smart_plugs(church_id)');

  // Backfill referral codes for existing churches that don't have one.
  // Keep this async so the queryClient path stays consistent even during setup.
  void (async () => {
    try {
      const churchesMissingCode = await qAll('SELECT churchId FROM churches WHERE referral_code IS NULL OR referral_code = ?', ['']);
      for (const c of churchesMissingCode) {
        let code;
        do {
          code = crypto.randomBytes(3).toString('hex').toUpperCase();
        } while (await qOne('SELECT 1 FROM churches WHERE registration_code = ? OR referral_code = ?', [code, code]));
        await qRun('UPDATE churches SET referral_code = ? WHERE churchId = ?', [code, c.churchId]);
      }
    } catch (e) {
      log.warn('Referral code backfill skipped: ' + safeErrorMessage(e));
    }
  })();

  const authMiddleware = requirePortalAuth(db, jwtSecret, portalQuery);         // admin OR TD
  const adminMiddleware = requireAdminAuth(db, jwtSecret, portalQuery);         // admin only
  const supportAuthMiddleware = requireChurchPortalOrAppAuth(db, jwtSecret, portalQuery);

  // ── Room tier limits ──────────────────────────────────────────────────────
  function maxRoomsForTier(tierValue) {
    const tier = String(tierValue || 'connect').toLowerCase();
    const limits = {
      connect: 1,   // single room
      plus: 3,      // up to 3 rooms
      pro: 5,       // up to 5 rooms
      managed: 999, // unlimited rooms (Enterprise)
      event: 1,
    };
    return limits[tier] || 1;
  }

  // ── Login page ───────────────────────────────────────────────────────────────
  app.get('/church-login', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildChurchLoginHtml());
  });

  // ── Login POST ────────────────────────────────────────────────────────────────
  app.post('/api/church/login', express.urlencoded({ extended: false }), loginRateLimit, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(400).send(buildChurchLoginHtml('Email and password are required.'));
    }
    const normalEmail = email.trim().toLowerCase();

    // Try church admin first
    const church = await getChurchByPortalEmail(normalEmail);
    if (church && church.portal_password_hash && verifyPassword(password, church.portal_password_hash)) {
      const token = issueChurchToken(church.churchId, jwtSecret);
      res.cookie('tally_church_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      setCsrfCookie(res, generateCsrfToken());
      return res.redirect('/church-portal');
    }

    // Try TD login
    const td = await getTdByEmail(normalEmail);
    if (td && td.password_hash && verifyPassword(password, td.password_hash)) {
      // Check room assignments — if TD has exactly one room, auto-scope the token
      const roomAssignments = await getTdRoomAssignments(td.id, td.church_id);
      const roomId = roomAssignments.length === 1 ? roomAssignments[0].room_id : null;
      const token = issueTdToken(td.id, td.church_id, td.access_level || 'operator', jwtSecret, roomId);
      res.cookie('tally_church_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      await qRun('UPDATE church_tds SET last_portal_login = ? WHERE id = ?', [new Date().toISOString(), td.id]);
      setCsrfCookie(res, generateCsrfToken());
      // If TD has multiple rooms and no auto-scope, redirect to room picker
      if (roomAssignments.length > 1) {
        return res.redirect('/church-portal?pickRoom=1');
      }
      return res.redirect('/church-portal');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(buildChurchLoginHtml('Invalid email or password.'));
  });

  // ── Logout ────────────────────────────────────────────────────────────────────
  app.post('/api/church/logout', (req, res) => {
    res.clearCookie('tally_church_session');
    res.json({ ok: true });
  });

  // ── Portal HTML ───────────────────────────────────────────────────────────────
  app.get('/church-portal', authMiddleware, async (req, res) => {
    // Refresh CSRF token on every portal load so users with existing sessions
    // (e.g. logged in before CSRF was introduced) always get a valid token.
    if (!req.cookies?.tally_csrf) {
      setCsrfCookie(res, generateCsrfToken());
    }
    // Count rooms server-side so we can strip the zero-rooms gate from HTML
    // when the church already has rooms (prevents any client-side flash).
    let roomCount = 0;
    try {
      roomCount = await getRoomCount(req.church.churchId) || 0;
    } catch {}
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildChurchPortalHtml(req.church, { roomCount }));
  });

  // ── GET /api/church/me ────────────────────────────────────────────────────────
  app.get('/api/church/me', authMiddleware, async (req, res) => {
    const c = req.church;
    let tds = [];
    try {
      const tdsRows = await qAll('SELECT * FROM church_tds WHERE church_id = ? ORDER BY registered_at ASC', [c.churchId]);
      tds = tdsRows.map(td => { const { password_hash, ...s } = td; s.has_password = !!password_hash; return s; });
    } catch {}
    const { portal_password_hash, token, fb_access_token, yt_access_token, yt_refresh_token, ...safe } = c;

    let notifications = {};
    try { notifications = JSON.parse(c.notifications || '{}'); } catch {}
    const liveStatus = await resolvePortalLiveStatus(c, req);

    const response = {
      ...safe,
      notifications,
      tds,
      connected: liveStatus.connected,
      status: liveStatus.status,
      instanceStatus: liveStatus.instanceStatus,
      instances: liveStatus.instances,
      roomInstanceMap: liveStatus.roomInstanceMap,
      lastSeen: liveStatus.lastSeen,
      autoRecoveryEnabled: c.auto_recovery_enabled !== 0,
      broadcastHealth: liveStatus.broadcastHealth,
      facebookConnected: !!c.fb_access_token,
      facebookPageName: c.fb_page_name || null,
    };

    // Attach TD session metadata so the frontend can scope the UI
    if (req.td) {
      response.isTd = true;
      response.tdName = req.td.name;
      response.tdAccessLevel = req.tdAccessLevel;
      response.tdRoomId = req.tdRoomId || null;
      // Include assigned rooms for room picker
      try {
      response.tdRooms = await qAll(
          `SELECT r.id, r.name FROM td_room_assignments tra
           JOIN rooms r ON r.id = tra.room_id AND r.deleted_at IS NULL
           WHERE tra.td_id = ? AND tra.church_id = ? ORDER BY r.name ASC`,
          [req.td.id, req.church.churchId]
        );
      } catch { response.tdRooms = []; }
    }

    res.json(response);
  });

  // ── GET /api/church/live-status ──────────────────────────────────────────────
  // Lightweight live payload for dashboard polling. Keeps the frequent refresh
  // path focused on connection/state instead of re-sending the full profile.
  app.get('/api/church/live-status', authMiddleware, async (req, res) => {
    const liveStatus = await resolvePortalLiveStatus(req.church, req);
    res.json({
      connected: liveStatus.connected,
      status: liveStatus.status,
      lastSeen: liveStatus.lastSeen,
      broadcastHealth: liveStatus.broadcastHealth,
      audio_via_atem: !!req.church.audio_via_atem,
    });
  });

  // ── POST /api/church/onboarding/dismiss ──────────────────────────────────
  app.post('/api/church/onboarding/dismiss', adminMiddleware, async (req, res) => {
    try {
      await qRun('UPDATE churches SET onboarding_dismissed = 1 WHERE churchId = ?', [req.church.churchId]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to dismiss onboarding' });
    }
  });

  // ── POST /api/church/onboarding/undismiss ──────────────────────────────────
  app.post('/api/church/onboarding/undismiss', adminMiddleware, async (req, res) => {
    try {
      await qRun('UPDATE churches SET onboarding_dismissed = 0 WHERE churchId = ?', [req.church.churchId]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to restore onboarding' });
    }
  });

  // ── POST /api/church/onboarding/failover-tested ──────────────────────────────
  // Marks the "Run a test failover" onboarding step complete. Called when the
  // user clicks the "Mark done" button on the onboarding checklist.
  app.post('/api/church/onboarding/failover-tested', adminMiddleware, async (req, res) => {
    try {
      await qRun('UPDATE churches SET onboarding_failover_tested_at = ? WHERE churchId = ?', [
        new Date().toISOString(),
        req.church.churchId,
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to record failover test' });
    }
  });

  // ── POST /api/church/onboarding/team-invited ─────────────────────────────────
  app.post('/api/church/onboarding/team-invited', adminMiddleware, async (req, res) => {
    try {
      await qRun('UPDATE churches SET onboarding_team_invited_at = ? WHERE churchId = ?', [
        new Date().toISOString(),
        req.church.churchId,
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to record team invite' });
    }
  });

  // ── GET /api/church/failover ─────────────────────────────────────────────────
  app.get('/api/church/failover', supportAuthMiddleware, async (req, res) => {
    try {
      const row = await qOne(
        `SELECT failover_enabled, failover_black_threshold_s, failover_ack_timeout_s,
                failover_action, failover_auto_recover, failover_audio_trigger, recovery_outside_service_hours
         FROM churches WHERE churchId = ?`
      , [req.church.churchId]);
      if (!row) return res.status(404).json({ error: 'Church not found' });
      let action = null;
      try { action = row.failover_action ? JSON.parse(row.failover_action) : null; } catch { /* invalid JSON */ }
      res.json({
        enabled: !!row.failover_enabled,
        blackThresholdS: row.failover_black_threshold_s || 5,
        ackTimeoutS: row.failover_ack_timeout_s || 30,
        action,
        autoRecover: !!row.failover_auto_recover,
        audioTrigger: !!row.failover_audio_trigger,
        recoveryOutsideServiceHours: !!row.recovery_outside_service_hours,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load failover settings' });
    }
  });

  // ── GET /api/church/failover/state ─────────────────────────────────────────────
  app.get('/api/church/failover/state', supportAuthMiddleware, (req, res) => {
    try {
      const state = signalFailover.getState(req.church.churchId);
      res.json(state);
    } catch (e) {
      res.status(500).json({ error: 'Failed to get failover state' });
    }
  });

  // ── GET /api/church/failover/sources ──────────────────────────────────────────
  // Returns available failover sources from live device status (ATEM inputs,
  // VideoHub routes, OBS scenes) so the Electron app can populate a dropdown.
  app.get('/api/church/failover/sources', supportAuthMiddleware, (req, res) => {
    try {
      const churchId = req.church.churchId;
      const church = churches.get(churchId);
      if (!church) return res.json({ atem: [], videohub: [], obs: [] });

      const status = church.status || {};
      const sources = { atem: [], videohub: [], videohubOutputs: [], obs: [] };

      // ATEM inputs from labels
      const labels = status.atem?.inputLabels || {};
      for (const [id, name] of Object.entries(labels)) {
        sources.atem.push({ id: Number(id), name: String(name) });
      }
      // Fallback: if no labels but ATEM is connected, show generic inputs 1-8
      if (sources.atem.length === 0 && status.atem?.connected) {
        for (let i = 1; i <= 8; i++) sources.atem.push({ id: i, name: `Input ${i}` });
      }

      // VideoHub routes from each connected hub
      const hubs = status.videoHubs || [];
      for (const hub of hubs) {
        if (!hub.connected) continue;
        const hubInputLabels = hub.inputLabels || {};
        for (const [idx, label] of Object.entries(hubInputLabels)) {
          sources.videohub.push({ id: Number(idx), name: label, hub: hub.name || hub.ip });
        }
        const hubOutputLabels = hub.outputLabels || {};
        for (const [idx, label] of Object.entries(hubOutputLabels)) {
          sources.videohubOutputs.push({ id: Number(idx), name: label || `Output ${idx}`, hub: hub.name || hub.ip });
        }
      }

      // OBS scenes (if OBS is the encoder)
      if (status.obs?.scenes && Array.isArray(status.obs.scenes)) {
        for (const scene of status.obs.scenes) {
          sources.obs.push({ name: scene.name || scene });
        }
      }

      res.json(sources);
    } catch (e) {
      res.status(500).json({ error: 'Failed to get failover sources' });
    }
  });

  // ── PUT /api/church/failover ─────────────────────────────────────────────────
  app.put('/api/church/failover', supportAuthMiddleware, async (req, res) => {
    try {
      const { enabled, blackThresholdS, ackTimeoutS, action, autoRecover, audioTrigger, recoveryOutsideServiceHours } = req.body;
      const churchId = req.church.churchId;

      // Validate thresholds
      const blackS = Math.max(3, Math.min(15, Number(blackThresholdS) || 5));
      const ackS = Math.max(10, Math.min(120, Number(ackTimeoutS) || 30));

      // Validate action shape
      let actionJson = null;
      if (action && typeof action === 'object') {
        if (action.type === 'atem_switch' && action.input != null) {
          actionJson = JSON.stringify({ type: 'atem_switch', input: Number(action.input) });
        } else if (action.type === 'videohub_route' && action.output != null && action.input != null) {
          actionJson = JSON.stringify({
            type: 'videohub_route',
            output: Number(action.output),
            input: Number(action.input),
            hubIndex: Number(action.hubIndex) || 0,
          });
        } else if (action.type === 'backup_encoder') {
          actionJson = JSON.stringify({ type: 'backup_encoder' });
        }
      }

      await qRun(
        `UPDATE churches SET failover_enabled = ?, failover_black_threshold_s = ?, failover_ack_timeout_s = ?,
                failover_action = ?, failover_auto_recover = ?, failover_audio_trigger = ?,
                recovery_outside_service_hours = ?
         WHERE churchId = ?`,
        [enabled ? 1 : 0, blackS, ackS, actionJson, autoRecover ? 1 : 0, audioTrigger ? 1 : 0, recoveryOutsideServiceHours ? 1 : 0, churchId]
      );

      if (signalFailover?.refreshChurchConfig) {
        await signalFailover.refreshChurchConfig(churchId);
      }

      pushConfigToClients(churchId, 'failover', { enabled, blackThresholdS: blackS, ackTimeoutS: ackS, action, autoRecover, audioTrigger, recoveryOutsideServiceHours });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save failover settings' });
    }
  });

  // ── POST /api/church/failover/drill ──────────────────────────────────────────
  // Runs a simulated failover sequence and returns a pass/fail report.
  // Does NOT send real Telegram alerts or execute real device commands.
  app.post('/api/church/failover/drill', supportAuthMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const row = await qOne(
        `SELECT failover_enabled, failover_black_threshold_s, failover_ack_timeout_s, failover_action
         FROM churches WHERE churchId = ?`
      , [churchId]);

      const issues = [];
      const checks = [];

      // Check 1: failover is configured
      if (!row || !row.failover_enabled) {
        issues.push('Failover is not enabled. Enable it above and configure an action.');
      }
      checks.push({ name: 'Failover enabled', passed: !!(row && row.failover_enabled) });

      // Check 2: failover action is set
      let action = null;
      try { action = row && row.failover_action ? JSON.parse(row.failover_action) : null; } catch {}
      if (!action) issues.push('No failover action configured. Select an ATEM input, VideoHub route, or backup encoder above.');
      checks.push({ name: 'Failover action configured', passed: !!action });

      // Check 3: church client is connected (so the action could actually execute)
      const church = churches.get(churchId);
      const clientConnected = church?.sockets?.size && [...church.sockets.values()].some(s => s.readyState === 1);
      if (!clientConnected) issues.push('Tally desktop app is not connected — failover actions require an active client connection. This is OK for a planning drill.');
      checks.push({ name: 'Client app connected', passed: !!clientConnected, optional: true });

      // Check 4: validate the configured action type
      const validAction = action && (action.type === 'atem_switch' || action.type === 'videohub_route' || action.type === 'backup_encoder');
      checks.push({ name: 'Action type is valid', passed: !!validAction });

      const criticalIssues = issues.filter((_, i) => !checks[i]?.optional);
      const passed = criticalIssues.length === 0 && validAction;

      const checkList = checks.map(c =>
        (c.passed ? '[ok]' : (c.optional ? '[warn]' : '[fail]')) + ' ' + c.name
      ).join('\n');

      const actionDesc = action
        ? (action.type === 'atem_switch' ? 'Switch ATEM to ' + friendlyInputName(action.input)
          : action.type === 'backup_encoder' ? 'Switch to backup encoder'
          : 'VideoHub route output ' + action.output + ' → input ' + action.input)
        : 'No action configured';

      const thresholds = `Black threshold: ${row?.failover_black_threshold_s || 5}s, Ack timeout: ${row?.failover_ack_timeout_s || 30}s`;

      const report = passed
        ? `Drill passed! ${checkList}\n\nConfigured action: ${actionDesc}\n${thresholds}\n\nYour failover setup is ready. When a real outage occurs, Tally will: (1) Detect signal loss after ${row?.failover_black_threshold_s || 5}s, (2) Alert your TD via Telegram, (3) Auto-execute "${actionDesc}" if no ack in ${row?.failover_ack_timeout_s || 30}s.`
        : `Drill found issues:\n${issues.join('\n')}\n\n${checkList}\n\nFix the issues above and run the drill again.`;

      // Record drill run time
      try {
        await qRun('UPDATE churches SET onboarding_failover_tested_at = ? WHERE churchId = ?', [
          new Date().toISOString(),
          churchId,
        ]);
      } catch {}

      res.json({ passed, report, checks });
    } catch (e) {
      log.error('Failover drill error: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Failover drill failed') });
    }
  });

  // ── GET /api/church/config/equipment ───────────────────────────────────────────
  // Returns equipment config + available rooms for the room selector dropdown.
  // Accepts optional ?roomId= to load a specific room's equipment.
  app.get('/api/church/config/equipment', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const requestedRoomId = req.tdRoomId || req.query.roomId;

      // Get rooms for dropdown — TD sees only assigned rooms, admin sees all
      let rooms;
      if (req.tdRoomId) {
        rooms = await qAll('SELECT id, name, campus_id FROM rooms WHERE id = ? AND campus_id = ? AND deleted_at IS NULL', [req.tdRoomId, churchId]);
      } else {
        rooms = await qAll('SELECT id, name, campus_id FROM rooms WHERE campus_id = ? AND deleted_at IS NULL ORDER BY name', [churchId]);
      }

      // Also get room_equipment entries to show which rooms have config
      const equipRows = await qAll('SELECT room_id, updated_at FROM room_equipment WHERE church_id = ?', [churchId]);
      const equipByRoom = {};
      for (const er of equipRows) equipByRoom[er.room_id] = er.updated_at;

      // Load equipment for the requested room, or most recent, or default
      let row;
      if (requestedRoomId) {
        row = await qOne('SELECT room_id, equipment, updated_at FROM room_equipment WHERE room_id = ? AND church_id = ?', [requestedRoomId, churchId]);
      }
      if (!row) {
        row = await qOne('SELECT room_id, equipment, updated_at FROM room_equipment WHERE church_id = ? ORDER BY updated_at DESC LIMIT 1', [churchId]);
      }

      let equipment = {};
      let roomId = null;
      let updatedAt = null;
      if (row) {
        try { equipment = JSON.parse(row.equipment); } catch { /* corrupt */ }
        roomId = row.room_id;
        updatedAt = row.updated_at;
      }

      res.json({
        equipment,
        updatedAt,
        roomId,
        rooms: rooms.map(r => ({ id: r.id, name: r.name, campusId: r.campus_id, hasConfig: !!equipByRoom[r.id], lastUpdated: equipByRoom[r.id] || null })),
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── PUT /api/church/config/equipment ───────────────────────────────────────────
  // Saves equipment config from the portal. Writes to the room_id provided in
  // the request body (from the GET response), or falls back to the church's most
  // recent room, or {churchId}_default for brand-new churches.
  app.put('/api/church/config/equipment', adminMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const equipment = req.body?.equipment;
      if (!equipment || typeof equipment !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid equipment object' });
      }

      // Basic validation
      const isIp = (s) => typeof s === 'string' && /^[\d.]+$/.test(s);
      const isPort = (n) => typeof n === 'number' && n >= 1 && n <= 65535;
      if (equipment.atemIp && !isIp(equipment.atemIp)) {
        return res.status(400).json({ error: 'Invalid ATEM IP format' });
      }
      if (Array.isArray(equipment.atems)) {
        for (const a of equipment.atems) {
          if (a && a.ip && !isIp(a.ip)) {
            return res.status(400).json({ error: 'Invalid ATEM IP format: ' + a.ip });
          }
        }
      }
      if (Array.isArray(equipment.tricaster)) {
        for (const t of equipment.tricaster) {
          if (t && t.port !== undefined && t.port !== null && t.port !== '' && !isPort(Number(t.port))) {
            return res.status(400).json({ error: 'TriCaster port must be between 1 and 65535' });
          }
        }
      }
      if (equipment.mixer?.port && !isPort(equipment.mixer.port)) {
        return res.status(400).json({ error: 'Mixer port must be between 1 and 65535' });
      }
      if (equipment.encoderPort && !isPort(equipment.encoderPort)) {
        return res.status(400).json({ error: 'Encoder port must be between 1 and 65535' });
      }
      if (Array.isArray(equipment.encoders)) {
        for (const e of equipment.encoders) {
          if (e && e.port !== undefined && e.port !== null && e.port !== '') {
            const p = Number(e.port);
            if (!Number.isNaN(p) && !isPort(p)) {
              return res.status(400).json({ error: 'Encoder port must be between 1 and 65535' });
            }
          }
        }
      }
      if (equipment.companion?.port && !isPort(equipment.companion.port)) {
        return res.status(400).json({ error: 'Companion port must be between 1 and 65535' });
      }

      // Use the room_id from the request (passed from the GET), or find the most
      // recent room for this church, or default to {churchId}_default
      let roomId = req.body?.roomId;
      if (!roomId) {
        const existing = await qOne(
          'SELECT room_id FROM room_equipment WHERE church_id = ? ORDER BY updated_at DESC LIMIT 1',
          [churchId]
        );
        roomId = existing?.room_id || (churchId + '_default');
      }
      const now = new Date().toISOString();
      await qRun(`
        INSERT INTO room_equipment (room_id, church_id, equipment, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          equipment = excluded.equipment,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `, [roomId, churchId, JSON.stringify(equipment), now, churchId]);

      pushConfigToClients(churchId, 'equipment', equipment, roomId);
      res.json({ ok: true, updatedAt: now });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── Stream Platform OAuth (portal-initiated) ──────────────────────────────────
  // These mirror the Electron app's /api/church/app/oauth/* routes but use portal auth.
  if (streamOAuth) {
    const YOUTUBE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
    const YOUTUBE_SCOPES = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube';
    const FACEBOOK_AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth';

    // ── YouTube ──

    // Initiate YouTube OAuth from portal (returns the auth URL for the browser popup)
    app.post('/api/church/oauth/youtube/start', adminMiddleware, (req, res) => {
      const clientId = process.env.YOUTUBE_CLIENT_ID || '';
      if (!clientId) return res.status(500).json({ error: 'YouTube OAuth not configured' });
      const state = require('crypto').randomBytes(16).toString('hex');
      const redirectUri = `${req.protocol}://${req.get('host')}/api/oauth/youtube/callback`;
      const authUrl = `${YOUTUBE_AUTH_URL}?` + new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: YOUTUBE_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString();
      res.json({ authUrl, state, redirectUri });
    });

    // Poll for pending YouTube auth code
    app.get('/api/church/oauth/youtube/pending', adminMiddleware, (req, res) => {
      const { state } = req.query;
      if (!state) return res.status(400).json({ error: 'state required' });
      const pending = streamOAuth.getYouTubePendingCode(state);
      if (!pending) return res.json({ ready: false });
      res.json({ ready: true, code: pending.code });
    });

    // Exchange YouTube auth code for tokens + stream key
    app.post('/api/church/oauth/youtube/exchange', adminMiddleware, async (req, res) => {
      try {
        const result = await streamOAuth.exchangeYouTubeCode(req.church.churchId, req.body.code, req.body.redirectUri);
        res.json(result);
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });

    // Disconnect YouTube
    app.delete('/api/church/oauth/youtube', adminMiddleware, async (req, res) => {
      try {
        await streamOAuth.disconnectYouTube(req.church.churchId);
        res.json({ disconnected: true });
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });

    // ── Facebook ──

    // Initiate Facebook OAuth from portal (returns the auth URL for the browser popup)
    app.post('/api/church/oauth/facebook/start', adminMiddleware, (req, res) => {
      const appId = process.env.FACEBOOK_APP_ID || '';
      if (!appId) return res.status(500).json({ error: 'Facebook app not configured' });
      const state = require('crypto').randomBytes(16).toString('hex');
      const redirectUri = `${req.protocol}://${req.get('host')}/api/oauth/facebook/callback`;
      const authUrl = `${FACEBOOK_AUTH_URL}?` + new URLSearchParams({
        client_id: appId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'pages_show_list,pages_read_engagement,publish_video',
        state,
      }).toString();
      res.json({ authUrl, state, redirectUri });
    });

    // Poll for pending Facebook auth code
    app.get('/api/church/oauth/facebook/pending', adminMiddleware, (req, res) => {
      const { state } = req.query;
      if (!state) return res.status(400).json({ error: 'state required' });
      const pending = streamOAuth.getFacebookPendingCode(state);
      if (!pending) return res.json({ ready: false });
      res.json({ ready: true, code: pending.code });
    });

    // Exchange Facebook auth code for tokens
    app.post('/api/church/oauth/facebook/exchange', adminMiddleware, async (req, res) => {
      try {
        const result = await streamOAuth.exchangeFacebookCode(req.church.churchId, req.body.code, req.body.redirectUri);
        res.json(result);
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });

    // List Facebook pages
    app.get('/api/church/oauth/facebook/pages', adminMiddleware, async (req, res) => {
      try {
        const result = await streamOAuth.listFacebookDestinations(req.church.churchId);
        res.json(result);
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });

    // Select Facebook page
    app.post('/api/church/oauth/facebook/select-page', adminMiddleware, async (req, res) => {
      try {
        const result = await streamOAuth.selectFacebookPage(req.church.churchId, req.body.pageId);
        res.json(result);
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });

    // Disconnect Facebook
    app.delete('/api/church/oauth/facebook', adminMiddleware, async (req, res) => {
      try {
        await streamOAuth.disconnectFacebook(req.church.churchId);
        res.json({ disconnected: true });
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });

    // ── Shared ──

    // OAuth status (both platforms)
    app.get('/api/church/oauth/status', authMiddleware, async (req, res) => {
      try {
        res.json(await streamOAuth.getStatus(req.church.churchId));
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });
  }

  // ── Planning Center OAuth (portal-initiated) ──────────────────────────────────
  if (planningCenter) {
    // Get PCO connection status
    app.get('/api/church/pco/status', authMiddleware, (req, res) => {
      try {
        const status = planningCenter.getStatus(req.church.churchId);
        res.json(status || { connected: false });
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });

    // Get PCO OAuth authorization URL (opens popup)
    app.get('/api/church/pco/auth-url', adminMiddleware, (req, res) => {
      try {
        const PCO_REDIRECT_URI = process.env.PCO_REDIRECT_URI || 'https://relay.tallyconnect.com/api/admin/pco/callback';
        const { authUrl, state } = planningCenter.generateOAuthUrl(req.church.churchId, PCO_REDIRECT_URI);
        res.json({ authUrl, state });
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });

    // Disconnect PCO
    app.post('/api/church/pco/disconnect', adminMiddleware, async (req, res) => {
      try {
        const result = await planningCenter.disconnect(req.church.churchId);
        res.json(result || { success: true });
      } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
    });
  }

  // ── POST /api/church/config/ingest-key/regenerate ─────────────────────────────
  // Legacy church-level key regeneration (kept for backward compat)
  app.post('/api/church/config/ingest-key/regenerate', adminMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const newKey = require('crypto').randomBytes(16).toString('hex');
      await qRun('UPDATE churches SET ingest_stream_key = ? WHERE churchId = ?', [newKey, churchId]);
      res.json({ ok: true, ingestStreamKey: newKey });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/rooms/:roomId/roles ─────────────────────────────────────
  app.get('/api/church/rooms/:roomId/roles', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = String(req.params.roomId || '').trim();
      const room = await getRoomById(roomId, churchId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const row = await qOne('SELECT equipment FROM room_equipment WHERE room_id = ?', [roomId]);
      let equipment = {};
      try { equipment = JSON.parse(row?.equipment || '{}'); } catch { }

      const { ROLE_DEFINITIONS, autoDetectRoles } = require('./routes/roomEquipment');
      const savedRoles = equipment._roles || null;
      const autoRoles = autoDetectRoles(equipment);
      const roles = savedRoles || autoRoles;

      res.json({
        roles,
        autoDetected: !savedRoles,
        defaults: autoRoles,
        roleDefinitions: ROLE_DEFINITIONS,
        equipment,
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── PUT /api/church/rooms/:roomId/roles ─────────────────────────────────────
  app.put('/api/church/rooms/:roomId/roles', adminMiddleware, express.json(), async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = String(req.params.roomId || '').trim();
      const room = await getRoomById(roomId, churchId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const roles = req.body?.roles;
      if (!roles || typeof roles !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid roles object' });
      }

      const { VALID_ROLE_KEYS } = require('./routes/roomEquipment');
      for (const key of Object.keys(roles)) {
        if (!VALID_ROLE_KEYS.includes(key)) {
          return res.status(400).json({ error: `Invalid role key: ${key}` });
        }
      }

      const row = await qOne('SELECT equipment FROM room_equipment WHERE room_id = ?', [roomId]);
      let equipment = {};
      try { equipment = JSON.parse(row?.equipment || '{}'); } catch { }

      equipment._roles = roles;
      const now = new Date().toISOString();

      await qRun(`
        INSERT INTO room_equipment (room_id, church_id, equipment, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          equipment = excluded.equipment,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `, [roomId, churchId, JSON.stringify(equipment), now, churchId]);

      res.json({ ok: true, roles, updatedAt: now });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/rooms/:roomId/stream-key/regenerate ──────────────────────
  app.post('/api/church/rooms/:roomId/stream-key/regenerate', adminMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = String(req.params.roomId || '').trim();
      const room = await getRoomById(roomId, churchId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const { disconnectStream } = require('./rtmpIngest');
      disconnectStream(roomId);

      const newKey = require('crypto').randomBytes(16).toString('hex');
      await qRun('UPDATE rooms SET stream_key = ? WHERE id = ?', [newKey, roomId]);
      res.json({ ok: true, streamKey: newKey, roomId });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/rooms/:roomId/stream-key ──────────────────────────────────
  app.get('/api/church/rooms/:roomId/stream-key', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = String(req.params.roomId || '').trim();
      const room = await getRoomById(roomId, churchId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const { isStreamActive, getStreamInfo } = require('./rtmpIngest');
      const active = isStreamActive(roomId);
      const info = active ? getStreamInfo(roomId) : null;
      const rtmpHost = process.env.RTMP_PUBLIC_URL || `rtmp://${req.hostname}:${Number(process.env.RTMP_PORT || 1935)}`;
      res.json({
        roomId,
        streamKey: room.stream_key,
        rtmpUrl: `${rtmpHost}/live/${room.stream_key}`,
        active,
        meta: info?.meta || null,
        startedAt: info?.startedAt || null,
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── PUT /api/church/me ────────────────────────────────────────────────────────
  app.put('/api/church/me', adminMiddleware, async (req, res) => {
    const { email, phone, location, notes, notifications, telegramChatId, engineerProfile, autoRecoveryEnabled, currentPassword, newPassword, leadershipEmails, locale, timezone, churchType, eventLabel, eventExpiresAt } = req.body;
    const churchId = req.church.churchId;

    if (newPassword) {
      if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      // Require current password for security
      if (!currentPassword) return res.status(400).json({ error: 'Current password is required to change password' });
      const row = await qOne('SELECT portal_password_hash FROM churches WHERE churchId = ?', [churchId]);
      if (!row?.portal_password_hash || !verifyPassword(currentPassword, row.portal_password_hash)) {
        return res.status(403).json({ error: 'Current password is incorrect' });
      }
      await qRun('UPDATE churches SET portal_password_hash = ? WHERE churchId = ?', [hashPassword(newPassword), churchId]);
    }

    const { audioViaAtem } = req.body;
    const allowedColumns = ['portal_email', 'phone', 'location', 'notes', 'telegram_chat_id', 'notifications', 'engineer_profile', 'auto_recovery_enabled', 'audio_via_atem', 'leadership_emails', 'locale', 'timezone', 'church_type', 'event_label', 'event_expires_at'];
    const patch = {};
    if (email          !== undefined) patch.portal_email     = email.trim().toLowerCase();
    if (phone          !== undefined) patch.phone            = phone;
    if (location       !== undefined) patch.location         = location;
    if (notes          !== undefined) patch.notes            = notes;
    if (telegramChatId !== undefined) patch.telegram_chat_id = telegramChatId;
    if (notifications  !== undefined) patch.notifications    = JSON.stringify(notifications);
    if (engineerProfile !== undefined) patch.engineer_profile = JSON.stringify(engineerProfile);
    if (autoRecoveryEnabled !== undefined) patch.auto_recovery_enabled = autoRecoveryEnabled ? 1 : 0;
    if (audioViaAtem   !== undefined) patch.audio_via_atem   = audioViaAtem ? 1 : 0;
    if (leadershipEmails !== undefined) patch.leadership_emails = String(leadershipEmails || '').trim();
    if (locale !== undefined) patch.locale = ['en', 'es'].includes(locale) ? locale : 'en';
    if (timezone !== undefined) patch.timezone = String(timezone || '').trim();
    if (churchType !== undefined) patch.church_type = ['recurring', 'event'].includes(churchType) ? churchType : 'recurring';
    if (eventLabel !== undefined) patch.event_label = String(eventLabel || '').trim().slice(0, 200);
    if (eventExpiresAt !== undefined) patch.event_expires_at = eventExpiresAt || null;

    const safePatch = Object.fromEntries(Object.entries(patch).filter(([k]) => allowedColumns.includes(k)));
    const oldEmail = req.church.portal_email;
    if (Object.keys(safePatch).length) {
      const sets = Object.keys(safePatch).map(k => `${k} = ?`).join(', ');
      await qRun(`UPDATE churches SET ${sets} WHERE churchId = ?`, [...Object.values(safePatch), churchId]);
      // Sync audio_via_atem to in-memory runtime state + mark as manual override
      if (safePatch.audio_via_atem !== undefined) {
        const runtime = churches.get(churchId);
        if (runtime) {
          runtime.audio_via_atem = safePatch.audio_via_atem;
          runtime._audioViaAtemManualOverride = true;
        }
      }
      // Send email change confirmation if portal_email changed
      if (safePatch.portal_email && safePatch.portal_email !== oldEmail && lifecycleEmails) {
        lifecycleEmails.sendEmailChangeConfirmation(req.church, { oldEmail, newEmail: safePatch.portal_email }).catch(e => console.error('[Profile] Email change confirmation failed:', e.message));
      }
    }
    // Push profile changes relevant to the desktop app
    if (safePatch.audio_via_atem !== undefined || safePatch.timezone || safePatch.auto_recovery_enabled !== undefined) {
      pushConfigToClients(churchId, 'profile', safePatch);
    }
    res.json({ ok: true });
  });


  // ── Room CRUD (flat routes) ──────────────────────────────────────────────────
  // Rooms belong directly to the authenticated church (rooms.campus_id = churchId).

  app.get('/api/church/rooms', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const runtime = churches.get(churchId);
      const roomInstanceMap = runtime?.roomInstanceMap || {};

      let rooms;
      if (req.tdRoomId) {
        // TD is scoped to a specific room — only show that room
        rooms = await qAll(
          `SELECT r.id, r.campus_id, r.name, r.description, r.created_at, r.stream_key
           FROM rooms r WHERE r.id = ? AND r.campus_id = ? AND r.deleted_at IS NULL`,
          [req.tdRoomId, churchId]
        );
      } else if (req.td) {
        // TD without room lock — show assigned rooms (or all if no assignments)
        const assigned = await qAll('SELECT room_id FROM td_room_assignments WHERE td_id = ? AND church_id = ?', [req.td.id, churchId]);
        if (assigned.length > 0) {
          const placeholders = assigned.map(() => '?').join(',');
          rooms = await qAll(
            `SELECT r.id, r.campus_id, r.name, r.description, r.created_at, r.stream_key
             FROM rooms r WHERE r.id IN (${placeholders}) AND r.campus_id = ? AND r.deleted_at IS NULL
             ORDER BY r.name ASC`,
            [...assigned.map(a => a.room_id), churchId]
          );
        } else {
          rooms = await qAll(
            `SELECT r.id, r.campus_id, r.name, r.description, r.created_at, r.stream_key
             FROM rooms r WHERE r.campus_id = ? AND r.deleted_at IS NULL
             ORDER BY r.name ASC`,
            [churchId]
          );
        }
      } else {
        rooms = await qAll(
          `SELECT r.id, r.campus_id, r.name, r.description, r.created_at, r.stream_key
           FROM rooms r WHERE r.campus_id = ? AND r.deleted_at IS NULL
           ORDER BY r.name ASC`,
          [churchId]
        );
      }

      const result = await Promise.all(rooms.map(async (r) => {
        const assigned = await qAll('SELECT churchId, name, room_name FROM churches WHERE room_id = ?', [r.id]);
        const instanceName = roomInstanceMap[r.id] || null;
        const instanceWs = instanceName && runtime?.sockets?.get(instanceName);
        return {
          id: r.id,
          campusId: r.campus_id,
          name: r.name,
          description: r.description || '',
          streamKey: r.stream_key || null,
          assignedDesktops: assigned.map(a => ({ churchId: a.churchId, name: a.name })),
          connected: !!(instanceWs && instanceWs.readyState === 1),
          instanceName,
        };
      }));
      const allRoomCount = await getRoomAssignmentCount(churchId);
      const maxRooms = maxRoomsForTier(req.church.billing_tier);
      res.json({
        rooms: result,
        currentRoomId: await getCurrentRoomId(churchId),
        limits: { usedTotal: allRoomCount || 0, maxTotal: maxRooms },
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/church/rooms', adminMiddleware, express.json(), async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const tier = String(req.church.billing_tier || 'connect').toLowerCase();
      const maxRooms = maxRoomsForTier(tier);
      const currentCount = await getRoomAssignmentCount(churchId) || 0;
      if (currentCount >= maxRooms) {
        return res.status(403).json({
          error: `Your ${tier.toUpperCase()} plan allows ${maxRooms} room${maxRooms === 1 ? '' : 's'}. Upgrade for more.`,
        });
      }
      const name = String(req.body?.name || '').trim();
      const description = String(req.body?.description || '').trim();
      if (!name) return res.status(400).json({ error: 'Room name is required' });
      if (description.length > 500) return res.status(400).json({ error: 'Room description must be 500 characters or less' });

      const id = crypto.randomUUID();
      const created_at = new Date().toISOString();
      const stream_key = crypto.randomBytes(16).toString('hex');
      await qRun('INSERT INTO rooms (id, campus_id, church_id, name, description, created_at, stream_key) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        id, churchId, churchId, name, description, created_at, stream_key,
      ]);
      onRoomCreated(churchId, id);
      res.status(201).json({ id, campusId: churchId, name, description, createdAt: created_at, streamKey: stream_key });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.patch('/api/church/rooms/:roomId', adminMiddleware, express.json(), async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = String(req.params.roomId || '').trim();
      const room = await getRoomById(roomId, churchId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const updates = [];
      const params = [];
      const { name, description } = req.body || {};
      if (name !== undefined) {
        const cleanName = String(name).trim();
        if (!cleanName) return res.status(400).json({ error: 'Room name cannot be empty' });
        updates.push('name = ?');
        params.push(cleanName);
      }
      if (description !== undefined) {
        const cleanDesc = String(description).trim();
        if (cleanDesc.length > 500) return res.status(400).json({ error: 'Room description must be 500 characters or less' });
        updates.push('description = ?');
        params.push(cleanDesc);
      }
      if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
      params.push(roomId);
      await qRun(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, params);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/church/rooms/:roomId', adminMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = String(req.params.roomId || '').trim();
      const room = await qOne('SELECT id, name FROM rooms WHERE id = ? AND campus_id = ? AND deleted_at IS NULL', [roomId, churchId]);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      await qRun('UPDATE rooms SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), roomId]);
      await qRun('DELETE FROM problem_finder_reports WHERE church_id = ? AND instance_name = ?', [churchId, roomId]);
      await qRun('DELETE FROM preservice_check_results WHERE church_id = ? AND instance_name = ?', [churchId, roomId]);
      await qRun('DELETE FROM alerts WHERE church_id = ? AND instance_name = ?', [churchId, roomId]);
      await qRun('DELETE FROM service_events WHERE church_id = ? AND instance_name = ?', [churchId, roomId]);
      await qRun('DELETE FROM room_equipment WHERE room_id = ? AND church_id = ?', [roomId, churchId]);
      await qRun('UPDATE churches SET room_id = NULL, room_name = NULL WHERE room_id = ? AND churchId = ?', [roomId, churchId]);
      await qRun('DELETE FROM td_room_assignments WHERE room_id = ? AND church_id = ?', [roomId, churchId]);
      onRoomDeleted(churchId, roomId);

      const runtime = churches.get(churchId);
      if (runtime?.roomInstanceMap?.[roomId]) {
        const instanceName = runtime.roomInstanceMap[roomId];
        const sock = runtime.sockets?.get(instanceName);
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ type: 'room_deleted', roomId, roomName: room.name }));
        }
        if (runtime.instanceStatus?.[instanceName]) {
          delete runtime.instanceStatus[instanceName];
        }
        delete runtime.roomInstanceMap[roomId];
      }

      if (broadcastToPortal) {
        broadcastToPortal(churchId, {
          type: 'room_deleted',
          roomId,
          roomName: room.name,
          instanceStatus: runtime?.instanceStatus || {},
          roomInstanceMap: runtime?.roomInstanceMap || {},
        });
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/rooms/:roomId/restore — restore a soft-deleted room (within 30 days)
  app.post('/api/church/rooms/:roomId/restore', adminMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = String(req.params.roomId || '').trim();
      const room = await getRoomByIdIncludingDeleted(roomId, churchId);
      if (!room || !room.deleted_at) return res.status(404).json({ error: 'Deleted room not found' });

      const deletedAt = new Date(room.deleted_at);
      const daysSinceDelete = (Date.now() - deletedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceDelete > 30) {
        return res.status(410).json({ error: 'Room was deleted more than 30 days ago and cannot be restored' });
      }

      await qRun('UPDATE rooms SET deleted_at = NULL WHERE id = ?', [roomId]);
      onRoomRestored(churchId, roomId);
      res.json({ ok: true, roomId, roomName: room.name });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── Smart Plugs CRUD + Power Control ─────────────────────────────────────────

  // GET /api/church/smart-plugs — list saved + live-discovered plugs
  app.get('/api/church/smart-plugs', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      let saved;
      if (req.tdRoomId) {
        saved = await qAll('SELECT * FROM smart_plugs WHERE church_id = ? AND room_id = ? ORDER BY created_at', [churchId, req.tdRoomId]);
      } else {
        saved = await qAll('SELECT * FROM smart_plugs WHERE church_id = ? ORDER BY created_at', [churchId]);
      }

      // Merge with live status from the church client
      const runtime = churches.get(churchId);
      const livePlugs = [];
      if (runtime?.instanceStatus) {
        for (const inst of Object.values(runtime.instanceStatus)) {
          if (Array.isArray(inst.smartPlugs)) {
            for (const p of inst.smartPlugs) livePlugs.push(p);
          }
        }
      }
      // Also check the flattened status
      if (runtime?.status?.smartPlugs && Array.isArray(runtime.status.smartPlugs)) {
        for (const p of runtime.status.smartPlugs) {
          if (!livePlugs.some(lp => lp.ip === p.ip)) livePlugs.push(p);
        }
      }

      // Merge: saved plugs get live status overlaid, live-only plugs appended
      const merged = saved.map(s => {
        const live = livePlugs.find(lp => lp.ip === s.plug_ip);
        return { ...s, live: live || null };
      });
      // Append any live plugs not in DB (auto-discovered)
      for (const lp of livePlugs) {
        if (!saved.some(s => s.plug_ip === lp.ip)) {
          merged.push({ id: null, church_id: churchId, plug_ip: lp.ip, plug_name: lp.name, room_id: null, assigned_device: '', created_at: null, live: lp });
        }
      }

      res.json({ plugs: merged });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/smart-plugs — save/assign a plug
  app.post('/api/church/smart-plugs', authMiddleware, express.json(), async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const { plugIp, plugName, roomId, assignedDevice } = req.body;
      if (!plugIp) return res.status(400).json({ error: 'plugIp required' });

      const id = crypto.randomUUID();
      await qRun(
        'INSERT INTO smart_plugs (id, church_id, plug_ip, plug_name, room_id, assigned_device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, churchId, plugIp.trim(), (plugName || '').trim(), roomId || null, (assignedDevice || '').trim(), new Date().toISOString()]
      );

      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // PATCH /api/church/smart-plugs/:plugId — update plug assignment
  app.patch('/api/church/smart-plugs/:plugId', authMiddleware, express.json(), async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const plugId = req.params.plugId;
      const existing = await qOne('SELECT * FROM smart_plugs WHERE id = ? AND church_id = ?', [plugId, churchId]);
      if (!existing) return res.status(404).json({ error: 'Plug not found' });

      const { plugName, roomId, assignedDevice } = req.body;
      if (plugName !== undefined) await qRun('UPDATE smart_plugs SET plug_name = ? WHERE id = ?', [plugName.trim(), plugId]);
      if (roomId !== undefined) await qRun('UPDATE smart_plugs SET room_id = ? WHERE id = ?', [roomId || null, plugId]);
      if (assignedDevice !== undefined) await qRun('UPDATE smart_plugs SET assigned_device = ? WHERE id = ?', [assignedDevice.trim(), plugId]);

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // DELETE /api/church/smart-plugs/:plugId
  app.delete('/api/church/smart-plugs/:plugId', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const plugId = req.params.plugId;
      const result = await qRun('DELETE FROM smart_plugs WHERE id = ? AND church_id = ?', [plugId, churchId]);
      if (!result.changes) return res.status(404).json({ error: 'Plug not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/smart-plugs/:plugIp/power-cycle — power cycle via WebSocket
  app.post('/api/church/smart-plugs/:plugIp/power-cycle', authMiddleware, express.json(), (req, res) => {
    try {
      const churchId = req.church.churchId;
      const plugIp = req.params.plugIp;
      const delayMs = Number(req.body?.delayMs) || 5000;
      const runtime = churches.get(churchId);
      if (!runtime?.sockets?.size) return res.status(409).json({ error: 'Church client not connected' });

      const payload = JSON.stringify({ type: 'smart_plug_command', action: 'power_cycle', plugId: plugIp, delayMs });
      for (const sock of runtime.sockets.values()) {
        if (sock.readyState === 1) sock.send(payload);
      }
      res.json({ sent: true, action: 'power_cycle', plugIp, delayMs });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/smart-plugs/:plugIp/toggle — toggle via WebSocket
  app.post('/api/church/smart-plugs/:plugIp/toggle', authMiddleware, express.json(), (req, res) => {
    try {
      const churchId = req.church.churchId;
      const plugIp = req.params.plugIp;
      const action = req.body?.on === true ? 'turn_on' : req.body?.on === false ? 'turn_off' : 'toggle';
      const runtime = churches.get(churchId);
      if (!runtime?.sockets?.size) return res.status(409).json({ error: 'Church client not connected' });

      const payload = JSON.stringify({ type: 'smart_plug_command', action, plugId: plugIp });
      for (const sock of runtime.sockets.values()) {
        if (sock.readyState === 1) sock.send(payload);
      }
      res.json({ sent: true, action, plugIp });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/room-assign — assign this church/desktop to a room
  app.post('/api/church/room-assign', adminMiddleware, express.json(), async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = req.body?.roomId || null;
      if (roomId) {
        const room = await qOne('SELECT r.id, r.name FROM rooms r WHERE r.id = ? AND r.campus_id = ? AND r.deleted_at IS NULL', [roomId, churchId]);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        await qRun('UPDATE churches SET room_id = ?, room_name = ? WHERE churchId = ?', [roomId, room.name, churchId]);
        res.json({ ok: true, roomId, roomName: room.name });
      } else {
        await qRun('UPDATE churches SET room_id = NULL, room_name = NULL WHERE churchId = ?', [churchId]);
        res.json({ ok: true, roomId: null, roomName: null });
      }
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/problems ─────────────────────────────────────────────────
  // Returns latest Tally Engineer report for the authenticated church.
  app.get('/api/church/problems', authMiddleware, async (req, res) => {
    try {
      const targetId = req.church.churchId;
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);
      let row = null;
      if (instanceName) {
        row = await qOne(
          'SELECT * FROM problem_finder_reports WHERE church_id = ? AND instance_name = ? ORDER BY created_at DESC LIMIT 1',
          [targetId, instanceName]
        );
      }
      if (!row && !roomId) {
        row = await qOne(
          'SELECT * FROM problem_finder_reports WHERE church_id = ? ORDER BY created_at DESC LIMIT 1',
          [targetId]
        );
      }
      if (!row) return res.json({ status: null, message: 'No reports yet' });
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/preservice-check ──────────────────────────────────────────
  // Returns the latest pre-service check result for the authenticated church.
  app.get('/api/church/preservice-check', supportAuthMiddleware, async (req, res) => {
    try {
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);
      let row = null;
      if (instanceName) {
        row = await qOne(
          'SELECT * FROM preservice_check_results WHERE church_id = ? AND instance_name = ? ORDER BY created_at DESC LIMIT 1',
          [req.church.churchId, instanceName]
        );
      }
      if (!row && roomId) {
        row = await qOne(
          'SELECT * FROM preservice_check_results WHERE church_id = ? AND room_id = ? ORDER BY created_at DESC LIMIT 1',
          [req.church.churchId, roomId]
        );
      }
      if (!row) {
        row = await qOne(
          'SELECT * FROM preservice_check_results WHERE church_id = ? ORDER BY created_at DESC LIMIT 1',
          [req.church.churchId]
        );
      }
      if (!row) return res.json(null);
      if (roomId) {
        try {
          const checks = JSON.parse(row.checks_json || '[]');
          const filtered = await filterChecksByRoomEquipment(checks, roomId, req.church.churchId, portalQuery);
          row = { ...row, checks_json: JSON.stringify(filtered) };
        } catch { /* return unfiltered */ }
      }
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/preservice-check/run ───────────────────────────────────
  // Triggers a manual pre-service check via WebSocket command to the church client.
  app.post('/api/church/preservice-check/run', supportAuthMiddleware, async (req, res) => {
    try {
      if (!preServiceCheck) return res.status(503).json({ error: 'Pre-service check not available' });
      const instanceName = resolveRoomInstance(req, churches) || null;
      const result = await preServiceCheck.runManualCheck(req.church.churchId, instanceName);
      if (!result) return res.json({ result: null, message: 'Client offline or no response' });
      // Filter checks by room equipment config
      const roomId = getEffectiveRoomId(req);
      if (roomId && result.checks) {
        result.checks = await filterChecksByRoomEquipment(result.checks, roomId, req.church.churchId, portalQuery);
        result.pass = result.checks.every(c => c.pass);
      }
      res.json({ result });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/preservice-check/fix-all ────────────────────────────────
  // Sends fix commands for all auto-fixable failures from the latest pre-service check.
  app.post('/api/church/preservice-check/fix-all', supportAuthMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const churchRuntime = churches.get(churchId);
      const instanceName = resolveRoomInstance(req, churches) || null;
      // Pick the specific instance socket if requested, else fall back to default
      const targetWs = getSocketForInstance(churchRuntime, instanceName);
      if (!targetWs) {
        return res.json({ results: [], message: 'Client offline' });
      }

      // Get latest check results
      const row = await qOne(
        'SELECT checks_json FROM preservice_check_results WHERE church_id = ? ORDER BY created_at DESC LIMIT 1',
        [churchId]
      );
      if (!row) return res.json({ results: [], message: 'No check results' });

      let checks = [];
      try { checks = JSON.parse(row.checks_json || '[]'); } catch {}

      // Map of check names to fix commands
      const FIX_MAP = {
        'Main Output': { command: 'mixer.unmute', params: { channel: 'master' } },
      };

      const failures = checks.filter(c => !c.pass && FIX_MAP[c.name]);
      if (!failures.length) return res.json({ results: [], message: 'No auto-fixable issues' });

      const crypto = require('crypto');
      const results = [];

      for (const check of failures) {
        const fix = FIX_MAP[check.name];
        const msgId = crypto.randomUUID();
        try {
          const resultPromise = new Promise((resolve) => {
            const timer = setTimeout(() => { cleanup(); resolve({ success: false, error: 'timeout' }); }, 8000);
            const handler = (msg) => {
              if (msg.type === 'command_result' && msg.churchId === churchId && msg.messageId === msgId) {
                cleanup();
                resolve(msg.error ? { success: false, error: msg.error } : { success: true });
              }
            };
            const cleanup = () => {
              clearTimeout(timer);
              if (preServiceCheck) {
                const idx = preServiceCheck._resultListeners.indexOf(handler);
                if (idx !== -1) preServiceCheck._resultListeners.splice(idx, 1);
              }
            };
            if (preServiceCheck) preServiceCheck._resultListeners.push(handler);
          });

          targetWs.send(JSON.stringify({ type: 'command', command: fix.command, params: fix.params || {}, id: msgId }));
          const result = await resultPromise;
          results.push({ check: check.name, command: fix.command, ...result });
        } catch (e) {
          results.push({ check: check.name, command: fix.command, success: false, error: e.message });
        }
      }

      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── RUNDOWN ENDPOINTS ─────────────────────────────────────────────────────────

  app.get('/api/church/rundowns', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.json([]);
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);
      res.json(rundownEngine.getRundowns(req.church.churchId, { instanceName, roomId }));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundowns', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const { name, steps } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);
      const rundown = rundownEngine.createRundown(req.church.churchId, name.trim(), steps || [], { instanceName, roomId });
      res.json(rundown);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/church/rundowns/:id', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const rundown = rundownEngine.getRundown(req.params.id);
      if (!rundown || rundown.church_id !== req.church.churchId) return res.status(404).json({ error: 'Rundown not found' });
      res.json(rundown);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.put('/api/church/rundowns/:id', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const existing = rundownEngine.getRundown(req.params.id);
      if (!existing || existing.church_id !== req.church.churchId) return res.status(404).json({ error: 'Rundown not found' });
      const { name, steps } = req.body;
      const updated = rundownEngine.updateRundown(req.params.id, { name, steps });
      res.json(updated);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.delete('/api/church/rundowns/:id', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const existing = rundownEngine.getRundown(req.params.id);
      if (!existing || existing.church_id !== req.church.churchId) return res.status(404).json({ error: 'Rundown not found' });
      res.json(rundownEngine.deleteRundown(req.params.id));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundowns/:id/activate', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const { instanceName } = getRequestedRoomContext(req, churches);
      const result = rundownEngine.activateRundown(req.church.churchId, req.params.id, instanceName);
      if (!result) return res.status(404).json({ error: 'Rundown not found' });
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/church/rundown/active', supportAuthMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.json({ active: false });
      const { instanceName } = getRequestedRoomContext(req, churches);
      const active = rundownEngine.getActiveRundown(req.church.churchId, instanceName);
      if (!active) return res.json({ active: false });
      const current = rundownEngine.getCurrentStep(req.church.churchId, instanceName);
      res.json({ active: true, ...active, ...current });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundown/advance', supportAuthMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const { instanceName } = getRequestedRoomContext(req, churches);
      const result = rundownEngine.advanceStep(req.church.churchId, instanceName);
      if (!result) return res.status(400).json({ error: 'Cannot advance — at last step or no active rundown' });
      const current = rundownEngine.getCurrentStep(req.church.churchId, instanceName);
      res.json({ ...result, ...current });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundown/execute', supportAuthMiddleware, async (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const { instanceName } = getRequestedRoomContext(req, churches);
      const current = rundownEngine.getCurrentStep(req.church.churchId, instanceName);
      if (!current || !current.step) return res.status(400).json({ error: 'No active step' });

      const commands = current.step.commands || [];
      if (commands.length === 0) return res.json({ executed: true, results: [] });

      const churchId = req.church.churchId;
      const churchRuntime = churches.get(churchId);
      const targetWs = getSocketForInstance(churchRuntime, instanceName);
      if (!targetWs) {
        return res.status(503).json({ error: 'Church client offline' });
      }

      const crypto = require('crypto');
      const results = [];
      for (const cmd of commands) {
        const msgId = crypto.randomUUID();
        try {
          targetWs.send(JSON.stringify({
            type: 'command',
            command: cmd.command,
            params: cmd.params || {},
            messageId: msgId,
            source: 'rundown',
          }));
          results.push({ command: cmd.command, sent: true });
        } catch (e) {
          results.push({ command: cmd.command, sent: false, error: e.message });
        }
      }
      res.json({ executed: true, results, step: current });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundown/deactivate', supportAuthMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const { instanceName } = getRequestedRoomContext(req, churches);
      res.json(rundownEngine.deactivateRundown(req.church.churchId, instanceName));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── POST /api/church/rundown/jump ──────────────────────────────────────────
  // Jump to a specific step in the active rundown by index.
  app.post('/api/church/rundown/jump', supportAuthMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const { stepIndex } = req.body;
      if (stepIndex == null || typeof stepIndex !== 'number') {
        return res.status(400).json({ error: 'stepIndex (number) required' });
      }
      const { instanceName } = getRequestedRoomContext(req, churches);
      const result = rundownEngine.goToStep(req.church.churchId, stepIndex, instanceName);
      if (!result) return res.status(400).json({ error: 'Cannot jump — invalid step or no active rundown' });
      const current = rundownEngine.getCurrentStep(req.church.churchId, instanceName);
      res.json({ ...result, ...current });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── PRE-SERVICE RUNDOWN ENDPOINTS ─────────────────────────────────────────────

  // GET /api/church/rundown/status — Get the active pre-service rundown
  app.get('/api/church/rundown/status', supportAuthMiddleware, async (req, res) => {
    try {
      if (!preServiceRundown) return res.json({ active: false });
      const churchId = req.church.churchId;
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);

      // Try in-memory first, then DB fallback
      let rundown = preServiceRundown.getActiveRundown(churchId, instanceName, roomId);
      if (!rundown) {
        rundown = preServiceRundown.getLatestRundown(churchId, instanceName, roomId);
      }
      if (!rundown) return res.json({ active: false });

      res.json({ active: true, ...rundown });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // POST /api/church/rundown/confirm — Confirm "All Clear"
  app.post('/api/church/rundown/confirm', authMiddleware, (req, res) => {
    try {
      if (!preServiceRundown) return res.status(503).json({ error: 'Pre-service rundown not available' });
      const churchId = req.church.churchId;
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);
      const confirmedBy = req.body.confirmedBy || req.church.churchName || 'portal';
      const confirmedVia = req.body.confirmedVia || 'portal';

      const result = preServiceRundown.confirm(churchId, confirmedBy, confirmedVia, instanceName, roomId);
      if (!result) return res.status(404).json({ error: 'No active rundown to confirm' });
      res.json({ confirmed: true, confirmedBy, confirmedAt: result.confirmation.confirmedAt });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // POST /api/church/rundown/generate — Manually trigger a rundown generation
  app.post('/api/church/rundown/generate', authMiddleware, async (req, res) => {
    try {
      if (!preServiceRundown) return res.status(503).json({ error: 'Pre-service rundown not available' });
      const churchId = req.church.churchId;
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);
      const rundown = await preServiceRundown.generate(churchId, instanceName, roomId);
      if (!rundown) return res.status(500).json({ error: 'Failed to generate rundown' });

      // Generate AI summary in background
      preServiceRundown.generateAISummary(churchId, instanceName, roomId).catch(() => {});

      res.json(rundown);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // GET /api/church/rundown/viewer-baseline — Get viewer baseline for next service
  app.get('/api/church/rundown/viewer-baseline', supportAuthMiddleware, async (req, res) => {
    try {
      if (!viewerBaseline) return res.json({});
      const churchId = req.church.churchId;
      const day = req.query.day != null ? parseInt(req.query.day, 10) : new Date().getDay();
      const baseline = await viewerBaseline.getBaseline(churchId, day);
      res.json(baseline);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // GET /api/church/rundown/escalation-contacts — List escalation contacts
  app.get('/api/church/rundown/escalation-contacts', authMiddleware, (req, res) => {
    try {
      if (!preServiceRundown) return res.json([]);
      res.json(preServiceRundown.getEscalationContacts(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // POST /api/church/rundown/escalation-contacts — Add escalation contact
  app.post('/api/church/rundown/escalation-contacts', authMiddleware, (req, res) => {
    try {
      if (!preServiceRundown) return res.status(503).json({ error: 'Not available' });
      const { role, name, contactType, contactValue, notifyOn } = req.body;
      if (!role || !name || !contactType || !contactValue) {
        return res.status(400).json({ error: 'role, name, contactType, contactValue required' });
      }
      const allowed = ['backup_td', 'pastor', 'admin'];
      if (!allowed.includes(role)) return res.status(400).json({ error: `role must be one of: ${allowed.join(', ')}` });

      const contact = preServiceRundown.addEscalationContact(req.church.churchId, { role, name, contactType, contactValue, notifyOn });
      res.json(contact);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // DELETE /api/church/rundown/escalation-contacts/:id — Remove escalation contact
  app.delete('/api/church/rundown/escalation-contacts/:id', authMiddleware, (req, res) => {
    try {
      if (!preServiceRundown) return res.status(503).json({ error: 'Not available' });
      preServiceRundown.removeEscalationContact(req.params.id);
      res.json({ removed: true });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // GET /api/church/rundown/history — Get recent pre-service rundown history
  app.get('/api/church/rundown/history', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);
      const rows = await qAll(
        'SELECT id, church_id, service_time, overall_status, confirmed_by, confirmed_at, escalation_level, ai_summary, created_at FROM preservice_rundowns WHERE church_id = ? ORDER BY created_at DESC LIMIT ?',
        [req.church.churchId, limit]
      );
      res.json(rows);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // GET /api/church/rundown/escalation-settings — Get escalation config
  app.get('/api/church/rundown/escalation-settings', authMiddleware, async (req, res) => {
    try {
      const row = await qOne('SELECT escalation_enabled, escalation_timing_json FROM churches WHERE churchId = ?', [req.church.churchId]);
      res.json({
        enabled: !!(row?.escalation_enabled),
        timing: row?.escalation_timing_json ? JSON.parse(row.escalation_timing_json) : { remind: 20, backup: 15, pastor: 10, unconfirmed: 5 },
      });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // PUT /api/church/rundown/escalation-settings — Update escalation config
  app.put('/api/church/rundown/escalation-settings', authMiddleware, async (req, res) => {
    try {
      const { enabled, timing } = req.body;
      const updates = [];
      const vals = [];
      if (enabled !== undefined) { updates.push('escalation_enabled = ?'); vals.push(enabled ? 1 : 0); }
      if (timing) { updates.push('escalation_timing_json = ?'); vals.push(JSON.stringify(timing)); }
      if (updates.length === 0) return res.status(400).json({ error: 'No settings to update' });
      vals.push(req.church.churchId);
      await qRun(`UPDATE churches SET ${updates.join(', ')} WHERE churchId = ?`, vals);
      res.json({ updated: true });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── POST /api/church/app/send-command ──────────────────────────────────────
  // Sends a command to the church client via WebSocket, accessible with church
  // app Bearer tokens (used by the Electron troubleshooter auto-actions).
  app.post('/api/church/app/send-command', supportAuthMiddleware, (req, res) => {
    const { command, params } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });

    const ALLOWED_APP_COMMANDS = new Set([
      'restart_stream', 'stop_stream', 'start_recording', 'stop_recording',
      'reconnect_obs', 'reconnect_atem', 'reconnect_encoder', 'restart_encoder',
      'system.diagnosticBundle', 'system.preServiceCheck',
      'mixer.unmute', 'mixer.mute', 'mixer.recallScene',
      'atem.runMacro', 'obs.setScene', 'vmix.function', 'vmix.setProgram',
      'shelly.turnOn', 'shelly.turnOff', 'shelly.toggle', 'shelly.powerCycle', 'shelly.status',
    ]);

    if (!ALLOWED_APP_COMMANDS.has(command)) {
      return res.status(400).json({ error: `Unknown command: ${command}. Allowed: ${[...ALLOWED_APP_COMMANDS].join(', ')}` });
    }

    const churchId = req.church.churchId;
    const runtime = churches.get(churchId);
    const openSockets = [];
    if (runtime?.sockets?.size) {
      // If TD is room-scoped, only send to the socket for that room
      if (req.tdRoomId && runtime.roomInstanceMap) {
        const instName = runtime.roomInstanceMap[req.tdRoomId];
        if (instName) {
          const sock = runtime.sockets.get(instName);
          if (sock && sock.readyState === 1) openSockets.push(sock);
        }
      } else {
        for (const sock of runtime.sockets.values()) {
          if (sock.readyState === 1) openSockets.push(sock);
        }
      }
    }
    if (openSockets.length === 0) {
      return res.status(409).json({ error: 'Church client is not connected' });
    }

    const crypto = require('crypto');
    const commandId = crypto.randomUUID();
    const payload = JSON.stringify({
      type: 'command',
      id: commandId,
      command,
      params: params || {},
      source: 'app',
    });
    try {
      for (const sock of openSockets) sock.send(payload);
      res.json({ sent: true, commandId });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e, 'Failed to send command') });
    }
  });

  // ── Scheduler routes (church portal) ────────────────────────────────────────
  app.post('/api/church/scheduler/activate', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.activate(req.church.churchId, req.body.rundownId);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/advance', authMiddleware, async (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = await scheduler.advance(req.church.churchId);
      if (result?.error) return res.status(400).json(result);
      res.json(result || { error: 'Could not advance' });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/skip', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.skip(req.church.churchId);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/back', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.goBack(req.church.churchId);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/jump', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.jumpToCue(req.church.churchId, Number(req.body.cueIndex));
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/pause', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      res.json(scheduler.pause(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/resume', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.resume(req.church.churchId);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/deactivate', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      res.json(scheduler.deactivate(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/church/scheduler/status', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.json({ active: false });
      res.json(scheduler.getStatus(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── GET /api/church/coaching ──────────────────────────────────────────────────
  // Returns weekly coaching data: patterns, reliability, auto-recovery stats.
  app.get('/api/church/coaching', authMiddleware, async (req, res) => {
    try {
      if (!weeklyDigest) return res.json(null);
      const data = await weeklyDigest.getChurchDigest(req.church.churchId);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/session/active ────────────────────────────────────────────
  // Returns the active session with recent events for the live incident card.
  app.get('/api/church/session/active', authMiddleware, async (req, res) => {
    try {
      if (!sessionRecap) return res.json({ active: false });
      const session = sessionRecap.getActiveSession(req.church.churchId);
      if (!session) return res.json({ active: false });

      const instanceName = resolveRoomInstance(req, churches);

      // Get events for this session with diagnosis info
      let events = [];
      try {
        const { DIAGNOSIS_TEMPLATES } = require('./alertEngine');
        let eventRows;
        if (instanceName) {
          eventRows = await qAll(
            'SELECT * FROM service_events WHERE session_id = ? AND instance_name = ? ORDER BY timestamp DESC LIMIT 20',
            [session.sessionId, instanceName]
          );
          // Fall back to all events if no room-specific ones
          if (!eventRows.length) {
            eventRows = await qAll(
              'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 20',
              [session.sessionId]
            );
          }
        } else {
          eventRows = await qAll(
            'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 20',
            [session.sessionId]
          );
        }
        events = eventRows.map(e => ({
          ...e,
          resolved: !!e.resolved,
          auto_resolved: !!e.auto_resolved,
          diagnosis: DIAGNOSIS_TEMPLATES[e.event_type] || null,
        }));
      } catch { /* service_events table may not exist */ }

      res.json({ active: true, ...session, events });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/dashboard/stats ───────────────────────────────────────────
  // Quick-stats card: this week summary, alert trend, equipment health, next service
  app.get('/api/church/dashboard/stats', authMiddleware, async (req, res) => {
    try {
      const stats = await getDashboardStats(portalQuery, req.church.churchId, churches);
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/schedule ──────────────────────────────────────────────────
  app.get('/api/church/schedule', authMiddleware, async (req, res) => {
    try {
      const row = await qOne('SELECT schedule FROM churches WHERE churchId = ?', [req.church.churchId]);
      const sched = (row && row.schedule) ? JSON.parse(row.schedule) : {};
      res.json(sched);
    } catch { res.json({}); }
  });

  // ── PUT /api/church/schedule ──────────────────────────────────────────────────
  app.put('/api/church/schedule', adminMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      await qRun('UPDATE churches SET schedule = ? WHERE churchId = ?', [JSON.stringify(req.body), churchId]);
      const runtime = churches.get(churchId);
      if (runtime) runtime.schedule = req.body;
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── GET /api/church/tds ───────────────────────────────────────────────────────
  app.get('/api/church/tds', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const tds = await qAll('SELECT * FROM church_tds WHERE church_id = ? ORDER BY registered_at ASC', [churchId]);
      const withAssignments = await Promise.all(tds.map(async (td) => {
        const { password_hash, ...safe } = td;
        safe.has_password = !!password_hash;
        try {
          safe.roomAssignments = await qAll(
            `SELECT tra.room_id, r.name AS room_name
             FROM td_room_assignments tra
             JOIN rooms r ON r.id = tra.room_id AND r.deleted_at IS NULL
             WHERE tra.td_id = ? AND tra.church_id = ?
             ORDER BY r.name ASC`,
            [td.id, churchId]
          );
        } catch {
          safe.roomAssignments = [];
        }
        return safe;
      }));
      res.json(withAssignments);
    } catch {
      res.json([]);
    }
  });

  // ── POST /api/church/tds ──────────────────────────────────────────────────────
  app.post('/api/church/tds', adminMiddleware, async (req, res) => {
    const { name, role, email, phone, accessLevel } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const validAccessLevels = ['viewer', 'operator', 'admin'];
    const resolvedAccessLevel = validAccessLevels.includes(accessLevel) ? accessLevel : 'operator';
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const registeredAt = new Date().toISOString();
    try {
      try {
        await qRun(
          'INSERT INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active, role, email, phone, access_level) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
          [req.church.churchId, `portal_${id}`, `portal_${id}`, name, registeredAt, role || 'td', email || '', phone || '', resolvedAccessLevel]
        );
      } catch {
        // Fallback if access_level column doesn't exist yet (migration pending)
        await qRun(
          'INSERT INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active, role, email, phone) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
          [req.church.churchId, `portal_${id}`, `portal_${id}`, name, registeredAt, role || 'td', email || '', phone || '']
        );
      }
      res.json({ id, name, role, accessLevel: resolvedAccessLevel, email, phone });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── DELETE /api/church/tds/:tdId ──────────────────────────────────────────────
  app.delete('/api/church/tds/:tdId', adminMiddleware, async (req, res) => {
    const churchId = req.church.churchId;
    const tdId = req.params.tdId;
    await qRun('DELETE FROM td_room_assignments WHERE td_id = ? AND church_id = ?', [tdId, churchId]);
    await qRun('DELETE FROM church_tds WHERE id = ? AND church_id = ?', [tdId, churchId]);
    res.json({ ok: true });
  });

  // ── MACROS CRUD ───────────────────────────────────────────────────────────────
  const { v4: _uuid } = require('uuid');

  app.get('/api/church/macros', authMiddleware, async (req, res) => {
    try {
      const macros = await qAll('SELECT * FROM church_macros WHERE church_id = ? ORDER BY name ASC', [req.church.churchId]);
      res.json(macros.map(m => ({
        ...m,
        steps: (() => { try { return JSON.parse(m.steps || '[]'); } catch { return []; } })(),
      })));
    } catch { res.json([]); }
  });

  app.get('/api/church/macros/:id', authMiddleware, async (req, res) => {
    const m = await qOne('SELECT * FROM church_macros WHERE id = ? AND church_id = ?', [req.params.id, req.church.churchId]);
    if (!m) return res.status(404).json({ error: 'Macro not found' });
    res.json({ ...m, steps: (() => { try { return JSON.parse(m.steps || '[]'); } catch { return []; } })() });
  });

  app.post('/api/church/macros', adminMiddleware, async (req, res) => {
    const { name, description, steps } = req.body;
    if (!name || !/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid macro name (lowercase, numbers, underscores only)' });
    if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'steps array required' });
    const reserved = ['start', 'stop', 'status', 'help', 'register', 'fix', 'menu', 'history', 'macros'];
    if (reserved.includes(name)) return res.status(400).json({ error: `"${name}" is a reserved command name` });
    const id = _uuid();
    const now = new Date().toISOString();
    try {
      await qRun('INSERT INTO church_macros (id, church_id, name, description, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        id, req.church.churchId, name, description || '', JSON.stringify(steps), now, now,
      ]);
      res.json({ id, name, description, steps });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: `Macro "/${name}" already exists` });
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.put('/api/church/macros/:id', adminMiddleware, async (req, res) => {
    const { name, description, steps } = req.body;
    if (!name || !/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid macro name' });
    if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'steps array required' });
    const now = new Date().toISOString();
    try {
      await qRun('UPDATE church_macros SET name = ?, description = ?, steps = ?, updated_at = ? WHERE id = ? AND church_id = ?', [
        name, description || '', JSON.stringify(steps), now, req.params.id, req.church.churchId,
      ]);
      res.json({ ok: true });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: `Macro "/${name}" already exists` });
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/church/macros/:id', adminMiddleware, async (req, res) => {
    await qRun('DELETE FROM church_macros WHERE id = ? AND church_id = ?', [req.params.id, req.church.churchId]);
    res.json({ ok: true });
  });

  // ── GET /api/church/td-invite-link ────────────────────────────────────────────
  // Returns a Telegram deep link that auto-registers the TD when clicked.
  app.get('/api/church/td-invite-link', adminMiddleware, (req, res) => {
    const church = req.church;
    const code = church.registration_code;
    if (!code) return res.status(404).json({ error: 'No registration code found' });
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'TallyConnectBot';
    const deepLink = `https://t.me/${botUsername}?start=reg_${code}`;
    res.json({ link: deepLink, code, botUsername });
  });

  // ── GET /api/church/sessions ──────────────────────────────────────────────────
  app.get('/api/church/sessions', authMiddleware, async (req, res) => {
    try {
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);
      let sessions;
      if (instanceName) {
        sessions = await qAll(
          'SELECT * FROM service_sessions WHERE church_id = ? AND instance_name = ? ORDER BY started_at DESC LIMIT 20',
          [req.church.churchId, instanceName]
        );
        if (!sessions.length && !roomId) {
          sessions = await qAll(
            'SELECT * FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT 20',
            [req.church.churchId]
          );
        }
      } else {
        sessions = await qAll(
          'SELECT * FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT 20',
          [req.church.churchId]
        );
      }
      res.json(sessions);
    } catch { res.json([]); }
  });

  // ── PUT /api/church/sessions/:sessionId/type ─────────────────────────────────
  // Override session type classification (test ↔ service).
  app.put('/api/church/sessions/:sessionId/type', authMiddleware, async (req, res) => {
    try {
      const { type } = req.body;
      if (type !== 'service' && type !== 'test') {
        return res.status(400).json({ error: 'type must be "service" or "test"' });
      }
      const session = await qOne('SELECT * FROM service_sessions WHERE id = ? AND church_id = ?', [req.params.sessionId, req.church.churchId]);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      await ensureSessionTypeColumn();
      await qRun('UPDATE service_sessions SET session_type = ? WHERE id = ?', [type, req.params.sessionId]);
      res.json({ updated: true, session_type: type });
    } catch (e) { res.status(500).json({ error: 'Failed to update session type' }); }
  });

  // ── GET /api/church/service-reports ───────────────────────────────────────────
  // Returns recent post-service AI reports.
  app.get('/api/church/service-reports', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);
      const { roomId, instanceName } = getRequestedRoomContext(req, churches);
      const testSessionPredicate = await getTestSessionPredicate('service_sessions.session_type');
      let reports;
      if (instanceName) {
        reports = await qAll(
          `SELECT id, church_id, session_id, created_at, duration_minutes, uptime_pct,
                  grade, alert_count, auto_recovered_count, failover_count, peak_viewers,
                  stream_runtime_minutes, recommendations, ai_summary
           FROM post_service_reports WHERE church_id = ? AND instance_name = ?
                  AND NOT EXISTS (SELECT 1 FROM service_sessions WHERE id = post_service_reports.session_id AND ${testSessionPredicate})
                  ORDER BY created_at DESC LIMIT ?`,
          [req.church.churchId, instanceName, limit]
        );
        if (!reports.length && !roomId) {
          reports = await qAll(
            `SELECT id, church_id, session_id, created_at, duration_minutes, uptime_pct,
                    grade, alert_count, auto_recovered_count, failover_count, peak_viewers,
                    stream_runtime_minutes, recommendations, ai_summary
             FROM post_service_reports WHERE church_id = ?
                    AND NOT EXISTS (SELECT 1 FROM service_sessions WHERE id = post_service_reports.session_id AND ${testSessionPredicate})
                    ORDER BY created_at DESC LIMIT ?`,
            [req.church.churchId, limit]
          );
        }
      } else {
        reports = await qAll(
          `SELECT id, church_id, session_id, created_at, duration_minutes, uptime_pct,
                  grade, alert_count, auto_recovered_count, failover_count, peak_viewers,
                  stream_runtime_minutes, recommendations, ai_summary
           FROM post_service_reports WHERE church_id = ?
                  AND NOT EXISTS (SELECT 1 FROM service_sessions WHERE id = post_service_reports.session_id AND ${testSessionPredicate})
                  ORDER BY created_at DESC LIMIT ?`,
          [req.church.churchId, limit]
        );
      }
      res.json(reports.map(r => ({
        ...r,
        recommendations: (() => { try { return JSON.parse(r.recommendations || '[]'); } catch { return []; } })(),
      })));
    } catch { res.json([]); }
  });

  // ── GET /api/church/service-reports/:id ───────────────────────────────────────
  // Returns the full HTML report for display or download.
  app.get('/api/church/service-reports/:id', authMiddleware, async (req, res) => {
    try {
      const report = await qOne(
        'SELECT * FROM post_service_reports WHERE id = ? AND church_id = ?',
        [req.params.id, req.church.churchId]
      );
      if (!report) return res.status(404).json({ error: 'Report not found' });
      res.json({
        ...report,
        recommendations: (() => { try { return JSON.parse(report.recommendations || '[]'); } catch { return []; } })(),
        failover_events: (() => { try { return JSON.parse(report.failover_events || '[]'); } catch { return []; } })(),
        device_health: (() => { try { return JSON.parse(report.device_health || '{}'); } catch { return {}; } })(),
      });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── GET /api/church/guest-tokens ──────────────────────────────────────────────
  // Uses GuestTdMode for unified token management (tokens work with Telegram /register)
  app.get('/api/church/guest-tokens', authMiddleware, async (req, res) => {
    if (!guestTdMode) return res.json([]);
    try {
      const tokens = await guestTdMode.listTokensForChurch(req.church.churchId);
      res.json(tokens.map(t => ({
        token: t.token, label: t.name, createdAt: t.createdAt,
        expiresAt: t.expiresAt, registered: !!t.usedByChat,
      })));
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/guest-tokens ─────────────────────────────────────────────
  app.post('/api/church/guest-tokens', adminMiddleware, async (req, res) => {
    if (!guestTdMode) return res.status(503).json({ error: 'Guest tokens not configured' });
    const { label, expiresInDays } = req.body;
    const expiresInHours = expiresInDays ? expiresInDays * 24 : 24;
    const church = req.church;
    try {
      const result = await guestTdMode.generateTokenWithOptions(church.churchId, church.name, { label, expiresInHours });
      res.json({ token: result.token, label: result.name, expiresAt: result.expiresAt });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── DELETE /api/church/guest-tokens/:token ────────────────────────────────────
  app.delete('/api/church/guest-tokens/:tok', adminMiddleware, async (req, res) => {
    if (!guestTdMode) return res.status(503).json({ error: 'Guest tokens not configured' });
    const existing = await guestTdMode.getToken(req.params.tok);
    if (!existing || existing.churchId !== req.church.churchId) return res.status(404).json({ error: 'Token not found' });
    await guestTdMode.revokeAndNotify(req.params.tok);
    res.json({ ok: true });
  });

  // ── PUT /api/church/tds/:tdId/access-level ────────────────────────────────────
  app.put('/api/church/tds/:tdId/access-level', adminMiddleware, async (req, res) => {
    const { accessLevel } = req.body;
    if (!['viewer', 'operator', 'admin'].includes(accessLevel)) {
      return res.status(400).json({ error: 'accessLevel must be viewer, operator, or admin' });
    }
    const result = await qRun(
      'UPDATE church_tds SET access_level = ? WHERE id = ? AND church_id = ?',
      [accessLevel, req.params.tdId, req.church.churchId]
    );
    if (!result.changes) return res.status(404).json({ error: 'TD not found' });
    res.json({ ok: true, accessLevel });
  });

  // ── PUT /api/church/tds/:tdId/portal-access ──────────────────────────────────
  // Admin toggles portal access on/off for a TD
  app.put('/api/church/tds/:tdId/portal-access', adminMiddleware, async (req, res) => {
    const { enabled } = req.body;
    const result = await qRun(
      'UPDATE church_tds SET portal_enabled = ? WHERE id = ? AND church_id = ?',
      [enabled ? 1 : 0, req.params.tdId, req.church.churchId]
    );
    if (!result.changes) return res.status(404).json({ error: 'TD not found' });
    res.json({ ok: true, portalEnabled: !!enabled });
  });

  // ── POST /api/church/tds/:tdId/set-password ──────────────────────────────────
  // Admin sets/resets a TD's portal password
  app.post('/api/church/tds/:tdId/set-password', adminMiddleware, async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const td = await qOne('SELECT id, email FROM church_tds WHERE id = ? AND church_id = ?', [req.params.tdId, req.church.churchId]);
    if (!td) return res.status(404).json({ error: 'TD not found' });
    if (!td.email) return res.status(400).json({ error: 'TD must have an email address before enabling portal login' });
    await qRun('UPDATE church_tds SET password_hash = ?, portal_enabled = 1 WHERE id = ?', [hashPassword(password), td.id]);
    res.json({ ok: true });
  });

  // ── POST /api/td/change-password ─────────────────────────────────────────────
  // TD changes their own password (requires TD session)
  app.post('/api/td/change-password', authMiddleware, async (req, res) => {
    if (!req.td) return res.status(403).json({ error: 'Only TD accounts can change TD passwords' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    if (!req.td.password_hash || !verifyPassword(currentPassword, req.td.password_hash)) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    await qRun('UPDATE church_tds SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), req.td.id]);
    res.json({ ok: true });
  });

  // ── TD Room Assignments ────────────────────────────────────────────────────

  // GET /api/church/tds/:tdId/rooms — list rooms assigned to a TD
  app.get('/api/church/tds/:tdId/rooms', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const tdId = req.params.tdId;
      const td = await qOne('SELECT id FROM church_tds WHERE id = ? AND church_id = ?', [tdId, churchId]);
      if (!td) return res.status(404).json({ error: 'TD not found' });
      const assignments = await qAll(
        `SELECT tra.id, tra.room_id, tra.created_at, r.name AS room_name
         FROM td_room_assignments tra
         JOIN rooms r ON r.id = tra.room_id AND r.deleted_at IS NULL
         WHERE tra.td_id = ? AND tra.church_id = ?
         ORDER BY r.name ASC`,
        [tdId, churchId]
      );
      res.json(assignments);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/tds/:tdId/rooms — assign TD to a room
  app.post('/api/church/tds/:tdId/rooms', adminMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const tdId = req.params.tdId;
      const { roomId } = req.body;
      if (!roomId) return res.status(400).json({ error: 'roomId required' });
      const td = await qOne('SELECT id FROM church_tds WHERE id = ? AND church_id = ?', [tdId, churchId]);
      if (!td) return res.status(404).json({ error: 'TD not found' });
      const room = await qOne('SELECT id FROM rooms WHERE id = ? AND campus_id = ? AND deleted_at IS NULL', [roomId, churchId]);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      try {
        await qRun('INSERT INTO td_room_assignments (td_id, room_id, church_id, created_at) VALUES (?, ?, ?, ?)', [
          tdId, roomId, churchId, new Date().toISOString(),
        ]);
      } catch (e) {
        if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'TD already assigned to this room' });
        throw e;
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // DELETE /api/church/tds/:tdId/rooms/:roomId — unassign TD from a room
  app.delete('/api/church/tds/:tdId/rooms/:roomId', adminMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const result = await qRun(
        'DELETE FROM td_room_assignments WHERE td_id = ? AND room_id = ? AND church_id = ?',
        [req.params.tdId, req.params.roomId, churchId]
      );
      if (!result.changes) return res.status(404).json({ error: 'Assignment not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/td/select-room — TD picks a room (for multi-room TDs)
  // Re-issues the JWT with a specific roomId baked in.
  app.post('/api/td/select-room', authMiddleware, async (req, res) => {
    if (!req.td) return res.status(403).json({ error: 'Only TD accounts can select a room' });
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    const churchId = req.church.churchId;
    // Verify TD is assigned to this room
    const assignment = await qOne('SELECT 1 FROM td_room_assignments WHERE td_id = ? AND room_id = ? AND church_id = ?', [req.td.id, roomId, churchId]);
    if (!assignment) return res.status(403).json({ error: 'You are not assigned to this room' });
    // Re-issue token scoped to the selected room
    const token = issueTdToken(req.td.id, churchId, req.tdAccessLevel, jwtSecret, roomId);
    res.cookie('tally_church_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, roomId });
  });

  // GET /api/td/rooms — list rooms available to the current TD
  app.get('/api/td/rooms', authMiddleware, async (req, res) => {
    if (!req.td) return res.status(403).json({ error: 'Only TD accounts' });
    try {
      const churchId = req.church.churchId;
      const rooms = await qAll(
        `SELECT r.id, r.name, r.description
         FROM td_room_assignments tra
         JOIN rooms r ON r.id = tra.room_id AND r.deleted_at IS NULL
         WHERE tra.td_id = ? AND tra.church_id = ?
         ORDER BY r.name ASC`
      , [req.td.id, churchId]);
      res.json({ rooms, currentRoomId: req.tdRoomId || null });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/billing ───────────────────────────────────────────────────
  app.get('/api/church/billing', adminMiddleware, async (req, res) => {
    try {
      const church = req.church;
      const tier = church.billing_tier || 'connect';
      const billingRow = await qOne(
        'SELECT stripe_customer_id, billing_interval, current_period_end, cancel_at_period_end FROM billing_customers WHERE church_id = ? ORDER BY updated_at DESC LIMIT 1',
        [church.churchId]
      );
      const billingInterval = tier === 'event'
        ? 'one_time'
        : (church.billing_interval || billingRow?.billing_interval || 'monthly');
      const status = church.billing_status || 'inactive';
      const trialEnds = church.billing_trial_ends;
      const trialDaysRemaining = trialEnds ? Math.max(0, Math.ceil((new Date(trialEnds) - Date.now()) / (1000 * 60 * 60 * 24))) : null;
      const TIER_NAMES = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise', event: 'Event' };
      const INTERVAL_NAMES = { monthly: 'Monthly', annual: 'Annual', one_time: 'One-time' };

      let portalUrl = null;
      try {
        const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
        if (STRIPE_KEY && billingRow?.stripe_customer_id) {
          const Stripe = require('stripe');
          const stripe = Stripe(STRIPE_KEY);
          const session = await stripe.billingPortal.sessions.create({
            customer: billingRow.stripe_customer_id,
            return_url: req.headers.origin || 'https://tallyconnect.app',
          });
          portalUrl = session.url;
        }
      } catch (e) { log.error(`Billing portal session: ${e.message}`); }

      // AI usage stats for portal dashboard
      let aiUsage = null;
      try {
        if (aiRateLimiter) aiUsage = await aiRateLimiter.getUsageStats(church.churchId, tier);
      } catch (e) { log.error(`AI usage stats: ${e.message}`); }

      res.json({
        tier,
        tierName: TIER_NAMES[tier] || tier,
        billingInterval,
        billingIntervalLabel: INTERVAL_NAMES[billingInterval] || billingInterval,
        status,
        trialEndsAt: trialEnds,
        trialDaysRemaining,
        portalUrl,
        cancelAtPeriodEnd: !!(billingRow?.cancel_at_period_end),
        currentPeriodEnd: billingRow?.current_period_end || null,
        aiUsage,
        features: {
          autopilot: !['connect', 'plus'].includes(tier),
          planningCenter: !['connect', 'plus'].includes(tier),
          oncall: tier !== 'connect',
          propresenter: tier !== 'connect',
          livePreview: tier !== 'connect',
          monthlyReport: !['connect', 'plus'].includes(tier),
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'Billing info unavailable' });
    }
  });

  // ── POST /api/church/billing/upgrade ──────────────────────────────────────────
  // Upgrades the church's Stripe subscription to a new tier.
  app.post('/api/church/billing/upgrade', adminMiddleware, billingRateLimit, async (req, res) => {
    try {
      const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
      if (!STRIPE_KEY) return res.status(503).json({ error: 'Stripe not configured' });

      const Stripe = require('stripe');
      const stripeClient = Stripe(STRIPE_KEY);

      const newTier = String(req.body?.tier || '').toLowerCase();
      if (newTier === 'managed') {
        return res.status(400).json({ error: 'Enterprise uses custom pricing. Contact support to upgrade.' });
      }
      const VALID_TIERS = ['connect', 'plus', 'pro'];
      if (!newTier || !VALID_TIERS.includes(newTier)) {
        return res.status(400).json({ error: 'Invalid tier. Must be: connect, plus, or pro.' });
      }

      const church = req.church;
      const currentTier = church.billing_tier || 'connect';
      if (newTier === currentTier) {
        return res.status(400).json({ error: 'Already on this plan.' });
      }

      const TIER_ORDER = { connect: 0, plus: 1, pro: 2, managed: 3 };
      if (TIER_ORDER[newTier] < TIER_ORDER[currentTier]) {
        return res.status(400).json({ error: 'Use the downgrade endpoint instead.' });
      }

      const billingRow = await qOne(
        'SELECT stripe_customer_id, stripe_subscription_id, billing_interval FROM billing_customers WHERE church_id = ? ORDER BY updated_at DESC LIMIT 1',
        [church.churchId]
      );

      if (!billingRow?.stripe_subscription_id) {
        // No existing subscription — redirect to signup
        return res.json({ redirect: 'https://tallyconnect.app/signup?plan=' + newTier });
      }

      // Resolve the new price ID
      const billingInterval = church.billing_interval || billingRow.billing_interval || 'monthly';
      const PRICE_MAP = {
        connect: { monthly: process.env.STRIPE_PRICE_CONNECT, annual: process.env.STRIPE_PRICE_CONNECT_ANNUAL },
        plus: { monthly: process.env.STRIPE_PRICE_PLUS, annual: process.env.STRIPE_PRICE_PLUS_ANNUAL },
        pro: { monthly: process.env.STRIPE_PRICE_PRO, annual: process.env.STRIPE_PRICE_PRO_ANNUAL },
        managed: { monthly: process.env.STRIPE_PRICE_MANAGED, annual: process.env.STRIPE_PRICE_MANAGED_ANNUAL },
      };
      const newPriceId = PRICE_MAP[newTier]?.[billingInterval];
      if (!newPriceId || newPriceId.includes('placeholder')) {
        return res.status(400).json({ error: 'Price not configured for ' + newTier + ' (' + billingInterval + '). Contact support.' });
      }

      // Get current subscription to find the item to update
      const sub = await stripeClient.subscriptions.retrieve(billingRow.stripe_subscription_id);
      if (!sub?.items?.data?.length) {
        return res.status(400).json({ error: 'No active subscription found. Contact support.' });
      }

      // Update the subscription item to the new price (Stripe handles proration)
      const updated = await stripeClient.subscriptions.update(billingRow.stripe_subscription_id, {
        items: [{
          id: sub.items.data[0].id,
          price: newPriceId,
        }],
        metadata: { ...sub.metadata, tier: newTier },
        proration_behavior: 'create_prorations',
      });

      // Update local DB
      const now = new Date().toISOString();
      await qRun('UPDATE churches SET billing_tier = ? WHERE churchId = ?', [newTier, church.churchId]);
      await qRun('UPDATE billing_customers SET tier = ?, updated_at = ? WHERE church_id = ?', [newTier, now, church.churchId]);

      log.info('Upgraded church ' + church.churchId + ' from ' + currentTier + ' to ' + newTier);

      // Send upgrade confirmation email
      if (lifecycleEmails) {
        lifecycleEmails.sendUpgradeConfirmation(church, { oldTier: currentTier, newTier }).catch(e => console.error('[Billing] Upgrade confirmation email failed:', e.message));
      }

      res.json({ success: true, tier: newTier, message: 'Plan upgraded to ' + newTier });
    } catch (e) {
      log.error('Billing upgrade: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Upgrade failed') });
    }
  });

  // ── POST /api/church/billing/reactivate ─────────────────────────────────────
  // Reactivation path for cancelled/expired/inactive churches.
  app.post('/api/church/billing/reactivate', adminMiddleware, billingRateLimit, async (req, res) => {
    try {
      const church = req.church;
      const { tier, billingInterval } = req.body || {};

      const result = await billing.reactivate({
        churchId: church.churchId,
        tier: tier || church.billing_tier,
        billingInterval: billingInterval || church.billing_interval,
        successUrl: 'https://tallyconnect.app/portal?reactivated=true',
        cancelUrl: 'https://tallyconnect.app/portal',
      });

      res.json(result);
    } catch (e) {
      log.error('Billing reactivate: ' + e.message);
      res.status(400).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/billing/downgrade ─────────────────────────────────────
  // Downgrade to a lower tier (same billing interval).
  app.post('/api/church/billing/downgrade', adminMiddleware, billingRateLimit, async (req, res) => {
    try {
      const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
      if (!STRIPE_KEY) return res.status(503).json({ error: 'Stripe not configured' });

      const Stripe = require('stripe');
      const stripeClient = Stripe(STRIPE_KEY);

      const { tier: newTier } = req.body;
      const TIER_ORDER = ['connect', 'plus', 'pro', 'managed'];
      if (!newTier || !TIER_ORDER.includes(newTier)) {
        return res.status(400).json({ error: 'Invalid tier.' });
      }

      const church = req.church;
      const currentTier = church.billing_tier || 'connect';
      const currentIndex = TIER_ORDER.indexOf(currentTier);
      const newIndex = TIER_ORDER.indexOf(newTier);

      if (currentIndex === -1 || newIndex === -1) {
        return res.status(400).json({ error: 'Invalid tier configuration.' });
      }
      if (newIndex >= currentIndex) {
        return res.status(400).json({ error: 'Use upgrade endpoint for higher tiers.' });
      }

      const billingRow = await qOne(
        'SELECT stripe_customer_id, stripe_subscription_id, billing_interval FROM billing_customers WHERE church_id = ? ORDER BY updated_at DESC LIMIT 1',
        [church.churchId]
      );

      if (!billingRow?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription found.' });
      }

      const billingInterval = church.billing_interval || billingRow.billing_interval || 'monthly';
      const PRICE_MAP = {
        connect: { monthly: process.env.STRIPE_PRICE_CONNECT, annual: process.env.STRIPE_PRICE_CONNECT_ANNUAL },
        plus: { monthly: process.env.STRIPE_PRICE_PLUS, annual: process.env.STRIPE_PRICE_PLUS_ANNUAL },
        pro: { monthly: process.env.STRIPE_PRICE_PRO, annual: process.env.STRIPE_PRICE_PRO_ANNUAL },
        managed: { monthly: process.env.STRIPE_PRICE_MANAGED, annual: process.env.STRIPE_PRICE_MANAGED_ANNUAL },
      };
      const newPriceId = PRICE_MAP[newTier]?.[billingInterval];
      if (!newPriceId || newPriceId.includes('placeholder')) {
        return res.status(400).json({ error: 'Price not configured for ' + newTier + ' (' + billingInterval + ').' });
      }

      const sub = await stripeClient.subscriptions.retrieve(billingRow.stripe_subscription_id);
      if (!sub?.items?.data?.length) {
        return res.status(400).json({ error: 'No subscription items found.' });
      }

      // Downgrade takes effect at end of current billing period (no proration credit by default)
      const updated = await stripeClient.subscriptions.update(billingRow.stripe_subscription_id, {
        items: [{ id: sub.items.data[0].id, price: newPriceId }],
        metadata: { ...sub.metadata, tier: newTier },
        proration_behavior: 'none',
      });

      // Don't update local tier immediately — let the Stripe webhook handle it
      // when the subscription change takes effect at end of billing period.
      // db.prepare('UPDATE churches SET billing_tier = ? WHERE churchId = ?').run(newTier, church.churchId);
      // db.prepare('UPDATE billing_customers SET tier = ?, updated_at = ? WHERE church_id = ?').run(newTier, now, church.churchId);
      log.info(`[Billing] Downgrade scheduled for ${church.churchId}: ${currentTier} → ${newTier} (takes effect at period end)`);

      log.info('Downgraded church ' + church.churchId + ' from ' + currentTier + ' to ' + newTier);

      // Send downgrade confirmation email
      if (lifecycleEmails) {
        lifecycleEmails.sendDowngradeConfirmation(church, { oldTier: currentTier, newTier }).catch(e => console.error('[Billing] Downgrade confirmation email failed:', e.message));
      }

      res.json({ success: true, tier: newTier, message: 'Plan downgraded to ' + newTier + '. Change takes effect at end of current billing period.' });
    } catch (e) {
      log.error('Billing downgrade: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Downgrade failed') });
    }
  });

  // ── POST /api/church/billing/cancel ─────────────────────────────────────────
  // Schedule cancellation at period end. No immediate cut-off — transparent.
  app.post('/api/church/billing/cancel', adminMiddleware, billingRateLimit, async (req, res) => {
    try {
      const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
      if (!STRIPE_KEY) return res.status(503).json({ error: 'Stripe not configured' });
      const stripeClient = require('stripe')(STRIPE_KEY);

      const church = req.church;
      const billingRow = await qOne(
        'SELECT stripe_subscription_id, current_period_end FROM billing_customers WHERE church_id = ? AND stripe_subscription_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
        [church.churchId]
      );

      if (!billingRow?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription found.' });
      }

      // Schedule cancellation at period end — no immediate cut-off
      await stripeClient.subscriptions.update(billingRow.stripe_subscription_id, {
        cancel_at_period_end: true,
      });

      // Update local DB immediately so the UI reflects it
      await qRun(
        'UPDATE billing_customers SET cancel_at_period_end = 1, updated_at = ? WHERE stripe_subscription_id = ?',
        [new Date().toISOString(), billingRow.stripe_subscription_id]
      );

      const periodEnd = billingRow.current_period_end;
      const endDate = periodEnd
        ? new Date(periodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : null;

      log.info(`Church ${church.churchId} scheduled cancellation at period end (${periodEnd})`);

      // Send cancellation confirmation email immediately
      if (lifecycleEmails) {
        // Use a date-stamped type so reactivate→cancel cycles each get an email
        const cancelEmailType = `cancellation-scheduled-${new Date().toISOString().slice(0, 7)}`;
        lifecycleEmails.sendEmail({
          churchId: church.churchId,
          emailType: cancelEmailType,
          to: church.portal_email,
          subject: 'Your Tally subscription has been cancelled',
          html: lifecycleEmails._wrap(`
            <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Tally subscription has been cancelled</h1>
            <p style="font-size: 15px; color: #333; line-height: 1.6;">
              We're sorry to see <strong>${lifecycleEmails._esc(church.name)}</strong> go.
              Your subscription has been cancelled and will remain active until <strong>${endDate || 'the end of your billing period'}</strong>.
            </p>

            <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
              <div style="font-size: 14px; color: #333; line-height: 2;">
                &bull; Monitoring continues until your current period ends<br>
                &bull; Your data and settings are preserved for 30 days after<br>
                &bull; You can reactivate anytime from your Church Portal
              </div>
            </div>

            <p style="font-size: 15px; color: #333; line-height: 1.6;">
              Changed your mind? Reactivate your subscription before it expires:
            </p>

            ${lifecycleEmails._cta('Reactivate Here', lifecycleEmails.appUrl + '/portal')}

            <p style="font-size: 14px; color: #666; line-height: 1.6;">
              We'd love to know why you cancelled &mdash; reply to this email and let us know. Your feedback helps us improve.
            </p>
          `),
          text: `Your Tally subscription has been cancelled\n\nYour subscription for ${church.name} has been cancelled and will remain active until ${endDate || 'the end of your billing period'}.\n\nYour data is preserved for 30 days. Reactivate anytime at ${lifecycleEmails.appUrl}/portal\n\nTally`,
        }).catch(e => console.error('[Billing] Cancel confirmation email failed:', e.message));
      }

      res.json({ success: true, endDate });
    } catch (e) {
      log.error('Billing cancel: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Cancellation failed') });
    }
  });

  // ── POST /api/church/billing/retention ──────────────────────────────────────
  // Apply 50% off for 3 months (retention offer) to the church's subscription.
  app.post('/api/church/billing/retention', adminMiddleware, billingRateLimit, async (req, res) => {
    try {
      const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
      if (!STRIPE_KEY) return res.status(503).json({ error: 'Stripe not configured' });
      const stripeClient = require('stripe')(STRIPE_KEY);

      const church = req.church;
      const billingRow = await qOne(
        'SELECT stripe_subscription_id FROM billing_customers WHERE church_id = ? AND stripe_subscription_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
        [church.churchId]
      );

      if (!billingRow?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription found.' });
      }

      // Get or create a fixed retention coupon in Stripe
      const COUPON_ID = 'TALLY_RETENTION_50_3MO';
      let coupon;
      try {
        coupon = await stripeClient.coupons.retrieve(COUPON_ID);
      } catch {
        coupon = await stripeClient.coupons.create({
          id: COUPON_ID,
          percent_off: 50,
          duration: 'repeating',
          duration_in_months: 3,
          name: '50% off for 3 months (retention offer)',
        });
      }

      // Apply coupon to subscription
      await stripeClient.subscriptions.update(billingRow.stripe_subscription_id, {
        coupon: coupon.id,
      });

      log.info(`Applied retention coupon to church ${church.churchId}`);
      res.json({ success: true });
    } catch (e) {
      log.error('Billing retention: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Could not apply discount') });
    }
  });

  // ── GET /api/church/data-export ────────────────────────────────────────────
  // GDPR: Export all data associated with this church account.
  app.get('/api/church/data-export', adminMiddleware, async (req, res) => {
    try {
      const church = req.church;
      const churchId = church.churchId;

      // Gather all data associated with this church
      const exportData = {
        exportedAt: new Date().toISOString(),
        church: {},
        billing: null,
        sessions: [],
        events: [],
        alerts: [],
        tickets: [],
        tds: [],
        schedule: null,
        reviews: [],
        referrals: [],
        emailsSent: [],
      };

      // Church profile
      const row = await qOne('SELECT * FROM churches WHERE churchId = ?', [churchId]);
      if (row) {
        // Strip sensitive hashes
        const { portal_password_hash, token, ...safeRow } = row;
        exportData.church = safeRow;
      }

      // Billing
      try {
        exportData.billing = await qOne('SELECT tier, billing_interval, status, trial_ends_at, current_period_end, cancel_at_period_end, created_at FROM billing_customers WHERE church_id = ?', [churchId]) || null;
      } catch { /* table may not exist */ }

      // Sessions
      try {
        exportData.sessions = await qAll('SELECT * FROM session_recaps WHERE church_id = ? ORDER BY started_at DESC LIMIT 500', [churchId]);
      } catch { /* table may not exist */ }

      // Events
      try {
        exportData.events = await qAll('SELECT * FROM service_events WHERE church_id = ? ORDER BY timestamp DESC LIMIT 1000', [churchId]);
      } catch { /* */ }

      // Alerts
      try {
        exportData.alerts = await qAll('SELECT * FROM alerts WHERE church_id = ? ORDER BY created_at DESC LIMIT 500', [churchId]);
      } catch { /* */ }

      // Support tickets
      try {
        exportData.tickets = await qAll('SELECT * FROM support_tickets WHERE church_id = ? ORDER BY created_at DESC', [churchId]);
      } catch { /* */ }

      // TDs
      try {
        exportData.tds = await qAll('SELECT * FROM church_tds WHERE church_id = ?', [churchId]);
      } catch { /* */ }

      // TD Room Assignments
      try {
        exportData.tdRoomAssignments = await qAll('SELECT * FROM td_room_assignments WHERE church_id = ?', [churchId]);
      } catch { /* */ }

      // Schedule
      try {
        const sched = await qOne('SELECT service_times FROM churches WHERE churchId = ?', [churchId]);
        if (sched && sched.service_times) exportData.schedule = JSON.parse(sched.service_times);
      } catch { /* */ }

      // Reviews
      try {
        exportData.reviews = await qAll('SELECT * FROM church_reviews WHERE church_id = ?', [churchId]);
      } catch { /* */ }

      // Referrals (as referrer or referred)
      try {
        exportData.referrals = await qAll('SELECT * FROM referrals WHERE referrer_id = ? OR referred_id = ?', [churchId, churchId]);
      } catch { /* */ }

      // Emails sent
      try {
        exportData.emailsSent = await qAll('SELECT email_type, recipient, sent_at FROM email_sends WHERE church_id = ?', [churchId]);
      } catch { /* */ }

      res.setHeader('Content-Disposition', `attachment; filename="tally-data-export-${churchId.substring(0, 8)}.json"`);
      res.setHeader('Content-Type', 'application/json');
      res.json(exportData);
    } catch (e) {
      log.error('DataExport: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Export failed') });
    }
  });

  // ── DELETE /api/church/account ─────────────────────────────────────────────
  // GDPR: Delete church account and all associated data.
  app.delete('/api/church/account', adminMiddleware, async (req, res) => {
    try {
      const church = req.church;
      const churchId = church.churchId;
      const { confirmName } = req.body || {};

      // Require confirmation: user must type their church name
      if (!confirmName || confirmName.trim().toLowerCase() !== church.name.trim().toLowerCase()) {
        return res.status(400).json({ error: 'To delete your account, provide confirmName matching your church name.' });
      }

      // Cancel Stripe subscription if active
      try {
        const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
        if (STRIPE_KEY) {
          const Stripe = require('stripe');
          const stripeClient = Stripe(STRIPE_KEY);
          const billingRow = await qOne(
            'SELECT stripe_subscription_id FROM billing_customers WHERE church_id = ? AND stripe_subscription_id IS NOT NULL',
            [churchId]
          );
          if (billingRow?.stripe_subscription_id) {
            await stripeClient.subscriptions.cancel(billingRow.stripe_subscription_id);
            log.info(`Cancelled Stripe subscription for ${churchId}`);
          }
        }
      } catch (e) {
        log.error(`GDPR Stripe cancellation failed for ${churchId}: ${e.message}`);
        // Continue with deletion even if Stripe cancel fails
      }

      // Delete all data from related tables (best-effort, tables may not exist)
      const tablesToClean = [
        { table: 'billing_customers', column: 'church_id' },
        { table: 'billing_disputes', column: 'church_id' },
        { table: 'session_recaps', column: 'church_id' },
        { table: 'service_events', column: 'church_id' },
        { table: 'alerts', column: 'church_id' },
        { table: 'support_tickets', column: 'church_id' },
        { table: 'support_triage_runs', column: 'church_id' },
        { table: 'church_tds', column: 'church_id' },
        { table: 'td_room_assignments', column: 'church_id' },
        { table: 'church_schedules', column: 'church_id' },
        { table: 'church_reviews', column: 'church_id' },
        { table: 'guest_tokens', column: 'church_id' },
        { table: 'maintenance_windows', column: 'churchId' },
        { table: 'email_sends', column: 'church_id' },
        { table: 'referrals', column: 'referrer_id' },
        { table: 'referrals', column: 'referred_id' },
      ];

      for (const { table, column } of tablesToClean) {
        try {
          await qRun(`DELETE FROM ${table} WHERE ${column} = ?`, [churchId]);
        } catch { /* table doesn't exist — fine */ }
      }

      // Remove from runtime
      const runtime = churches.get(churchId);
      if (runtime?.sockets?.size) {
        for (const sock of runtime.sockets.values()) {
          if (sock.readyState === 1) sock.close(1000, 'account_deleted');
        }
      }
      churches.delete(churchId);

      // Delete the church record last
      await qRun('DELETE FROM churches WHERE churchId = ?', [churchId]);

      log.info(`GDPR: Deleted all data for church "${church.name}" (${churchId})`);
      res.json({ deleted: true, message: 'Your account and all associated data have been permanently deleted.' });
    } catch (e) {
      log.error('GDPR delete: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Deletion failed') });
    }
  });

  // ── Review eligibility helper ─────────────────────────────────────────────
  async function isReviewEligible(churchId) {
    try {
      const church = await qOne('SELECT * FROM churches WHERE churchId = ?', [churchId]);
      if (!church) return false;
      if (church.billing_status !== 'active') return false;

      const daysSince = (Date.now() - new Date(church.registeredAt).getTime()) / 86400000;
      if (daysSince < 30) return false;

      let sessionCount = 0, cleanCount = 0;
      const nonTestSessionClause = await getNonTestSessionClause();
      try {
        const sc = await qOne(`SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ?${nonTestSessionClause}`, [churchId]);
        sessionCount = sc?.cnt || 0;
      } catch { return false; }
      if (sessionCount < 4) return false;

      try {
        const cc = await qOne(`SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND grade LIKE '%Clean%'${nonTestSessionClause}`, [churchId]);
        cleanCount = cc?.cnt || 0;
      } catch { return false; }
      if (cleanCount < 2) return false;

      return true;
    } catch { return false; }
  }

  // ── GET /api/church/review ────────────────────────────────────────────────
  app.get('/api/church/review', authMiddleware, async (req, res) => {
    try {
      const existing = await qOne(
        'SELECT id, rating, body, reviewer_name, reviewer_role, approved, submitted_at FROM church_reviews WHERE church_id = ? ORDER BY submitted_at DESC LIMIT 1',
        [req.church.churchId]
      );

      if (existing) {
        return res.json({ hasReview: true, review: existing });
      }
      const eligible = await isReviewEligible(req.church.churchId);
      res.json({ hasReview: false, eligible });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/review ───────────────────────────────────────────────
  app.post('/api/church/review', adminMiddleware, async (req, res) => {
    try {
      const { rating, body, reviewerName, reviewerRole } = req.body;

      if (!rating || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be 1-5' });
      }
      if (!body || body.trim().length < 10) {
        return res.status(400).json({ error: 'Review must be at least 10 characters' });
      }
      if (body.trim().length > 500) {
        return res.status(400).json({ error: 'Review must be 500 characters or less' });
      }
      if (!reviewerName || !reviewerName.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const existing = await qOne('SELECT 1 FROM church_reviews WHERE church_id = ?', [req.church.churchId]);
      if (existing) {
        return res.status(409).json({ error: 'You have already submitted a review. Thank you!' });
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await qRun(`
        INSERT INTO church_reviews (id, church_id, reviewer_name, reviewer_role, rating, body, church_name, submitted_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'portal')
      `, [id, req.church.churchId, reviewerName.trim(), (reviewerRole || '').trim(), rating, body.trim(), req.church.name, now]);

      log.info('New review from ' + req.church.name + ' (' + rating + ' stars)');
      res.json({ ok: true, id });
    } catch (e) {
      log.error('Reviews: ' + e.message);
      res.status(500).json({ error: 'Failed to submit review' });
    }
  });

  // ── GET /api/public/reviews (NO auth — for landing page) ─────────────────
  app.get('/api/public/reviews', async (req, res) => {
    try {
      const reviews = await qAll(
        'SELECT id, reviewer_name, reviewer_role, rating, body, church_name, featured, submitted_at FROM church_reviews WHERE approved = 1 ORDER BY featured DESC, submitted_at DESC LIMIT 12'
      );
      res.json({ reviews });
    } catch (e) {
      res.json({ reviews: [] });
    }
  });

  // ── Admin review management ───────────────────────────────────────────────
  app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
    try {
      const reviews = await qAll(
        'SELECT * FROM church_reviews ORDER BY approved ASC, submitted_at DESC'
      );
      res.json({ reviews });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.put('/api/admin/reviews/:id/approve', requireAdmin, async (req, res) => {
    try {
      const now = new Date().toISOString();
      const result = await qRun('UPDATE church_reviews SET approved = 1, approved_at = ? WHERE id = ?', [now, req.params.id]);
      if (result.changes === 0) return res.status(404).json({ error: 'Review not found' });
      log.info('Approved review ' + req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.put('/api/admin/reviews/:id/feature', requireAdmin, async (req, res) => {
    try {
      const review = await qOne('SELECT featured FROM church_reviews WHERE id = ?', [req.params.id]);
      if (!review) return res.status(404).json({ error: 'Review not found' });
      const newVal = review.featured ? 0 : 1;
      await qRun('UPDATE church_reviews SET featured = ? WHERE id = ?', [newVal, req.params.id]);
      res.json({ ok: true, featured: newVal });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
    try {
      const result = await qRun('DELETE FROM church_reviews WHERE id = ?', [req.params.id]);
      if (result.changes === 0) return res.status(404).json({ error: 'Review not found' });
      log.info('Deleted review ' + req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/referrals ────────────────────────────────────────────────
  app.get('/api/church/referrals', authMiddleware, async (req, res) => {
    try {
      const church = await qOne('SELECT referral_code FROM churches WHERE churchId = ?', [req.church.churchId]);
      const referralCode = church?.referral_code || '';

      let referrals = [];
      let totalCredits = 0;
      try {
        referrals = await qAll(
          'SELECT referred_name, status, credit_amount, created_at, converted_at FROM referrals WHERE referrer_id = ? ORDER BY created_at DESC',
          [req.church.churchId]
        );
        totalCredits = referrals
          .filter(r => r.status === 'credited')
          .reduce((sum, r) => sum + (r.credit_amount || 0), 0);
      } catch { /* table may not exist */ }

      const totalCredited = referrals.filter(r => r.status === 'credited').length;
      const maxCredits = 5;

      res.json({
        referralCode,
        shareUrl: `https://tallyconnect.app/signup?ref=${referralCode}`,
        referrals,
        totalCredits,
        totalReferred: referrals.length,
        totalConverted: referrals.filter(r => ['credited', 'converted'].includes(r.status)).length,
        totalCredited,
        maxCredits,
        creditsRemaining: Math.max(0, maxCredits - totalCredited),
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/email-preferences ────────────────────────────────────
  app.get('/api/church/email-preferences', authMiddleware, (req, res) => {
    try {
      if (!lifecycleEmails) return res.json({ categories: {}, preferences: {} });
      const categories = {};
      for (const [cat, def] of Object.entries(lifecycleEmails.constructor.EMAIL_CATEGORIES)) {
        categories[cat] = def.name;
      }
      const preferences = lifecycleEmails.getPreferences(req.church.churchId);
      res.json({ categories, preferences });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── PUT /api/church/email-preferences ──────────────────────────────────────
  app.put('/api/church/email-preferences', adminMiddleware, (req, res) => {
    try {
      const { category, enabled } = req.body || {};
      if (!category || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'category and enabled (boolean) required' });
      }
      if (!lifecycleEmails) return res.json({ ok: true });
      const ok = lifecycleEmails.setPreference(req.church.churchId, category, enabled);
      if (!ok) return res.status(400).json({ error: 'Invalid category' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/alerts ──────────────────────────────────────────────────
  app.get('/api/church/alerts', authMiddleware, async (req, res) => {
    try {
      const instanceName = resolveRoomInstance(req, churches);
      let alerts;
      if (instanceName) {
        alerts = await qAll(`
          SELECT id, alert_type, severity, context, created_at, acknowledged_at, acknowledged_by, escalated, resolved
          FROM alerts WHERE church_id = ? AND instance_name = ? ORDER BY created_at DESC LIMIT 50
        `, [req.church.churchId, instanceName]);
        // Fall back to all alerts if no room-specific ones
        if (!alerts.length) {
          alerts = await qAll(`
            SELECT id, alert_type, severity, context, created_at, acknowledged_at, acknowledged_by, escalated, resolved
            FROM alerts WHERE church_id = ? ORDER BY created_at DESC LIMIT 50
          `, [req.church.churchId]);
        }
      } else {
        alerts = await qAll(`
          SELECT id, alert_type, severity, context, created_at, acknowledged_at, acknowledged_by, escalated, resolved
          FROM alerts WHERE church_id = ? ORDER BY created_at DESC LIMIT 50
        `, [req.church.churchId]);
      }

      const parsed = alerts.map(a => ({
        ...a,
        context: (() => { try { return JSON.parse(a.context || '{}'); } catch { return {}; } })(),
      }));
      res.json(parsed);
    } catch (e) {
      // alerts table may not exist yet
      res.json([]);
    }
  });

  // ── GET /api/church/analytics ─────────────────────────────────────────────
  app.get('/api/church/analytics', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const instanceName = resolveRoomInstance(req, churches);
      const nonTestSessionClause = await getNonTestSessionClause();
      // Build optional room filter for session queries
      const roomFilter = instanceName ? ' AND instance_name = ?' : '';
      const sessParams = instanceName ? [churchId, since, instanceName] : [churchId, since];

      // ── Sessions aggregate ──────────────────────────────────────────
      let sessAgg = {};
      try {
        sessAgg = await qOne(`
          SELECT
            COUNT(*)                                 AS total_sessions,
            COALESCE(SUM(duration_minutes), 0)       AS total_duration_min,
            ROUND(AVG(duration_minutes), 0)          AS avg_session_minutes,
            ROUND(AVG(peak_viewers), 0)              AS avg_peak_viewers,
            COALESCE(SUM(alert_count), 0)            AS total_alerts,
            COALESCE(SUM(auto_recovered_count), 0)   AS auto_recovered_count,
            COALESCE(SUM(escalated_count), 0)        AS escalated_count,
            COALESCE(SUM(audio_silence_count), 0)    AS audio_silence_total,
            SUM(CASE WHEN stream_ran = 1 THEN 1 ELSE 0 END) AS stream_ran_count,
            COALESCE(SUM(stream_runtime_minutes), 0) AS total_stream_minutes
          FROM service_sessions
          WHERE church_id = ? AND started_at >= ?${nonTestSessionClause}${roomFilter}
        `, sessParams) || {};
      } catch { /* table may not exist yet */ }

      const totalSessions = sessAgg.total_sessions || 0;
      const totalAlerts = sessAgg.total_alerts || 0;
      const autoRecovered = sessAgg.auto_recovered_count || 0;
      const totalStreamMin = sessAgg.total_stream_minutes || 0;
      const totalDurMin = sessAgg.total_duration_min || 0;

      const uptimePct = totalDurMin > 0
        ? Math.min(100, (totalStreamMin / totalDurMin) * 100)
        : (totalSessions > 0 ? 100 : 0);

      const autoRecoveryRate = totalAlerts > 0
        ? (autoRecovered / totalAlerts) * 100
        : null;

      const weeksInRange = Math.max(1, days / 7);
      const sessionsPerWeek = totalSessions / weeksInRange;

      const streamRanPct = totalSessions > 0
        ? ((sessAgg.stream_ran_count || 0) / totalSessions) * 100
        : null;

      // ── Viewer trend (by week) ──────────────────────────────────────
      let viewerTrend = [];
      try {
        viewerTrend = (await qAll(`
          SELECT
            strftime('%Y-W%W', started_at) AS week_key,
            MAX(peak_viewers)              AS peak
          FROM service_sessions
          WHERE church_id = ? AND started_at >= ?${nonTestSessionClause}${roomFilter} AND peak_viewers IS NOT NULL
          GROUP BY week_key
          ORDER BY week_key ASC
        `, sessParams)).map(r => ({
          label: r.week_key,
          peak: r.peak || 0
        }));
      } catch {}

      // ── Weekly session counts ───────────────────────────────────────
      let weeklySessions = [];
      try {
        weeklySessions = (await qAll(`
          SELECT
            strftime('%Y-W%W', started_at) AS week_key,
            COUNT(*)                        AS count
          FROM service_sessions
          WHERE church_id = ? AND started_at >= ?${nonTestSessionClause}${roomFilter}
          GROUP BY week_key
          ORDER BY week_key ASC
        `, sessParams)).map(r => ({
          label: r.week_key,
          count: r.count
        }));
      } catch {}

      // ── Top event types ─────────────────────────────────────────────
      let topEventTypes = [];
      try {
        topEventTypes = await qAll(`
          SELECT event_type AS type, COUNT(*) AS count
          FROM service_events
          WHERE church_id = ? AND timestamp >= ?
          GROUP BY event_type
          ORDER BY count DESC
          LIMIT 8
        `, [churchId, since]);
      } catch {}

      // ── Equipment disconnects ───────────────────────────────────────
      let equipDisconnects = [];
      try {
        equipDisconnects = await qAll(`
          SELECT
            REPLACE(event_type, '_disconnected', '') AS device,
            COUNT(*) AS count
          FROM service_events
          WHERE church_id = ? AND timestamp >= ?
            AND event_type LIKE '%_disconnected'
          GROUP BY event_type
          ORDER BY count DESC
        `, [churchId, since]);
      } catch {}

      // ── Equipment auto-resolve rates ────────────────────────────────
      let equipAutoResolve = [];
      try {
        equipAutoResolve = (await qAll(`
          SELECT
            REPLACE(event_type, '_disconnected', '') AS device,
            COUNT(*) AS total,
            SUM(CASE WHEN auto_resolved = 1 THEN 1 ELSE 0 END) AS auto_count
          FROM service_events
          WHERE church_id = ? AND timestamp >= ?
            AND event_type LIKE '%_disconnected'
          GROUP BY event_type
          ORDER BY total DESC
        `, [churchId, since])).map(r => ({
          device: r.device,
          rate: r.total > 0 ? (r.auto_count / r.total) * 100 : 0
        }));
      } catch {}

      res.json({
        days,
        total_sessions: totalSessions,
        uptime_pct: Math.round(uptimePct * 10) / 10,
        avg_peak_viewers: sessAgg.avg_peak_viewers ?? null,
        auto_recovery_rate: autoRecoveryRate !== null ? Math.round(autoRecoveryRate * 10) / 10 : null,
        total_alerts: totalAlerts,
        auto_recovered_count: autoRecovered,
        escalated_count: sessAgg.escalated_count || 0,
        audio_silence_total: sessAgg.audio_silence_total || 0,
        total_stream_hours: Math.round((totalStreamMin / 60) * 10) / 10,
        avg_session_minutes: sessAgg.avg_session_minutes ?? null,
        sessions_per_week: Math.round(sessionsPerWeek * 10) / 10,
        stream_ran_pct: streamRanPct !== null ? Math.round(streamRanPct * 10) / 10 : null,
        viewer_trend: viewerTrend,
        weekly_sessions: weeklySessions,
        top_event_types: topEventTypes,
        equipment_disconnects: equipDisconnects,
        equipment_auto_resolve_rates: equipAutoResolve,
      });
    } catch (e) {
      log.error(`[Analytics] Error: ${e.message}`);
      res.status(500).json({ error: 'Failed to load analytics' });
    }
  });

  // ── GET /api/church/analytics/export — CSV export of session data ──────────
  app.get('/api/church/analytics/export', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const instanceName = resolveRoomInstance(req, churches);
      const nonTestSessionClause = await getNonTestSessionClause();
      const roomFilter = instanceName ? ' AND instance_name = ?' : '';
      const params = instanceName ? [churchId, since, instanceName] : [churchId, since];

      let sessions = [];
      try {
        sessions = await qAll(`
          SELECT started_at, ended_at, duration_minutes, stream_ran, stream_runtime_minutes,
                 alert_count, auto_recovered_count, escalated_count, audio_silence_count,
                 peak_viewers, td_name, grade
          FROM service_sessions
          WHERE church_id = ? AND started_at >= ?${nonTestSessionClause}${roomFilter}
          ORDER BY started_at DESC
        `, params);
      } catch { /* table may not exist */ }

      const header = 'Date,End,Duration (min),Stream Ran,Stream Minutes,Alerts,Auto-Recovered,Escalated,Audio Silence,Peak Viewers,TD,Grade';
      const rows = sessions.map(s => [
        s.started_at || '',
        s.ended_at || '',
        s.duration_minutes ?? '',
        s.stream_ran ? 'Yes' : 'No',
        s.stream_runtime_minutes ?? '',
        s.alert_count ?? 0,
        s.auto_recovered_count ?? 0,
        s.escalated_count ?? 0,
        s.audio_silence_count ?? 0,
        s.peak_viewers ?? '',
        `"${(s.td_name || '').replace(/"/g, '""')}"`,
        s.grade || '',
      ].join(','));

      const csv = [header, ...rows].join('\n');
      const churchName = (req.church.name || 'tally').replace(/[^a-zA-Z0-9]/g, '-');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${churchName}-sessions-${days}d.csv"`);
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/analytics/audience — platform viewer analytics ─────────
  app.get('/api/church/analytics/audience', authMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const instanceName = resolveRoomInstance(req, churches);
      const roomFilter = instanceName ? ' AND ss.instance_name = ?' : '';
      const audParams = instanceName ? [churchId, since, instanceName] : [churchId, since];

      // Per-session viewer peaks with platform breakdown
      let sessionViewers = [];
      try {
        sessionViewers = await qAll(`
          SELECT
            vs.session_id,
            ss.started_at,
            ss.grade,
            MAX(vs.total) AS peak_total,
            MAX(vs.youtube) AS peak_youtube,
            MAX(vs.facebook) AS peak_facebook,
            MAX(vs.vimeo) AS peak_vimeo,
            COUNT(*) AS snapshot_count
          FROM viewer_snapshots vs
          LEFT JOIN service_sessions ss ON ss.id = vs.session_id
          WHERE vs.church_id = ? AND vs.captured_at >= ?
            AND vs.session_id IS NOT NULL${roomFilter}
          GROUP BY vs.session_id
          ORDER BY ss.started_at DESC
          LIMIT 100
        `, audParams);
      } catch { /* table may not exist yet */ }

      // Weekly platform trends
      const vsRoomFilter = instanceName ? ' AND instance_name = ?' : '';
      const vsParams = instanceName ? [churchId, since, instanceName] : [churchId, since];
      let weeklyTrend = [];
      try {
        weeklyTrend = await qAll(`
          SELECT
            strftime('%Y-W%W', captured_at) AS week_key,
            MAX(total) AS peak_total,
            MAX(youtube) AS peak_youtube,
            MAX(facebook) AS peak_facebook,
            MAX(vimeo) AS peak_vimeo,
            ROUND(AVG(total), 0) AS avg_total,
            COUNT(*) AS snapshots
          FROM viewer_snapshots
          WHERE church_id = ? AND captured_at >= ?${vsRoomFilter}
          GROUP BY week_key
          ORDER BY week_key ASC
        `, vsParams);
      } catch {}

      // Platform summary
      let platformSummary = {};
      try {
        const row = await qOne(`
          SELECT
            ROUND(AVG(total), 0) AS avg_total,
            MAX(total) AS peak_total,
            ROUND(AVG(youtube), 0) AS avg_youtube,
            MAX(youtube) AS peak_youtube,
            ROUND(AVG(facebook), 0) AS avg_facebook,
            MAX(facebook) AS peak_facebook,
            ROUND(AVG(vimeo), 0) AS avg_vimeo,
            MAX(vimeo) AS peak_vimeo,
            COUNT(*) AS total_snapshots
          FROM viewer_snapshots
          WHERE church_id = ? AND captured_at >= ?${vsRoomFilter}
        `, vsParams);
        if (row) platformSummary = row;
      } catch {}

      // Recent snapshots (last 2 hours for live view)
      const recentSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const recentParams = instanceName ? [churchId, recentSince, instanceName] : [churchId, recentSince];
      let recentSnapshots = [];
      try {
        recentSnapshots = await qAll(`
          SELECT total, youtube, facebook, vimeo, captured_at
          FROM viewer_snapshots
          WHERE church_id = ? AND captured_at >= ?${vsRoomFilter}
          ORDER BY captured_at ASC
          LIMIT 120
        `, recentParams);
      } catch {}

      res.json({
        days,
        platform_summary: platformSummary,
        weekly_trend: weeklyTrend,
        session_viewers: sessionViewers,
        recent_snapshots: recentSnapshots,
      });
    } catch (e) {
      log.error(`[AudienceAnalytics] Error: ${e.message}`);
      res.status(500).json({ error: 'Failed to load audience analytics' });
    }
  });

  // ── Church support hub API ──────────────────────────────────────────────────

  app.get('/api/church/support/tickets', supportAuthMiddleware, async (req, res) => {
    try {
      const status = String(req.query.status || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(Number(req.query.limit || 25), 100));
      const rows = status
        ? await qAll(`
            SELECT id, church_id, triage_id, issue_category, severity, title, description, status, created_at, updated_at
            FROM support_tickets
            WHERE church_id = ? AND status = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `, [req.church.churchId, status, limit])
        : await qAll(`
            SELECT id, church_id, triage_id, issue_category, severity, title, description, status, created_at, updated_at
            FROM support_tickets
            WHERE church_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `, [req.church.churchId, limit]);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/church/support/tickets/:ticketId', supportAuthMiddleware, async (req, res) => {
    try {
      const ticket = await qOne(`
        SELECT id, church_id, triage_id, issue_category, severity, title, description, status, diagnostics_json, created_at, updated_at
        FROM support_tickets
        WHERE id = ? AND church_id = ?
      `, [req.params.ticketId, req.church.churchId]);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      const updates = await qAll(`
        SELECT id, message, actor_type, created_at
        FROM support_ticket_updates
        WHERE ticket_id = ?
        ORDER BY created_at ASC
      `, [ticket.id]);
      let diagnostics = {};
      try { diagnostics = JSON.parse(ticket.diagnostics_json || '{}'); } catch {}
      res.json({ ...ticket, diagnostics, updates });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/church/support/triage', supportAuthMiddleware, async (req, res) => {
    try {
      const issueCategory = String(req.body.issueCategory || 'other').trim().toLowerCase();
      const severity = String(req.body.severity || 'P3').trim().toUpperCase();
      const summary = String(req.body.summary || '').trim().slice(0, 2000);
      const runtime = churches.get(req.church.churchId);
      const sinceIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const alerts = await qAll(`
        SELECT id, alert_type, severity, created_at
        FROM alerts
        WHERE church_id = ? AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 15
      `, [req.church.churchId, sinceIso]);

      const checks = [];
      const churchClientConnected = hasOpenSocket(runtime);
      checks.push({
        key: 'church_client_connection',
        ok: churchClientConnected,
        note: churchClientConnected ? 'Church client connected' : 'Church client offline',
      });

      const s = runtime?.status || {};
      if (issueCategory === 'stream_down') {
        const streamActive = isStreamActive(s);
        checks.push({
          key: 'stream_state',
          ok: streamActive,
          note: streamActive ? 'Stream appears active' : 'Stream appears inactive',
        });
      }
      if (issueCategory === 'no_audio_stream') {
        const audioOk = s.obs?.audioConnected !== false
          && s.mixer?.mainMuted !== true
          && s.audio?.silenceDetected !== true;
        checks.push({
          key: 'audio_path',
          ok: audioOk,
          note: audioOk ? 'No hard audio mute detected' : 'Audio path likely muted/disconnected',
        });
      }
      if (issueCategory === 'atem_connectivity') {
        checks.push({
          key: 'atem_link',
          ok: s.atem?.connected === true,
          note: s.atem?.connected ? 'ATEM connected' : 'ATEM disconnected',
        });
      }
      if (issueCategory === 'recording_issue') {
        const recordingActive = isRecordingActive(s);
        checks.push({
          key: 'recording_state',
          ok: recordingActive,
          note: recordingActive ? 'Recording appears active' : 'Recording appears inactive',
        });
      }

      const failed = checks.filter(c => !c.ok).length;
      const triageResult = failed > 0 ? 'needs_escalation' : 'monitoring';

      const diagnostics = {
        churchId: req.church.churchId,
        issueCategory,
        severity,
        timezone: String(req.body.timezone || ''),
        relayVersion: process.env.RELAY_VERSION || null,
        appVersion: String(req.body.appVersion || ''),
        generatedAt: new Date().toISOString(),
        connection: {
          churchClientConnected,
          lastSeen: runtime?.lastSeen || null,
          lastHeartbeat: runtime?.lastHeartbeat || null,
        },
        deviceHealth: s,
        recentAlerts: alerts,
        checks,
      };

      const triageId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      await qRun(`
        INSERT INTO support_triage_runs (
          id, church_id, issue_category, severity, summary, triage_result,
          diagnostics_json, autofix_attempts_json, timezone, app_version, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        triageId,
        req.church.churchId,
        issueCategory,
        severity,
        summary,
        triageResult,
        JSON.stringify(diagnostics),
        JSON.stringify([]),
        diagnostics.timezone || null,
        diagnostics.appVersion || null,
        `church:${req.church.churchId}`,
        nowIso
      ]);

      // ── AI-powered root cause analysis via Sonnet ──────────────────
      let aiAnalysis = null;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const diagContext = await require('./diagnostic-context').buildDiagnosticContext(
            req.church.churchId, db, churches, null
          );
          const recentEvents = await qAll(`
            SELECT event_type, timestamp, auto_resolved, details
            FROM service_events
            WHERE church_id = ? AND timestamp >= ?
            ORDER BY timestamp DESC LIMIT 20
          `, [req.church.churchId, new Date(Date.now() - 60 * 60 * 1000).toISOString()]);

          const { buildBackgroundPrompt } = require('./tally-engineer');
          const systemPrompt = `${buildBackgroundPrompt('support_triage')}

ISSUE REPORTED: ${issueCategory} (${severity})
USER DESCRIPTION: ${summary || 'No description provided'}

${diagContext}

RECENT EVENTS (last hour):
${recentEvents.map(e => `  ${e.timestamp}: ${e.event_type}${e.auto_resolved ? ' (auto-resolved)' : ''}${e.details ? ' — ' + e.details : ''}`).join('\n') || '  No recent events'}

BASIC CHECKS:
${checks.map(c => `  ${c.key}: ${c.ok ? '✓' : '✗'} ${c.note}`).join('\n')}

Respond in EXACTLY this JSON format:
{
  "primaryCause": { "cause": "string", "confidence": 0-100, "explanation": "1-2 sentences" },
  "secondaryCauses": [{ "cause": "string", "confidence": 0-100 }],
  "steps": ["step 1", "step 2", "step 3"],
  "canAutoFix": false,
  "autoFixAction": null,
  "suggestedRule": null
}

For suggestedRule, if an AutoPilot rule could prevent this in the future, include:
{ "name": "rule name", "triggerType": "alert_condition|equipment_state_match", "description": "what it does" }`;

          const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              system: systemPrompt,
              messages: [{ role: 'user', content: 'Analyze this issue and provide your diagnosis.' }],
              temperature: 0.3,
              max_tokens: 1024,
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (aiResp.ok) {
            const aiData = await aiResp.json();
            const text = aiData.content?.[0]?.text || '';
            try {
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) aiAnalysis = JSON.parse(jsonMatch[0]);
            } catch { /* parse failed, use raw text */ }
          }
        } catch (e) {
          log.warn('[Triage] AI analysis failed: ' + e.message);
        }
      }

      res.status(201).json({
        triageId,
        triageResult: aiAnalysis ? (aiAnalysis.primaryCause?.confidence > 70 ? 'diagnosed' : triageResult) : triageResult,
        checks,
        diagnostics,
        aiAnalysis,
        createdAt: nowIso,
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/church/support/tickets', supportAuthMiddleware, async (req, res) => {
    try {
      const triageId = String(req.body.triageId || '').trim();
      if (!triageId) return res.status(400).json({ error: 'triageId required' });

      const triage = await qOne(`
        SELECT * FROM support_triage_runs
        WHERE id = ? AND church_id = ?
      `, [triageId, req.church.churchId]);
      if (!triage) return res.status(404).json({ error: 'triageId not found' });

      const title = String(req.body.title || triage.summary || 'Support ticket').trim().slice(0, 160);
      if (!title) return res.status(400).json({ error: 'title required' });
      const description = String(req.body.description || '').trim().slice(0, 4000);
      const severity = String(req.body.severity || triage.severity || 'P3').trim().toUpperCase();
      const issueCategory = String(req.body.issueCategory || triage.issue_category || 'other').trim().toLowerCase();

      const ticketId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      await qRun(`
        INSERT INTO support_tickets (
          id, church_id, triage_id, issue_category, severity, title, description, status, forced_bypass,
          diagnostics_json, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
      `, [
        ticketId,
        req.church.churchId,
        triageId,
        issueCategory,
        severity,
        title,
        description,
        triage.diagnostics_json || '{}',
        `church:${req.church.churchId}`,
        nowIso,
        nowIso
      ]);

      await qRun(`
        INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
        VALUES (?, ?, 'church', ?, ?)
      `, [ticketId, description || 'Ticket opened from church portal', req.church.churchId, nowIso]);

      res.status(201).json({ ticketId, status: 'open', createdAt: nowIso });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/church/support/tickets/:ticketId/updates', supportAuthMiddleware, async (req, res) => {
    try {
      const ticket = await qOne('SELECT * FROM support_tickets WHERE id = ? AND church_id = ?', [req.params.ticketId, req.church.churchId]);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      const message = String(req.body.message || '').trim();
      if (!message) return res.status(400).json({ error: 'message required' });
      const status = String(req.body.status || ticket.status).trim().toLowerCase();
      const allowedStatus = new Set(['open', 'waiting_customer', 'closed']);
      if (!allowedStatus.has(status)) return res.status(400).json({ error: 'invalid status for church update' });

      const nowIso = new Date().toISOString();
      await qRun(`
        INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
        VALUES (?, ?, 'church', ?, ?)
      `, [ticket.id, message.slice(0, 4000), req.church.churchId, nowIso]);

      await qRun('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso, ticket.id]);

      res.json({ ok: true, ticketId: ticket.id, status, updatedAt: nowIso });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── Admin: set portal credentials ─────────────────────────────────────────────
  app.post('/api/churches/:churchId/portal-credentials', requireAdmin, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = await getChurchByPortalEmailExcluding(email.toLowerCase(), req.params.churchId);
    if (existing) return res.status(409).json({ error: 'Email already used by another church' });

    await qRun('UPDATE churches SET portal_email = ?, portal_password_hash = ? WHERE churchId = ?', [
      email.trim().toLowerCase(),
      hashPassword(password),
      req.params.churchId,
    ]);

    log.info(`Set portal credentials for church ${req.params.churchId}: ${email}`);
    res.json({ ok: true, email: email.trim().toLowerCase(), loginUrl: '/church-login' });
  });

  // ── AI TRIAGE ENDPOINTS (church-facing) ────────────────────────────────────

  if (aiTriageEngine) {
    // GET /api/church/ai-triage/events — triage events for this church
    app.get('/api/church/ai-triage/events', authMiddleware, (req, res) => {
      try {
        const events = aiTriageEngine.getRecentEvents({
          churchId: req.church.churchId,
          limit: Math.min(parseInt(req.query.limit, 10) || 50, 100),
          offset: parseInt(req.query.offset, 10) || 0,
          severity: req.query.severity || null,
        });
        res.json({ events });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch triage events' });
      }
    });

    // GET /api/church/ai-triage/stats — triage stats for this church
    app.get('/api/church/ai-triage/stats', authMiddleware, (req, res) => {
      try {
        const stats = aiTriageEngine.getStats({
          churchId: req.church.churchId,
          days: Math.min(parseInt(req.query.days, 10) || 7, 30),
        });
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch triage stats' });
      }
    });

    // GET /api/church/ai-triage/settings — AI settings for this church
    app.get('/api/church/ai-triage/settings', authMiddleware, (req, res) => {
      try {
        const settings = aiTriageEngine.getChurchSettings(req.church.churchId);
        res.json(settings);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch AI settings' });
      }
    });

    // PUT /api/church/ai-triage/settings — update AI settings (admin only)
    app.put('/api/church/ai-triage/settings', adminMiddleware, async (req, res) => {
      try {
        const settings = aiTriageEngine.updateChurchSettings(
          req.church.churchId,
          req.body,
          req.church.portal_email || 'church_admin',
        );
        // Ensure DB persistence (updateChurchSettings queues writes asynchronously;
        // do a direct DB write here to guarantee the save is durable)
        const now = new Date().toISOString();
        const updatedBy = req.church.portal_email || 'church_admin';
        try {
          await qRun(`
            INSERT INTO church_ai_settings (church_id, ai_mode, sensitivity_threshold, pre_service_window_minutes,
              post_service_buffer_minutes, custom_settings, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(church_id) DO UPDATE SET
              ai_mode = excluded.ai_mode,
              sensitivity_threshold = excluded.sensitivity_threshold,
              pre_service_window_minutes = excluded.pre_service_window_minutes,
              post_service_buffer_minutes = excluded.post_service_buffer_minutes,
              custom_settings = excluded.custom_settings,
              updated_at = excluded.updated_at,
              updated_by = excluded.updated_by
          `, [req.church.churchId, settings.ai_mode, settings.sensitivity_threshold,
            settings.pre_service_window_minutes, settings.post_service_buffer_minutes,
            JSON.stringify(settings.custom_settings || {}), now, updatedBy]);
        } catch (dbErr) {
          log.error('AI settings DB write failed:', dbErr);
        }
        res.json(settings);
      } catch (err) {
        if (err.message.includes('Invalid AI mode')) {
          return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: 'Failed to update AI settings' });
      }
    });

    // ── REPORTS TAB ENDPOINTS ──────────────────────────────────────────────────

    // GET /api/church/reports/weekly-summary — same data as weekly digest, interactive
    app.get('/api/church/reports/weekly-summary', authMiddleware, async (req, res) => {
      try {
        const churchId = req.church.churchId;
        const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const instanceName = resolveRoomInstance(req, churches);
        const nonTestSessionClause = await getNonTestSessionClause();
        const roomFilter = instanceName ? ' AND instance_name = ?' : '';
        const baseParams = instanceName ? [churchId, since, instanceName] : [churchId, since];

        // Sessions aggregate
        let sessAgg = {};
        try {
          sessAgg = await qOne(`
            SELECT
              COUNT(*)                                 AS total_sessions,
              COALESCE(SUM(duration_minutes), 0)       AS total_duration_min,
              COALESCE(SUM(alert_count), 0)            AS total_alerts,
              COALESCE(SUM(auto_recovered_count), 0)   AS auto_recovered,
              COALESCE(SUM(escalated_count), 0)        AS escalated,
              SUM(CASE WHEN stream_ran = 1 THEN 1 ELSE 0 END) AS stream_ran_count,
              COALESCE(SUM(stream_runtime_minutes), 0) AS total_stream_minutes
            FROM service_sessions
            WHERE church_id = ? AND started_at >= ?${nonTestSessionClause}${roomFilter}
          `, baseParams) || {};
        } catch {}

        // Events detected/resolved
        let eventAgg = {};
        try {
          eventAgg = await qOne(`
            SELECT
              COUNT(*) AS total_events,
              SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) AS resolved_events,
              SUM(CASE WHEN auto_resolved = 1 THEN 1 ELSE 0 END) AS auto_resolved_events
            FROM service_events
            WHERE church_id = ? AND timestamp >= ?${roomFilter}
          `, baseParams) || {};
        } catch {}

        // Device uptime from post_service_reports
        let deviceUptime = [];
        try {
          const reports = await qAll(`
            SELECT instance_name, uptime_pct, device_health, created_at
            FROM post_service_reports
            WHERE church_id = ? AND created_at >= ?${roomFilter}
            ORDER BY created_at DESC
          `, baseParams);

          // Group by instance and average uptime
          const byDevice = {};
          for (const r of reports) {
            const key = r.instance_name || 'Default';
            if (!byDevice[key]) byDevice[key] = { uptimes: [], healthData: [] };
            byDevice[key].uptimes.push(r.uptime_pct || 0);
            try { byDevice[key].healthData.push(JSON.parse(r.device_health || '{}')); } catch {}
          }
          deviceUptime = Object.entries(byDevice).map(([name, data]) => ({
            device: name,
            avgUptime: data.uptimes.length ? (data.uptimes.reduce((a, b) => a + b, 0) / data.uptimes.length).toFixed(1) : null,
            sessions: data.uptimes.length
          }));
        } catch {}

        const totalSessions = sessAgg.total_sessions || 0;
        const totalAlerts = sessAgg.total_alerts || 0;
        const autoRecovered = sessAgg.auto_recovered || 0;
        const totalStreamMin = sessAgg.total_stream_minutes || 0;
        const totalDurMin = sessAgg.total_duration_min || 0;

        res.json({
          period: { days, since },
          sessions: totalSessions,
          totalAlerts,
          eventsDetected: eventAgg.total_events || 0,
          eventsResolved: eventAgg.resolved_events || 0,
          autoRecoveryCount: autoRecovered,
          autoRecoveryRate: totalAlerts > 0 ? ((autoRecovered / totalAlerts) * 100).toFixed(1) : null,
          uptimePct: totalDurMin > 0 ? Math.min(100, (totalStreamMin / totalDurMin) * 100).toFixed(1) : (totalSessions > 0 ? '100.0' : null),
          escalated: sessAgg.escalated || 0,
          deviceUptime
        });
      } catch (err) {
        log.error('Reports weekly-summary error:', err);
        res.status(500).json({ error: 'Failed to generate weekly summary' });
      }
    });

    // GET /api/church/reports/event-history — searchable/filterable event history
    app.get('/api/church/reports/event-history', authMiddleware, async (req, res) => {
      try {
        const churchId = req.church.churchId;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;
        const severity = req.query.severity || null;
        const room = req.query.room || null;
        const deviceType = req.query.deviceType || null;
        const since = req.query.since || null;
        const until = req.query.until || null;
        const search = req.query.search || null;

        let where = 'WHERE t.church_id = ?';
        const params = [churchId];

        if (severity) { where += ' AND t.triage_severity = ?'; params.push(severity); }
        if (room) { where += ' AND t.room_id = ?'; params.push(room); }
        if (since) { where += ' AND t.created_at >= ?'; params.push(since); }
        if (until) { where += ' AND t.created_at <= ?'; params.push(until); }
        if (search) { where += ' AND (t.alert_type LIKE ? OR t.details LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
        if (deviceType) { where += ' AND t.alert_type LIKE ?'; params.push(`%${deviceType}%`); }

        // Count total
        let total = 0;
        try {
          const countRow = await qOne(`SELECT COUNT(*) AS cnt FROM ai_triage_events t ${where}`, params);
          total = countRow?.cnt || 0;
        } catch {}

        // Fetch page
        let events = [];
        try {
          events = await qAll(`
            SELECT t.*, r.action_taken, r.success AS resolution_success, r.duration_ms AS resolution_duration
            FROM ai_triage_events t
            LEFT JOIN ai_resolutions r ON r.event_id = t.id
            ${where}
            ORDER BY t.created_at DESC
            LIMIT ? OFFSET ?
          `, [...params, limit, offset]);
        } catch {}

        res.json({
          events: events.map(e => ({
            id: e.id,
            timestamp: e.created_at,
            severity: e.triage_severity,
            score: e.triage_score,
            alertType: (e.alert_type || '').replace(/_/g, ' '),
            roomId: e.room_id,
            timeContext: e.time_context,
            details: (() => { try { return JSON.parse(e.details || '{}'); } catch { return {}; } })(),
            resolution: e.action_taken ? { action: e.action_taken, success: !!e.resolution_success, durationMs: e.resolution_duration } : null
          })),
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
      } catch (err) {
        log.error('Reports event-history error:', err);
        res.status(500).json({ error: 'Failed to fetch event history' });
      }
    });

    // GET /api/church/reports/service-windows — service window activity data
    app.get('/api/church/reports/service-windows', authMiddleware, async (req, res) => {
      try {
        const churchId = req.church.churchId;
        const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 90);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const instanceName = resolveRoomInstance(req, churches);
        const nonTestSessionClause = await getNonTestSessionClause();
        const roomFilter = instanceName ? ' AND instance_name = ?' : '';
        const baseParams = instanceName ? [churchId, since, instanceName] : [churchId, since];
        const roomId = req.query.roomId || null;
        const triageRoomFilter = roomId ? ' AND room_id = ?' : '';
        const triageParams = roomId ? [churchId, since, roomId] : [churchId, since];

        // Get church schedule (use aiTriageEngine's scheduleEngine for consistent format normalization)
        let serviceTimes = [];
        try {
          if (aiTriageEngine && aiTriageEngine.scheduleEngine) {
            serviceTimes = aiTriageEngine.scheduleEngine.getSchedule(churchId);
          } else {
            const church = await qOne('SELECT service_times, schedule, timezone FROM churches WHERE churchId = ?', [churchId]);
            if (church?.service_times) {
              try { serviceTimes = JSON.parse(church.service_times); } catch {}
            }
            // Fall back to schedule column (modern format from portal schedule page)
            if ((!serviceTimes || !serviceTimes.length) && church?.schedule) {
              try { serviceTimes = JSON.parse(church.schedule); } catch {}
            }
            // Normalize modern object format to legacy array
            if (serviceTimes && !Array.isArray(serviceTimes) && typeof serviceTimes === 'object') {
              const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
              const normalized = [];
              for (const [dayName, entries] of Object.entries(serviceTimes)) {
                const dayNum = dayMap[dayName.toLowerCase()];
                if (dayNum === undefined || !Array.isArray(entries)) continue;
                for (const entry of entries) {
                  const start = String(entry.start || entry.startTime || '').split(':').map(Number);
                  const end = String(entry.end || entry.endTime || '').split(':').map(Number);
                  if (start.length < 2 || end.length < 2) continue;
                  const startMin = (start[0] || 0) * 60 + (start[1] || 0);
                  const endMin = (end[0] || 0) * 60 + (end[1] || 0);
                  normalized.push({ day: dayNum, startHour: start[0] || 0, startMin: start[1] || 0, durationHours: Math.round(((endMin > startMin ? endMin - startMin : 120) / 60) * 100) / 100 });
                }
              }
              serviceTimes = normalized;
            }
          }
        } catch {}

        // Get sessions in range
        let sessions = [];
        try {
          sessions = await qAll(`
            SELECT id, started_at, ended_at, duration_minutes, alert_count, auto_recovered_count, instance_name, grade
            FROM service_sessions
            WHERE church_id = ? AND started_at >= ?${nonTestSessionClause}${roomFilter}
            ORDER BY started_at DESC
          `, baseParams);
        } catch {}

        // Get events in range with time context
        let eventsByContext = { pre_service: 0, in_service: 0, off_hours: 0 };
        try {
          const contextRows = await qAll(`
            SELECT time_context, COUNT(*) AS cnt
            FROM ai_triage_events
            WHERE church_id = ? AND created_at >= ?${triageRoomFilter}
            GROUP BY time_context
          `, triageParams);
          for (const r of contextRows) {
            if (r.time_context && eventsByContext.hasOwnProperty(r.time_context)) {
              eventsByContext[r.time_context] = r.cnt;
            }
          }
        } catch {}

        res.json({
          serviceWindows: serviceTimes,
          sessions: sessions.map(s => ({
            id: s.id,
            startedAt: s.started_at,
            endedAt: s.ended_at,
            durationMin: s.duration_minutes,
            alerts: s.alert_count || 0,
            autoRecovered: s.auto_recovered_count || 0,
            room: s.instance_name,
            grade: s.grade
          })),
          eventsByContext,
          period: { days, since }
        });
      } catch (err) {
        log.error('Reports service-windows error:', err);
        res.status(500).json({ error: 'Failed to fetch service window data' });
      }
    });

    // GET /api/church/reports/device-health — per-device reliability stats
    app.get('/api/church/reports/device-health', authMiddleware, async (req, res) => {
      try {
        const churchId = req.church.churchId;
        const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const compareSince = new Date(Date.now() - days * 2 * 86400000).toISOString();
        const instanceName = resolveRoomInstance(req, churches);
        const roomFilter = instanceName ? ' AND instance_name = ?' : '';
        const baseParams = instanceName ? [churchId, since, instanceName] : [churchId, since];
        const roomId = req.query.roomId || null;
        const triageRoomFilter = roomId ? ' AND room_id = ?' : '';
        const triageParams = roomId ? [churchId, since, roomId] : [churchId, since];

        // Alerts by device type (current period)
        let currentAlerts = [];
        try {
          currentAlerts = await qAll(`
            SELECT alert_type, COUNT(*) AS cnt,
              SUM(CASE WHEN resolution_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved_cnt
            FROM ai_triage_events
            WHERE church_id = ? AND created_at >= ?${triageRoomFilter}
            GROUP BY alert_type
            ORDER BY cnt DESC
          `, triageParams);
        } catch {}

        // Previous period for trend comparison
        let previousAlerts = [];
        try {
          const prevParams = roomId ? [churchId, compareSince, since, roomId] : [churchId, compareSince, since];
          previousAlerts = await qAll(`
            SELECT alert_type, COUNT(*) AS cnt
            FROM ai_triage_events
            WHERE church_id = ? AND created_at >= ? AND created_at < ?${triageRoomFilter}
            GROUP BY alert_type
          `, prevParams);
        } catch {}
        const prevMap = {};
        for (const p of previousAlerts) prevMap[p.alert_type] = p.cnt;

        // Reconnection stats from resolutions
        let reconnStats = [];
        try {
          reconnStats = await qAll(`
            SELECT
              t.alert_type,
              COUNT(*) AS attempts,
              SUM(CASE WHEN r.success = 1 THEN 1 ELSE 0 END) AS successes,
              ROUND(AVG(r.duration_ms)) AS avg_duration_ms
            FROM ai_resolutions r
            JOIN ai_triage_events t ON t.id = r.event_id
            WHERE r.church_id = ? AND r.created_at >= ?${roomId ? ' AND t.room_id = ?' : ''}
            GROUP BY t.alert_type
          `, triageParams);
        } catch {}
        const reconnMap = {};
        for (const r of reconnStats) reconnMap[r.alert_type] = r;

        // Per-device uptime from post_service_reports
        let deviceUptimes = [];
        try {
          deviceUptimes = await qAll(`
            SELECT instance_name, uptime_pct
            FROM post_service_reports
            WHERE church_id = ? AND created_at >= ?${roomFilter}
          `, baseParams);
        } catch {}
        const uptimeByDevice = {};
        for (const d of deviceUptimes) {
          const key = d.instance_name || 'Default';
          if (!uptimeByDevice[key]) uptimeByDevice[key] = [];
          uptimeByDevice[key].push(d.uptime_pct || 0);
        }

        const devices = currentAlerts.map(a => {
          const prevCount = prevMap[a.alert_type] || 0;
          const reconn = reconnMap[a.alert_type] || {};
          const trend = prevCount === 0 ? (a.cnt > 0 ? 'declining' : 'stable') :
            a.cnt < prevCount ? 'improving' : a.cnt > prevCount ? 'declining' : 'stable';
          return {
            alertType: a.alert_type,
            label: (a.alert_type || '').replace(/_/g, ' '),
            incidents: a.cnt,
            resolved: a.resolved_cnt || 0,
            trend,
            prevIncidents: prevCount,
            reconnAttempts: reconn.attempts || 0,
            reconnSuccesses: reconn.successes || 0,
            avgReconnMs: reconn.avg_duration_ms || null
          };
        });

        const uptimeSummary = Object.entries(uptimeByDevice).map(([name, vals]) => ({
          device: name,
          avgUptime: (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1),
          sessions: vals.length
        }));

        res.json({ devices, uptimeSummary, period: { days, since } });
      } catch (err) {
        log.error('Reports device-health error:', err);
        res.status(500).json({ error: 'Failed to fetch device health data' });
      }
    });

    // GET /api/church/reports/ai-activity — AI action log
    app.get('/api/church/reports/ai-activity', authMiddleware, async (req, res) => {
      try {
        const churchId = req.church.churchId;
        const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(10, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const roomId = req.query.roomId || null;
        const triageRoomFilter = roomId ? ' AND t.room_id = ?' : '';
        const triageParams = roomId ? [churchId, since, roomId] : [churchId, since];

        // Check AI mode
        let aiSettings = {};
        try {
          aiSettings = await qOne('SELECT * FROM church_ai_settings WHERE church_id = ?', [churchId]) || {};
        } catch {}

        // Auto-fix actions
        let actions = [];
        try {
          actions = await qAll(`
            SELECT r.*, t.alert_type, t.triage_severity, t.time_context, t.room_id
            FROM ai_resolutions r
            JOIN ai_triage_events t ON t.id = r.event_id
            WHERE r.church_id = ? AND r.created_at >= ?${triageRoomFilter}
            ORDER BY r.created_at DESC
            LIMIT ? OFFSET ?
          `, [...triageParams, limit, offset]);
        } catch {}

        let totalActions = 0;
        try {
          const triageCountParams = roomId ? [churchId, since, roomId] : [churchId, since];
          const cnt = await qOne(`
            SELECT COUNT(*) AS cnt FROM ai_resolutions r
            JOIN ai_triage_events t ON t.id = r.event_id
            WHERE r.church_id = ? AND r.created_at >= ?${triageRoomFilter}
          `, triageCountParams);
          totalActions = cnt?.cnt || 0;
        } catch {}

        // Summary stats
        let summary = {};
        try {
          summary = await qOne(`
            SELECT
              COUNT(*) AS total_actions,
              SUM(CASE WHEN r.success = 1 THEN 1 ELSE 0 END) AS successful,
              SUM(CASE WHEN r.success = 0 THEN 1 ELSE 0 END) AS failed,
              ROUND(AVG(r.duration_ms)) AS avg_duration_ms
            FROM ai_resolutions r
            JOIN ai_triage_events t ON t.id = r.event_id
            WHERE r.church_id = ? AND r.created_at >= ?${triageRoomFilter}
          `, triageParams) || {};
        } catch {}

        // Pending issues (triage events with no resolution)
        let pending = [];
        try {
          pending = await qAll(`
            SELECT t.id, t.alert_type, t.triage_severity, t.time_context, t.room_id, t.created_at
            FROM ai_triage_events t
            LEFT JOIN ai_resolutions r ON r.event_id = t.id
            WHERE t.church_id = ? AND t.created_at >= ? AND r.id IS NULL${roomId ? ' AND t.room_id = ?' : ''}
            ORDER BY t.triage_score DESC
            LIMIT 10
          `, triageParams);
        } catch {}

        const effectiveAiMode = aiSettings.ai_mode || 'recommend_only';
        res.json({
          aiEnabled: effectiveAiMode !== 'disabled',
          aiMode: effectiveAiMode,
          summary: {
            totalActions: summary.total_actions || 0,
            successful: summary.successful || 0,
            failed: summary.failed || 0,
            avgDurationMs: summary.avg_duration_ms || null,
            successRate: (summary.total_actions || 0) > 0 ? (((summary.successful || 0) / summary.total_actions) * 100).toFixed(1) : null
          },
          actions: actions.map(a => ({
            id: a.id,
            timestamp: a.created_at,
            alertType: (a.alert_type || '').replace(/_/g, ' '),
            severity: a.triage_severity,
            action: a.action_taken,
            command: a.action_command,
            success: !!a.success,
            durationMs: a.duration_ms,
            notes: a.notes,
            roomId: a.room_id,
            timeContext: a.time_context
          })),
          pendingIssues: pending.map(p => ({
            id: p.id,
            alertType: (p.alert_type || '').replace(/_/g, ' '),
            severity: p.triage_severity,
            roomId: p.room_id,
            timestamp: p.created_at,
            timeContext: p.time_context
          })),
          pagination: { page, limit, total: totalActions, totalPages: Math.ceil(totalActions / limit) },
          period: { days, since }
        });
      } catch (err) {
        log.error('Reports ai-activity error:', err);
        res.status(500).json({ error: 'Failed to fetch AI activity data' });
      }
    });

    // GET /api/church/ai-triage/windows — service window visualization
    app.get('/api/church/ai-triage/windows', authMiddleware, (req, res) => {
      try {
        const windows = aiTriageEngine.getServiceWindows(req.church.churchId);
        res.json(windows);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch service windows' });
      }
    });

    // GET /api/church/ai-triage/context — current time context
    app.get('/api/church/ai-triage/context', authMiddleware, (req, res) => {
      try {
        const context = aiTriageEngine.getTimeContext(req.church.churchId);
        res.json(context);
      } catch (err) {
        res.status(500).json({ error: 'Failed to determine time context' });
      }
    });
  }

  log.info('Setup complete — routes registered');
}

module.exports = { setupChurchPortal, _buildChurchPortalHtml: buildChurchPortalHtml, getDashboardStats, _findNextService };
