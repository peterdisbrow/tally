'use strict';

/**
 * Slack integration route handlers.
 *
 * @param {import('express').Express} app
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Map} ctx.churches
 * @param {Function} ctx.requireAdmin
 * @param {Object} ctx.stmtGet - prepared statement: SELECT * FROM churches WHERE churchId = ?
 * @param {Object} ctx.alertEngine
 * @param {Function} ctx.log
 */
module.exports = function setupSlackRoutes(app, ctx) {
  const { db, churches, requireAdmin, stmtGet, alertEngine, log } = ctx;

  // Get Slack config for a church (masked webhook for security)
  app.get('/api/churches/:churchId/slack', requireAdmin, (req, res) => {
    const row = stmtGet.get(req.params.churchId);
    if (!row) return res.status(404).json({ error: 'Church not found' });
    const url = row.slack_webhook_url || '';
    res.json({
      configured: !!url,
      webhookUrl: url ? url.slice(0, 40) + '\u2022\u2022\u2022\u2022\u2022\u2022' : '',
      webhookUrlFull: url, // admin-only endpoint, safe to return full URL
      channel: row.slack_channel || '',
    });
  });

  // Set Slack config for a church
  app.put('/api/churches/:churchId/slack', requireAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const { webhookUrl, channel } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl required' });
    db.prepare('UPDATE churches SET slack_webhook_url = ?, slack_channel = ? WHERE churchId = ?')
      .run(webhookUrl, channel || null, req.params.churchId);
    log(`Slack configured for church ${church.name}`);
    res.json({ saved: true, channel: channel || null });
  });

  // Remove Slack config
  app.delete('/api/churches/:churchId/slack', requireAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    db.prepare('UPDATE churches SET slack_webhook_url = NULL, slack_channel = NULL WHERE churchId = ?')
      .run(req.params.churchId);
    res.json({ removed: true });
  });

  // Test Slack integration
  app.post('/api/churches/:churchId/slack/test', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const row = stmtGet.get(req.params.churchId);
    if (!row?.slack_webhook_url) return res.status(400).json({ error: 'Slack not configured for this church' });

    try {
      await alertEngine.sendSlackAlert(
        { ...church, ...row },
        'test_alert',
        'INFO',
        { church: church.name },
        { likely_cause: 'This is a test message from Tally.', steps: ['Slack integration is working correctly!'] }
      );
      res.json({ sent: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
