/**
 * Slack integration CRUD + test routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupSlackRoutes(app, ctx) {
  const { db, queryClient, churches, requireAdmin, alertEngine, safeErrorMessage, log, isValidSlackWebhookUrl } = ctx;
  const hasQueryClient = !!queryClient;
  const qOne = (sql, params = []) =>
    hasQueryClient ? queryClient.queryOne(sql, params) : db.prepare(sql).get(...params) || null;
  const qRun = (sql, params = []) =>
    hasQueryClient ? queryClient.run(sql, params) : db.prepare(sql).run(...params);

  // Get Slack config for a church (masked webhook for security)
  app.get('/api/churches/:churchId/slack', requireAdmin, async (req, res) => {
    const row = await qOne('SELECT * FROM churches WHERE churchId = ?', [req.params.churchId]);
    if (!row) return res.status(404).json({ error: 'Church not found' });
    const url = row.slack_webhook_url || '';
    res.json({
      configured: !!url,
      webhookUrl: url ? url.slice(0, 40) + '••••••' : '',
      webhookUrlFull: url, // admin-only endpoint, safe to return full URL
      channel: row.slack_channel || '',
    });
  });

  // Set Slack config for a church
  app.put('/api/churches/:churchId/slack', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const { webhookUrl, channel } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl required' });
    if (isValidSlackWebhookUrl && !isValidSlackWebhookUrl(webhookUrl)) {
      return res.status(400).json({ error: 'Invalid Slack webhook URL. Must be an https:// URL on hooks.slack.com.' });
    }
    await qRun(
      'UPDATE churches SET slack_webhook_url = ?, slack_channel = ? WHERE churchId = ?',
      [webhookUrl, channel || null, req.params.churchId],
    );
    log(`Slack configured for church ${church.name}`);
    res.json({ saved: true, channel: channel || null });
  });

  // Remove Slack config
  app.delete('/api/churches/:churchId/slack', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    await qRun(
      'UPDATE churches SET slack_webhook_url = NULL, slack_channel = NULL WHERE churchId = ?',
      [req.params.churchId],
    );
    res.json({ removed: true });
  });

  // Test Slack integration
  app.post('/api/churches/:churchId/slack/test', requireAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const row = await qOne('SELECT * FROM churches WHERE churchId = ?', [req.params.churchId]);
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
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });
};
