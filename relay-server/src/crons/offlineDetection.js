/**
 * Offline between-service detection (Feature 12).
 *
 * Periodically checks for churches whose booth computer has gone offline
 * outside of service hours, and sends Telegram alerts.
 *
 * @param {object} ctx - Shared server context
 * @returns {{ checkOfflineChurches: Function, start: Function }}
 */
const { WebSocket } = require('ws');

module.exports = function setupOfflineDetection(ctx) {
  const { db, churches, scheduleEngine, alertEngine, eventMode, tallyBot, log, _intervals } = ctx;
  const queryClient = ctx.queryClient || db?.queryClient || null;
  const hasQueryClient = queryClient
    && typeof queryClient.query === 'function'
    && typeof queryClient.queryOne === 'function'
    && typeof queryClient.run === 'function';

  function isInMaintenanceWindow(churchId) {
    const now = new Date().toISOString();
    if (hasQueryClient) {
      return queryClient.queryOne(
        `SELECT id FROM maintenance_windows WHERE churchId = ? AND startTime <= ? AND endTime >= ? LIMIT 1`,
        [churchId, now, now],
      ).then(row => !!row);
    }
    const row = db.prepare(
      `SELECT id FROM maintenance_windows WHERE churchId = ? AND startTime <= ? AND endTime >= ? LIMIT 1`
    ).get(churchId, now, now);
    return !!row;
  }

  /**
   * Determine the local hour for a church using its IANA timezone.
   * Falls back to server local time if no timezone is stored.
   */
  function getChurchLocalHour(churchId) {
    const church = churches.get(churchId);
    const tz = church?.timezone || '';
    if (tz) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).formatToParts(new Date());
        const hourPart = parts.find(p => p.type === 'hour');
        if (hourPart) return parseInt(hourPart.value, 10);
      } catch { /* invalid timezone — fall through */ }
    }
    return new Date().getHours(); // fallback: server local time
  }

  function processRows(allChurches, now) {
    const botToken = process.env.ALERT_BOT_TOKEN;
    const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.ANDREW_TELEGRAM_CHAT_ID;

    for (const row of allChurches) {
      const church = churches.get(row.churchId);
      if (!church) continue;
      if (!church.lastHeartbeat) continue; // never connected — skip
      if (scheduleEngine.isServiceWindow(row.churchId)) continue; // in service — normal

      const localHour = getChurchLocalHour(row.churchId);
      const isNightTime = localHour >= 23 || localHour < 6; // 11pm–6am church local

      const offlineMs = now - church.lastHeartbeat;
      const offlineHours = offlineMs / (1000 * 60 * 60);

      // Already connected — reset flag
      const hasOpenSock = church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN);
      if (hasOpenSock) {
        church._offlineAlertSent = false;
        church._criticalOfflineAlertSent = false;
        continue;
      }

      if (offlineHours >= 24) {
        if (!church._criticalOfflineAlertSent && botToken && adminChatId) {
          church._criticalOfflineAlertSent = true;
          const lastSeen = new Date(church.lastHeartbeat).toLocaleString();
          const msg = `🔴 *CRITICAL: ${row.name}* has been offline for 24+ hours\nLast seen: ${lastSeen}\n\nThis church's booth computer may need attention.`;
          alertEngine.sendTelegramMessage(adminChatId, botToken, msg).catch(() => {});
          log(`[OfflineDetection] 🔴 CRITICAL: ${row.name} offline 24h+`);
        }
      } else if (offlineHours >= 2 && !isNightTime) {
        if (!church._offlineAlertSent && botToken && adminChatId) {
          church._offlineAlertSent = true;
          const lastSeen = new Date(church.lastHeartbeat).toLocaleString();
          const msg = `⚠️ *${row.name}* booth computer offline for 2h+\nLast seen: ${lastSeen}\nNot during service hours — may need attention.`;
          alertEngine.sendTelegramMessage(adminChatId, botToken, msg).catch(() => {});
          log(`[OfflineDetection] ⚠️ ${row.name} offline 2h+ (not in service window)`);
        }
      }
    }
  }

  function checkOfflineChurches() {
    const now = Date.now();
    if (hasQueryClient) {
      const nowIso = new Date(now).toISOString();
      return queryClient.query('SELECT * FROM churches')
        .then(async (allChurches) => {
          const maintenanceRows = await queryClient.query(
            'SELECT DISTINCT churchId FROM maintenance_windows WHERE churchId IS NOT NULL AND startTime <= ? AND endTime >= ?',
            [nowIso, nowIso],
          ).catch(() => []);
          const maintenanceChurches = new Set(maintenanceRows.map((row) => row.churchId));
          const filtered = allChurches.filter((row) => !maintenanceChurches.has(row.churchId));
          processRows(filtered, now);
        });
    }

    const allChurches = db.prepare('SELECT * FROM churches').all()
      .filter(row => !isInMaintenanceWindow(row.churchId));
    processRows(allChurches, now);
    return Promise.resolve();
  }

  /** Start the periodic check (every 10 minutes) */
  function start() {
    _intervals.push(setInterval(() => {
      Promise.resolve(checkOfflineChurches()).catch(e => console.error('[OfflineDetection] error:', e.message));
      // Event expiry also runs on its own 10-min loop (started in eventMode.start()),
      // but calling it here too ensures sync with the same cadence.
      eventMode.checkExpiry(tallyBot, churches).catch(e => console.error('[EventMode] expiry error:', e.message));
    }, 10 * 60 * 1000));
  }

  return { checkOfflineChurches, start };
};
