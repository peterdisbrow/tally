/**
 * Telegram bot webhook & TD registration routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupTelegramRoutes(app, ctx) {
  const { db, churches, tallyBot, requireAdmin, safeErrorMessage, log,
          TALLY_BOT_WEBHOOK_URL, TALLY_BOT_WEBHOOK_SECRET } = ctx;

  // Receive Telegram webhook updates
  app.post('/api/telegram-webhook', (req, res) => {
    const providedSecret = req.headers['x-telegram-bot-api-secret-token'] || '';
    const requireSecret = process.env.NODE_ENV === 'production' || !!TALLY_BOT_WEBHOOK_SECRET;
    if (requireSecret && (!providedSecret || providedSecret !== TALLY_BOT_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized webhook secret' });
    }
    res.sendStatus(200); // Respond immediately to Telegram
    if (tallyBot) tallyBot.handleUpdate(req.body).catch(e => console.error('[TallyBot] webhook error:', e.message));
    else console.warn('[TallyBot] Webhook called but bot is not initialized.');
  });

  // Register a TD for a church (admin only)
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

  // List TDs for a church
  app.get('/api/churches/:churchId/tds', requireAdmin, (req, res) => {
    if (!tallyBot) return res.json([]);
    const tds = tallyBot._stmtListTDs.all(req.params.churchId);
    res.json(tds);
  });

  // Deactivate a TD
  app.delete('/api/churches/:churchId/tds/:userId', requireAdmin, (req, res) => {
    if (!tallyBot) return res.status(503).json({ error: 'Telegram bot not configured' });
    tallyBot._stmtDeactivateTD.run(req.params.churchId, req.params.userId);
    res.json({ removed: true });
  });

  // Set/update the bot webhook URL
  app.post('/api/bot/set-webhook', requireAdmin, (req, res) => {
    if (!tallyBot) return res.status(503).json({ error: 'Telegram bot not configured' });
    const { url, secret_token } = req.body || {};
    const payload = {
      url: url || TALLY_BOT_WEBHOOK_URL
    };
    const webhookSecret = secret_token || TALLY_BOT_WEBHOOK_SECRET;
    if (webhookSecret) payload.secret_token = webhookSecret;
    if (!payload.url) return res.status(400).json({ error: 'url required (or TALLY_BOT_WEBHOOK_URL env var)'});
    tallyBot.setWebhook(payload).then(r => res.json(r)).catch(e => res.status(500).json({ error: safeErrorMessage(e) }));
  });
};
