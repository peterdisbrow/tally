/**
 * Preset library + Autopilot automation + command log routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupAutomationRoutes(app, ctx) {
  const { churches, requireAdmin, requireChurchOrAdmin, requireFeature,
          presetLibrary, autoPilot, safeErrorMessage, safeSend, log } = ctx;
  const WebSocket = require('ws').WebSocket;

  // ─── Helper: create a sendCommand function for a church WebSocket ─────────
  function makeCommandSender(church) {
    return (command, params) => new Promise((resolve, reject) => {
      // Gather all open sockets (multi-instance support)
      const openSockets = [];
      if (church.sockets?.size) {
        for (const sock of church.sockets.values()) {
          if (sock.readyState === WebSocket.OPEN) openSockets.push(sock);
        }
      }
      if (openSockets.length === 0) {
        return reject(new Error('Church client not connected'));
      }
      const { v4: uuid } = require('uuid');
      const id = uuid();

      const cleanup = () => {
        for (const sock of openSockets) {
          try { sock.removeListener('message', handler); } catch { /* ignore */ }
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Command timeout (15s)'));
      }, 15000);

      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'command_result' && msg.id === id) {
            clearTimeout(timeout);
            cleanup();
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
          }
        } catch { /* ignore */ }
      };

      // Listen on all sockets and send to all
      for (const sock of openSockets) {
        sock.on('message', handler);
        safeSend(sock, { type: 'command', command, params, id });
      }
    });
  }

  // ─── PRESET LIBRARY ──────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/presets', requireChurchOrAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const presets = await presetLibrary.list(req.params.churchId);
      res.json(presets);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/churches/:churchId/presets', requireChurchOrAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const { name, type, data } = req.body;
    if (!name || !type || !data) return res.status(400).json({ error: 'name, type, and data required' });
    try {
      const id = await presetLibrary.save(req.params.churchId, name, type, data);
      res.json({ id, name, type, saved: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/churches/:churchId/presets/:name', requireChurchOrAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const preset = await presetLibrary.get(req.params.churchId, req.params.name);
      if (!preset) return res.status(404).json({ error: 'Preset not found' });
      res.json(preset);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/churches/:churchId/presets/:name', requireChurchOrAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const deleted = await presetLibrary.delete(req.params.churchId, req.params.name);
      if (!deleted) return res.status(404).json({ error: 'Preset not found' });
      res.json({ deleted: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/churches/:churchId/presets/:name/recall', requireChurchOrAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const hasOpenSock = church.sockets?.size && [...church.sockets.values()].some(s => s.readyState === WebSocket.OPEN);
    if (!hasOpenSock) {
      return res.status(503).json({ error: 'Church client not connected' });
    }
    try {
      const sendCommand = makeCommandSender(church);
      const preset = await presetLibrary.recall(req.params.churchId, req.params.name, sendCommand);
      log(`PRESET recall → ${church.name}: "${preset.name}" (${preset.type})`);
      res.json({ recalled: true, preset: { name: preset.name, type: preset.type } });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── AUTOPILOT ───────────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/automation', requireChurchOrAdmin, requireFeature('autopilot'), (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    res.json({
      paused: autoPilot.isPaused(req.params.churchId),
      rules: autoPilot.getRules(req.params.churchId),
    });
  });

  app.post('/api/churches/:churchId/automation', requireChurchOrAdmin, requireFeature('autopilot'), (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const rule = autoPilot.createRule(req.params.churchId, {
        name: req.body.name,
        triggerType: req.body.triggerType,
        triggerConfig: req.body.triggerConfig || {},
        actions: req.body.actions || [],
      });
      res.json(rule);
    } catch (e) {
      if (e.code === 'RULE_LIMIT_REACHED') {
        const NEXT_TIER = { connect: 'plus', plus: 'pro', pro: 'managed', managed: 'managed' };
        const suggestedPlan = NEXT_TIER[e.currentTier] || 'pro';
        return res.status(402).json({
          error: safeErrorMessage(e, 'Rule limit reached'),
          upgradeUrl: `https://tallyconnect.app/signup?plan=${suggestedPlan}`,
          suggestedPlan,
          currentTier: e.currentTier,
          ruleLimit: e.ruleLimit,
        });
      }
      res.status(400).json({ error: safeErrorMessage(e, 'Failed to create rule') });
    }
  });

  app.put('/api/churches/:churchId/automation/:ruleId', requireChurchOrAdmin, requireFeature('autopilot'), (req, res) => {
    try {
      const rule = autoPilot.updateRule(req.params.ruleId, req.body);
      res.json(rule);
    } catch (e) {
      res.status(400).json({ error: safeErrorMessage(e, 'Failed to update rule') });
    }
  });

  app.delete('/api/churches/:churchId/automation/:ruleId', requireChurchOrAdmin, requireFeature('autopilot'), (req, res) => {
    const deleted = autoPilot.deleteRule(req.params.ruleId);
    if (!deleted) return res.status(404).json({ error: 'Rule not found' });
    res.json({ deleted: true });
  });

  app.post('/api/churches/:churchId/automation/:ruleId/test', requireChurchOrAdmin, requireFeature('autopilot'), (req, res) => {
    const rule = autoPilot.getRule(req.params.ruleId);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    if (rule.church_id !== req.params.churchId) return res.status(403).json({ error: 'Access denied' });
    try {
      const result = autoPilot.testRule(req.params.ruleId, req.body || {});
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/churches/:churchId/automation/pause', requireChurchOrAdmin, requireFeature('autopilot'), (req, res) => {
    autoPilot.pause(req.params.churchId);
    res.json({ paused: true });
  });

  app.post('/api/churches/:churchId/automation/resume', requireChurchOrAdmin, requireFeature('autopilot'), (req, res) => {
    autoPilot.resume(req.params.churchId);
    res.json({ paused: false });
  });

  app.get('/api/churches/:churchId/command-log', requireChurchOrAdmin, requireFeature('autopilot'), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const logData = autoPilot.getCommandLog(req.params.churchId, limit, offset);
    res.json(logData);
  });
};
