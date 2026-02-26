/**
 * Church / Admin chat endpoints.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupChatRoutes(app, ctx) {
  const { db, chatEngine, requireAdmin, requireChurchAppAuth,
          handleChatCommandMessage, log } = ctx;

  // Church-facing: TD sends a chat message from Electron app
  app.post('/api/church/chat', requireChurchAppAuth, (req, res) => {
    const { message, senderName } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
    const trimmedMessage = message.trim();
    const saved = chatEngine.saveMessage({
      churchId: req.church.churchId,
      senderName: senderName || req.church.td_name || 'TD',
      senderRole: 'td',
      source: 'app',
      message: trimmedMessage,
    });
    chatEngine.broadcastChat(saved);
    handleChatCommandMessage(req.church.churchId, trimmedMessage).catch((err) => {
      log(`Chat command handler error (${req.church.churchId}): ${err.message}`);
    });
    res.json(saved);
  });

  // Church-facing: TD polls for messages
  app.get('/api/church/chat', requireChurchAppAuth, (req, res) => {
    const messages = chatEngine.getMessages(req.church.churchId, {
      since: req.query.since || null,
      limit: parseInt(req.query.limit) || 50,
    });
    res.json({ messages });
  });

  // Admin-facing: Admin sends a chat message
  app.post('/api/churches/:churchId/chat', requireAdmin, (req, res) => {
    const churchRow = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(req.params.churchId);
    if (!churchRow) return res.status(404).json({ error: 'Church not found' });
    const { message, senderName } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
    const trimmedMessage = message.trim();
    const saved = chatEngine.saveMessage({
      churchId: req.params.churchId,
      senderName: senderName || req.adminUser?.name || 'Admin',
      senderRole: 'admin',
      source: 'dashboard',
      message: trimmedMessage,
    });
    chatEngine.broadcastChat(saved);
    handleChatCommandMessage(req.params.churchId, trimmedMessage).catch((err) => {
      log(`Chat command handler error (${req.params.churchId}): ${err.message}`);
    });
    res.json(saved);
  });

  // Admin-facing: Admin polls for messages
  app.get('/api/churches/:churchId/chat', requireAdmin, (req, res) => {
    const messages = chatEngine.getMessages(req.params.churchId, {
      since: req.query.since || null,
      limit: parseInt(req.query.limit) || 50,
      sessionId: req.query.sessionId || null,
    });
    res.json({ messages });
  });
};
