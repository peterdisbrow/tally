/**
 * Church / Admin chat endpoints.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
const { processOnboardingMessage, executeOnboardingAction, getSession } = require('../onboardingChat');

module.exports = function setupChatRoutes(app, ctx) {
  const { db, queryClient, chatEngine, requireAdmin, requireChurchAppAuth,
          handleChatCommandMessage, rateLimit, log,
          churches, scheduleEngine } = ctx;
  const hasQueryClient = queryClient
    && typeof queryClient.queryOne === 'function'
    && typeof queryClient.run === 'function';

  async function getChurchById(churchId) {
    if (hasQueryClient) {
      return queryClient.queryOne('SELECT * FROM churches WHERE churchId = ?', [churchId]);
    }
    return db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
  }

  // Church-facing: TD sends a chat message from Electron app
  // Supports optional `attachment` field: { data: "base64...", mimeType: "image/jpeg", fileName: "patch.jpg" }
  app.post('/api/church/chat', requireChurchAppAuth, rateLimit(20, 60_000), async (req, res) => {
    try {
      const { message, senderName, attachment, roomId } = req.body;
      // Allow empty message if there's an attachment
      if ((!message || !message.trim()) && !attachment?.data) {
        return res.status(400).json({ error: 'Message or attachment required' });
      }
      const trimmedMessage = (message || '').trim();
      const displayMessage = attachment?.fileName
        ? `${trimmedMessage ? trimmedMessage + ' ' : ''}📎 ${attachment.fileName}`
        : trimmedMessage;
      const saved = await chatEngine.saveMessage({
        churchId: req.church.churchId,
        senderName: senderName || req.church.td_name || 'TD',
        senderRole: 'td',
        source: 'app',
        message: displayMessage || '📎 File attached',
        roomId: roomId || null,
      });
      chatEngine.broadcastChat(saved);
      handleChatCommandMessage(req.church.churchId, trimmedMessage, attachment || null, roomId || null).catch((err) => {
        log(`Chat command handler error (${req.church.churchId}): ${err.message}`);
      });
      res.json(saved);
    } catch (err) {
      log(`[Chat] POST /api/church/chat error: ${err.message}`);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // Church-facing: TD polls for messages
  app.get('/api/church/chat', requireChurchAppAuth, async (req, res) => {
    try {
      const messages = await chatEngine.getMessages(req.church.churchId, {
        since: req.query.since || null,
        limit: parseInt(req.query.limit) || 50,
        latest: req.query.latest === 'true',
        roomId: req.query.roomId || null,
      });
      res.json({ messages });
    } catch (err) {
      log(`[Chat] GET /api/church/chat error: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // Admin-facing: Admin sends a chat message
  app.post('/api/churches/:churchId/chat', requireAdmin, rateLimit(30, 60_000), async (req, res) => {
    try {
      const churchRow = await getChurchById(req.params.churchId);
      if (!churchRow) return res.status(404).json({ error: 'Church not found' });
      const { message, senderName } = req.body;
      if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
      const trimmedMessage = message.trim();
      const saved = await chatEngine.saveMessage({
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
    } catch (err) {
      log(`[Chat] POST /api/churches/:churchId/chat error: ${err.message}`);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // Admin-facing: Admin polls for messages
  app.get('/api/churches/:churchId/chat', requireAdmin, async (req, res) => {
    try {
      const messages = await chatEngine.getMessages(req.params.churchId, {
        since: req.query.since || null,
        limit: parseInt(req.query.limit) || 50,
        sessionId: req.query.sessionId || null,
      });
      res.json({ messages });
    } catch (err) {
      log(`[Chat] GET /api/churches/:churchId/chat error: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // ─── ONBOARDING CHAT ──────────────────────────────────────────────────────

  // Process an onboarding message
  app.post('/api/church/onboarding/chat', requireChurchAppAuth, rateLimit(30, 60_000), async (req, res) => {
    const { message, scanResults } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message required' });
    }
    try {
      // Save user message
      await chatEngine.saveMessage({
        churchId: req.church.churchId,
        senderName: req.church.td_name || 'TD',
        senderRole: 'td',
        source: 'onboarding',
        message: message.trim(),
      });

      const result = await processOnboardingMessage(
        hasQueryClient ? queryClient : db, req.church.churchId, message.trim(), scanResults || {}, chatEngine
      );

      // Save AI reply
      await chatEngine.saveMessage({
        churchId: req.church.churchId,
        senderName: 'TallyConnect',
        senderRole: 'system',
        source: 'onboarding',
        message: result.reply,
      });

      res.json(result);
    } catch (err) {
      log(`Onboarding chat error (${req.church.churchId}): ${err.message}`);
      res.status(500).json({ error: 'Failed to process message' });
    }
  });

  // Execute a confirmed onboarding action
  app.post('/api/church/onboarding/confirm', requireChurchAppAuth, rateLimit(20, 60_000), async (req, res) => {
    const { action } = req.body;
    if (!action || !action.type) {
      return res.status(400).json({ error: 'Action required' });
    }
    try {
      const result = await executeOnboardingAction(
        hasQueryClient ? queryClient : db, req.church.churchId, action, churches || new Map(), scheduleEngine
      );
      res.json(result);
    } catch (err) {
      log(`[Chat] Onboarding confirm error (${req.church.churchId}): ${err.message}`);
      res.status(500).json({ error: 'Failed to execute action' });
    }
  });

  // Get current onboarding state (for resume) — includes message history (#9)
  app.get('/api/church/onboarding/state', requireChurchAppAuth, async (req, res) => {
    try {
      const session = await Promise.resolve(getSession(hasQueryClient ? queryClient : db, req.church.churchId));
      if (!session) {
        return res.json({ state: null, progress: null, messages: [] });
      }

      // Return previous onboarding messages so the UI can rebuild the chat
      let messages = [];
      try {
        const allMsgs = await chatEngine.getMessages(req.church.churchId, { limit: 50 });
        messages = allMsgs
          .filter(m => m.source === 'onboarding')
          .map(m => ({
            role: m.sender_role === 'system' ? 'ai' : 'user',
            text: m.message,
          }));
      } catch { /* non-fatal */ }

      res.json({
        state: session.state,
        collectedData: session.collectedData,
        progress: {
          completed: Object.keys(session.collectedData),
          remaining: ['gear', 'schedule', 'tds', 'stream'].filter(
            s => !session.collectedData[s === 'gear' ? 'equipment' : s]
          ),
        },
        messages,
      });
    } catch (err) {
      log(`[Chat] GET /api/church/onboarding/state error: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch onboarding state' });
    }
  });
};
