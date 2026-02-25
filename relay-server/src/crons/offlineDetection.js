'use strict';

const { WebSocket } = require('ws');
const { createLogger } = require('../logger');
const serverLog = createLogger('server');

function log(msg) { serverLog.info(msg); }

/**
 * Offline detection cron — checks for churches that have gone offline
 * between service windows and sends alerts.
 *
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Map} ctx.churches
 * @param {Object} ctx.scheduleEngine
 * @param {Object} ctx.alertEngine
 * @param {Object} ctx.eventMode
 * @param {Object|null} ctx.tallyBot
 * @param {Array} ctx.activeTimers - array to push interval handles into
 */
module.exports = function setupOfflineDetection(ctx) {
  const { db, churches, scheduleEngine, alertEngine, eventMode, tallyBot, activeTimers } = ctx;

  function isInMaintenanceWindow(churchId) {
    const now = new Date().toISOString();
    const row = db.prepare(
      `SELECT id FROM maintenance_windows WHERE churchId = ? AND startTime <= ? AND endTime >= ? LIMIT 1`
    ).get(churchId, now, now);
    return !!row;
  }

  function checkOfflineChurches() {
    const now = Date.now();
    const hour = new Date().getHours();
    const isNightTime = hour >= 23 || hour < 6; // 11pm–6am: don't alert

    const allChurches = db.prepare('SELECT * FROM churches').all();
    const botToken = process.env.ALERT_BOT_TOKEN;
    const andrewChatId = process.env.ANDREW_TELEGRAM_CHAT_ID;

    for (const row of allChurches) {
      const church = churches.get(row.churchId);
      if (!church) continue;
      if (!church.lastHeartbeat) continue; // never connected — skip
      if (isInMaintenanceWindow(row.churchId)) continue;
      if (scheduleEngine.isServiceWindow(row.churchId)) continue; // in service — normal

      const offlineMs = now - church.lastHeartbeat;
      const offlineHours = offlineMs / (1000 * 60 * 60);

      // Already connected — reset flag
      if (church.ws?.readyState === WebSocket.OPEN) {
        church._offlineAlertSent = false;
        church._criticalOfflineAlertSent = false;
        continue;
      }

      if (offlineHours >= 24) {
        // Critical: offline for 24+ hours
        if (!church._criticalOfflineAlertSent && botToken && andrewChatId) {
          church._criticalOfflineAlertSent = true;
          const lastSeen = new Date(church.lastHeartbeat).toLocaleString();
          const msg = `\uD83D\uDD34 *CRITICAL: ${row.name}* has been offline for 24+ hours\nLast seen: ${lastSeen}\n\nThis church's booth computer may need attention.`;
          alertEngine.sendTelegramMessage(andrewChatId, botToken, msg).catch(() => {});
          log(`[OfflineDetection] \uD83D\uDD34 CRITICAL: ${row.name} offline 24h+`);
        }
      } else if (offlineHours >= 2 && !isNightTime) {
        // Warning: offline 2+ hours outside of nighttime
        if (!church._offlineAlertSent && botToken && andrewChatId) {
          church._offlineAlertSent = true;
          const lastSeen = new Date(church.lastHeartbeat).toLocaleString();
          const msg = `\u26A0\uFE0F *${row.name}* booth computer offline for 2h+\nLast seen: ${lastSeen}\nNot during service hours \u2014 may need attention.`;
          alertEngine.sendTelegramMessage(andrewChatId, botToken, msg).catch(() => {});
          log(`[OfflineDetection] \u26A0\uFE0F ${row.name} offline 2h+ (not in service window)`);
        }
      }
    }
  }

  // Check every 10 minutes (offline detection + event expiry)
  activeTimers.push(setInterval(() => {
    checkOfflineChurches();
    // Event expiry also runs on its own 10-min loop (started in eventMode.start()),
    // but calling it here too ensures sync with the same cadence.
    eventMode.checkExpiry(tallyBot, churches).catch(e => serverLog.error(`EventMode expiry error: ${e.message}`));
  }, 10 * 60 * 1000));

  return { checkOfflineChurches, isInMaintenanceWindow };
};
