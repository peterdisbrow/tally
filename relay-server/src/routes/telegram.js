'use strict';

const { createLogger } = require('../logger');
const serverLog = createLogger('server');

/**
 * Telegram bot route handlers (webhook, TD registration, bot config).
 *
 * @param {import('express').Express} app
 * @param {Object} ctx
 * @param {Map} ctx.churches
 * @param {Function} ctx.requireAdmin
 * @param {Object|null} ctx.tallyBot
 * @param {string} ctx.TALLY_BOT_WEBHOOK_SECRET
 * @param {string} ctx.TALLY_BOT_WEBHOOK_URL
 */
module.exports = function setupTelegramRoutes(app, ctx) {
  const { churches, requireAdmin, tallyBot, TALLY_BOT_WEBHOOK_SECRET, TALLY_BOT_WEBHOOK_URL } = ctx;

  app.post('/api/telegram-webhook', (req, res) => {
    const providedSecret = req.headers['x-telegram-bot-api-secret-token'] || '';
    if (TALLY_BOT_WEBHOOK_SECRET && providedSecret !== TALLY_BOT_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized webhook secret' });
    }
    res.sendStatus(200); // Respond immediately to Telegram
    if (tallyBot) tallyBot.handleUpdate(req.body).catch(e => serverLog.error(`TallyBot webhook error: ${e.message}`));
    else serverLog.warn('TallyBot webhook called but bot is not initialized.');
  });

  app.post('/api/churches/:churchId/td-register', requireAdmin, (req, res) => {
    const { churchId } = req.params;
    const church = churches.get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const { telegram_user_id, telegram_chat_id, name } = req.body;
    if (!telegram_user_id || !name) return res.status(400).json({ error: 'telegram_user_id and name required' });
    if (!tallyBot) return res.status(503).json({ error: 'Telegram bot not configured' });
    tallyBot._stmtRegisterTD.run(churchId, telegram_user_id, telegram_chat_id || telegram_user_id, name, new Date().toISOString());
    res.json({ registered: true, name });
  });

  app.get('/api/churches/:churchId/tds', requireAdmin, (req, res) => {
    if (!tallyBot) return res.json([]);
    const tds = tallyBot._stmtListTDs.all(req.params.churchId);
    res.json(tds);
  });

  app.delete('/api/churches/:churchId/tds/:userId', requireAdmin, (req, res) => {
    if (!tallyBot) return res.status(503).json({ error: 'Telegram bot not configured' });
    tallyBot._stmtDeactivateTD.run(req.params.churchId, req.params.userId);
    res.json({ removed: true });
  });

  app.post('/api/bot/set-webhook', requireAdmin, (req, res) => {
    if (!tallyBot) return res.status(503).json({ error: 'Telegram bot not configured' });
    const { url, secret_token } = req.body || {};
    const payload = {
      url: url || TALLY_BOT_WEBHOOK_URL
    };
    const webhookSecret = secret_token || TALLY_BOT_WEBHOOK_SECRET;
    if (webhookSecret) payload.secret_token = webhookSecret;
    if (!payload.url) return res.status(400).json({ error: 'url required (or TALLY_BOT_WEBHOOK_URL env var)'});
    tallyBot.setWebhook(payload).then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message }));
  });
};
